// Runs synchronously in <head>, before paint, so a saved preference
// applies before any dark/light CSS resolves (no flash of the wrong
// theme). No explicit preference saved -- stays unset here and the
// prefers-color-scheme media query in style.css decides, same as before
// this toggle existed.
(function () {
  try {
    var saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (e) {
    // localStorage blocked (private mode, etc.) -- falls back to
    // whatever the OS/browser prefers, same as before this toggle existed.
  }
})();

document.addEventListener("DOMContentLoaded", function () {
  var btn = document.getElementById("theme-toggle");
  if (!btn) return;

  function currentTheme() {
    var explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    var systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return systemDark ? "dark" : "light";
  }

  function render() {
    btn.textContent = currentTheme() === "dark" ? "Light mode" : "Dark mode";
  }

  btn.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch (e) {
      // Preference just won't persist across page loads -- the toggle
      // still works for the current page view.
    }
    render();
  });

  render();
});
