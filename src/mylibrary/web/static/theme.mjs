// Shared 夜览模式 (night-reading / dark mode) toggle, used by the app-shell
// pages (via app.js) and the two standalone full-page apps (reader.js,
// study.js). Three explicit modes, cycled in this order on each click:
// system -> light -> dark -> system -> ... "system" is the absence of a
// stored key (not the literal string "system"), matching the inline
// FOUC-prevention snippet duplicated at the top of every document <head>
// (base.html/reader.html/study.html), which reads this same key before
// first paint: `if (t) dataset.theme = t` already does nothing when the key
// is absent, correctly falling through to the CSS's own
// prefers-color-scheme media query - no changes needed there for this file
// to support a third mode.
const THEME_KEY = "mylibrary-theme";
const MODES = ["system", "light", "dark"];
const MODE_ICON = { system: "🖥️", light: "☀️", dark: "🌙" };
const MODE_LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };

function storedMode() {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch (_error) {
    return "system";
  }
}

function applyMode(mode) {
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  try {
    if (mode === "light" || mode === "dark") window.localStorage.setItem(THEME_KEY, mode);
    else window.localStorage.removeItem(THEME_KEY);
  } catch (_error) {
    // Theme still applies for this session without persistence.
  }
}

function syncButton(button) {
  const mode = storedMode();
  button.textContent = MODE_ICON[mode];
  button.title = `外观：${MODE_LABEL[mode]}（点击切换）`;
  button.setAttribute("aria-label", button.title);
  // "pressed" reads as "you've overridden the system" - only true for the
  // two explicit modes, not for "system" itself.
  button.setAttribute("aria-pressed", String(mode !== "system"));
}

// Wires a single toggle button: click advances system -> light -> dark ->
// system and persists the choice (or clears it, for "system"). Safe to call
// once per page with the page's own toggle element (each document has
// exactly one).
export function initThemeToggle(button) {
  if (!button) return;
  syncButton(button);
  button.addEventListener("click", () => {
    const next = MODES[(MODES.indexOf(storedMode()) + 1) % MODES.length];
    applyMode(next);
    syncButton(button);
  });
}
