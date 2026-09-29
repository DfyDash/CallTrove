// Without this, a double-click fires two POSTs -- each one silently sends
// its own password-reset-code email (the response is the same either way,
// see routes/auth.js's POST /forgot-password), so one impatient click can
// mean two codes landing in the same inbox.
document.querySelector("form").addEventListener("submit", () => {
  document.querySelectorAll('form button[type="submit"]').forEach((b) => (b.disabled = true));
});
