import { AnnotationPanel } from "/static/annotations.js?v=28";
import { annotationMarkColor } from "/static/annotation-colors.mjs?v=1";
import { createFloatingWindow } from "/static/floating-window.mjs?v=2";
import { PdfView, renderOutline } from "/static/pdfview.js?v=12";
import { renderMathTokens, sanitizeMarkdownHtml, tokenizeMarkdownMath } from "/static/math-markdown.mjs?v=2";

const body = document.body;
const paperId = body.dataset.paperId;
const lecture = document.querySelector("#lecture");
const pdfScroll = document.querySelector("#study-pdf-scroll");
const pdfPages = document.querySelector("#pdf-pages");
const pdfStatus = document.querySelector("#pdf-status");
const zoomControls = document.querySelector("#zoom-controls");
const zoomDisplay = document.querySelector("#zoom-display");
const notesPane = document.querySelector("#study-notes");
const notesZoomControls = document.querySelector("#notes-zoom");
const notesZoomDisplay = document.querySelector("#notes-zoom-display");
const tocToggle = document.querySelector("#toc-toggle");
const tocPanel = document.querySelector("#pdf-toc");
const tocBody = tocPanel.querySelector(".pdf-toc-body");
const pageLayoutToggle = document.querySelector("#page-layout-toggle");
const viewSwitch = document.querySelector("#view-switch");
const studySplit = document.querySelector("#study-split");
let pdfView = null;

// --- 显示模式:只看 PDF / 对照 / 只看讲义(全局偏好,不分论文) ---
const VIEW_MODE_KEY = "mylibrary.study.view-mode";
function readViewMode() {
  try {
    const saved = window.localStorage.getItem(VIEW_MODE_KEY);
    return ["pdf", "notes", "both"].includes(saved) ? saved : "both";
  } catch (_error) {
    return "both";
  }
}
function setViewMode(mode) {
  studySplit.classList.toggle("view-pdf", mode === "pdf");
  studySplit.classList.toggle("view-notes", mode === "notes");
  viewSwitch.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === mode);
  });
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch (_error) {
    // View mode still applies for this session without persistence.
  }
}
viewSwitch.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) setViewMode(button.dataset.view);
});
setViewMode(readViewMode());

// --- 会话:刷新后保留左右两栏的滚动位置和当前打开的批注(镜像 reader.js) ---
const sessionStorageKey = `mylibrary.study.session.${paperId}`;
let savedSession = readStudySession();
let selectedAnnotationId = savedSession?.annotationId || null;
let saveSessionTimer = null;

function readStudySession() {
  try {
    const value = JSON.parse(window.localStorage.getItem(sessionStorageKey) || "null");
    if (!value) return null;
    return {
      pdfScrollY: Number.isFinite(value.pdfScrollY) && value.pdfScrollY >= 0 ? value.pdfScrollY : 0,
      notesScrollY: Number.isFinite(value.notesScrollY) && value.notesScrollY >= 0 ? value.notesScrollY : 0,
      annotationId: typeof value.annotationId === "string" ? value.annotationId : null,
    };
  } catch (_error) {
    return null;
  }
}

function saveStudySession() {
  try {
    window.localStorage.setItem(sessionStorageKey, JSON.stringify({
      pdfScrollY: pdfScroll.scrollTop,
      notesScrollY: notesPane.scrollTop,
      annotationId: selectedAnnotationId,
    }));
  } catch (_error) {
    // Reading position is a convenience; private-mode storage may be unavailable.
  }
}

function scheduleStudySessionSave() {
  window.clearTimeout(saveSessionTimer);
  saveSessionTimer = window.setTimeout(saveStudySession, 150);
}

pdfScroll.addEventListener("scroll", scheduleStudySessionSave, { passive: true });
notesPane.addEventListener("scroll", scheduleStudySessionSave, { passive: true });
window.addEventListener("pagehide", saveStudySession);

function openToc() { tocPanel.hidden = false; tocToggle.hidden = true; }
function closeToc() { tocPanel.hidden = true; tocToggle.hidden = tocBody.childElementCount === 0; }
function toggleToc() {
  if (!tocPanel.hidden) { closeToc(); return; }
  if (tocBody.childElementCount) openToc();
}
tocToggle.addEventListener("click", openToc);
tocPanel.querySelector(".pdf-toc-close").addEventListener("click", closeToc);
// Option/Alt+L toggles the outline. Cmd/Ctrl+L (focus address bar) is
// reserved by the browser and never reaches page JS; Option/Alt is free.
// event.code, not .key - macOS remaps Option+letter to a special character.
window.addEventListener("keydown", (event) => {
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.repeat && event.code === "KeyL") {
    event.preventDefault();
    toggleToc();
  }
});

