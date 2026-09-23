const mm = require("music-metadata");

// The one number that can't be wrong: measured straight from the actual
// recording bytes being stored/played, instead of trusting GHL's
// self-reported duration -- which src/poller.js's own comments already
// note isn't always settled yet when a call message first shows up.
// Returns null (never throws) on a malformed/unparseable file so callers
// can fall back to GHL's figure rather than lose the recording over it.
async function getRealDurationSeconds(buffer, contentType) {
  try {
    const meta = await mm.parseBuffer(buffer, { mimeType: contentType });
    const seconds = meta.format.duration;
    return typeof seconds === "number" && isFinite(seconds) ? Math.round(seconds) : null;
  } catch (err) {
    console.error("[audioDuration] failed to measure recording duration, falling back to GHL's reported value:", err);
    return null;
  }
}

module.exports = { getRealDurationSeconds };
