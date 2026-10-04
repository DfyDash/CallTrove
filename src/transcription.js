// Call transcription via AWS Transcribe.
//
// AWS Transcribe over a cheaper option (e.g. Deepgram, ~6x less per minute)
// is a deliberate tradeoff: AWS will sign a BAA covering the whole account
// self-serve (AWS Artifact) -- already needed for RDS/S3/EC2 once real PHI
// is in play -- where most third-party transcription vendors require a
// separate, sales-negotiated BAA with no guaranteed turnaround. Still
// meaningfully cheaper per minute than GHL's own call transcription fee.
//
// AWS Transcribe only accepts audio from S3 (no raw-bytes upload API), so
// this module manages its own transient S3 upload independent of
// STORAGE_DRIVER -- transcription works even when recordings are stored
// on local disk.
//
// The transient upload must land in the SAME tier's bucket as the
// recording itself (billingRates.js's STORAGE_TIERS), not always the
// legacy single bucket -- a HIPAA-tier call's audio must never pass
// through the standard-tier bucket, even transiently. startJob takes the
// tier explicitly; checkJob/cleanupInput never need it, since they parse
// the actual bucket straight out of the job's own stored Media.MediaFileUri
// rather than assuming a fixed bucket.
const billingRates = require("./billingRates");

const REGION = process.env.S3_REGION;
const LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || "en-US";
const INPUT_PREFIX = "transcribe-input";

function isEnabled() {
  return process.env.TRANSCRIPTION_ENABLED === "true" && !!billingRates.storageTier("standard").bucket && !!REGION;
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

function jobNameFor(callId) {
  return `calltrove-${callId}`;
}

function inputKeyFor(callId, extension) {
  return `${INPUT_PREFIX}/${callId}.${extension}`;
}

// Uploads the recording to a transient S3 key and starts an async
// Transcribe job against it. Returns nothing -- progress is checked later
// by jobName (deterministic from callId), not by anything returned here.
// tier defaults to 'standard' so any pre-tiering caller keeps working
// unchanged, same convention as src/storage/index.js.
async function startJob(callId, buffer, extension, tier = "standard") {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const { StartTranscriptionJobCommand } = require("@aws-sdk/client-transcribe");

  const bucket = billingRates.storageTier(tier).bucket;
  const key = inputKeyFor(callId, extension);
  await getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer }));

  await getTranscribeClient().send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobNameFor(callId),
      LanguageCode: LANGUAGE_CODE,
      MediaFormat: extension === "wav" ? "wav" : "mp3",
      Media: { MediaFileUri: `s3://${bucket}/${key}` },
    })
  );
}

// Checks one call's transcription job. On completion or failure, cleans up
// the transient input object and the Transcribe job record itself -- the
// transcript text is what's kept, in Postgres, not AWS's copy.
async function checkJob(callId) {
  const { GetTranscriptionJobCommand, DeleteTranscriptionJobCommand } = require("@aws-sdk/client-transcribe");
  const jobName = jobNameFor(callId);

  const { TranscriptionJob: job } = await getTranscribeClient().send(
    new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
  );

  if (job.TranscriptionJobStatus === "IN_PROGRESS" || job.TranscriptionJobStatus === "QUEUED") {
    return { status: "pending" };
  }

  await cleanupInput(job);
  await getTranscribeClient().send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })).catch(() => {});

  if (job.TranscriptionJobStatus === "FAILED") {
    return { status: "failed", reason: job.FailureReason };
  }

  const res = await fetch(job.Transcript.TranscriptFileUri);
  const data = await res.json();
  const text = data.results.transcripts.map((t) => t.transcript).join(" ");
  // Kept alongside the joined text so the UI can flag individual
  // low-confidence words (see db.markTranscriptionComplete) -- Transcribe
  // computes this per word regardless, this just stops throwing it away.
  const words = data.results.items.map((it) => ({
    type: it.type,
    content: it.alternatives[0].content,
    confidence: it.type === "pronunciation" ? Number(it.alternatives[0].confidence) : null,
  }));
  return { status: "completed", text, words };
}

async function cleanupInput(job) {
  const uri = job.Media && job.Media.MediaFileUri;
  // Parsed straight out of the job's own URI (s3://bucket/key) rather than
  // assumed to be one fixed bucket -- this job's input could be in either
  // tier's bucket depending on which tier startJob used for it.
  const match = uri && /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return;
  const [, bucket, key] = match;
  const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
}

module.exports = { isEnabled, startJob, checkJob };
