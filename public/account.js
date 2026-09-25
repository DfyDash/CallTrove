const sessionBar = document.getElementById("session-bar");
const successMessage = document.getElementById("success-message");
const errorMessage = document.getElementById("error-message");

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const ERROR_MESSAGES = {
  mismatch: "New password and confirmation don't match.",
  tooshort: "New password must be at least 8 characters.",
  wrongcurrent: "Current password is incorrect.",
  csrf: "Your session expired -- please try again.",
};

let csrfToken = "";

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  csrfToken = me.csrfToken || "";
  document.getElementById("csrf-token-input").value = csrfToken;
  const adminLink = me.role === "admin" ? ` · <a href="/settings.html">Settings</a>` : "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})${adminLink}</span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;
  await refreshMfaStatus();
}

const params = new URLSearchParams(location.search);
if (params.get("success")) successMessage.hidden = false;
const error = params.get("error");
if (error) {
  errorMessage.textContent = ERROR_MESSAGES[error] || "Could not change password.";
  errorMessage.hidden = false;
}

loadSession();

// --- Two-factor authentication ---

let pendingPasswordAction = null; // "disable" | "regenerate"

const mfaStatus = document.getElementById("mfa-status");
const mfaOffPanel = document.getElementById("mfa-off-panel");
const mfaSetupPanel = document.getElementById("mfa-setup-panel");
const mfaRecoveryCodesPanel = document.getElementById("mfa-recovery-codes-panel");
const mfaOnPanel = document.getElementById("mfa-on-panel");
const mfaQr = document.getElementById("mfa-qr");
const mfaManualKey = document.getElementById("mfa-manual-key");
const mfaConfirmInput = document.getElementById("mfa-confirm-input");
const mfaSetupError = document.getElementById("mfa-setup-error");
const mfaRecoveryCodesList = document.getElementById("mfa-recovery-codes-list");
const mfaRecoveryRemaining = document.getElementById("mfa-recovery-remaining");
const mfaPasswordConfirm = document.getElementById("mfa-password-confirm");
const mfaPasswordConfirmCopy = document.getElementById("mfa-password-confirm-copy");
const mfaPasswordInput = document.getElementById("mfa-password-input");
const mfaPasswordError = document.getElementById("mfa-password-error");

function hidePanels() {
  mfaOffPanel.hidden = true;
  mfaSetupPanel.hidden = true;
  mfaRecoveryCodesPanel.hidden = true;
  mfaOnPanel.hidden = true;
  mfaPasswordConfirm.hidden = true;
}

async function refreshMfaStatus() {
  const res = await fetch("/api/account/mfa");
  const data = await res.json();
  hidePanels();
  if (data.enabled) {
    mfaStatus.textContent = "Two-factor authentication is on.";
    mfaRecoveryRemaining.textContent = `${data.recoveryCodesRemaining} unused recovery code${data.recoveryCodesRemaining === 1 ? "" : "s"} remaining.`;
    mfaOnPanel.hidden = false;
  } else {
    mfaStatus.textContent = "Two-factor authentication is off.";
    mfaOffPanel.hidden = false;
  }
  refreshEmailOtpStatus(data);
}

