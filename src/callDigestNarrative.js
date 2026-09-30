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

const SYSTEM_PROMPT = `You write a short, plain-English summary for a small business owner who is not a data or call-center person. Given a JSON object of aggregate call statistics (no call content -- this account doesn't have transcription on), write 2-4 short, warm, conversational sentences that:
- Lead with the headline number (total calls) and how today compares to yesterday, in everyday words.
- Call out the one thing that actually matters to a business owner: are calls being missed, is anyone waiting on a callback, or is everything running smoothly.
- Mention which team member handled the most calls, if that's informative.
- If there's an unreturned call, say plainly that someone hasn't been called back yet and roughly how long they've been waiting -- that's the single most actionable thing here.
Write the way you'd explain it to a friend who owns the business, not the way an analyst would write a report. Never use business-jargon or call-center jargon (no "queue", "escalate", "aging", "leverage", "actionable", "metrics", "KPI", or similar) and never speculate about causes the data doesn't show (e.g. don't guess whether a slow day means a "technical issue" -- just state the numbers).
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
