const params = new URLSearchParams(location.search);
if (params.get("error") === "pending") {
  document.getElementById("login-pending").hidden = false;
} else if (params.get("error")) {
  document.getElementById("login-error").hidden = false;
}
if (params.get("activated")) {
  document.getElementById("login-activated").hidden = false;
}
if (params.get("paid")) {
  document.getElementById("login-paid").hidden = false;
}
if (params.get("reset")) {
  document.getElementById("login-reset").hidden = false;
}

// Without this, a double-click (or a slow response someone clicks through)
// fires two POSTs -- harmless for a plain password check, but when email
// OTP is enabled that's two sign-in-code emails for one login attempt.
document.querySelector("form").addEventListener("submit", () => {
  document.querySelectorAll('form button[type="submit"]').forEach((b) => (b.disabled = true));
});
