// Shared by every place that asks a Bedrock/Claude model for a JSON-only
// response (src/callSummary.js, src/transcriptCleanup.js) -- despite an
// explicit "respond with ONLY a JSON object, no other text" instruction,
// the model can still wrap its JSON in a markdown code fence anyway
// (```json ... ```). Confirmed for real: the very first production test
// of transcriptCleanup.js hit exactly this, which also means
// callSummary.js's identical unguarded JSON.parse(text) has carried the
// same latent bug in production the whole time, just not yet hit by a
// response shaped that way. One shared place to strip it, so the fix
// can't drift out of sync between call sites the way the two raw
// JSON.parse(text) calls already had.
function stripJsonCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

module.exports = { stripJsonCodeFence };
