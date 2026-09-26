const params = new URLSearchParams(location.search);
if (params.get("error") === "pending") {
  document.getElementById("login-pending").hidden = false;
} else if (params.get("error")) {
  document.getElementById("login-error").hidden = false;
}
if (params.get("activated")) {
  document.getElementById("login-activated").hidden = false;
}
