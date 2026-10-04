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

// Deletes every stored version (and any delete marker) of one object, not
// just whatever DeleteObject would otherwise hide behind a new marker.
// ListObjectVersions is prefix-based, not exact-key, so results are
// filtered to the exact key -- a prefix match could otherwise also catch
// an unrelated key that merely starts with the same string. Works
// identically whether or not the bucket actually has Versioning enabled:
// an unversioned bucket's objects list with a single version id of
// "null", and deleting that version is a normal, permanent delete -- so
// this is safe to deploy before, during, or after Versioning is turned on.
//
// Needs s3:ListBucketVersions (the IAM action gating ListObjectVersions --
// a distinct permission from s3:ListBucket, which only covers the plain
// ListObjectsV2 API) on top of the object-level actions (Get/Put/Delete/
// PutObjectTagging) this app's IAM policy already granted -- a genuinely
// new permission, not covered by the existing s3:DeleteObject grant.
// Scope it to the recordings/ prefix the same way the object-level
// actions are (an s3:prefix condition), not the whole bucket.
async function s3PermanentlyDelete(key, tier) {
  const { ListObjectVersionsCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
  const bucket = bucketForTier(tier);
  const fullKey = s3ObjectKey(key);

  // Versions and DeleteMarkers come back as two separately-sorted arrays,
  // not one merged-by-key sequence -- an early exit the moment a
  // non-matching key is seen in one array would risk skipping real
  // matches still waiting in the other. Simplest correct approach: walk
  // every page fully and filter, rather than trying to be clever about
  // stopping early. A single recording's version history is realistically
  // one or two entries and never spans more than a page, so there's no
  // real cost to this being unconditionally thorough.
  const versions = [];
  let keyMarker, versionIdMarker;
  for (;;) {
    const res = await getS3Client().send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: fullKey, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker })
    );
    for (const v of [...(res.Versions || []), ...(res.DeleteMarkers || [])]) {
      if (v.Key === fullKey) versions.push({ Key: v.Key, VersionId: v.VersionId });
    }
    if (!res.IsTruncated) break;
    keyMarker = res.NextKeyMarker;
    versionIdMarker = res.NextVersionIdMarker;
  }
  if (versions.length === 0) return; // already gone -- nothing to delete

  // Chunked to S3's own 1000-objects-per-request cap on DeleteObjects --
  // a single recording never has more than a couple of versions today,
  // but nothing should silently fail outright if that ever changes.
  // Quiet:true still returns an Errors array for any key DeleteObjects
  // couldn't actually remove (e.g. an Object Lock/legal hold, a
  // permissions edge case) even though the call itself doesn't throw --
  // checked and thrown here so tenantPurge.js's own try/catch actually
  // sees it, instead of this silently reporting success while bytes (and
  // their billing) are left behind.
  for (let i = 0; i < versions.length; i += 1000) {
    const batch = versions.slice(i, i + 1000);
    const res = await getS3Client().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
    if (res.Errors && res.Errors.length > 0) {
      const detail = res.Errors.map((e) => `${e.Key} (${e.VersionId}): ${e.Code} ${e.Message}`).join("; ");
      throw new Error(`Failed to permanently delete ${res.Errors.length} version(s) of ${fullKey}: ${detail}`);
    }
  }
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

// For account purge (src/tenantPurge.js) -- the one deliberate, human-
// confirmed deletion path in this app (typed "DELETE ACCOUNT" phrase,
// only reachable once a tenant's own cancellation grace period has
// passed -- see routes/operator.js's purge route). Permanently removes
// the recording, including on a versioned bucket: a plain DeleteObject
// there would only hide the object behind a delete marker (recoverable --
// the protection every other path gets), which is the wrong behavior
// specifically here, where the point is that the data is really gone and
// billing actually stops. Deletes every version and delete marker for the
// key, not just the current one. Never throws on an already-missing
// recording: purge already races nothing else that writes, so "already
// gone" is success, not an error.
async function permanentlyDeleteRecording(key, tier = DEFAULT_TIER) {
  if (driver === "s3") return s3PermanentlyDelete(key, tier);
  return localDelete(key);
}

module.exports = { saveRecording, getPlayback, getBuffer, permanentlyDeleteRecording, driver };
