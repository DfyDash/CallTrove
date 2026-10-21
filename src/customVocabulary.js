// AWS Transcribe custom vocabulary, one per connected GHL sub-account --
// see schema.sql's comment on ghl_account_vocabulary_terms for why this is
// scoped per sub-account rather than per tenant (a shared vocabulary
// across a multi-location tenant's different staff would risk
// cross-location name mix-ups -- the same class of mistake this exists to
// fix, just self-inflicted).
//
// This is unrelated to, and much lighter than, a "custom language model"
// (CLM) -- a vocabulary is just a list of words/phrases Transcribe is told
// about up front, with no training step and no extra per-minute charge.
// CLM trains an entire custom speech model on your own audio/text data and
// is billed as a genuinely separate, additional charge; nothing here uses
// it or needs it.
//
// AWS builds/updates a vocabulary asynchronously -- CreateVocabulary and
// UpdateVocabulary both return long before it's actually usable (typically
// a couple of minutes) -- so src/vocabularyPoller.js is what advances an
// account from 'pending' to 'ready'/'failed'; nothing here blocks waiting
// for that.
const db = require("./db");
const accountCredentials = require("./accountCredentials");
const billingRates = require("./billingRates");

const REGION = process.env.S3_REGION;
const LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || "en-US";
const VOCAB_INPUT_PREFIX = "transcribe-vocab-input";

// Gated on the same TRANSCRIPTION_ENABLED flag as src/transcription.js --
// a vocabulary with no transcription happening at all would just be dead
// weight, and this needs the same S3_REGION either way.
function isEnabled() {
  return process.env.TRANSCRIPTION_ENABLED === "true" && !!REGION;
}

let transcribeClient;
function getTranscribeClient() {
  if (!transcribeClient) {
    const { TranscribeClient } = require("@aws-sdk/client-transcribe");
    transcribeClient = new TranscribeClient({ region: REGION });
  }
  return transcribeClient;
}

let s3Client;
function getS3Client() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({ region: REGION });
  }
  return s3Client;
}

// AWS vocabulary names allow only letters, digits, '.', '_', '-' -- a raw
// UUID (hex + hyphens) already satisfies that, so this is just a prefix,
// not a transformation.
function vocabularyNameFor(ghlAccountId) {
  return `calltrove-${ghlAccountId}`;
}

