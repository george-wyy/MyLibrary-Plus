import assert from "node:assert/strict";
import markedPackage from "../src/mylibrary/web/static/vendor/marked/marked.min.js";

import {
  hitTestPdfAnnotations,
  annotationFloatModeStorageKey,
  annotationCandidateTabLabels,
  chooseFloatModeActivation,
  chooseNextAnnotationCandidate,
  readAnnotationFloatMode,
  reconcileFloatingAnnotationSelection,
  shouldAdoptDeletedAnnotationSurvivor,
  isSafeAnnotationUri,
  isForbiddenAnnotationAttribute,
  shortAnnotationCandidateLabels,
  normalizeCjkStrongBoundaries,
  scrollAnnotationIntoView,
  setAnnotationReadingMode,
  sortAnnotationCandidates,
  writeAnnotationFloatMode,
} from "../src/mylibrary/web/static/annotation-interaction.mjs";

const { marked } = markedPackage;

function test(name, run) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("hit testing returns every overlapping PDF annotation, newest first", () => {
  const annotations = [
    { id: "old", target_type: "pdf", page_number: 4, rects: [{ x: .1, y: .2, width: .5, height: .4 }] },
    { id: "other-page", target_type: "pdf", page_number: 5, rects: [{ x: .1, y: .2, width: .5, height: .4 }] },
    { id: "lecture", target_type: "lecture", page_number: 4, rects: [{ x: .1, y: .2, width: .5, height: .4 }] },
    { id: "new", target_type: "pdf", page_number: 4, rects: [{ x: .2, y: .25, width: .2, height: .2 }] },
  ];

  assert.deepEqual(
    hitTestPdfAnnotations(annotations, 4, .3, .3).map((annotation) => annotation.id),
    ["new", "old"],
  );
});

test("floating annotation candidates sort by most recently updated and pick a survivor after delete", () => {
  const candidates = sortAnnotationCandidates([
    { id: "old", updated_at: "2026-08-01T09:00:00Z" },
    { id: "new", updated_at: "2026-08-02T09:00:00Z" },
    { id: "middle", updated_at: "2026-08-01T12:00:00Z" },
  ]);
  assert.deepEqual(candidates.map((annotation) => annotation.id), ["new", "middle", "old"]);
  assert.equal(chooseNextAnnotationCandidate(candidates, "new")?.id, "middle");
  assert.equal(chooseNextAnnotationCandidate([{ id: "only" }], "only"), null);
});

test("floating candidate labels are compact and unique", () => {
  assert.deepEqual(shortAnnotationCandidateLabels([
    { id: "a", note: "Same note with a long tail that should be shortened" },
    { id: "b", note: "Same note with a long tail that should be shortened" },
    { id: "c", note: "" },
  ], 16), ["Same note with…", "Same note with… · 2", "仅高亮"]);
});

test("floating candidate tabs retain their complete preview for assistive labels", () => {
  const fullNote = "A complete annotation note that is intentionally longer than its compact tab";
  assert.deepEqual(annotationCandidateTabLabels([{ id: "a", note: fullNote }], 14), [{
    text: "A complete an…",
    label: fullNote,
  }]);
});

test("filter reconciliation closes a floating thread whose active annotation is hidden", () => {
  const visible = [{ id: "kept", updated_at: "2026-08-02T00:00:00Z" }];
  assert.deepEqual(reconcileFloatingAnnotationSelection(visible, {
    floatOpen: true, currentId: "hidden", candidateIds: ["hidden", "kept"],
  }), { close: true, candidateIds: ["kept"] });
  assert.deepEqual(reconcileFloatingAnnotationSelection(visible, {
    floatOpen: true, currentId: "kept", candidateIds: ["hidden", "kept"],
  }), { close: false, candidateIds: ["kept"] });
});

test("floating annotation mode defaults on but preserves an explicit per-paper choice", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const key = annotationFloatModeStorageKey("paper-a");
  assert.equal(readAnnotationFloatMode(storage, key), true);
  writeAnnotationFloatMode(storage, key, false);
  assert.equal(readAnnotationFloatMode(storage, key), false);
  assert.equal(readAnnotationFloatMode(storage, annotationFloatModeStorageKey("paper-b")), true);
});

