const fs = require("fs");
const path = require("path");

const driver = process.env.STORAGE_DRIVER || "local";

// --- local disk driver (default, zero AWS setup needed for the prototype) ---

const localDir = path.resolve(process.env.STORAGE_LOCAL_DIR || "./data/recordings");

function localSave(key, buffer) {
  const filePath = path.join(localDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return key;
}

function localGetStream(key) {
  const filePath = path.join(localDir, key);
  if (!fs.existsSync(filePath)) return null;
  return fs.createReadStream(filePath);
}

function localGetBuffer(key) {
  const filePath = path.join(localDir, key);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function localDelete(key) {
  const filePath = path.join(localDir, key);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// --- S3 driver (for the eventual AWS deployment) ---

let s3Client;
function getS3Client() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({ region: process.env.S3_REGION });
  }
  return s3Client;
}

// Recordings live under this prefix rather than at the bucket root, so the
// IAM policy granting the app access can be scoped to recordings/* instead
// of the whole bucket (which also holds unrelated things like deploy
// tarballs). The stored `key` itself (used in calls.storage_key) stays
// prefix-free -- it's a driver-agnostic identifier, not an S3 path.
const s3ObjectKey = (key) => `recordings/${key}`;

async function s3Save(key, buffer) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3ObjectKey(key),
      Body: buffer,
    })
  );
  return key;
}

async function s3GetBuffer(key) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3ObjectKey(key) }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function s3Delete(key) {
  const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
  await getS3Client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3ObjectKey(key) }));
}

async function s3GetPresignedUrl(key, downloadFilename) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: s3ObjectKey(key),
    ResponseContentDisposition: downloadFilename ? `attachment; filename="${downloadFilename}"` : undefined,
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: 3600 });
}

// --- public interface ---

async function saveRecording(key, buffer) {
  if (driver === "s3") return s3Save(key, buffer);
  return localSave(key, buffer);
}

// Returns either a redirect URL (s3) or a stream to pipe (local).
// Callers check which field is set. downloadFilename, if given, requests
// that the response be presented as an attachment with that filename.
async function getPlayback(key, downloadFilename) {
  if (driver === "s3") {
    return { redirectUrl: await s3GetPresignedUrl(key, downloadFilename) };
  }
  const stream = localGetStream(key);
  return { stream };
}

// Raw bytes regardless of driver -- for on-demand transcription (AWS
// Transcribe needs to read the recording again after the fact, unlike
// playback/download, which can redirect to S3 or stream from disk without
// ever pulling the whole file into memory here).
async function getBuffer(key) {
  if (driver === "s3") return s3GetBuffer(key);
  return localGetBuffer(key);
}

// For account purge (src/tenantPurge.js) -- deletes the underlying
// recording. Never throws on a missing file/object: purge already races
// nothing else that writes, so "already gone" is a success, not an error.
async function deleteRecording(key) {
  try {
    if (driver === "s3") return await s3Delete(key);
    return localDelete(key);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") return;
    throw err;
  }
}

module.exports = { saveRecording, getPlayback, getBuffer, deleteRecording, driver };
