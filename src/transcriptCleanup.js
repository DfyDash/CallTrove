// Transcript cleanup via Claude on Bedrock -- the Bedrock-based answer to
// GHL's poor call-audio quality, picked over audio preprocessing
// (ffmpeg-style noise reduction before transcription, which research
// showed can just as easily *hurt* accuracy as help it -- see the
// decision not to build that). This instead asks the same model already
// used for call summaries (src/callSummary.js) to look at the words AWS
// Transcribe itself was least confident about and decide, from the
// surrounding context it can already see, whether each one is right or
// should be something else. Nothing it's confident about is ever touched.
//
// Same Bedrock-over-direct-Anthropic-API reasoning as callSummary.js: the
// transcript may contain PHI, and Bedrock is covered under the account's
// existing AWS BAA.

const { stripJsonCodeFence } = require("./bedrockJson");

const REGION = process.env.BEDROCK_REGION || process.env.S3_REGION;
const MODEL_ID = process.env.BEDROCK_MODEL_ID;

function isEnabled() {
  return process.env.TRANSCRIPT_CLEANUP_ENABLED === "true" && !!MODEL_ID && !!REGION;
}

let bedrockClient;
function getBedrockClient() {
  if (!bedrockClient) {
    const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
    bedrockClient = new BedrockRuntimeClient({ region: REGION });
  }
  return bedrockClient;
}

// Must match public/app.js's own LOW_CONFIDENCE_THRESHOLD exactly -- that
// file decides which words the *person* sees flagged in the transcript
// view; this decides which words Bedrock is asked to reconsider. The two
// drifting apart would mean either asking (and paying) to reconsider
// words nobody sees flagged, or leaving a visibly-flagged word untouched
// by cleanup for no reason a user could tell.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

// Distinctive marker unlikely to ever appear in real transcribed speech
// -- used to point Bedrock at exactly which words it may reconsider,
// without having to send positions/indices back and forth. Anything
// outside the markers is instructed to be left untouched.
const MARK_OPEN = "⟦"; // ⟦
const MARK_CLOSE = "⟧"; // ⟧

// Same shape as renderTranscriptWordsHtml in public/app.js (punctuation
// attaches with no leading space; everything else is space-joined) --
// deliberately kept in sync with how the person actually reads the
// transcript, so the flagged spots Bedrock sees line up with the ones
// highlighted on screen.
function buildMarkedText(words) {
  let text = "";
  let needsSpace = false;
  let flaggedCount = 0;
  for (const w of words) {
    if (w.type === "punctuation") {
      text += w.content;
      continue;
    }
    if (needsSpace) text += " ";
    needsSpace = true;
    const flagged = typeof w.confidence === "number" && w.confidence < LOW_CONFIDENCE_THRESHOLD;
    if (flagged) {
      flaggedCount++;
      text += `${MARK_OPEN}${w.content}${MARK_CLOSE}`;
    } else {
      text += w.content;
    }
  }
  return { text, flaggedCount };
}

const SYSTEM_PROMPT = `You clean up a phone-call transcript of real, casual spoken conversation. Some words are wrapped like ${MARK_OPEN}this${MARK_CLOSE} -- these are the only words you may reconsider; the speech-to-text engine was least confident about exactly these ones. Everything else is unmarked and is already correct -- never change it.

For each marked word, decide whether the speech-to-text engine likely MISHEARD it -- transcribed a different, wrong word in place of what the speaker actually said (often a homophone or similar-sounding word). Only change a marked word when a different word is clearly what was actually said. Never change a word just because different wording would read more smoothly, sound more formal, or be more grammatically "correct" as written prose -- that is not a transcription error, and fixing it would change what the person actually said, not just how it was transcribed.

This is casual spoken conversation, not an essay. It will naturally include things that are NOT transcription errors and must be left exactly as transcribed: filler words ("uh", "um"), run-on or incomplete sentences, repeated words, and informal tag questions like "...correct?" or "...right?" tacked onto a statement to ask for confirmation. "You did fill out the form, correct?" means "isn't that right?" -- it is not asking whether the form was filled out *correctly*, and "correct" here is already the right word, not an error to fix. When in doubt, assume the person simply talks that way and leave the word unchanged.

Respond with ONLY a single JSON object, no other text, matching exactly this shape:
{
  "correctedText": "the full transcript with every marker removed, corrections applied only to genuine mishearings",
  "changes": [{"original": "want", "corrected": "went", "reason": "short reason, grounded in the surrounding context"}]
}
If nothing needed correcting, "changes" must be an empty array and "correctedText" must be the original wording with the markers simply removed. Never invent content the transcript doesn't support.`;

// Same bound and same reasoning as callSummary.js's MAX_TRANSCRIPT_CHARS.
const MAX_TRANSCRIPT_CHARS = 100_000;

// Throws on any failure -- the caller (routes/api.js's on-demand route)
// treats a thrown error as "mark this cleanup failed", same posture as
// callSummary.js's summarizeTranscript.
//
// Returns { changed: false } with no Bedrock call at all when nothing is
// flagged -- a transcript with no low-confidence words costs nothing to
// "clean up" and shouldn't pretend otherwise.
async function cleanTranscript(words) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error("no word-level transcript data available to clean up");
  }

  const { text: markedText, flaggedCount } = buildMarkedText(words);
  if (flaggedCount === 0) {
    return { bedrockCalled: false, changed: false, correctedText: null, changes: [], inputTokens: 0, outputTokens: 0 };
  }
  if (markedText.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error(`transcript too long to clean up completely (${markedText.length} chars) -- skipping rather than processing a partial transcript`);
  }

  const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Transcript:\n\n${markedText}` }],
  });

  const res = await getBedrockClient().send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body,
    })
  );

  const payload = JSON.parse(new TextDecoder().decode(res.body));
  const text = payload.content && payload.content[0] && payload.content[0].text;
  if (!text) throw new Error("Bedrock response had no text content");

  const usage = payload.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;

  let parsed;
  try {
    parsed = JSON.parse(stripJsonCodeFence(text));
  } catch (err) {
    throw new Error(`Bedrock did not return valid JSON: ${text.slice(0, 200)}`);
  }
  if (typeof parsed.correctedText !== "string") {
    throw new Error("Bedrock JSON was missing a usable correctedText field");
  }
  const changes = Array.isArray(parsed.changes)
    ? parsed.changes
        .filter((c) => c && typeof c.original === "string" && typeof c.corrected === "string")
        .map((c) => ({ original: c.original, corrected: c.corrected, reason: typeof c.reason === "string" ? c.reason : null }))
    : [];

  // Defensive: strip any marker the model failed to remove rather than
  // let one leak into a transcript someone actually reads -- the prompt
  // instructs it to always remove them, but nothing here should trust
  // that blindly for text a person is going to see.
  const correctedText = parsed.correctedText.split(MARK_OPEN).join("").split(MARK_CLOSE).join("");

  return {
    bedrockCalled: true,
    changed: changes.length > 0,
    correctedText,
    changes,
    inputTokens,
    outputTokens,
  };
}

module.exports = { isEnabled, cleanTranscript, LOW_CONFIDENCE_THRESHOLD };
