const DEFAULT_MARGIN = 12;
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 180;
const DEFAULT_RESIZE_EDGES = ["e", "w", "s", "se", "sw"];
const stackEntries = [];

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function geometryLimits(viewport, options = {}) {
  const viewportWidth = Math.max(1, finiteNumber(viewport?.width, 1));
  const viewportHeight = Math.max(1, finiteNumber(viewport?.height, 1));
  const requestedMargin = Math.max(0, finiteNumber(options.margin, DEFAULT_MARGIN));
  const margin = Math.min(requestedMargin, Math.max(0, (Math.min(viewportWidth, viewportHeight) - 1) / 2));
  const maxWidth = Math.max(1, viewportWidth - (margin * 2));
  const maxHeight = Math.max(1, viewportHeight - (margin * 2));
  return {
    margin,
    maxWidth,
    maxHeight,
    minWidth: Math.min(maxWidth, Math.max(1, finiteNumber(options.minWidth, DEFAULT_MIN_WIDTH))),
    minHeight: Math.min(maxHeight, Math.max(1, finiteNumber(options.minHeight, DEFAULT_MIN_HEIGHT))),
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

export function clampFloatingGeometry(geometry, viewport, options = {}) {
  const limits = geometryLimits(viewport, options);
  const width = clamp(finiteNumber(geometry?.width, limits.minWidth), limits.minWidth, limits.maxWidth);
  const height = clamp(finiteNumber(geometry?.height, limits.minHeight), limits.minHeight, limits.maxHeight);
  const left = clamp(
    finiteNumber(geometry?.left, limits.margin),
    limits.margin,
    limits.margin + limits.maxWidth - width,
  );
  const top = clamp(
    finiteNumber(geometry?.top, limits.margin),
    limits.margin,
    limits.margin + limits.maxHeight - height,
  );
  return { left, top, width, height };
}

export function moveFloatingGeometry(geometry, delta, viewport, options = {}) {
  const start = clampFloatingGeometry(geometry, viewport, options);
  return clampFloatingGeometry({
    ...start,
    left: start.left + finiteNumber(delta?.x, 0),
    top: start.top + finiteNumber(delta?.y, 0),
  }, viewport, options);
}

export function resizeFloatingGeometry(geometry, edge, delta, viewport, options = {}) {
  const start = clampFloatingGeometry(geometry, viewport, options);
  const limits = geometryLimits(viewport, options);
  const dx = finiteNumber(delta?.x, 0);
  const dy = finiteNumber(delta?.y, 0);
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  let left = start.left;
  let top = start.top;
  let nextRight = right;
  let nextBottom = bottom;

  if (String(edge).includes("w")) {
    left = clamp(start.left + dx, limits.margin, right - limits.minWidth);
  } else if (String(edge).includes("e")) {
    nextRight = clamp(right + dx, start.left + limits.minWidth, limits.margin + limits.maxWidth);
  }
  if (String(edge).includes("n")) {
    top = clamp(start.top + dy, limits.margin, bottom - limits.minHeight);
  } else if (String(edge).includes("s")) {
    nextBottom = clamp(bottom + dy, start.top + limits.minHeight, limits.margin + limits.maxHeight);
  }

  return clampFloatingGeometry({
    left,
    top,
    width: nextRight - left,
    height: nextBottom - top,
  }, viewport, options);
}

export function serializeFloatingGeometry(geometry) {
  const normalized = {};
  for (const field of ["left", "top", "width", "height"]) {
    if (!Number.isFinite(geometry?.[field])) return null;
    normalized[field] = Math.round(geometry[field]);
  }
  return JSON.stringify(normalized);
}

export function restoreFloatingGeometry(serialized, fallback, viewport, options = {}) {
  let saved = null;
  if (typeof serialized === "string" && serialized.trim()) {
    try {
      saved = JSON.parse(serialized);
    } catch (_error) {
      saved = null;
    }
  } else if (serialized && typeof serialized === "object") {
    saved = serialized;
  }
  const restored = { ...fallback };
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const field of ["left", "top", "width", "height"]) {
      if (Number.isFinite(saved[field])) restored[field] = saved[field];
    }
  }
  return clampFloatingGeometry(restored, viewport, options);
}

function reflowStack() {
  const sharedBase = stackEntries.reduce(
    (highest, entry) => Math.max(highest, entry.baseZIndex),
    0,
  );
  stackEntries.forEach((entry, index) => {
    entry.element.style.zIndex = String(sharedBase + index);
  });
}

function activateStackEntry(entry) {
  const index = stackEntries.indexOf(entry);
  if (index !== -1) stackEntries.splice(index, 1);
  stackEntries.push(entry);
  reflowStack();
}

