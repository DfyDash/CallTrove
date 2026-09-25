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
