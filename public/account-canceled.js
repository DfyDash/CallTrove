const messageEl = document.getElementById("cancel-message");
const purgeDateEl = document.getElementById("cancel-purge-date");
const restoreBtn = document.getElementById("restore-btn");
const restoreError = document.getElementById("restore-error");
const logoutCsrf = document.getElementById("logout-csrf");

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

async function load() {
  // /api/me and /api/tenant/status are both reachable even after lockout
  // (see REACHABLE_WHILE_CANCELED in src/auth.js) -- everything else in
  // the app is not, which is what actually enforces the lockout.
  const meRes = await fetch("/api/me");
  const me = await meRes.json();
  logoutCsrf.value = me.csrfToken || "";

  const statusRes = await fetch("/api/tenant/status");
  const tenant = await statusRes.json();

  if (tenant.status === "canceled") {
    messageEl.textContent = `This account ("${tenant.name}") has been canceled and its data has been permanently deleted.`;
    return;
  }

  if (tenant.status === "cancellation_pending") {
    // requireAuth only ever redirects here once purgeAt has actually
    // passed -- the app works completely normally for the whole grace
    // period. This branch still covers someone navigating here directly
    // (a bookmark, a stale tab) before that point, so it doesn't falsely
    // claim they're locked out when they aren't yet.
    const stillInGracePeriod = new Date(tenant.purgeAt) > new Date();

    if (tenant.isOwner) {
      messageEl.textContent = stillInGracePeriod
        ? `You canceled this account ("${tenant.name}"). Everything still works normally until the grace period ends -- you can undo this any time before then.`
        : `This account ("${tenant.name}") is now locked -- its grace period ended on ${formatDate(tenant.purgeAt)}. Its data hasn't been deleted yet; you can still restore access.`;
      if (stillInGracePeriod) {
        purgeDateEl.textContent = `Locks out on ${formatDate(tenant.purgeAt)}.`;
        purgeDateEl.hidden = false;
      }
      restoreBtn.hidden = false;
    } else {
      messageEl.textContent = stillInGracePeriod
        ? `This account ("${tenant.name}") has been scheduled for cancellation by its owner. Everything still works normally until then.`
        : `This account ("${tenant.name}") has been canceled by its owner and is locked. Contact your account owner if this wasn't expected.`;
      purgeDateEl.textContent = stillInGracePeriod
        ? `Locks out on ${formatDate(tenant.purgeAt)}.`
        : `Its grace period ended on ${formatDate(tenant.purgeAt)}.`;
      purgeDateEl.hidden = false;
    }
    return;
  }

  // Status flipped back to active (someone else already restored it, or
  // this loaded stale) -- send them back into the real app.
  location.href = "/";
}

restoreBtn.addEventListener("click", async () => {
  restoreBtn.disabled = true;
  restoreError.hidden = true;
  const res = await fetch("/api/admin/tenant/restore", {
    method: "POST",
    headers: { "X-CSRF-Token": logoutCsrf.value },
  });
  if (res.ok) {
    location.href = "/";
    return;
  }
  const body = await res.json().catch(() => ({}));
  restoreError.textContent = body.error || "Could not restore the account.";
  restoreError.hidden = false;
  restoreBtn.disabled = false;
});

load();
