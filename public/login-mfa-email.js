const params = new URLSearchParams(location.search);
if (params.get("error")) {
  document.getElementById("login-error").hidden = false;
}
if (params.get("sent")) {
  document.getElementById("login-sent").hidden = false;
}

// Two submit buttons on this form (verify, and the formaction="resend"
// one) -- disabling both on submit covers either, so a double-click on
// "Send a new code" can't fire two sign-in-code emails for one click.
document.querySelector("form").addEventListener("submit", () => {
  document.querySelectorAll('form button[type="submit"]').forEach((b) => (b.disabled = true));
});
