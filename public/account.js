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

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  const csrfToken = me.csrfToken || "";
  document.getElementById("csrf-token-input").value = csrfToken;
  const adminLink = me.role === "admin" ? ` · <a href="/settings.html">Settings</a>` : "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})${adminLink}</span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;
}

const params = new URLSearchParams(location.search);
if (params.get("success")) successMessage.hidden = false;
const error = params.get("error");
if (error) {
  errorMessage.textContent = ERROR_MESSAGES[error] || "Could not change password.";
  errorMessage.hidden = false;
}

loadSession();
