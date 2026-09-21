/** Return all PDF annotations containing a normalized page point, newest first. */
export function hitTestPdfAnnotations(annotations, pageNumber, x, y) {
  return [...annotations].reverse().filter((annotation) => (
    (!annotation.target_type || annotation.target_type === "pdf")
    && annotation.page_number === pageNumber
    && (annotation.rects || []).some((rect) => (
      x >= rect.x && x <= rect.x + rect.width
      && y >= rect.y && y <= rect.y + rect.height
    ))
  ));
}

/** Keep the selected annotation visible without unnecessarily moving the list. */
export function scrollAnnotationIntoView(list, annotationId) {
  if (!list || !annotationId) return false;
  const item = [...list.querySelectorAll("[data-annotation-id]")]
    .find((candidate) => candidate.dataset.annotationId === annotationId);
  if (!item) return false;
  item.scrollIntoView({ block: "nearest" });
  return true;
}

/** Apply the study-page wide reading layout and keep its control accessible. */
export function setAnnotationReadingMode(body, button, enabled) {
  body.classList.toggle("annotation-reading-mode", enabled);
  if (!button) return;
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "退出宽读" : "宽读批注";
}

/** A paper-scoped preference so one reader's choice never changes another. */
export function annotationFloatModeStorageKey(paperId) {
  return `mylibrary.annotation.float-mode.${paperId}`;
}

export function readAnnotationFloatMode(storage, key) {
  try {
    return storage?.getItem(key) !== "false";
  } catch (_error) {
    return true;
  }
}

export function writeAnnotationFloatMode(storage, key, enabled) {
  try {
    storage?.setItem(key, String(Boolean(enabled)));
  } catch (_error) {
    // Reading still works when privacy settings deny local storage.
  }
}

/** A single global key (not per-paper): reading comfort, not something worth
 * re-tuning for every paper the way float-mode's opt-out is. */
const ANNOTATION_FLOAT_FONT_SIZE_KEY = "mylibrary.annotation.float-font-size";
const ANNOTATION_FLOAT_FONT_SIZE_DEFAULT = 14;
const ANNOTATION_FLOAT_FONT_SIZE_MIN = 11;
const ANNOTATION_FLOAT_FONT_SIZE_MAX = 22;

export function clampAnnotationFloatFontSize(value) {
  return Math.min(ANNOTATION_FLOAT_FONT_SIZE_MAX, Math.max(ANNOTATION_FLOAT_FONT_SIZE_MIN, Math.round(value)));
}

export function readAnnotationFloatFontSize(storage) {
  try {
    const raw = storage?.getItem(ANNOTATION_FLOAT_FONT_SIZE_KEY);
    // Number(null) is 0, not NaN - an explicit null check (no stored value
    // yet) is required, or a first-ever read clamps straight to the minimum
    // instead of falling through to the default.
    if (raw === null || raw === undefined) return ANNOTATION_FLOAT_FONT_SIZE_DEFAULT;
    const saved = Number(raw);
    return Number.isFinite(saved) ? clampAnnotationFloatFontSize(saved) : ANNOTATION_FLOAT_FONT_SIZE_DEFAULT;
  } catch (_error) {
    return ANNOTATION_FLOAT_FONT_SIZE_DEFAULT;
  }
}

export function writeAnnotationFloatFontSize(storage, value) {
  try {
    storage?.setItem(ANNOTATION_FLOAT_FONT_SIZE_KEY, String(value));
  } catch (_error) {
    // Font size still applies for this session without persistence.
  }
}

/** Newest discussion first, with stable input order for equal or bad dates. */
export function sortAnnotationCandidates(annotations) {
  return [...(annotations || [])]
    .map((annotation, index) => ({ annotation, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.annotation?.updated_at || left.annotation?.created_at || "") || 0;
      const rightTime = Date.parse(right.annotation?.updated_at || right.annotation?.created_at || "") || 0;
      return rightTime - leftTime || left.index - right.index;
    })
    .map(({ annotation }) => annotation);
}

export function chooseNextAnnotationCandidate(candidates, removedId) {
  return sortAnnotationCandidates(candidates).find((annotation) => annotation?.id !== removedId) || null;
}

