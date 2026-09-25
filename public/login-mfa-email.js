const params = new URLSearchParams(location.search);
if (params.get("error")) {
  document.getElementById("login-error").hidden = false;
}
if (params.get("sent")) {
  document.getElementById("login-sent").hidden = false;
}
