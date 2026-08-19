import assert from "node:assert/strict";

process.env.TZ = "Asia/Shanghai";

let metadata = {};
let importError = null;
let browserGlobalAccessed = false;
for (const name of ["window", "document"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      browserGlobalAccessed = true;
      throw new Error(`pure metadata module accessed ${name}`);
    },
  });
}
try {
  metadata = await import("../src/mylibrary/web/static/annotation-metadata.mjs");
} catch (error) {
  importError = error;
} finally {
  delete globalThis.window;
  delete globalThis.document;
}

function test(name, run) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("annotation metadata helpers are exported", () => {
  assert.equal(importError, null, importError?.message);
  assert.equal(browserGlobalAccessed, false);
  assert.equal(typeof metadata.formatAnnotationTime, "function");
  assert.equal(typeof metadata.formatAnnotationDateTime, "function");
  assert.equal(typeof metadata.matchesAnnotation, "function");
  assert.equal(typeof metadata.collectAnnotationTags, "function");
  assert.equal(typeof metadata.reconcileAnnotationPanelSelection, "function");
  assert.equal(typeof metadata.isActiveAnnotationTagEdit, "function");
  assert.equal(typeof metadata.parseAnnotationTags, "function");
  assert.equal(typeof metadata.resolveAnnotationMutationUi, "function");
});

test("same-day timestamps use a compact local time", () => {
  const now = new Date("2026-08-18T02:00:00+00:00");

  assert.equal(metadata.formatAnnotationTime("2026-08-18T00:05:00+00:00", now), "08:05");
});

test("exact timestamps always include the full local date and time", () => {
  const now = new Date("2026-08-18T02:00:00+00:00");

  assert.equal(metadata.formatAnnotationTime("2026-08-18T00:05:00+00:00", now), "08:05");
  assert.equal(metadata.formatAnnotationDateTime("2026-08-18T00:05:00+00:00"), "2026/08/18 08:05");
  assert.equal(metadata.formatAnnotationDateTime("not-a-date"), "");
});

test("older timestamps include the full local date and time", () => {
  const now = new Date("2026-08-18T02:00:00+00:00");

  assert.equal(metadata.formatAnnotationTime("2026-08-17T15:59:00+00:00", now), "2026/08/17 23:59");
  assert.equal(metadata.formatAnnotationTime("2025-12-31T16:01:00+00:00", now), "2026/01/01 00:01");
});

test("invalid or empty timestamps have a safe empty representation", () => {
  assert.equal(metadata.formatAnnotationTime("not-a-date"), "");
  assert.equal(metadata.formatAnnotationTime(""), "");
  assert.equal(metadata.formatAnnotationTime(null), "");
});

test("query matching covers annotation text, replies, paper titles, and tags", () => {
  const annotation = {
    note: "Discuss the METHOD",
    selected_text: "A spatial target",
    source: { text: "gesture vocabulary" },
    replies: [{ content: "Assistant synthesis" }],
    paper: { title: "SIAgent Study" },
    tags: ["Experiment", { name: "Validity" }],
  };

  for (const query of [
    " method ",
    "SPATIAL",
    "Gesture",
    "synthesis",
    "siagent",
    "experiment",
    "VALIDITY",
  ]) {
    assert.equal(metadata.matchesAnnotation(annotation, query), true, query);
  }
  assert.equal(metadata.matchesAnnotation(annotation, "missing"), false);
});

test("paper and source compatibility fields are searchable", () => {
  assert.equal(metadata.matchesAnnotation({ paper_title: "Direct Paper", source: "Quoted source" }, "direct"), true);
  assert.equal(metadata.matchesAnnotation({ title: "Fallback Paper", source_text: "Alternate source" }, "fallback"), true);
  assert.equal(metadata.matchesAnnotation({ title: "Fallback Paper", source_text: "Alternate source" }, "alternate"), true);
});

test("query and selected tag combine with AND semantics", () => {
  const annotation = { note: "Eye-hand intent", tags: ["Method", "Experiment"] };

  assert.equal(metadata.matchesAnnotation(annotation, "intent", "method"), true);
  assert.equal(metadata.matchesAnnotation(annotation, "absent", "method"), false);
  assert.equal(metadata.matchesAnnotation(annotation, "intent", "validity"), false);
});

test("selected tags match exactly and case-insensitively", () => {
  const annotation = { tags: ["Method Question"] };

  assert.equal(metadata.matchesAnnotation(annotation, "", " method question "), true);
  assert.equal(metadata.matchesAnnotation(annotation, "", "method"), false);
});

test("empty filters and missing fields are tolerated", () => {
  assert.equal(metadata.matchesAnnotation({}, "", ""), true);
  assert.equal(metadata.matchesAnnotation(null, "query"), false);
  assert.equal(metadata.matchesAnnotation(undefined), true);
});

test("tag collection is unique, stable in display name, and deterministically sorted", () => {
  const annotations = [
    { tags: ["Zeta", " beta ", { name: "Method" }] },
    { tags: ["BETA", "alpha", { name: "method" }, null, ""] },
    {},
  ];

  assert.deepEqual(metadata.collectAnnotationTags(annotations), ["alpha", "beta", "Method", "Zeta"]);
});

