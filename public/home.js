// The sign-in buttons point at the production app. On any other host (the
// test site), send people to that host's own login page instead, and add a
// Sign up link -- signup stays unlinked on production while it's being tested.
(function () {
  var host = location.hostname;
  if (host === "calltrove.com" || host === "www.calltrove.com" || host === "app.calltrove.com") return;
  document.querySelectorAll('a[href="https://app.calltrove.com/login.html"]').forEach(function (a) {
    a.setAttribute("href", "/login.html");
  });
  var signIn = document.querySelector(".nav-links .signin-btn");
  if (signIn) {
    var link = document.createElement("a");
    link.className = "nav-link";
    link.href = "/signup.html";
    link.textContent = "Sign up";
    signIn.parentNode.insertBefore(link, signIn);
  }
  var cta = document.querySelector(".hero-actions .cta-btn");
  if (cta) {
    var signUp = document.createElement("a");
    signUp.className = "cta-secondary";
    signUp.href = "/signup.html";
    signUp.textContent = "Create an account";
    cta.parentNode.insertBefore(signUp, cta.nextSibling);
  }
})();