// --- 右侧讲义的字号缩放(与左侧 PDF 各自独立;Ctrl +/- 同时缩放两侧)---
const NOTES_ZOOM_KEY = `mylibrary.study.notes-zoom.${paperId}`;
const NOTES_BASE_FONT = 16;
let notesZoom = readNotesZoom();

function readNotesZoom() {
  try {
    const saved = Number(window.localStorage.getItem(NOTES_ZOOM_KEY));
    return Number.isFinite(saved) && saved >= 0.7 && saved <= 2.4 ? saved : 1;
  } catch (_error) {
    return 1;
  }
}

function setNotesZoom(value) {
  const next = Math.min(2.4, Math.max(0.7, Math.round(value * 10) / 10));
  notesZoom = next;
  lecture.style.fontSize = `${NOTES_BASE_FONT * next}px`;
  notesZoomDisplay.textContent = `${Math.round(next * 100)}%`;
  try {
    window.localStorage.setItem(NOTES_ZOOM_KEY, String(next));
  } catch (_error) {
    // Zooming still works without persistence.
  }
}

notesZoomControls.addEventListener("click", (event) => {
  const button = event.target.closest("[data-notes-zoom]");
  if (!button) return;
  if (button.dataset.notesZoom === "in") setNotesZoom(notesZoom + 0.1);
  else if (button.dataset.notesZoom === "out") setNotesZoom(notesZoom - 0.1);
  else setNotesZoom(1);
});

// Ctrl+wheel over the notes scales the notes (the PDF pane has its own handler).
notesPane.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setNotesZoom(notesZoom + (event.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

// Keyboard zoom has no pointer to aim at, so it moves both panes together.
window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (["+", "="].includes(event.key)) {
    event.preventDefault();
    setNotesZoom(notesZoom + 0.1);
    pdfView?.setZoom(pdfView.zoom + 0.1);
  } else if (event.key === "-") {
    event.preventDefault();
    setNotesZoom(notesZoom - 0.1);
    pdfView?.setZoom(pdfView.zoom - 0.1);
  } else if (event.key === "0") {
    event.preventDefault();
    setNotesZoom(1);
    pdfView?.setZoom(1);
  }
});

setNotesZoom(notesZoom);

let annotations = [];
let panel = null;

