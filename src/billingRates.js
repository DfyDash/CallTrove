// Single source of truth for every per-unit rate the cost ledger (see
// schema.sql's cost_ledger comment) writes against -- both what AWS
// actually charges CallTrove and what clients are actually charged.
// Centralized here, rather than left as scattered literals (the AWS
// Transcribe rate used to live only in routes/operator.js), so every
// ledger-writing call site (src/transcriptionPoller.js,
// src/callSummaryPoller.js, src/storageCostJob.js) computes off the same
// numbers.
//
// The two CLIENT_* rates must match public/settings.html's Transcription
// tab exactly ($0.0195/min, $0.007/call) -- that display is deliberately
// left as static text, not wired to fetch these at runtime, since it was
// the subject of real back-and-forth about showing the exact figures
// with their leading zeros and no rounding; wiring it up risked
// reintroducing a formatting bug in a place that's already correct and
// already deployed. If either rate is ever renegotiated, update both
// this file and that page's text together.
//
// Every rate is env-overridable -- these are real prices that change
// (AWS revises its own pricing, or a client rate gets renegotiated), and
// nothing here should require a code deploy to correct.

// --- What AWS actually charges CallTrove ---

// AWS Transcribe standard batch pricing.
const AWS_TRANSCRIBE_PER_MINUTE = Number(process.env.TRANSCRIBE_RATE_PER_MINUTE || 0.006);

// Claude Haiku 4.5 on Amazon Bedrock (src/callSummary.js's MODEL_ID) --
// confirmed against AWS's published Bedrock pricing, not assumed to
// match Anthropic's own first-party API rate (Bedrock is a separate,
// partner-operated price list, even though it happens to be identical
// for this model).
const AWS_BEDROCK_HAIKU_INPUT_PER_MILLION_TOKENS = Number(process.env.BEDROCK_HAIKU_INPUT_RATE_PER_MILLION || 1.0);
const AWS_BEDROCK_HAIKU_OUTPUT_PER_MILLION_TOKENS = Number(process.env.BEDROCK_HAIKU_OUTPUT_RATE_PER_MILLION || 5.0);

// S3 Standard storage, first-50TB tier (src/storage/index.js's bucket
// uses the default storage class -- see src/storageCostJob.js).
const AWS_S3_STANDARD_PER_GB_MONTH = Number(process.env.S3_STORAGE_RATE_PER_GB_MONTH || 0.023);

// --- What clients are actually charged ---

const CLIENT_TRANSCRIPTION_PER_MINUTE = Number(process.env.CLIENT_TRANSCRIPTION_RATE_PER_MINUTE || 0.0195);
// Flat per call, not token-based -- unlike the AWS cost side, which is
// genuinely metered per token (see cost_ledger's own comment on why
// ai_summary's quantity/client_revenue use different bases).
const CLIENT_AI_SUMMARY_PER_CALL = Number(process.env.CLIENT_AI_SUMMARY_RATE_PER_CALL || 0.007);

// No client-facing storage rate has ever been agreed (public/
// settings.html's billing rates list only transcription and summary) --
// deliberately no CLIENT_STORAGE_* constant. Storage is tracked as a pure
// AWS cost in the ledger, never billed through.

module.exports = {
  AWS_TRANSCRIBE_PER_MINUTE,
  AWS_BEDROCK_HAIKU_INPUT_PER_MILLION_TOKENS,
  AWS_BEDROCK_HAIKU_OUTPUT_PER_MILLION_TOKENS,
  AWS_S3_STANDARD_PER_GB_MONTH,
  CLIENT_TRANSCRIPTION_PER_MINUTE,
  CLIENT_AI_SUMMARY_PER_CALL,
};
