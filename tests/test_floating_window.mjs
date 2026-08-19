import assert from "node:assert/strict";

let floatingWindow = {};
let importError = null;
let browserGlobalAccessed = false;
for (const name of ["window", "document"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      browserGlobalAccessed = true;
      throw new Error(`pure floating-window module accessed ${name}`);
    },
  });
}
try {
  floatingWindow = await import("../src/mylibrary/web/static/floating-window.mjs");
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

const viewport = { width: 1000, height: 800 };
const limits = { minWidth: 320, minHeight: 180, margin: 12 };

test("floating-window helpers are exported without browser globals", () => {
  assert.equal(importError, null, importError?.message);
  assert.equal(browserGlobalAccessed, false);
  assert.equal(typeof floatingWindow.clampFloatingGeometry, "function");
  assert.equal(typeof floatingWindow.moveFloatingGeometry, "function");
  assert.equal(typeof floatingWindow.resizeFloatingGeometry, "function");
  assert.equal(typeof floatingWindow.serializeFloatingGeometry, "function");
  assert.equal(typeof floatingWindow.restoreFloatingGeometry, "function");
  assert.equal(typeof floatingWindow.createFloatingWindow, "function");
});

test("valid initial geometry remains unchanged inside the viewport", () => {
  assert.deepEqual(
    floatingWindow.clampFloatingGeometry(
      { left: 120, top: 80, width: 680, height: 520 },
      viewport,
      limits,
    ),
    { left: 120, top: 80, width: 680, height: 520 },
  );
});

test("oversized and negative stale geometry is clamped into the viewport", () => {
  assert.deepEqual(
    floatingWindow.clampFloatingGeometry(
      { left: -500, top: -90, width: 5000, height: 4000 },
      viewport,
      limits,
    ),
    { left: 12, top: 12, width: 976, height: 776 },
  );
});

test("undersized geometry respects minimums and clamps far-away positions", () => {
  assert.deepEqual(
    floatingWindow.clampFloatingGeometry(
      { left: 9000, top: 9000, width: 10, height: -4 },
      viewport,
      limits,
    ),
    { left: 668, top: 608, width: 320, height: 180 },
  );
});

test("a viewport smaller than minimums still keeps the complete window visible", () => {
  assert.deepEqual(
    floatingWindow.clampFloatingGeometry(
      { left: 20, top: 20, width: 680, height: 500 },
      { width: 280, height: 150 },
      limits,
    ),
    { left: 12, top: 12, width: 256, height: 126 },
  );
});

test("moving a window clamps both axes", () => {
  assert.deepEqual(
    floatingWindow.moveFloatingGeometry(
      { left: 100, top: 80, width: 400, height: 300 },
      { x: 900, y: -200 },
      viewport,
      limits,
    ),
    { left: 588, top: 12, width: 400, height: 300 },
  );
});

test("east and south resize deltas grow from fixed north-west edges", () => {
  const start = { left: 100, top: 80, width: 400, height: 300 };

  assert.deepEqual(
    floatingWindow.resizeFloatingGeometry(start, "e", { x: 80, y: 0 }, viewport, limits),
    { left: 100, top: 80, width: 480, height: 300 },
  );
  assert.deepEqual(
    floatingWindow.resizeFloatingGeometry(start, "s", { x: 0, y: 100 }, viewport, limits),
    { left: 100, top: 80, width: 400, height: 400 },
  );
  assert.deepEqual(
    floatingWindow.resizeFloatingGeometry(start, "se", { x: 80, y: 100 }, viewport, limits),
    { left: 100, top: 80, width: 480, height: 400 },
  );
});

test("west resize deltas keep the east edge fixed and enforce minimum width", () => {
  const start = { left: 100, top: 80, width: 400, height: 300 };

  assert.deepEqual(
    floatingWindow.resizeFloatingGeometry(start, "w", { x: -80, y: 0 }, viewport, limits),
    { left: 20, top: 80, width: 480, height: 300 },
  );
  assert.deepEqual(
    floatingWindow.resizeFloatingGeometry(start, "w", { x: 300, y: 0 }, viewport, limits),
    { left: 180, top: 80, width: 320, height: 300 },
  );
  assert.deepEqual(
    floatingWindow.resizeFloatingGeometry(start, "sw", { x: 50, y: 100 }, viewport, limits),
    { left: 150, top: 80, width: 350, height: 400 },
  );
});

test("geometry serialization is stable and restoration supports legacy size-only data", () => {
  const fallback = { left: 40, top: 60, width: 680, height: 500 };
  assert.equal(
    floatingWindow.serializeFloatingGeometry({ left: 12.2, top: 24.8, width: 640.4, height: 419.6, extra: true }),
    '{"left":12,"top":25,"width":640,"height":420}',
  );
  assert.deepEqual(
    floatingWindow.restoreFloatingGeometry('{"width":540,"height":360}', fallback, viewport, limits),
    { left: 40, top: 60, width: 540, height: 360 },
  );
});

test("invalid JSON and invalid fields safely fall back while stale saved positions clamp", () => {
  const fallback = { left: 40, top: 60, width: 680, height: 500 };

  assert.deepEqual(
    floatingWindow.restoreFloatingGeometry("not json", fallback, viewport, limits),
    fallback,
  );
  assert.deepEqual(
    floatingWindow.restoreFloatingGeometry(
      '{"left":4000,"top":-100,"width":"wide","height":300}',
      fallback,
      viewport,
      limits,
    ),
    { left: 308, top: 12, width: 680, height: 300 },
  );
});

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { names.forEach((name) => this.names.add(name)); }
  remove(...names) { names.forEach((name) => this.names.delete(name)); }
  contains(name) { return this.names.has(name); }
}

