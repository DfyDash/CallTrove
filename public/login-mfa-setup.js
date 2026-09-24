const setupPanel = document.getElementById("setup-panel");
const recoveryCodesPanel = document.getElementById("recovery-codes-panel");
const mfaQr = document.getElementById("mfa-qr");
const mfaManualKey = document.getElementById("mfa-manual-key");
const mfaConfirmInput = document.getElementById("mfa-confirm-input");
const mfaSetupError = document.getElementById("mfa-setup-error");
const mfaRecoveryCodesList = document.getElementById("mfa-recovery-codes-list");

async function start() {
  const res = await fetch("/auth/login-mfa-setup/start", { method: "POST" });
  if (!res.ok) {
    // No pending login on this session (e.g. the page was reloaded well
    // after the fact, or reached directly) -- back to a real login.
    location.href = "/login.html";
    return;
  }
  const { manualEntryKey } = await res.json();
  mfaQr.src = `/auth/login-mfa-setup/qr?t=${Date.now()}`;
  mfaManualKey.textContent = manualEntryKey;
  mfaConfirmInput.focus();
}

document.getElementById("mfa-confirm-btn").addEventListener("click", async () => {
  const res = await fetch("/auth/login-mfa-setup/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: mfaConfirmInput.value.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    mfaSetupError.textContent = data.error || "Could not confirm that code.";
    mfaSetupError.hidden = false;
    return;
  }
  setupPanel.hidden = true;
  mfaRecoveryCodesList.textContent = data.recoveryCodes.join("\n");
  mfaRecoveryCodesList.dataset.codes = data.recoveryCodes.join("\n");
  recoveryCodesPanel.hidden = false;
});

mfaConfirmInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("mfa-confirm-btn").click();
});

document.getElementById("mfa-recovery-codes-download-btn").addEventListener("click", () => {
  const blob = new Blob([mfaRecoveryCodesList.dataset.codes + "\n"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "calltrove-recovery-codes.txt";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("mfa-continue-btn").addEventListener("click", () => {
  location.href = "/";
});

start();
