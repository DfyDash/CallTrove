const db = require("./db");
const callDigestNarrative = require("./callDigestNarrative");

// Checks every few minutes rather than running everyone on a fixed 12h
// clock -- each account now picks its own two times of day (+ timezone,
// see schema.sql's comment on ghl_accounts.digest_time_1/2/digest_timezone),
// so there's no single shared interval to sleep for anymore. 5 minutes is
// frequent enough that a configured time is never missed by more than a
// few minutes, without checking so often it's needless DB churn.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// How many minutes past a configured slot still counts as "due" -- wider
// than CHECK_INTERVAL_MS so a slow cycle, a brief outage, or ordinary
// setTimeout drift can never cause a slot to be skipped entirely.
const MATCH_WINDOW_MINUTES = 10;

// Guards against computing the same slot twice: if this account's last
// digest is more recent than this, skip it even if "due" matched again on
// a later 5-minute tick within the same window. Comfortably shorter than
// the gap between any two reasonable slot choices, comfortably longer
// than MATCH_WINDOW_MINUTES.
const RECENT_DIGEST_GUARD_MS = 90 * 60 * 1000;

function currentLocalHHMM(timezone, now) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(now);
  } catch (err) {
    // An invalid/unrecognized timezone string shouldn't silently stop
    // this account's digest from ever firing again -- fall back to UTC
    // rather than throwing.
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(now);
  }
}

function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Minutes-of-day arithmetic wraps past midnight (e.g. a 23:58 slot is
// still "due" at 00:03) rather than comparing HH:MM strings directly.
function isDue(slotHHMM, nowHHMM) {
  let diff = minutesOfDay(nowHHMM) - minutesOfDay(slotHHMM);
  if (diff < 0) diff += 24 * 60;
  return diff < MATCH_WINDOW_MINUTES;
}

async function checkOnce() {
  const accounts = await db.listGhlAccountsNeedingDigest();
  const now = new Date();

  for (const account of accounts) {
    const nowLocal = currentLocalHHMM(account.digestTimezone, now);
    const due = isDue(account.digestTime1, nowLocal) || isDue(account.digestTime2, nowLocal);
    if (!due) continue;

    try {
      const latest = await db.getLatestCallDigest(account.id);
      if (latest && now.getTime() - new Date(latest.computedAt).getTime() < RECENT_DIGEST_GUARD_MS) {
        continue; // already computed this slot
      }

      const stats = await db.computeCallDigestStats(account.id);
      let narrative = null;
      if (callDigestNarrative.isEnabled()) {
        try {
          narrative = await callDigestNarrative.generateNarrative(stats);
        } catch (err) {
          // The real numbers are still worth saving even if the one-line
          // synthesis on top fails -- see schema.sql's comment on
          // call_digests.narrative being nullable.
          console.error(`[callDigest] account ${account.id} (${account.name}): narrative generation failed:`, err);
        }
      }
      await db.saveCallDigest({ ghlAccountId: account.id, stats, narrative });
      console.log(`[callDigest] computed digest for account ${account.id} (${account.name}) at ${nowLocal} ${account.digestTimezone}`);
    } catch (err) {
      console.error(`[callDigest] account ${account.id} (${account.name}): failed to compute digest:`, err);
    }
  }
}

function start() {
  console.log(`[callDigest] starting, checking every ${CHECK_INTERVAL_MS / 60000}min for accounts due on their own schedule`);
  async function cycle() {
    try {
      await checkOnce();
    } catch (err) {
      console.error("[callDigest] check cycle failed:", err);
    }
    setTimeout(cycle, CHECK_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, checkOnce, isDue, currentLocalHHMM };
