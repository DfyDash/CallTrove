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

const { stripJsonCodeFence } = require("./bedrockJson");

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

// The sentence-count instruction alone wasn't enough -- in practice the
// model would narrate the call turn-by-turn instead (one sentence per
// back-and-forth, including pure pleasantries like "asks how they're
// doing"), which reads as a wall of text once posted to GHL as a note.
// Spelling out what NOT to do, with a concrete bad/good pair, is what
// actually got it to stop -- an abstract length limit on its own doesn't
// reliably stop this particular failure mode.
const SYSTEM_PROMPT = `You summarize business phone call transcripts for a CRM note that a busy salesperson will skim in a few seconds. Respond with ONLY a single JSON object, no other text, matching exactly this shape:
{
  "summary": "ONE short paragraph, 5-6 sentences, no line breaks and no bullet/numbered list. Cover why the call happened, what was actually discussed, how it resolved, and any follow-up needed. Do NOT narrate the call turn-by-turn (one sentence per thing each person said) and skip greetings/small talk unless that was the entire call.",
  "sentiment": "positive" | "neutral" | "negative",
  "outcome": "short label for how the call resolved, e.g. \\"Appointment scheduled\\", \\"Question answered\\", \\"No resolution\\"",
  "topics": ["short topic phrase", "..."],
  "followUpNeeded": true | false,
  "followUpDetails": "what needs following up on, or null if followUpNeeded is false"
}
Base everything strictly on the transcript text given. Do not invent details it doesn't support.

Bad summary (turn-by-turn narration -- do not do this): "Victor identifies himself. Victor asks how the caller is doing. The caller says they are doing well. The caller asks if this is about Medicare. The caller states they are already covered. No further actions are indicated."
Good summary for that same simple call (short calls don't need to be padded out to 6 sentences): "Victor called about Medicare coverage, but the contact said they're already covered and no follow-up was needed."
Good summary for a more involved call, showing the 5-6 sentence target actually in use: "Victor from DFY called to follow up on a furnace repair quote. The contact was interested but wanted to check with their spouse before committing to the $450 estimate. Victor offered to hold the Tuesday 10am appointment slot for 48 hours. The contact agreed to call back by Thursday to confirm, and no payment or scheduling was finalized on this call. Follow-up is needed to confirm the appointment by Thursday."`;

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

  // Anthropic's Messages API shape (which this is, even over Bedrock)
  // always includes usage -- the cost-ledger basis for this call
  // (src/callSummaryPoller.js, src/billingRates.js's per-token Bedrock
  // rates). Defaulting to 0 rather than throwing if it's ever missing:
  // a pricing gap in the ledger is a lesser failure than losing a
  // summary that otherwise parsed fine.
  const usage = payload.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;

  let parsed;
  try {
    parsed = JSON.parse(stripJsonCodeFence(text));
  } catch (err) {
    throw new Error(`Bedrock did not return valid JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.summary || typeof parsed.summary !== "string") {
    throw new Error("Bedrock JSON was missing a usable summary field");
  }
  // Belt-and-suspenders on top of the prompt's own formatting instructions:
  // a response that still slips in line breaks (one sentence per line, the
  // original symptom this was written to catch) gets collapsed to a single
  // paragraph before it's ever saved or posted as a GHL note, rather than
  // relying solely on the model to format it correctly every time.
  const summary = parsed.summary.replace(/\s*\n+\s*/g, " ").trim();

  return {
    summary,
    analysis: {
      sentiment: parsed.sentiment || null,
      outcome: parsed.outcome || null,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      followUpNeeded: Boolean(parsed.followUpNeeded),
      followUpDetails: parsed.followUpDetails || null,
    },
    inputTokens,
    outputTokens,
  };
}

module.exports = { isEnabled, summarizeTranscript };
