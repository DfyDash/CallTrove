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

// Storage safety net against a disproportionately high-volume account
// (a call-center-scale client would otherwise absorb the flat monthly
// fee's entire margin in storage alone) -- NOT meant to charge normal
// accounts anything: even the smaller (standard) tier's 100GB comfortably
// covers a typical single-location account for years (CallTrove's own
// real account ran about 22GB/year at its actual call volume), so this is
// a ceiling for outliers, not a quota anyone normal should ever see.
// $0.08/GB-month past that is roughly 3.5x AWS's own $0.023/GB-month
// cost, and about 6.6x cheaper than GHL's own equivalent call-recording
// storage rate (their $0.0005/minute converts to roughly $0.53/GB-month)
// -- confirmed against GHL's official LC Phone Pricing & Billing Guide,
// not guessed.
//
// Two tiers, each tenant assigned to exactly one (tenants.storage_tier):
// 'standard' is the default; 'hipaa' trades a higher price for more free
// storage and a signed BAA. Both tiers' buckets carry identical
// encryption/access/logging config -- this is a pricing/paperwork split,
// not a "more secure vs. less secure" one. Each tier writes to its own S3
// bucket (src/storage/index.js resolves which one per call), so the two
// pools of recordings never mix even though the protections are the
// same.
const STORAGE_TIERS = {
  standard: {
    freeGB: Number(process.env.CLIENT_STORAGE_FREE_GB_STANDARD || process.env.CLIENT_STORAGE_FREE_GB || 100),
    overagePerGbMonth: Number(
      process.env.CLIENT_STORAGE_OVERAGE_RATE_PER_GB_MONTH_STANDARD || process.env.CLIENT_STORAGE_OVERAGE_RATE_PER_GB_MONTH || 0.08
    ),
    // Falls back to the legacy single-bucket env var so an existing
    // deployment (one bucket, every tenant 'standard' by default) keeps
    // working unchanged until S3_BUCKET_HIPAA is actually set up.
    bucket: process.env.S3_BUCKET_STANDARD || process.env.S3_BUCKET,
  },
  hipaa: {
    freeGB: Number(process.env.CLIENT_STORAGE_FREE_GB_HIPAA || 150),
    overagePerGbMonth: Number(
      process.env.CLIENT_STORAGE_OVERAGE_RATE_PER_GB_MONTH_HIPAA || process.env.CLIENT_STORAGE_OVERAGE_RATE_PER_GB_MONTH || 0.08
    ),
    bucket: process.env.S3_BUCKET_HIPAA,
  },
};

// Looks up a tier's config, falling back to 'standard' for an unknown or
// missing tier (e.g. a tenant row written before this column existed, or
// a bad value that somehow got in despite the CHECK constraint) rather
// than throwing -- storage cost/display code should degrade, not crash.
// hasOwnProperty (not a plain STORAGE_TIERS[tier] lookup) matters here:
// tier can be arbitrary caller/request input, and a bare [] lookup also
// matches inherited Object.prototype names ("constructor", "toString",
// "hasOwnProperty" itself, ...) -- that would silently return a function
// instead of falling back to 'standard', not throw, so it's easy to miss.
function storageTier(tier) {
  if (Object.prototype.hasOwnProperty.call(STORAGE_TIERS, tier)) return STORAGE_TIERS[tier];
  return STORAGE_TIERS.standard;
}

module.exports = {
  AWS_TRANSCRIBE_PER_MINUTE,
  AWS_BEDROCK_HAIKU_INPUT_PER_MILLION_TOKENS,
  AWS_BEDROCK_HAIKU_OUTPUT_PER_MILLION_TOKENS,
  AWS_S3_STANDARD_PER_GB_MONTH,
  CLIENT_TRANSCRIPTION_PER_MINUTE,
  CLIENT_AI_SUMMARY_PER_CALL,
  STORAGE_TIERS,
  storageTier,
};