class FakeEventTarget {
  constructor(ownerDocument = null) {
    this.ownerDocument = ownerDocument;
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.capturedPointers = new Set();
    this.removed = false;
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  listenerCount(type) { return this.listeners.get(type)?.size || 0; }
  dispatch(type, values = {}) {
    let prevented = false;
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() { prevented = true; },
      ...values,
    };
    [...(this.listeners.get(type) || [])].forEach((callback) => callback(event));
    return { event, prevented };
  }
  append(child) { this.children.push(child); }
  remove() { this.removed = true; }
  closest() { return null; }
  setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); }
  hasPointerCapture(pointerId) { return this.capturedPointers.has(pointerId); }
  releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
}

function fakeBrowser() {
  const values = new Map();
  const windowObject = new FakeEventTarget();
  windowObject.innerWidth = 1000;
  windowObject.innerHeight = 800;
  windowObject.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  const documentObject = new FakeEventTarget();
  documentObject.defaultView = windowObject;
  documentObject.createElement = () => new FakeEventTarget(documentObject);
  return { documentObject, windowObject, values };
}

test("DOM controller captures pointers, persists changes, reclamps, and fully cleans up", () => {
  const { documentObject, windowObject, values } = fakeBrowser();
  const element = new FakeEventTarget(documentObject);
  const header = new FakeEventTarget(documentObject);
  const completed = [];
  const cleanup = floatingWindow.createFloatingWindow({
    element,
    dragHandle: header,
    storageKey: "test.geometry",
    defaultGeometry: { left: 100, top: 80, width: 400, height: 300 },
    minWidth: 320,
    minHeight: 180,
    onInteractionEnd: (result) => completed.push(result.type),
  });

  assert.deepEqual(
    [element.style.left, element.style.top, element.style.width, element.style.height],
    ["100px", "80px", "400px", "300px"],
  );
  assert.equal(element.children.length, 5);
  assert.equal(header.listenerCount("pointerdown"), 1);
  assert.equal(windowObject.listenerCount("resize"), 1);

  const down = header.dispatch("pointerdown", { button: 0, pointerId: 7, clientX: 20, clientY: 30 });
  assert.equal(down.prevented, true);
  assert.equal(header.hasPointerCapture(7), true);
  assert.equal(element.classList.contains("is-dragging"), true);
  assert.equal(header.listenerCount("pointermove"), 1);
  header.dispatch("pointermove", { pointerId: 7, clientX: 120, clientY: 80 });
  assert.equal(element.style.left, "200px");
  assert.equal(element.style.top, "130px");
  header.dispatch("pointerup", { pointerId: 7 });
  assert.equal(header.hasPointerCapture(7), false);
  assert.equal(element.classList.contains("is-dragging"), false);
  assert.equal(header.listenerCount("pointermove"), 0);
  assert.equal(values.get("test.geometry"), '{"left":200,"top":130,"width":400,"height":300}');

  const eastHandle = element.children.find((child) => child.dataset.floatingResize === "e");
  eastHandle.dispatch("pointerdown", { button: 0, pointerId: 8, clientX: 0, clientY: 0 });
  eastHandle.dispatch("pointermove", { pointerId: 8, clientX: 90, clientY: 0 });
  eastHandle.dispatch("pointercancel", { pointerId: 8 });
  assert.equal(element.style.width, "490px");
  assert.deepEqual(completed, ["drag", "resize"]);

  windowObject.innerWidth = 600;
  windowObject.dispatch("resize");
  assert.equal(element.style.left, "98px");
  assert.equal(element.style.width, "490px");

  header.dispatch("pointerdown", { button: 0, pointerId: 9, clientX: 0, clientY: 0 });
  cleanup();
  cleanup();
  assert.equal(header.listenerCount("pointerdown"), 0);
  assert.equal(header.listenerCount("pointermove"), 0);
  assert.equal(windowObject.listenerCount("resize"), 0);
  assert.equal(element.children.every((child) => child.removed), true);
  assert.equal(element.classList.contains("floating-window"), false);
});

