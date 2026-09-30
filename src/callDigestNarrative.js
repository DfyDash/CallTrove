// One-line AI synthesis for the metadata-only call digest -- see
// src/callDigestJob.js. Same Bedrock-over-direct-Anthropic reasoning as
// src/callSummary.js (covered under the account's existing AWS BAA), and
// reuses its exact model/region env vars: this is the same underlying
// Bedrock setup, just a different prompt, not a separately-billed feature
// gated behind CALL_SUMMARY_ENABLED -- narrating a handful of aggregate
// numbers twice a day per account is a different, much smaller cost line
// than per-call transcript summarization.

const REGION = process.env.BEDROCK_REGION || process.env.S3_REGION;
const MODEL_ID = process.env.BEDROCK_MODEL_ID;

function isEnabled() {
  return !!MODEL_ID && !!REGION;
}

let bedrockClient;
function getBedrockClient() {
  if (!bedrockClient) {
    const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
    bedrockClient = new BedrockRuntimeClient({ region: REGION });
  }
  return bedrockClient;
}

const SYSTEM_PROMPT = `You write a short narrative summary for a call-center analytics digest, in the style of a sharp ops manager's morning briefing. Given a JSON object of aggregate call statistics (no call content -- this account doesn't have transcription on), write 2-4 sentences that:
- Lead with the headline number (total calls) and how it compares to the prior period.
- Call out the single most useful fact a manager would want to know first (a volume spike, a missed-call problem, an unreturned-call backlog, or a genuinely good result worth noting).
- Mention which reps or hours carried the volume, if that's informative.
- End on whatever is most actionable right now (e.g. the oldest unreturned call), if there is one.
Respond with ONLY the narrative text, no preamble, no markdown, no JSON. Base every claim strictly on the numbers given -- never invent a reason, cause, or detail the data doesn't support.`;

async function generateNarrative(stats) {
  const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(stats) }],
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
  return text.trim();
}

module.exports = { isEnabled, generateNarrative };