// --- 子弹笔记双链:[[slug|显示文字]] → 可点击弹出的详细概念笔记 ---
// 渲染成按钮时保持"显示文字"不变,因此不影响批注按 textContent 偏移的锚定;
// 展开内容以浮层卡片显示在 #lecture 之外,零风险。
function linkifyWikilinks(markdown) {
  return markdown.replace(/\[\[([^\]|#]+?)(?:\|([^\]]+?))?\]\]/g, (_whole, slug, display) => {
    const s = String(slug).trim().replace(/"/g, "");
    const text = String(display || slug).trim();
    return `<button type="button" class="wikilink" data-slug="${s}">${text}</button>`;
  });
}

let wikilinkPopover = null;
let cleanupWikilinkPopover = null;
function closeWikilinkPopover() {
  cleanupWikilinkPopover?.();
  cleanupWikilinkPopover = null;
  if (wikilinkPopover) { wikilinkPopover.remove(); wikilinkPopover = null; }
}

// --- 概念浮窗的尺寸:默认更宽,可拖边框调整,并记住上次大小 ---
let suppressPopoverClose = false;
const POPOVER_SIZE_KEY = "mylibrary.study.note-popover";
const POPOVER_MIN_WIDTH = 320;
const POPOVER_MIN_HEIGHT = 180;
async function openWikilinkPopover(button) {
  closeWikilinkPopover();
  const slug = button.dataset.slug;
  const pop = document.createElement("div");
  pop.className = "wikilink-popover";
  pop.innerHTML = '<div class="wikilink-pop-head"><span class="wikilink-pop-title"></span>'
    + '<button type="button" class="wikilink-pop-close" aria-label="关闭">×</button></div>'
    + '<div class="wikilink-pop-body markdown-body">加载中…</div>';
  pop.querySelector(".wikilink-pop-title").textContent = "📄 " + button.textContent;
  pop.querySelector(".wikilink-pop-head").title = "拖动标题栏移动窗口，拖动边框调整大小";
  document.body.append(pop);
  wikilinkPopover = pop;
  const anchorRect = button.getBoundingClientRect();
  cleanupWikilinkPopover = createFloatingWindow({
    element: pop,
    dragHandle: pop.querySelector(".wikilink-pop-head"),
    storageKey: POPOVER_SIZE_KEY,
    minWidth: POPOVER_MIN_WIDTH,
    minHeight: POPOVER_MIN_HEIGHT,
    defaultGeometry: (viewport) => ({
      left: anchorRect.left,
      top: anchorRect.bottom + 6,
      width: 680,
      height: Math.round(viewport.height * 0.66),
    }),
    onInteractionEnd: ({ event }) => {
      // Releasing outside the popover can produce a body click; do not treat
      // that release as an intentional click-away close.
      if (event?.type === "pointerup") suppressPopoverClose = true;
    },
  });
  const bodyEl = pop.querySelector(".wikilink-pop-body");
  try {
    const res = await fetch(`/api/notes/${encodeURIComponent(slug)}`);
    if (res.status === 404) { bodyEl.innerHTML = `<p>概念笔记「${slug}」还没写。</p>`; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tokenized = tokenizeMarkdownMath(linkifyWikilinks(data.markdown));
    let html = window.marked.parse(tokenized.markdown);
    if (Array.isArray(data.backlinks) && data.backlinks.length) {
      const items = data.backlinks
        .map((b) => `<li><a href="/paper/${b.paper_id}/study" target="_blank">${b.title}</a></li>`)
        .join("");
      html += `<div class="wikilink-backlinks"><span class="bl-title">🔗 反向链接(引用这条的讲义)</span><ul>${items}</ul></div>`;
    }
    bodyEl.innerHTML = html;
    renderMathTokens(bodyEl, tokenized.formulas);
    sanitizeMarkdownHtml(bodyEl);
    pop.dataset.slug = slug;
    try {
      noteAnnotations = await (await fetch(`/api/notes/${encodeURIComponent(slug)}/annotations`)).json();
    } catch (_e) { noteAnnotations = []; }
    renderNoteHighlights(bodyEl);
  } catch (error) {
    bodyEl.innerHTML = `<p>加载失败:${error.message}</p>`;
  }
}
document.addEventListener("click", (event) => {
  if (event.target.closest(".wikilink-pop-close")) { closeWikilinkPopover(); return; }
  const link = event.target.closest(".wikilink");
  if (link) { event.preventDefault(); openWikilinkPopover(link); return; }
  if (suppressPopoverClose) { suppressPopoverClose = false; return; }
  if (wikilinkPopover && !event.target.closest(".wikilink-popover, .annotation-panel, .annotation-toggle, .annotation-inline-composer, .annotation-float")) closeWikilinkPopover();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeWikilinkPopover(); });

// --- 概念笔记内的批注(双落点:概念笔记共享 + 当前论文)---
let noteAnnotations = [];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function noteOffset(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}
function wrapRangeIn(root, start, end, annotationId, className, color) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; let cursor = 0; let node = walker.nextNode();
  while (node) {
    const length = node.data.length;
    if (cursor < end && cursor + length > start) nodes.push({ node, start: cursor });
    cursor += length; node = walker.nextNode();
  }
  nodes.reverse().forEach((entry) => {
    const originalLength = entry.node.data.length;
    const localStart = Math.max(0, start - entry.start);
    const localEnd = Math.min(originalLength, end - entry.start);
    let selected = entry.node;
    if (localEnd < originalLength) selected.splitText(localEnd);
    if (localStart > 0) selected = selected.splitText(localStart);
    const mark = document.createElement("mark");
    mark.className = className;
    mark.dataset.annotationId = annotationId;
    mark.style.background = annotationMarkColor(color);
    selected.replaceWith(mark); mark.append(selected);
  });
}
function resolveNoteAnchor(root, annotation) {
  const text = root.textContent || "";
  const anchor = annotation.anchor || {};
  const exact = annotation.selected_text;
  const start = Number(anchor.start); const end = Number(anchor.end);
  if (Number.isInteger(start) && Number.isInteger(end) && text.slice(start, end) === exact) return { start, end };
  const index = text.indexOf(exact);
  return index === -1 ? null : { start: index, end: index + exact.length };
}
function renderNoteHighlights(bodyEl) {
  bodyEl.querySelectorAll(".note-annotation-mark").forEach((mark) => mark.replaceWith(...mark.childNodes));
  bodyEl.normalize();
  noteAnnotations.forEach((annotation) => {
    const location = resolveNoteAnchor(bodyEl, annotation);
    if (location) wrapRangeIn(bodyEl, location.start, location.end, annotation.id, "note-annotation-mark", annotation.color);
  });
}
function captureNoteSelection(bodyEl, slug) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
  if (!bodyEl.contains(startElement)) return null;
  const raw = range.toString(); const exact = raw.trim();
  if (!exact) return null;
  const leading = raw.indexOf(exact);
  const full = bodyEl.textContent || "";
  const start = noteOffset(bodyEl, range.startContainer, range.startOffset) + leading;
  const end = start + exact.length;
  return {
    target_type: "note", page_number: 0, selected_text: exact, rects: [],
    anchor: { exact, prefix: full.slice(Math.max(0, start - 200), start), suffix: full.slice(end, end + 200), start, end, note_slug: slug },
    box: range.getBoundingClientRect(),
  };
}
async function refreshNoteHighlights() {
  const pop = wikilinkPopover;
  const bodyEl = pop?.querySelector(".wikilink-pop-body");
  const slug = pop?.dataset.slug;
  if (!bodyEl || !slug) return;
  try {
    noteAnnotations = await (await fetch(`/api/notes/${encodeURIComponent(slug)}/annotations`)).json();
  } catch (_e) { noteAnnotations = []; }
  renderNoteHighlights(bodyEl);
}

document.addEventListener("mouseup", (event) => {
  if (event.target.closest(".annotation-panel, .annotation-toggle, .annotation-inline-composer, .annotation-float")) return;
  const pop = wikilinkPopover;
  if (!pop) return;
  const bodyEl = pop.querySelector(".wikilink-pop-body");
  const draft = bodyEl ? captureNoteSelection(bodyEl, pop.dataset.slug) : null;
  if (draft && panel) panel.openInlineComposer(draft);    // 保存后经 onMutation 刷新浮层高亮
});

document.addEventListener("click", (event) => {
  const mark = event.target.closest(".note-annotation-mark");
  if (!mark) return;
  const annotation = noteAnnotations.find((a) => a.id === mark.dataset.annotationId);
  if (!annotation) return;
  if (annotation.paper_id === paperId && panel) {
    panel.openInlineEditor(annotation, mark.getBoundingClientRect());
  } else {
    window.location.href = `/paper/${annotation.paper_id}/study#annotation=${encodeURIComponent(annotation.id)}`;
  }
});

function textOffset(node, offset) {
  const range = document.createRange();
  range.selectNodeContents(lecture);
  range.setEnd(node, offset);
  return range.toString().length;
}

function captureLectureSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const endElement = range.endContainer.nodeType === Node.TEXT_NODE
    ? range.endContainer.parentElement
    : range.endContainer;
  if (!lecture.contains(startElement) || !lecture.contains(endElement)) return null;
  const raw = range.toString();
  const selectedText = raw.trim();
  if (!selectedText) return null;
  const leading = raw.indexOf(selectedText);
  const fullText = lecture.textContent || "";
  const start = textOffset(range.startContainer, range.startOffset) + leading;
  const end = start + selectedText.length;
  return {
    target_type: "lecture",
    page_number: 0,
    selected_text: selectedText,
    rects: [],
    anchor: {
      exact: selectedText,
      prefix: fullText.slice(Math.max(0, start - 200), start),
      suffix: fullText.slice(end, end + 200),
      start,
      end,
    },
    box: range.getBoundingClientRect(),
  };
}

function resolveLectureAnchor(annotation) {
  const text = lecture.textContent || "";
  const anchor = annotation.anchor || {};
  const exact = annotation.selected_text;
  const start = Number(anchor.start);
  const end = Number(anchor.end);
  if (Number.isInteger(start) && Number.isInteger(end) && text.slice(start, end) === exact) {
    return { start, end };
  }

  const matches = [];
  let index = text.indexOf(exact);
  while (index !== -1) {
    matches.push(index);
    index = text.indexOf(exact, index + 1);
  }
  if (!matches.length) return null;
  if (matches.length === 1) return { start: matches[0], end: matches[0] + exact.length };

  const prefix = String(anchor.prefix || "");
  const suffix = String(anchor.suffix || "");
  const scored = matches.map((candidate) => {
    const before = text.slice(Math.max(0, candidate - prefix.length), candidate);
    const after = text.slice(candidate + exact.length, candidate + exact.length + suffix.length);
    let score = 0;
    for (let i = 1; i <= Math.min(before.length, prefix.length); i += 1) {
      if (before.at(-i) !== prefix.at(-i)) break;
      score += 1;
    }
    for (let i = 0; i < Math.min(after.length, suffix.length); i += 1) {
      if (after[i] !== suffix[i]) break;
      score += 1;
    }
    return { candidate, score };
  }).sort((a, b) => b.score - a.score);
  return { start: scored[0].candidate, end: scored[0].candidate + exact.length };
}

function wrapTextRange(start, end, annotationId, color) {
  const walker = document.createTreeWalker(lecture, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let cursor = 0;
  let node = walker.nextNode();
  while (node) {
    const length = node.data.length;
    if (cursor < end && cursor + length > start) {
      nodes.push({ node, start: cursor });
    }
    cursor += length;
    node = walker.nextNode();
  }
  nodes.reverse().forEach((entry) => {
    const originalLength = entry.node.data.length;
    const localStart = Math.max(0, start - entry.start);
    const localEnd = Math.min(originalLength, end - entry.start);
    let selectedNode = entry.node;
    if (localEnd < originalLength) selectedNode.splitText(localEnd);
    if (localStart > 0) selectedNode = selectedNode.splitText(localStart);
    const mark = document.createElement("mark");
    mark.className = "lecture-annotation-mark";
    mark.dataset.annotationId = annotationId;
    mark.style.background = annotationMarkColor(color);
    selectedNode.replaceWith(mark);
    mark.append(selectedNode);
  });
}

function clearLectureHighlights() {
  [...lecture.querySelectorAll(".lecture-annotation-mark")].reverse().forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
  lecture.normalize();
}

function renderLectureHighlights() {
  clearLectureHighlights();
  annotations
    .filter((annotation) => annotation.target_type === "lecture")
    .forEach((annotation) => {
      const location = resolveLectureAnchor(annotation);
      if (location) wrapTextRange(location.start, location.end, annotation.id, annotation.color);
    });
}

function navigateToAnnotation(annotation) {
  if (annotation.paper_id !== paperId) {
    const destination = annotation.target_type === "lecture" ? "study" : "read";
    window.location.href = `/paper/${annotation.paper_id}/${destination}#annotation=${encodeURIComponent(annotation.id)}`;
    return;
  }
  if (annotation.target_type === "pdf") {
    pdfView?.navigateTo(annotation);
    return;
  }
  const mark = lecture.querySelector(`[data-annotation-id="${annotation.id}"]`);
  if (!mark) return;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  lecture.querySelectorAll(`[data-annotation-id="${annotation.id}"]`).forEach((part) => {
    part.classList.remove("annotation-flash");
    void part.offsetWidth;
    part.classList.add("annotation-flash");
  });
}

function handleMutation(type, annotation) {
  // "updated" is included so a color re-pick (inline composer) repaints the
  // mark - a plain note edit is a harmless no-op repaint since it ignores color.
  if (annotation.target_type === "lecture" && ["created", "deleted", "updated"].includes(type)) {
    renderLectureHighlights();
  }
  if (annotation.target_type === "note" && ["created", "deleted", "updated"].includes(type)) {
    refreshNoteHighlights();
  }
  // PDF annotations made here are the same records the reader shows.
  if ((!annotation.target_type || annotation.target_type === "pdf") && pdfView) {
    if (type === "created") pdfView.addAnnotation(annotation);
    if (type === "deleted") pdfView.removeAnnotation(annotation);
    if (type === "updated") { pdfView.removeAnnotation(annotation); pdfView.addAnnotation(annotation); }
  }
}

// --- 左侧 PDF:与阅读器同一套 pdf.js 视图,批注落到同一份记录 ---
zoomControls.addEventListener("click", (event) => {
  const button = event.target.closest("[data-zoom]");
  if (!button || !pdfView) return;
  if (button.dataset.zoom === "in") pdfView.setZoom(pdfView.zoom + 0.1);
  else if (button.dataset.zoom === "out") pdfView.setZoom(pdfView.zoom - 0.1);
  else pdfView.setZoom(1);
});

function startPdfView() {
  pdfView = new PdfView({
    container: pdfPages,
    scroller: pdfScroll,
    paperId,
    pdfUrl: `/paper/${paperId}/pdf`,
    annotations,
    zoomStorageKey: `mylibrary.study.zoom.${paperId}`,
    pageLayoutStorageKey: "mylibrary.study.page-layout",
    maxWidth: 1400,
    keyboardZoom: false,
    onStatus: (message) => {
      pdfStatus.hidden = message === null;
      if (message !== null) pdfStatus.textContent = message;
    },
    onSelection: (draft) => panel?.openInlineComposer(draft),
    onAnnotationClick: (ids, anchor) => panel?.openAnnotationClicked(ids, anchor),
    onZoomChange: (zoom) => { zoomDisplay.textContent = `${Math.round(zoom * 100)}%`; },
    onOutlineReady: (outline) => {
      tocToggle.hidden = !outline.length;
      if (outline.length) renderOutline(tocBody, outline, (pageNumber) => { pdfView.scrollToPage(pageNumber); closeToc(); });
    },
  });
  zoomDisplay.textContent = `${Math.round(pdfView.zoom * 100)}%`;
  syncPageLayoutToggle();
  return pdfView.render().catch((error) => {
    console.error(error);
    pdfStatus.hidden = false;
    pdfStatus.textContent = `PDF 加载失败：${error?.message || error}`;
  });
}

function syncPageLayoutToggle() {
  const isTwoUp = pdfView?.pagesPerRow === 2;
  pageLayoutToggle.classList.toggle("is-active", isTwoUp);
  pageLayoutToggle.setAttribute("aria-pressed", String(isTwoUp));
}
pageLayoutToggle.addEventListener("click", () => {
  if (!pdfView) return;
  pdfView.setPagesPerRow(pdfView.pagesPerRow === 2 ? 1 : 2);
  syncPageLayoutToggle();
});

document.addEventListener("mouseup", (event) => {
  if (event.target.closest(".annotation-panel, .annotation-toggle, .annotation-inline-composer, .annotation-float")) return;
  const draft = captureLectureSelection();
  if (draft && panel) panel.openInlineComposer(draft);
});

lecture.addEventListener("click", (event) => {
  const mark = event.target.closest(".lecture-annotation-mark");
  if (!mark || !panel) return;
  const annotation = panel.findAnnotation(mark.dataset.annotationId);
  if (annotation) panel.openInlineEditor(annotation, mark.getBoundingClientRect());
});

async function loadLecture() {
  try {
    const response = await fetch(`/paper/${paperId}/lecture.md`);
    if (!response.ok) throw new Error(`讲义 HTTP ${response.status}`);
    window.marked.setOptions({ gfm: true, breaks: false });
    const tokenized = tokenizeMarkdownMath(linkifyWikilinks(await response.text()));
    lecture.innerHTML = window.marked.parse(tokenized.markdown);
    renderMathTokens(lecture, tokenized.formulas);
    sanitizeMarkdownHtml(lecture);
    renderLectureHighlights();
  } catch (error) {
    lecture.replaceChildren();
    const message = document.createElement("p");
    message.className = "study-loading";
    message.textContent = `讲义加载失败：${error.message}`;
    lecture.append(message);
  }
}

async function initialize() {
  try {
    const response = await fetch(`/api/papers/${paperId}/annotations`);
    if (!response.ok) throw new Error(`批注 HTTP ${response.status}`);
    annotations = await response.json();
  } catch (error) {
    console.error("批注加载失败", error);
    annotations = [];
  }
  panel = new AnnotationPanel({
    paperId,
    annotations,
    onNavigate: navigateToAnnotation,
    onMutation: handleMutation,
    onSelectionChange: (annotation) => {
      selectedAnnotationId = annotation.id;
      scheduleStudySessionSave();
    },
  });
  const firstHeaderLink = document.querySelector(".study-head a");
  document.querySelector(".study-head").insertBefore(panel.toggle, firstHeaderLink);
  // The PDF and the lecture load independently: a missing lecture must not
  // cost the annotatable PDF, and vice versa. Scroll-position restore waits
  // for both, since pages/notes need their real height before scrollTo lands
  // anywhere meaningful.
  const pdfReady = startPdfView();
  await loadLecture();
  await pdfReady;
  const requestedAnnotation = new URLSearchParams(window.location.hash.slice(1)).get("annotation");
  const restoredAnnotation = requestedAnnotation || savedSession?.annotationId;
  if (restoredAnnotation) panel.select(restoredAnnotation, true);
  if (savedSession) {
    const { pdfScrollY, notesScrollY } = savedSession;
    window.requestAnimationFrame(() => {
      pdfScroll.scrollTo({ top: pdfScrollY, behavior: "auto" });
      notesPane.scrollTo({ top: notesScrollY, behavior: "auto" });
    });
  }
  savedSession = null;
}

initialize();