test("missing pointer capture falls back to window events and removes them after release", () => {
  const { documentObject, windowObject } = fakeBrowser();
  const element = new FakeEventTarget(documentObject);
  const header = new FakeEventTarget(documentObject);
  header.setPointerCapture = undefined;
  const completed = [];
  const cleanup = floatingWindow.createFloatingWindow({
    element,
    dragHandle: header,
    defaultGeometry: { left: 100, top: 80, width: 400, height: 300 },
    onInteractionEnd: (result) => completed.push(result.type),
  });

  header.dispatch("pointerdown", { button: 0, pointerId: 10, clientX: 20, clientY: 30 });
  assert.equal(windowObject.listenerCount("pointermove"), 1);
  assert.equal(windowObject.listenerCount("pointerup"), 1);
  assert.equal(windowObject.listenerCount("pointercancel"), 1);
  windowObject.dispatch("pointermove", { pointerId: 10, clientX: 70, clientY: 50 });
  assert.equal(element.style.left, "150px");
  assert.equal(element.style.top, "100px");
  windowObject.dispatch("pointerup", { pointerId: 10 });

  assert.equal(element.classList.contains("is-dragging"), false);
  assert.equal(windowObject.listenerCount("pointermove"), 0);
  assert.equal(windowObject.listenerCount("pointerup"), 0);
  assert.equal(windowObject.listenerCount("pointercancel"), 0);
  assert.deepEqual(completed, ["drag"]);
  cleanup();
});

