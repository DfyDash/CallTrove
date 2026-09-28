const ERROR_MESSAGES = {
  mismatch: "Password and confirmation don't match.",
  tooshort: "Password must be at least 8 characters.",
  code: "That code didn't work. Try again or send a new one.",
};

const params = new URLSearchParams(location.search);
const error = params.get("error");
if (error) {
  const el = document.getElementById("reset-error");
  el.textContent = ERROR_MESSAGES[error] || "Could not reset your password.";
  el.hidden = false;
}
if (params.get("sent")) {
  document.getElementById("reset-sent").hidden = false;
}
