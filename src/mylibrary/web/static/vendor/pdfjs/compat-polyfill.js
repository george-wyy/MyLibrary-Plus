// Local compatibility shim — NOT part of the upstream pdf.js distribution.
// Added 2026-08-27 alongside pdf.js 6.1.200.
//
// pdf.js 6.x calls `Promise.withResolvers()` (TC39 stage-4; landed in
// V8 12.1 / Chrome 121, shipped Jan 2024) unconditionally in ~40 places
// across pdf.mjs and pdf.worker.mjs, with no feature check and no
// fallback. Any engine older than that throws
// `TypeError: Promise.withResolvers is not a function` the moment
// pdf.js tries to spin up its worker or load a document — the rest of
// the page (plain HTML/CSS/JS) is unaffected, so only the PDF viewer
// breaks while everything else looks fine.
//
// Concretely on this machine: Obsidian's own JS bundle auto-updates,
// but its embedded Electron/Chromium shell only updates when the app
// itself is reinstalled. As of writing, Obsidian.app's bundled engine
// is Chromium 120.0.6099 / V8 12.0.267 — one minor V8 release short of
// the cutoff — so its built-in browser hits this exact TypeError.
//
// This file must be imported (for its side effect only) before any
// pdf.js code runs in a given JS realm. It is imported from two
// places, because a dedicated Worker (real or pdf.js's own
// "fake worker" main-thread fallback) is a *separate* global scope
// from the page — polyfilling window.Promise does not reach in there:
//   - static/pdfview.js (page/main-thread realm)
//   - static/vendor/pdfjs/worker-entry.mjs (worker realm)
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
