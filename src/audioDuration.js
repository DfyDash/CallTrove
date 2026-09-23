// music-metadata ships ESM-only (no CommonJS "require" export) -- the rest
// of this codebase is CommonJS, so it's loaded via dynamic import() instead
// of a top-level require(), and cached after the first call rather than
// re-imported on every recording.
let mmPromise = null;
function loadMusicMetadata() {
  if (!mmPromise) mmPromise = import("music-metadata");
  return mmPromise;
}

// The one number that can't be wrong: measured straight from the actual
// recording bytes being stored/played, instead of trusting GHL's
// self-reported duration -- which src/poller.js's own comments already
// note isn't always settled yet when a call message first shows up.
// Returns null (never throws) on a malformed/unparseable file so callers
// can fall back to GHL's figure rather than lose the recording over it.
async function getRealDurationSeconds(buffer, contentType) {
  try {
    const mm = await loadMusicMetadata();
    const meta = await mm.parseBuffer(buffer, { mimeType: contentType });
    const seconds = meta.format.duration;
    return typeof seconds === "number" && isFinite(seconds) ? Math.round(seconds) : null;
  } catch (err) {
    console.error("[audioDuration] failed to measure recording duration, falling back to GHL's reported value:", err);
    return null;
  }
}

module.exports = { getRealDurationSeconds };
