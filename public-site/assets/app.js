// Theme toggle and a tiny mobile tweak for the landing page. Same key and
// system -> light -> dark cycle as the app's own theme.mjs, so a visitor who
// picked dark inside the app keeps it here too.
(function () {
  var KEY = "mylibrary-theme";
  var MODES = ["system", "light", "dark"];
  var ICON = { system: "🖥️", light: "☀️", dark: "🌙" };
  var LABEL = {
    en: { system: "Follow system", light: "Light", dark: "Dark" },
    zh: { system: "跟随系统", light: "浅色", dark: "深色" }
  };

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : "system";
    } catch (error) {
      return "system";
    }
  }

  function apply(mode) {
    if (mode === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    try {
      if (mode === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch (error) { /* session-only */ }
  }

  var button = document.querySelector("[data-theme-toggle]");
  var lang = document.documentElement.lang === "zh-CN" ? "zh" : "en";

  function sync() {
    var mode = stored();
    if (!button) return;
    button.textContent = ICON[mode];
    button.title = LABEL[lang][mode];
    button.setAttribute("aria-label", LABEL[lang][mode]);
  }

  if (button) {
    button.addEventListener("click", function () {
      var next = MODES[(MODES.indexOf(stored()) + 1) % MODES.length];
      apply(next);
      sync();
    });
  }
  sync();
})();
