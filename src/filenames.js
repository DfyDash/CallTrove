// Shared by every place that turns a contact's name/phone into a
// filesystem- and ZIP-safe path component (src/routes/api.js's single
// recording download, src/routes/admin.js's bulk export) -- one
// definition so the two can't drift out of sync with each other.
function sanitizeForFilename(s) {
  return (s || "").replace(/[^a-zA-Z0-9]+/g, "_");
}

module.exports = { sanitizeForFilename };
