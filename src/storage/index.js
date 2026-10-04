const fs = require("fs");
const path = require("path");
const billingRates = require("../billingRates");

const driver = process.env.STORAGE_DRIVER || "local";

// Which tier a caller gets if it doesn't say -- 'standard' is every
// existing call site's implicit tier today (the one bucket that existed
// before tiering did), so this keeps every pre-tiering caller working
// unchanged rather than requiring every one to be updated in lockstep.
const DEFAULT_TIER = "standard";

function bucketForTier(tier) {
  return billingRates.storageTier(tier || DEFAULT_TIER).bucket;
}

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

// tenantId is written as an S3 object tag (not folded into the key) so an
// independent per-tenant byte count can be read straight from AWS -- via
// S3 Inventory configured to include this tag -- as a cross-check against
// calls.size_bytes summed in our own DB, entirely outside the app's own
// tracking. Cost allocation tags only work at the bucket level (AWS has no
// per-object cost breakdown), so this tag is for that bytes-stored audit,
// not for a dollar figure out of Cost Explorer.
async function s3Save(key, buffer, tenantId, tier) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucketForTier(tier),
      Key: s3ObjectKey(key),
      Body: buffer,
      Tagging: tenantId ? `tenant_id=${encodeURIComponent(tenantId)}` : undefined,
    })
  );
  return key;
}

async function s3GetBuffer(key, tier) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucketForTier(tier), Key: s3ObjectKey(key) }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function s3Delete(key, tier) {
  const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucketForTier(tier), Key: s3ObjectKey(key) }));
}

async function s3GetPresignedUrl(key, downloadFilename, tier) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const command = new GetObjectCommand({
    Bucket: bucketForTier(tier),
    Key: s3ObjectKey(key),
    ResponseContentDisposition: downloadFilename ? `attachment; filename="${downloadFilename}"` : undefined,
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: 3600 });
}

// --- public interface ---
//
// Every function below takes the storage tier the recording was (or
// should be) saved under, so the s3 driver can resolve the right bucket
// (see billingRates.js's STORAGE_TIERS). Defaults to DEFAULT_TIER so
// every caller that predates tiering keeps working unchanged against the
// one bucket that already existed. A caller reading/deleting an existing
// recording must pass the tier actually stamped on that call row
// (calls.storage_tier) -- not the tenant's *current* tier, which can
// differ if the tenant has since moved tiers.

async function saveRecording(key, buffer, tenantId, tier = DEFAULT_TIER) {
  if (driver === "s3") return s3Save(key, buffer, tenantId, tier);
  return localSave(key, buffer);
}

// Returns either a redirect URL (s3) or a stream to pipe (local).
// Callers check which field is set. downloadFilename, if given, requests
// that the response be presented as an attachment with that filename.
async function getPlayback(key, downloadFilename, tier = DEFAULT_TIER) {
  if (driver === "s3") {
    return { redirectUrl: await s3GetPresignedUrl(key, downloadFilename, tier) };
  }
  const stream = localGetStream(key);
  return { stream };
}

// Raw bytes regardless of driver -- for on-demand transcription (AWS
// Transcribe needs to read the recording again after the fact, unlike
// playback/download, which can redirect to S3 or stream from disk without
// ever pulling the whole file into memory here).
async function getBuffer(key, tier = DEFAULT_TIER) {
  if (driver === "s3") return s3GetBuffer(key, tier);
  return localGetBuffer(key);
}

// For account purge (src/tenantPurge.js) -- deletes the underlying
// recording. Never throws on a missing file/object: purge already races
// nothing else that writes, so "already gone" is a success, not an error.
async function deleteRecording(key, tier = DEFAULT_TIER) {
  try {
    if (driver === "s3") return await s3Delete(key, tier);
    return localDelete(key);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") return;
    throw err;
  }
}

module.exports = { saveRecording, getPlayback, getBuffer, deleteRecording, driver };