export function createFloatingWindow({
  element,
  dragHandle,
  storageKey = null,
  defaultGeometry,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  margin = DEFAULT_MARGIN,
  resizeEdges = DEFAULT_RESIZE_EDGES,
  baseZIndex = 120,
  onInteractionEnd = null,
  storage: providedStorage = null,
} = {}) {
  if (!element || !dragHandle) throw new TypeError("element and dragHandle are required");
  const documentObject = element.ownerDocument;
  const windowObject = documentObject?.defaultView;
  if (!documentObject || !windowObject) throw new TypeError("element must belong to a browser document");

  const options = { minWidth, minHeight, margin };
  const viewport = () => ({ width: windowObject.innerWidth, height: windowObject.innerHeight });
  const fallback = typeof defaultGeometry === "function" ? defaultGeometry(viewport()) : defaultGeometry;
  let storage = providedStorage;
  if (!storage) {
    try {
      storage = windowObject.localStorage;
    } catch (_error) {
      storage = null;
    }
  }
  let saved = null;
  if (storage && storageKey) {
    try {
      saved = storage.getItem(storageKey);
    } catch (_error) {
      saved = null;
    }
  }
  let geometry = restoreFloatingGeometry(saved, fallback, viewport(), options);
  let activeInteraction = null;
  let cleaned = false;
  const handles = [];
  const stackEntry = { element, baseZIndex };

  function applyGeometry() {
    element.style.left = `${geometry.left}px`;
    element.style.top = `${geometry.top}px`;
    element.style.width = `${geometry.width}px`;
    element.style.height = `${geometry.height}px`;
  }

  function persistGeometry() {
    if (!storage || !storageKey) return;
    const serialized = serializeFloatingGeometry(geometry);
    if (!serialized) return;
    try {
      storage.setItem(storageKey, serialized);
    } catch (_error) {
      // The floating window remains usable when browser storage is unavailable.
    }
  }

  function endInteraction(event, notify = true) {
    const active = activeInteraction;
    if (!active || (event && event.pointerId !== active.pointerId)) return;
    activeInteraction = null;
    active.listenerTarget.removeEventListener("pointermove", active.move);
    active.listenerTarget.removeEventListener("pointerup", active.stop);
    active.listenerTarget.removeEventListener("pointercancel", active.stop);
    active.captureTarget.removeEventListener("lostpointercapture", active.lost);
    try {
      if (active.captured && active.captureTarget.hasPointerCapture?.(active.pointerId)) {
        active.captureTarget.releasePointerCapture(active.pointerId);
      }
    } catch (_error) {
      // The pointer may already have been released by the browser.
    }
    element.classList.remove("is-dragging", "is-resizing");
    if (!notify) return;
    persistGeometry();
    onInteractionEnd?.({ type: active.type, geometry: { ...geometry }, event });
  }

  function startInteraction(event, type, edge = null) {
    if (cleaned || event.button !== 0 || activeInteraction) return;
    if (type === "drag" && event.target.closest?.("button, a, input, textarea, select, [data-floating-no-drag]")) return;
    event.preventDefault();
    activateStackEntry(stackEntry);
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const origin = geometry;
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const delta = { x: moveEvent.clientX - startX, y: moveEvent.clientY - startY };
      geometry = type === "drag"
        ? moveFloatingGeometry(origin, delta, viewport(), options)
        : resizeFloatingGeometry(origin, edge, delta, viewport(), options);
      applyGeometry();
    };
    const stop = (stopEvent) => endInteraction(stopEvent);
    const lost = (lostEvent) => endInteraction(lostEvent);
    let captured = false;
    if (typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(pointerId);
        captured = typeof target.hasPointerCapture === "function"
          ? target.hasPointerCapture(pointerId)
          : true;
      } catch (_error) {
        captured = false;
      }
    }
    const listenerTarget = captured ? target : windowObject;
    activeInteraction = {
      type,
      pointerId,
      captureTarget: target,
      listenerTarget,
      captured,
      move,
      stop,
      lost,
    };
    element.classList.add(type === "drag" ? "is-dragging" : "is-resizing");
    listenerTarget.addEventListener("pointermove", move);
    listenerTarget.addEventListener("pointerup", stop);
    listenerTarget.addEventListener("pointercancel", stop);
    if (captured) target.addEventListener("lostpointercapture", lost);
  }

  const startDrag = (event) => startInteraction(event, "drag");
  const activate = () => activateStackEntry(stackEntry);
  const resize = () => {
    geometry = clampFloatingGeometry(geometry, viewport(), options);
    applyGeometry();
    persistGeometry();
  };

  element.classList.add("floating-window");
  dragHandle.classList.add("floating-window-drag-handle");
  applyGeometry();
  stackEntries.push(stackEntry);
  activateStackEntry(stackEntry);
  dragHandle.addEventListener("pointerdown", startDrag);
  element.addEventListener("pointerdown", activate);
  for (const edge of resizeEdges) {
    const handle = documentObject.createElement("span");
    handle.className = `floating-window-resize floating-window-resize-${edge}`;
    handle.dataset.floatingResize = edge;
    const startResize = (event) => startInteraction(event, "resize", edge);
    handle.addEventListener("pointerdown", startResize);
    element.append(handle);
    handles.push({ handle, startResize });
  }
  windowObject.addEventListener("resize", resize);

  return function cleanupFloatingWindow() {
    if (cleaned) return;
    cleaned = true;
    endInteraction(null, false);
    dragHandle.removeEventListener("pointerdown", startDrag);
    element.removeEventListener("pointerdown", activate);
    windowObject.removeEventListener("resize", resize);
    handles.forEach(({ handle, startResize }) => {
      handle.removeEventListener("pointerdown", startResize);
      handle.remove();
    });
    dragHandle.classList.remove("floating-window-drag-handle");
    element.classList.remove("floating-window", "is-dragging", "is-resizing");
    const index = stackEntries.indexOf(stackEntry);
    if (index !== -1) stackEntries.splice(index, 1);
    reflowStack();
  };
}