document.getElementById("mfa-start-btn").addEventListener("click", async () => {
  const res = await fetch("/api/account/mfa/setup", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
  if (!res.ok) return alert("Could not start setup.");
  const { manualEntryKey } = await res.json();
  hidePanels();
  mfaStatus.textContent = "Scan the code below to finish setting up two-factor authentication.";
  mfaQr.src = `/api/account/mfa/qr?t=${Date.now()}`;
  mfaManualKey.textContent = manualEntryKey;
  mfaConfirmInput.value = "";
  mfaSetupError.hidden = true;
  mfaSetupPanel.hidden = false;
  mfaConfirmInput.focus();
});

document.getElementById("mfa-setup-cancel-btn").addEventListener("click", refreshMfaStatus);

document.getElementById("mfa-confirm-btn").addEventListener("click", async () => {
  const res = await fetch("/api/account/mfa/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ code: mfaConfirmInput.value.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    mfaSetupError.textContent = data.error || "Could not confirm that code.";
    mfaSetupError.hidden = false;
    return;
  }
  showRecoveryCodes(data.recoveryCodes);
});

function showRecoveryCodes(codes) {
  hidePanels();
  mfaStatus.textContent = "Two-factor authentication is on.";
  mfaRecoveryCodesList.textContent = codes.join("\n");
  mfaRecoveryCodesPanel.hidden = false;
  mfaRecoveryCodesPanel.dataset.codes = codes.join("\n");
}

document.getElementById("mfa-recovery-codes-download-btn").addEventListener("click", () => {
  const blob = new Blob([mfaRecoveryCodesPanel.dataset.codes + "\n"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "calltrove-recovery-codes.txt";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("mfa-recovery-codes-done-btn").addEventListener("click", refreshMfaStatus);

function askForPassword(action, copy) {
  pendingPasswordAction = action;
  hidePanels();
  mfaPasswordConfirmCopy.textContent = copy;
  mfaPasswordInput.value = "";
  mfaPasswordError.hidden = true;
  mfaPasswordConfirm.hidden = false;
  mfaPasswordInput.focus();
}

document.getElementById("mfa-disable-btn").addEventListener("click", () => {
  askForPassword("disable", "Disabling two-factor authentication removes the extra code requirement at login -- your password alone will be enough again.");
});

document.getElementById("mfa-regenerate-btn").addEventListener("click", () => {
  askForPassword("regenerate", "Regenerating replaces every existing recovery code -- old ones stop working immediately.");
});

document.getElementById("mfa-password-cancel-btn").addEventListener("click", () => {
  pendingPasswordAction = null;
  refreshMfaStatus();
});

document.getElementById("mfa-password-confirm-btn").addEventListener("click", async () => {
  const endpoint = pendingPasswordAction === "disable" ? "/api/account/mfa/disable" : "/api/account/mfa/recovery-codes/regenerate";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ password: mfaPasswordInput.value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    mfaPasswordError.textContent = data.error || "Could not confirm your password.";
    mfaPasswordError.hidden = false;
    return;
  }
  if (pendingPasswordAction === "regenerate") {
    showRecoveryCodes(data.recoveryCodes);
  } else {
    refreshMfaStatus();
  }
  pendingPasswordAction = null;
});

// --- Email sign-in codes (mutually exclusive with the authenticator app above) ---

const emailOtpStatus = document.getElementById("email-otp-status");
const emailOtpUnavailablePanel = document.getElementById("email-otp-unavailable-panel");
const emailOtpOffPanel = document.getElementById("email-otp-off-panel");
const emailOtpConfirmPanel = document.getElementById("email-otp-confirm-panel");
const emailOtpOnPanel = document.getElementById("email-otp-on-panel");
const emailOtpAddressInput = document.getElementById("email-otp-address-input");
const emailOtpConfirmCopy = document.getElementById("email-otp-confirm-copy");
const emailOtpConfirmInput = document.getElementById("email-otp-confirm-input");
const emailOtpSetupError = document.getElementById("email-otp-setup-error");
const emailOtpAddressDisplay = document.getElementById("email-otp-address-display");
const emailOtpPasswordConfirm = document.getElementById("email-otp-password-confirm");
const emailOtpPasswordInput = document.getElementById("email-otp-password-input");
const emailOtpPasswordError = document.getElementById("email-otp-password-error");

let pendingEmailAddress = null;

function hideEmailOtpPanels() {
  emailOtpUnavailablePanel.hidden = true;
  emailOtpOffPanel.hidden = true;
  emailOtpConfirmPanel.hidden = true;
  emailOtpOnPanel.hidden = true;
  emailOtpPasswordConfirm.hidden = true;
}

// Driven by the same GET /api/account/mfa response refreshMfaStatus already
// fetched, so the authenticator-app status and this section never
// disagree with each other.
function refreshEmailOtpStatus(data) {
  hideEmailOtpPanels();
  if (data.enabled) {
    // TOTP is the account's active method -- mutually exclusive, see
    // db/schema.sql's comment on email_otp_enabled.
    emailOtpStatus.textContent = "Email sign-in codes are off.";
    emailOtpUnavailablePanel.hidden = false;
    return;
  }
  if (data.email.enabled) {
    emailOtpStatus.textContent = "Email sign-in codes are on.";
    emailOtpAddressDisplay.textContent = `Codes are sent to ${data.email.address}.`;
    emailOtpOnPanel.hidden = false;
  } else if (data.email.address && !data.email.verified) {
    pendingEmailAddress = data.email.address;
    emailOtpStatus.textContent = "Confirm your email to finish turning on email sign-in codes.";
    emailOtpConfirmCopy.textContent = `Enter the code we sent to ${data.email.address}.`;
    emailOtpConfirmInput.value = "";
    emailOtpSetupError.hidden = true;
    emailOtpConfirmPanel.hidden = false;
  } else {
    emailOtpStatus.textContent = "Email sign-in codes are off.";
    emailOtpAddressInput.value = "";
    emailOtpOffPanel.hidden = false;
  }
}

document.getElementById("email-otp-start-btn").addEventListener("click", async () => {
  const res = await fetch("/api/account/email/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ email: emailOtpAddressInput.value.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || "Could not send a verification code.");
  refreshMfaStatus();
});

document.getElementById("email-otp-setup-cancel-btn").addEventListener("click", refreshMfaStatus);

document.getElementById("email-otp-resend-btn").addEventListener("click", async () => {
  if (!pendingEmailAddress) return refreshMfaStatus();
  const res = await fetch("/api/account/email/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ email: pendingEmailAddress }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    emailOtpSetupError.textContent = data.error || "Could not send a new code.";
    emailOtpSetupError.hidden = false;
    return;
  }
  refreshMfaStatus();
});

document.getElementById("email-otp-confirm-btn").addEventListener("click", async () => {
  const res = await fetch("/api/account/email/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ code: emailOtpConfirmInput.value.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    emailOtpSetupError.textContent = data.error || "Could not confirm that code.";
    emailOtpSetupError.hidden = false;
    return;
  }
  refreshMfaStatus();
});

document.getElementById("email-otp-disable-btn").addEventListener("click", () => {
  hideEmailOtpPanels();
  emailOtpPasswordInput.value = "";
  emailOtpPasswordError.hidden = true;
  emailOtpPasswordConfirm.hidden = false;
  emailOtpPasswordInput.focus();
});

document.getElementById("email-otp-password-cancel-btn").addEventListener("click", refreshMfaStatus);

document.getElementById("email-otp-password-confirm-btn").addEventListener("click", async () => {
  const res = await fetch("/api/account/email/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ password: emailOtpPasswordInput.value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    emailOtpPasswordError.textContent = data.error || "Could not confirm your password.";
    emailOtpPasswordError.hidden = false;
    return;
  }
  refreshMfaStatus();
});
