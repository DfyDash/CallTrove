const ERROR_MESSAGES = {
  mismatch: "Password and confirmation don't match.",
  tooshort: "Password must be at least 8 characters.",
  invalid: "This link is invalid or has expired. Ask your admin to resend the invite.",
};

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
document.getElementById("set-password-token").value = token;

const error = params.get("error");
if (error) {
  const el = document.getElementById("set-password-error");
  el.textContent = ERROR_MESSAGES[error] || "Could not set your password.";
  el.hidden = false;
}

const form = document.getElementById("set-password-form");
const intro = document.getElementById("set-password-intro");
const submitButton = document.getElementById("set-password-submit");

if (!token) {
  intro.textContent = "This link is missing its token. Ask your admin to resend the invite.";
  submitButton.disabled = true;
} else {
  fetch(`/auth/set-password/validate?token=${encodeURIComponent(token)}`)
    .then((res) => res.json())
    .then((data) => {
      if (!data.valid) {
        intro.textContent = "This link is invalid or has expired. Ask your admin to resend the invite.";
        submitButton.disabled = true;
        form.querySelectorAll("input[type=password]").forEach((i) => (i.disabled = true));
        return;
      }
      intro.textContent = `Set a password for ${data.username} to finish activating your account.`;
    })
    .catch(() => {
      // Validation is a courtesy check -- if it fails to load, still let
      // them submit; the real check happens server-side either way.
      intro.textContent = "Set a password to finish activating your account.";
    });
}
