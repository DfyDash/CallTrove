// Call summary + structured analytics via Claude on Amazon Bedrock.
//
// Bedrock over the direct Anthropic API is a deliberate choice, same
// reasoning as src/transcription.js's AWS-over-third-party tradeoff:
// Bedrock is covered under the account's existing AWS BAA (self-serve via
// AWS Artifact), so a call transcript that may contain PHI never leaves
// AWS's compliance boundary. The direct Anthropic API would need its own,
// separately negotiated BAA.
//
// BEDROCK_MODEL_ID must be the exact inference profile ID copied from the
// model's page in the Bedrock console (Model catalog -> the model ->
// "Cross-region inference" section) -- NOT a bare foundation-model ID.
// Claude Haiku 4.5 (and most current Claude models on Bedrock) are only
// reachable through cross-region inference, not an in-region endpoint, so
// there is no plausible default to guess here; this deliberately has none.

const REGION = process.env.BEDROCK_REGION || process.env.S3_REGION;
const MODEL_ID = process.env.BEDROCK_MODEL_ID;

function isEnabled() {
  return process.env.CALL_SUMMARY_ENABLED === "true" && !!MODEL_ID && !!REGION;
}

let bedrockClient;
function getBedrockClient() {
  if (!bedrockClient) {
    const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
    bedrockClient = new BedrockRuntimeClient({ region: REGION });
  }
  return bedrockClient;
}

const SYSTEM_PROMPT = `You summarize business phone call transcripts. Respond with ONLY a single JSON object, no other text, matching exactly this shape:
{
  "summary": "2-3 sentence plain-English summary of the call, suitable to post as a CRM note",
  "sentiment": "positive" | "neutral" | "negative",
  "outcome": "short label for how the call resolved, e.g. \\"Appointment scheduled\\", \\"Question answered\\", \\"No resolution\\"",
  "topics": ["short topic phrase", "..."],
  "followUpNeeded": true | false,
  "followUpDetails": "what needs following up on, or null if followUpNeeded is false"
}
Base everything strictly on the transcript text given. Do not invent details it doesn't support.`;

// Bounds the cost of any single pathologically long call -- but a
// *truncated* summary would be actively misleading (it could miss the
// call's actual resolution, which often happens near the end), worse than
// no summary at all. So a transcript over this length just isn't
// summarized, rather than silently summarizing part of it. ~100k
// characters is already far beyond any realistic phone call transcript
// (multiple hours of speech), so this never affects normal usage.
const MAX_TRANSCRIPT_CHARS = 100_000;

// Throws on any failure (network, malformed JSON, missing fields, or a
// transcript too long to summarize completely) rather than returning a
// partial/guessed result -- src/callSummaryPoller.js treats a thrown error
// as "mark this call's summary failed, don't retry past the attempts cap",
// same posture as src/transcriptionPoller.js already has for Transcribe
// job failures.
async function summarizeTranscript(transcriptText) {
  if (transcriptText.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error(
      `transcript too long to summarize completely (${transcriptText.length} chars) -- skipping rather than summarizing a partial transcript`
    );
  }

  const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Transcript:\n\n${transcriptText}` }],
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

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Bedrock did not return valid JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.summary || typeof parsed.summary !== "string") {
    throw new Error("Bedrock JSON was missing a usable summary field");
  }

  return {
    summary: parsed.summary,
    analysis: {
      sentiment: parsed.sentiment || null,
      outcome: parsed.outcome || null,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      followUpNeeded: Boolean(parsed.followUpNeeded),
      followUpDetails: parsed.followUpDetails || null,
    },
  };
}

module.exports = { isEnabled, summarizeTranscript };
