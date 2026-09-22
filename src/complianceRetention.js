// Per-state insurance "books and records" retention periods, for computing
// how long a HIPAA-tier account's call recordings need to stay locked.
//
// *** PENDING LEGAL VERIFICATION -- do not treat these numbers as final. ***
// No state has a rule specific to call recordings -- every state governs
// them under its general producer/agency "books and records" or "market
// conduct" statute, and a recorded call becomes part of the transaction
// record once it involves a quote, application, disclosure, or
// recommendation. The figures below are what a primary-source read of the
// NAIC's own "State Laws on Records Maintenance" chart (Summer 2024,
// MC-90) actually says for *producer* records specifically -- not company,
// adjuster, surplus-lines, or reinsurance-broker records, which are
// separate categories often with different (usually longer) periods.
//
// Only states with an explicit, confirmed producer-records year are listed.
// Every other state -- including Texas, where three independent research
// passes produced three different statute citations and none could be
// verified against the primary source -- falls through to DEFAULT_YEARS
// until someone actually confirms the current statute text (an attorney,
// or a paid compliance service; this was not verified with either).
const STATE_RETENTION_YEARS = {
  AL: 3, // § 27-7-33
  AK: 5, // § 21.27.350
  AZ: 3, // § 20-290
  AR: 5, // § 23-64-220
  CA: 5, // 10 CCR § 2190.2
  FL: 5, // § 626.748
  GA: 5, // § 33-23-34
  HI: 5, // § 431:9A-123
  KY: 5, // § 304.9-390
  MI: 7, // § 500.4163 (suitability/recommendation records)
  MN: 6, // MN ADC 2795.1500 (complaint files)
  MT: 3, // § 33-17-1101
  NV: 3, // § 683A.351
  NH: 5, // § 400-B:3 (current policy term + 5)
  NJ: 5, // N.J.A.C. 11:1-37.12
  NM: 3, // § 59A-12-21
  NY: 6, // NYCRR 11 § 243.2 (policy records)
  ND: 10, // § 26.1-34.2-05 (annuity suitability records specifically)
  OR: 3, // § 744.068
  PA: 7, // Dept. Notice 2011-10 (general requirement)
  PR: 5, // 26 L.P.R.A. § 952f
  SC: 5, // § 38-43-250
  SD: 5, // § 58-30-91
  VA: 3, // § 38.2-1809
  VI: 5, // 22 V.I.C. § 781
  WA: 5, // § 48.17.470
  WY: 3, // § 26-9-228
};

// Applied whenever a state isn't in the confirmed table above (Colorado,
// Indiana, Kansas, Louisiana, Massachusetts, Missouri, Nebraska, North
// Carolina, Ohio, Tennessee, Texas, Utah, Vermont, West Virginia,
// Wisconsin, and any state/territory not listed) -- picked as a
// conservative middle of the 3-7 year range the confirmed states cluster
// around, not derived from any single state's actual statute.
const DEFAULT_YEARS = 6;

function getRetentionYears(stateCode) {
  if (!stateCode) return DEFAULT_YEARS;
  return STATE_RETENTION_YEARS[stateCode.toUpperCase()] ?? DEFAULT_YEARS;
}

// The date a HIPAA-tier recording's lock can lift -- retention is anchored
// to when the call happened, not to today or to account closure, so an
// account's oldest recordings age out before its newest ones.
function getRetentionUntilDate(occurredAt, stateCode) {
  const years = getRetentionYears(stateCode);
  const until = new Date(occurredAt);
  until.setFullYear(until.getFullYear() + years);
  return until;
}

module.exports = { STATE_RETENTION_YEARS, DEFAULT_YEARS, getRetentionYears, getRetentionUntilDate };