function compactAnnotationPreview(note, maximum) {
  const compact = String(note || "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "仅高亮";
  return compact.length > maximum ? `${compact.slice(0, Math.max(1, maximum - 1)).trimEnd()}…` : compact;
}

/** Labels remain distinguishable even when two annotations start identically. */
export function shortAnnotationCandidateLabels(candidates, maximum = 28) {
  const counts = new Map();
  return (candidates || []).map((annotation) => {
    const preview = compactAnnotationPreview(annotation?.note, maximum);
    const count = (counts.get(preview) || 0) + 1;
    counts.set(preview, count);
    return count === 1 ? preview : `${preview} · ${count}`;
  });
}

/** Keep compact visual tabs while exposing the untruncated note to assistive tech. */
export function annotationCandidateTabLabels(candidates, maximum = 28) {
  const shortLabels = shortAnnotationCandidateLabels(candidates, maximum);
  return (candidates || []).map((annotation, index) => ({
    text: shortLabels[index],
    label: String(annotation?.note || "").replace(/\s+/g, " ").trim() || "仅高亮",
  }));
}

/** Reconcile an open floating thread after sidebar filters change selection. */
export function reconcileFloatingAnnotationSelection(visibleAnnotations, state = {}) {
  const visibleIds = new Set((visibleAnnotations || []).map((annotation) => annotation?.id).filter(Boolean));
  const candidateIds = [...new Set(state.candidateIds || [])].filter((annotationId) => visibleIds.has(annotationId));
  if (!state.floatOpen || !state.currentId || !visibleIds.has(state.currentId)) {
    return { close: Boolean(state.floatOpen), candidateIds };
  }
  if (!candidateIds.length) candidateIds.push(state.currentId);
  return { close: false, candidateIds };
}

/** Decide which thread opens when an overlap picker becomes a floating window. */
export function chooseFloatModeActivation(currentId, candidateIds, annotations) {
  const byId = new Map((annotations || []).map((annotation) => [annotation?.id, annotation]));
  const candidates = sortAnnotationCandidates((candidateIds || [])
    .map((annotationId) => byId.get(annotationId))
    .filter(Boolean));
  const current = byId.get(currentId);
  if (current) return { annotation: current, candidateIds: candidates.length ? candidates.map((item) => item.id) : [current.id] };
  return { annotation: candidates[0] || null, candidateIds: candidates.map((item) => item.id) };
}

/** A late deletion response may only change selection when the user stayed put. */
export function shouldAdoptDeletedAnnotationSurvivor(state, operationRevision, deletedId) {
  return state?.uiRevision === operationRevision && state?.currentId === deletedId;
}

/** Allow normal Markdown links and only image data URLs for rendered images. */
export function isSafeAnnotationUri(value, tagName = "a") {
  const uri = String(value || "").trim();
  if (!uri || uri.startsWith("#") || uri.startsWith("/") || uri.startsWith("./") || uri.startsWith("../")) return true;
  if (/^data:/i.test(uri)) return String(tagName).toUpperCase() === "IMG" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(uri);
  return /^(https?:|mailto:)/i.test(uri);
}

/** Attribute-level policy shared by every Markdown annotation renderer. */
export function isForbiddenAnnotationAttribute(name, value, tagName) {
  const attribute = String(name || "").toLowerCase();
  return attribute === "style" || attribute === "srcset" || attribute.startsWith("on")
    || ((attribute === "href" || attribute === "src") && !isSafeAnnotationUri(value, tagName));
}

/**
 * Let punctuation-ended strong spans flow directly into Chinese prose.
 *
 * CommonMark does not treat the closing marker as right-flanking when the
 * emphasized text ends in punctuation and the following character is a
 * letter. A zero-width HTML entity supplies a delimiter boundary without
 * adding a visible space to Chinese typography.
 */
export function normalizeCjkStrongBoundaries(markdown) {
  const source = String(markdown);
  const codeSpanPattern = /(`+)[\s\S]*?\1/g;
  const normalizeProse = (prose) => prose.replace(
    /(\*\*|__)(?=\S)([^\n]*?[\p{P}\p{S}])\1(?=[\p{L}\p{N}])/gu,
    "$1$2$1&#8203;",
  );
  let normalized = "";
  let offset = 0;
  for (const match of source.matchAll(codeSpanPattern)) {
    normalized += normalizeProse(source.slice(offset, match.index));
    normalized += match[0];
    offset = match.index + match[0].length;
  }
  return normalized + normalizeProse(source.slice(offset));
}
