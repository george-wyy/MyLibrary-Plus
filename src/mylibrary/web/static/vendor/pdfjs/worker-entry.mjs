// Local shim — NOT part of the upstream pdf.js distribution.
// Added 2026-08-27.
//
// Used as GlobalWorkerOptions.workerSrc (see ../../pdfview.js) instead of
// pointing straight at pdf.worker.mjs, so the compat-polyfill.js side
// effect runs inside the worker's own global scope before any real
// pdf.js worker code does. This entry point is loaded for both of
// pdf.js's worker strategies:
//   - a real dedicated Worker (`new Worker(workerSrc, {type: "module"})`)
//   - pdf.js's own main-thread "fake worker" fallback, which does
//     `await import(workerSrc)` when a real Worker can't be started
// See compat-polyfill.js for why this is needed at all.
// Both imports are static on purpose. ES modules are evaluated in import
// declaration order, so compat-polyfill.js still runs before any pdf.js
// worker code - the ordering this file exists for - while the module only
// counts as "loaded" once pdf.worker.mjs has actually finished evaluating.
// A dynamic `import("./pdf.worker.mjs")` (what this used to do) returns
// immediately without awaiting: the worker then reports ready while its
// message handlers do not exist yet, so pdf.js's first messages land in a
// worker that cannot answer them and every getDocument() hangs.
import "./compat-polyfill.js";
import "./pdf.worker.mjs";
