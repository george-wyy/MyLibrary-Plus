const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const tagCollator = new Intl.Collator("zh-CN", {
  sensitivity: "base",
  numeric: true,
});

function formatterParts(formatter, value) {
  return Object.fromEntries(
    formatter.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function isSameLocalDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("zh-CN") : "";
}

function tagName(tag) {
  if (typeof tag === "string") return tag.trim();
  if (!tag || typeof tag !== "object") return "";
  if (typeof tag.name === "string") return tag.name.trim();
  if (typeof tag.label === "string") return tag.label.trim();
  return "";
}

function annotationTagNames(annotation) {
  return Array.isArray(annotation?.tags)
    ? annotation.tags.map(tagName).filter(Boolean)
    : [];
}

function appendSearchValue(values, value) {
  if (typeof value === "string" || typeof value === "number") {
    values.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => appendSearchValue(values, item));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const key of ["text", "selected_text", "source_text", "quote", "content", "title", "name", "label"]) {
    appendSearchValue(values, value[key]);
  }
}

function searchableAnnotationValues(annotation) {
  const values = [];
  appendSearchValue(values, annotation.note);
  appendSearchValue(values, annotation.selected_text);
  appendSearchValue(values, annotation.source);
  appendSearchValue(values, annotation.source_text);
  appendSearchValue(values, annotation.paper_title);
  appendSearchValue(values, annotation.title);
  appendSearchValue(values, annotation.paper?.title);

  if (Array.isArray(annotation.replies)) {
    for (const reply of annotation.replies) {
      appendSearchValue(values, reply?.content);
      appendSearchValue(values, reply?.text);
      appendSearchValue(values, reply?.body);
    }
  }

  values.push(...annotationTagNames(annotation));
  return values;
}

export function formatAnnotationTime(value, now = new Date()) {
  if (value === null || value === undefined || value === "") return "";

  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  const reference = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(timestamp.getTime()) || Number.isNaN(reference.getTime())) return "";

  if (isSameLocalDay(timestamp, reference)) {
    const parts = formatterParts(timeFormatter, timestamp);
    return `${parts.hour}:${parts.minute}`;
  }

  return formatAnnotationDateTime(timestamp);
}

export function formatAnnotationDateTime(value) {
  if (value === null || value === undefined || value === "") return "";

  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "";

  const parts = formatterParts(dateTimeFormatter, timestamp);
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

// A WeChat-style read/pending status, derived entirely from data the server
// already sends (replies + last_viewed_at) - no separate "unread" flag to
// keep in sync. The thread's own note counts as the opening "user message",
// so a bare highlight with no note and no user reply never shows a pending
// badge - there's nothing there for the AI to respond to.
export function computeAnnotationStatus(annotation) {
  const replies = Array.isArray(annotation?.replies) ? annotation.replies : [];
  const lastReply = replies.length ? replies[replies.length - 1] : null;
  const hasUserContent = Boolean(annotation?.note) || replies.some((reply) => reply?.role === "user");
  const pendingAi = hasUserContent && (lastReply ? lastReply.role !== "assistant" : true);
  const lastViewedAt = annotation?.last_viewed_at ? new Date(annotation.last_viewed_at).getTime() : 0;
  const unreadReply = replies.some((reply) => {
    if (reply?.role !== "assistant" || !reply?.created_at) return false;
    return new Date(reply.created_at).getTime() > lastViewedAt;
  });
  return { pendingAi, unreadReply, isFavorite: Boolean(annotation?.is_favorite) };
}

export function matchesAnnotation(annotation, query = "", selectedTag = "", selectedStatus = "") {
  const normalizedQuery = normalizeText(query);
  const normalizedTag = normalizeText(selectedTag);
  if (!normalizedQuery && !normalizedTag && !selectedStatus) return true;
  if (!annotation || typeof annotation !== "object") return false;

  const tags = annotationTagNames(annotation).map(normalizeText);
  const tagMatches = !normalizedTag || tags.includes(normalizedTag);
  if (!tagMatches) return false;

  if (selectedStatus) {
    const status = computeAnnotationStatus(annotation);
    if (selectedStatus === "unread" && !status.unreadReply) return false;
    if (selectedStatus === "pending" && !status.pendingAi) return false;
    if (selectedStatus === "favorite" && !status.isFavorite) return false;
  }

  return !normalizedQuery || searchableAnnotationValues(annotation)
    .some((value) => normalizeText(value).includes(normalizedQuery));
}

export function collectAnnotationTags(annotations) {
  const displayNameByKey = new Map();

  if (Array.isArray(annotations)) {
    for (const annotation of annotations) {
      for (const displayName of annotationTagNames(annotation)) {
        const key = normalizeText(displayName);
        if (key && !displayNameByKey.has(key)) displayNameByKey.set(key, displayName);
      }
    }
  }

  return [...displayNameByKey.values()].sort((left, right) => {
    const result = tagCollator.compare(left, right);
    return result || normalizeText(left).localeCompare(normalizeText(right));
  });
}

export function reconcileAnnotationPanelSelection(annotations, state = {}) {
  const visibleIds = new Set(
    (Array.isArray(annotations) ? annotations : [])
      .map((annotation) => annotation?.id)
      .filter(Boolean),
  );
  const currentId = state.currentId || null;
  const candidateIds = Array.isArray(state.candidateIds) ? [...state.candidateIds] : [];
  const activeVisible = !currentId || visibleIds.has(currentId);
  const candidatesVisible = candidateIds.every((annotationId) => visibleIds.has(annotationId));

  if (!activeVisible || !candidatesVisible) {
    return { currentId: null, candidateIds: [], editing: false, editingTags: false };
  }

  return {
    currentId,
    candidateIds,
    editing: Boolean(currentId && state.editing),
    editingTags: Boolean(currentId && state.editingTags),
  };
}

export function isActiveAnnotationTagEdit(state, annotationId, editToken) {
  return Boolean(
    state?.editingTags
    && state.currentId === annotationId
    && state.activeTagEditToken === editToken,
  );
}

export function parseAnnotationTags(value) {
  return typeof value === "string"
    ? value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
    : [];
}

export function resolveAnnotationMutationUi(annotations, state = {}, operationRevision) {
  const selection = reconcileAnnotationPanelSelection(annotations, state);
  const previousCandidateIds = Array.isArray(state.candidateIds) ? state.candidateIds : [];
  const candidatesChanged = previousCandidateIds.length !== selection.candidateIds.length
    || previousCandidateIds.some((annotationId, index) => annotationId !== selection.candidateIds[index]);
  const selectionChanged = (state.currentId || null) !== selection.currentId
    || candidatesChanged
    || Boolean(state.editing) !== selection.editing
    || Boolean(state.editingTags) !== selection.editingTags;

  return {
    ...selection,
    shouldRender: state.uiRevision === operationRevision || selectionChanged,
  };
}