test("throwing pointer capture uses window cancel and cleanup never leaves fallback listeners", () => {
  const { documentObject, windowObject } = fakeBrowser();
  const element = new FakeEventTarget(documentObject);
  const header = new FakeEventTarget(documentObject);
  header.setPointerCapture = () => { throw new Error("capture unavailable"); };
  const completed = [];
  const cleanup = floatingWindow.createFloatingWindow({
    element,
    dragHandle: header,
    defaultGeometry: { left: 100, top: 80, width: 400, height: 300 },
    onInteractionEnd: (result) => completed.push(result.type),
  });

  header.dispatch("pointerdown", { button: 0, pointerId: 11, clientX: 20, clientY: 30 });
  windowObject.dispatch("pointercancel", { pointerId: 11 });
  assert.equal(element.classList.contains("is-dragging"), false);
  assert.deepEqual(completed, ["drag"]);
  assert.equal(windowObject.listenerCount("pointermove"), 0);
  assert.equal(windowObject.listenerCount("pointerup"), 0);
  assert.equal(windowObject.listenerCount("pointercancel"), 0);

  header.dispatch("pointerdown", { button: 0, pointerId: 12, clientX: 20, clientY: 30 });
  assert.equal(windowObject.listenerCount("pointermove"), 1);
  cleanup();
  cleanup();
  assert.equal(element.classList.contains("is-dragging"), false);
  assert.equal(windowObject.listenerCount("pointermove"), 0);
  assert.equal(windowObject.listenerCount("pointerup"), 0);
  assert.equal(windowObject.listenerCount("pointercancel"), 0);
  assert.deepEqual(completed, ["drag"]);
});

test("lost pointer capture ends once and clears every transient listener", () => {
  const { documentObject, windowObject, values } = fakeBrowser();
  const element = new FakeEventTarget(documentObject);
  const header = new FakeEventTarget(documentObject);
  const completed = [];
  const cleanup = floatingWindow.createFloatingWindow({
    element,
    dragHandle: header,
    storageKey: "lost.geometry",
    defaultGeometry: { left: 100, top: 80, width: 400, height: 300 },
    onInteractionEnd: (result) => completed.push(result.type),
  });

  header.dispatch("pointerdown", { button: 0, pointerId: 13, clientX: 20, clientY: 30 });
  assert.equal(header.listenerCount("lostpointercapture"), 1);
  header.dispatch("pointermove", { pointerId: 13, clientX: 60, clientY: 60 });
  header.dispatch("lostpointercapture", { pointerId: 13 });
  header.dispatch("pointerup", { pointerId: 13 });

  assert.equal(element.classList.contains("is-dragging"), false);
  assert.equal(header.listenerCount("pointermove"), 0);
  assert.equal(header.listenerCount("pointerup"), 0);
  assert.equal(header.listenerCount("pointercancel"), 0);
  assert.equal(header.listenerCount("lostpointercapture"), 0);
  assert.equal(windowObject.listenerCount("pointermove"), 0);
  assert.deepEqual(completed, ["drag"]);
  assert.equal(values.get("lost.geometry"), '{"left":140,"top":110,"width":400,"height":300}');
  cleanup();
});

test("activation order wins across different requested base z-indexes", () => {
  const { documentObject } = fakeBrowser();
  const highElement = new FakeEventTarget(documentObject);
  const highHeader = new FakeEventTarget(documentObject);
  const cleanupHigh = floatingWindow.createFloatingWindow({
    element: highElement,
    dragHandle: highHeader,
    baseZIndex: 200,
    defaultGeometry: { left: 20, top: 20, width: 400, height: 300 },
  });
  const lowElement = new FakeEventTarget(documentObject);
  const lowHeader = new FakeEventTarget(documentObject);
  const cleanupLow = floatingWindow.createFloatingWindow({
    element: lowElement,
    dragHandle: lowHeader,
    baseZIndex: 100,
    defaultGeometry: { left: 40, top: 40, width: 400, height: 300 },
  });

  assert.ok(Number(lowElement.style.zIndex) > Number(highElement.style.zIndex));
  highElement.dispatch("pointerdown");
  assert.ok(Number(highElement.style.zIndex) > Number(lowElement.style.zIndex));

  cleanupHigh();
  cleanupLow();
});