test("enabling floating mode promotes the newest overlap candidate when the sidebar picker is open", () => {
  const activation = chooseFloatModeActivation(null, ["old", "new"], [
    { id: "old", updated_at: "2026-08-01T00:00:00Z" },
    { id: "new", updated_at: "2026-08-02T00:00:00Z" },
  ]);
  assert.equal(activation.annotation?.id, "new");
  assert.deepEqual(activation.candidateIds, ["new", "old"]);
});

test("a completed delete never steals a newer user selection", () => {
  assert.equal(shouldAdoptDeletedAnnotationSurvivor({ uiRevision: 4, currentId: "a" }, 4, "a"), true);
  assert.equal(shouldAdoptDeletedAnnotationSurvivor({ uiRevision: 5, currentId: "c" }, 4, "a"), false);
});

test("annotation URIs reject executable and non-image data payloads", () => {
  assert.equal(isSafeAnnotationUri("https://example.org", "a"), true);
  assert.equal(isSafeAnnotationUri("mailto:me@example.org", "a"), true);
  assert.equal(isSafeAnnotationUri("#section", "a"), true);
  assert.equal(isSafeAnnotationUri("../relative", "a"), true);
  assert.equal(isSafeAnnotationUri("javascript:alert(1)", "a"), false);
  assert.equal(isSafeAnnotationUri("data:text/html,<svg onload=alert(1)>", "img"), false);
  assert.equal(isSafeAnnotationUri("data:image/png;base64,AAAA", "img"), true);
  assert.equal(isForbiddenAnnotationAttribute("onerror", "alert(1)", "img"), true);
  assert.equal(isForbiddenAnnotationAttribute("style", "background:url(javascript:alert(1))", "p"), true);
  assert.equal(isForbiddenAnnotationAttribute("src", "data:text/html,<svg>", "img"), true);
  assert.equal(isForbiddenAnnotationAttribute("href", "javascript:alert(1)", "a"), true);
  assert.equal(isForbiddenAnnotationAttribute("href", "https://example.org", "a"), false);
});

test("selected annotation is scrolled into the nearest visible list position", () => {
  const calls = [];
  const items = [
    { dataset: { annotationId: "first" }, scrollIntoView: (options) => calls.push(["first", options]) },
    { dataset: { annotationId: "target" }, scrollIntoView: (options) => calls.push(["target", options]) },
  ];
  const list = { querySelectorAll: () => items };

  assert.equal(scrollAnnotationIntoView(list, "target"), true);
  assert.deepEqual(calls, [["target", { block: "nearest" }]]);
  assert.equal(scrollAnnotationIntoView(list, "missing"), false);
});

test("annotation reading mode synchronizes layout class and button state", () => {
  const classes = new Set();
  const attributes = new Map();
  const body = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  const button = {
    textContent: "",
    setAttribute(name, value) { attributes.set(name, value); },
  };

  setAnnotationReadingMode(body, button, true);
  assert.equal(classes.has("annotation-reading-mode"), true);
  assert.equal(attributes.get("aria-pressed"), "true");
  assert.equal(button.textContent, "退出宽读");

  setAnnotationReadingMode(body, button, false);
  assert.equal(classes.has("annotation-reading-mode"), false);
  assert.equal(attributes.get("aria-pressed"), "false");
  assert.equal(button.textContent, "宽读批注");
});

test("Chinese prose can immediately follow a bold Markdown span", () => {
  const source = "**RAG（Retrieval-Augmented Generation，检索增强生成）**可以拆成三步：";
  const prepared = normalizeCjkStrongBoundaries(source);
  const html = marked.parse(prepared, { gfm: true, breaks: true });

  assert.match(html, /<strong>RAG（Retrieval-Augmented Generation，检索增强生成）<\/strong>/);
  assert.doesNotMatch(html, /\*\*RAG/);
});

test("Chinese bold-boundary normalization leaves code spans unchanged", () => {
  const source = "示例：`**RAG（检索增强生成）**可以继续`";

  assert.equal(normalizeCjkStrongBoundaries(source), source);
});