test("metadata helpers do not mutate their inputs", () => {
  const annotations = [{
    note: "A note",
    selected_text: "A source",
    replies: [{ content: "A reply" }],
    paper: { title: "A paper" },
    tags: ["Beta", { name: "Alpha" }],
  }];
  const before = JSON.stringify(annotations);

  metadata.matchesAnnotation(annotations[0], "note", "beta");
  metadata.collectAnnotationTags(annotations);

  assert.equal(JSON.stringify(annotations), before);
});

test("filter reconciliation clears hidden active and edit state", () => {
  const next = metadata.reconcileAnnotationPanelSelection(
    [{ id: "annotation-b" }],
    {
      currentId: "annotation-a",
      candidateIds: ["annotation-a"],
      editing: true,
      editingTags: true,
    },
  );

  assert.deepEqual(next, {
    currentId: null,
    candidateIds: [],
    editing: false,
    editingTags: false,
  });
});

test("filter reconciliation preserves an overlap picker only while every candidate remains visible", () => {
  const state = {
    currentId: null,
    candidateIds: ["annotation-a", "annotation-b"],
    editing: false,
    editingTags: false,
  };

  assert.deepEqual(
    metadata.reconcileAnnotationPanelSelection([{ id: "annotation-a" }, { id: "annotation-b" }], state),
    state,
  );
  assert.deepEqual(
    metadata.reconcileAnnotationPanelSelection([{ id: "annotation-a" }], state),
    { currentId: null, candidateIds: [], editing: false, editingTags: false },
  );
});

test("tag edit responses only own the editor for their submitted annotation", () => {
  const editingB = { currentId: "annotation-b", editingTags: true, activeTagEditToken: 2 };

  assert.equal(metadata.isActiveAnnotationTagEdit(editingB, "annotation-a", 2), false);
  assert.equal(metadata.isActiveAnnotationTagEdit(editingB, "annotation-b", 2), true);
  assert.equal(metadata.isActiveAnnotationTagEdit(editingB, "annotation-b", 1), false);
  assert.equal(metadata.isActiveAnnotationTagEdit(
    { currentId: "annotation-b", editingTags: false, activeTagEditToken: 2 },
    "annotation-b",
    2,
  ), false);
});

test("tag parsing accepts ASCII and full-width commas", () => {
  assert.deepEqual(
    metadata.parseAnnotationTags(" 方法, 证据，待确认 ,, "),
    ["方法", "证据", "待确认"],
  );
});

function resolveMutation(annotations, state, operationRevision, query = "", selectedTag = "") {
  const filtered = annotations.filter((annotation) => (
    metadata.matchesAnnotation(annotation, query, selectedTag)
  ));
  return metadata.resolveAnnotationMutationUi(filtered, state, operationRevision);
}

test("tag saves clear an active detail that no longer matches its tag filter", () => {
  const result = resolveMutation(
    [{ id: "annotation-a", tags: [] }, { id: "annotation-b", tags: ["方法"] }],
    { currentId: "annotation-a", candidateIds: [], editing: false, editingTags: false, uiRevision: 4 },
    4,
    "",
    "方法",
  );

  assert.deepEqual(result, {
    currentId: null,
    candidateIds: [],
    editing: false,
    editingTags: false,
    shouldRender: true,
  });
});

test("note saves clear an active detail that no longer matches its query", () => {
  const result = resolveMutation(
    [{ id: "annotation-a", note: "unrelated" }, { id: "annotation-b", note: "sequence models" }],
    { currentId: "annotation-a", candidateIds: [], editing: false, editingTags: false, uiRevision: 7 },
    7,
    "eye",
  );

  assert.equal(result.currentId, null);
  assert.equal(result.shouldRender, true);
});

test("stale note and reply responses do not redraw a newer annotation editor", () => {
  const annotations = [{ id: "annotation-a" }, { id: "annotation-b" }];
  const editingBTags = {
    currentId: "annotation-b",
    candidateIds: [],
    editing: false,
    editingTags: true,
    uiRevision: 12,
  };
  const editingBNote = { ...editingBTags, editing: true, editingTags: false, uiRevision: 13 };

  assert.equal(resolveMutation(annotations, editingBTags, 10).shouldRender, false);
  assert.equal(resolveMutation(annotations, editingBNote, 11).shouldRender, false);
  assert.equal(resolveMutation(annotations, editingBTags, 10).editingTags, true);
  assert.equal(resolveMutation(annotations, editingBNote, 11).editing, true);
});

test("create under an active filter does not select an invisible annotation", () => {
  const result = resolveMutation(
    [{ id: "annotation-b", tags: ["方法"] }, { id: "annotation-new", tags: [] }],
    { currentId: "annotation-new", candidateIds: [], editing: false, editingTags: false, uiRevision: 3 },
    3,
    "",
    "方法",
  );

  assert.equal(result.currentId, null);
  assert.equal(result.shouldRender, true);
});

test("a stale async failure does not request a redraw of a newer draft", () => {
  const result = resolveMutation(
    [{ id: "annotation-b" }],
    { currentId: "annotation-b", candidateIds: [], editing: false, editingTags: true, uiRevision: 9 },
    8,
  );

  assert.equal(result.currentId, "annotation-b");
  assert.equal(result.editingTags, true);
  assert.equal(result.shouldRender, false);
});