// AWS Transcribe's custom-vocabulary table format: tab-separated columns,
// header row first. A Phrase can't contain spaces -- a multi-word term
// gets hyphen-joined, with the original spelling kept in DisplayAs so the
// hyphen never leaks into an actual transcript.
function toPhrase(text) {
  return text
    .trim()
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

// Bounds a pathologically large contact list well below AWS's own vocabulary
// size limit -- never matters for a real small-business account, just a
// safety net against building an unusably huge (and slow-to-build) table.
const MAX_VOCABULARY_ENTRIES = 3000;

// account: a src/db.getGhlAccountForVocabulary() row.
async function buildTermsForAccount(account) {
  const entries = [];
  const seen = new Set();
  function add(text, soundsLike) {
    const displayAs = (text || "").trim();
    if (!displayAs) return;
    const phrase = toPhrase(displayAs);
    if (!phrase || seen.has(phrase)) return;
    seen.add(phrase);
    entries.push({ phrase, soundsLike: (soundsLike || "").trim() || null, displayAs });
  }

  // The shared business name and this specific location's own name --
  // both genuinely apply to every call on this account.
  add(account.tenantName);
  add(account.name);

  const manualTerms = await db.listVocabularyTerms(account.id);
  for (const t of manualTerms) add(t.term, t.soundsLike);

  // Staff names come from this account's own GHL user list -- the same
  // source handled_by_name already comes from -- not CallTrove's login
  // users table, since someone can handle calls in GHL without ever having
  // a CallTrove login at all.
  try {
    const api = await accountCredentials.clientForAccount(account);
    if (api.isConfigured()) {
      const users = await api.listUsers();
      for (const u of users) add(u.name);
    }
  } catch (err) {
    console.error(`[customVocabulary] could not fetch GHL user list for account ${account.id}:`, err.message);
  }

  const contactNames = await db.listContactNamesForAccount(account.id);
  for (const name of contactNames) {
    if (entries.length >= MAX_VOCABULARY_ENTRIES) break;
    add(name);
  }

  return entries;
}

// Builds this account's term list fresh and pushes it to AWS as either a
// new vocabulary or an update to the existing one. Always leaves the
// account's vocabulary_status as 'pending' on success -- the poller picks
// up from there.
async function syncVocabulary(ghlAccountId) {
  const account = await db.getGhlAccountForVocabulary(ghlAccountId);
  if (!account) throw new Error(`no such GHL account ${ghlAccountId}`);

  const entries = await buildTermsForAccount(account);
  if (entries.length === 0) {
    // Nothing to teach Transcribe yet (brand new account, no contacts
    // synced, no GHL users, no manual terms) -- leave any existing
    // vocabulary alone rather than push an empty table AWS would reject.
    return { skipped: true, reason: "no terms to build a vocabulary from yet" };
  }

  const header = "Phrase\tSoundsLike\tDisplayAs";
  const lines = entries.map((e) => `${e.phrase}\t${e.soundsLike || ""}\t${e.displayAs}`);
  const table = [header, ...lines].join("\n") + "\n";

  // Same tier-bucket split as every other PHI-adjacent upload in this app
  // (src/transcription.js's own transient input, src/storage) -- a HIPAA
  // account's contact/staff names never transiently pass through the
  // standard-tier bucket.
  const bucket = billingRates.requireTierBucket(account.storageTier);
  const key = `${VOCAB_INPUT_PREFIX}/${ghlAccountId}.txt`;
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  await getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: table }));

  const vocabularyName = vocabularyNameFor(ghlAccountId);
  const { CreateVocabularyCommand, UpdateVocabularyCommand } = require("@aws-sdk/client-transcribe");
  const params = { VocabularyName: vocabularyName, LanguageCode: LANGUAGE_CODE, VocabularyFileUri: `s3://${bucket}/${key}` };

  try {
    if (account.vocabularyStatus) {
      await getTranscribeClient().send(new UpdateVocabularyCommand(params));
    } else {
      await getTranscribeClient().send(new CreateVocabularyCommand(params));
    }
  } catch (err) {
    // vocabulary_status said one should already exist but AWS disagrees
    // (e.g. it was deleted out-of-band in the AWS console) -- fall back to
    // creating it fresh instead of failing the whole sync over that.
    if (account.vocabularyStatus && err.name === "NotFoundException") {
      await getTranscribeClient().send(new CreateVocabularyCommand(params));
    } else {
      throw err;
    }
  }

  await db.setVocabularyStatus(ghlAccountId, "pending");
  return { pending: true, termCount: entries.length };
}

// Called by src/vocabularyPoller.js for every account whose build is still
// 'pending' -- checks in on AWS's own async build state and advances the
// stored status once it settles.
async function refreshVocabularyStatus(ghlAccountId) {
  const { GetVocabularyCommand } = require("@aws-sdk/client-transcribe");
  const vocabularyName = vocabularyNameFor(ghlAccountId);
  let result;
  try {
    result = await getTranscribeClient().send(new GetVocabularyCommand({ VocabularyName: vocabularyName }));
  } catch (err) {
    if (err.name === "NotFoundException") {
      // The Create/Update call itself must have failed after
      // vocabulary_status was already set to 'pending' -- treat as failed
      // rather than polling forever for something that was never started.
      await db.setVocabularyStatus(ghlAccountId, "failed");
      return "failed";
    }
    throw err;
  }
  if (result.VocabularyState === "READY") {
    await db.setVocabularyStatus(ghlAccountId, "ready");
    return "ready";
  }
  if (result.VocabularyState === "FAILED") {
    await db.setVocabularyStatus(ghlAccountId, "failed");
    return "failed";
  }
  return "pending";
}

// What src/transcription.js's callers (poller.js, webhookIngest.js,
// routes/api.js's on-demand retry) actually need: null unless this
// account's vocabulary is confirmed ready, so a still-building or
// never-built vocabulary never gets passed to a transcription job.
async function readyVocabularyNameFor(ghlAccountId) {
  const status = await db.getVocabularyStatus(ghlAccountId);
  return status === "ready" ? vocabularyNameFor(ghlAccountId) : null;
}

module.exports = {
  isEnabled,
  vocabularyNameFor,
  buildTermsForAccount,
  syncVocabulary,
  refreshVocabularyStatus,
  readyVocabularyNameFor,
};
