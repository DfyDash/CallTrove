// Adds an eye button to every password field so people can check what
// they're typing. Click to show, click again to hide.
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var EYE = "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z";
  var SLASH = "M3 3l18 18";

  function icon(slashed) {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var eye = document.createElementNS(NS, "path");
    eye.setAttribute("d", EYE);
    svg.appendChild(eye);
    var pupil = document.createElementNS(NS, "circle");
    pupil.setAttribute("cx", "12");
    pupil.setAttribute("cy", "12");
    pupil.setAttribute("r", "3");
    svg.appendChild(pupil);
    if (slashed) {
      var slash = document.createElementNS(NS, "path");
      slash.setAttribute("d", SLASH);
      svg.appendChild(slash);
    }
    return svg;
  }

  function attach(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = "1";
    var wrap = document.createElement("span");
    wrap.className = "password-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "password-toggle";
    btn.setAttribute("aria-label", "Show password");
    btn.setAttribute("aria-pressed", "false");
    btn.appendChild(icon(false));
    btn.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.setAttribute("aria-pressed", show ? "true" : "false");
      btn.replaceChildren(icon(show));
    });
    wrap.appendChild(btn);
  }

  document.querySelectorAll('input[type="password"]').forEach(attach);
})();
