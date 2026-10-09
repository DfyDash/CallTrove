const ERROR_MESSAGES = {
  missing: "Fill in every field to create an account.",
  email: "Enter a valid email address.",
  mismatch: "Password and confirmation don't match.",
  tooshort: "Password must be at least 8 characters.",
  taken: "That username is already taken.",
};

const error = new URLSearchParams(location.search).get("error");
if (error) {
  const el = document.getElementById("signup-error");
  el.textContent = ERROR_MESSAGES[error] || "Could not create your account.";
  el.hidden = false;
}

// Without this, a double-click fires two POSTs -- the username unique
// constraint already stops a second welcome email (createUser throws for
// the loser before the route ever reaches the email step), but the loser
// still leaves an orphaned tenant row behind (createTenant already ran)
// and surfaces as a raw 500 instead of the normal "username taken" flow.
document.querySelector("form").addEventListener("submit", () => {
  document.querySelectorAll('form button[type="submit"]').forEach((b) => (b.disabled = true));
});
