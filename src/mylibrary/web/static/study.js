import { AnnotationPanel } from "/static/annotations.js?v=33";
import { annotationMarkColor } from "/static/annotation-colors.mjs?v=1";
import { createFloatingWindow } from "/static/floating-window.mjs?v=2";
import { PdfView, renderOutline } from "/static/pdfview.js?v=28";
import { renderMathTokens, sanitizeMarkdownHtml, tokenizeMarkdownMath } from "/static/math-markdown.mjs?v=4";
import { initThemeToggle } from "/static/theme.mjs?v=2";
import { clampWidgetHeight, resolveWidgetBlock } from "/static/lecture-widget.mjs?v=1";

initThemeToggle(document.querySelector("#theme-toggle"));

const body = document.body;
const paperId = body.dataset.paperId;
const lecture = document.querySelector("#lecture");
const pdfScroll = document.querySelector("#study-pdf-scroll");
const pdfPages = document.querySelector("#pdf-pages");
const pdfStatus = document.querySelector("#pdf-status");
const pdfFallback = document.querySelector("#pdf-fallback");
const pdfFallbackMessage = document.querySelector("#pdf-fallback-message");
const zoomControls = document.querySelector("#zoom-controls");
const zoomDisplay = document.querySelector("#zoom-display");
const notesPane = document.querySelector("#study-notes");
const notesZoomControls = document.querySelector("#notes-zoom");
const notesZoomDisplay = document.querySelector("#notes-zoom-display");
const tocToggle = document.querySelector("#toc-toggle");
const tocPanel = document.querySelector("#pdf-toc");
const tocBody = tocPanel.querySelector(".pdf-toc-body");
const lectureTocToggle = document.querySelector("#lecture-toc-toggle");
const lectureTocPanel = document.querySelector("#lecture-toc");
const lectureTocBody = lectureTocPanel.querySelector(".pdf-toc-body");
const pageLayoutToggle = document.querySelector("#page-layout-toggle");
const pdfFileSelect = document.querySelector("#pdf-file-select");
const lectureSelectWrap = document.querySelector("#lecture-select-wrap");
const lectureSelect = document.querySelector("#lecture-select");

// A paper can carry several 讲义 (data/lectures/<id>.md plus <id>__<slug>.md).
// "" is the main one, which is also what every pre-multi-lecture annotation
// anchor implies, so the empty string is the right default everywhere.
let lectureVariant = "";
const viewSwitch = document.querySelector("#view-switch");
const layoutToggle = document.querySelector("#layout-toggle");
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

// --- 分屏方向:左右 / 上下(全局偏好,不分论文) ---
const LAYOUT_MODE_KEY = "mylibrary.study.layout-mode";
function readLayoutMode() {
  try {
    return window.localStorage.getItem(LAYOUT_MODE_KEY) === "vertical" ? "vertical" : "horizontal";
  } catch (_error) {
    return "horizontal";
  }
}
function setLayoutMode(mode) {
  studySplit.classList.toggle("layout-vertical", mode === "vertical");
  layoutToggle.textContent = mode === "vertical" ? "⬌" : "⬍";
  layoutToggle.title = mode === "vertical" ? "切换为左右分屏" : "切换为上下分屏";
  layoutToggle.setAttribute("aria-pressed", String(mode === "vertical"));
  try {
    window.localStorage.setItem(LAYOUT_MODE_KEY, mode);
  } catch (_error) {
    // Layout still applies for this session without persistence.
  }
}
layoutToggle.addEventListener("click", () => {
  setLayoutMode(readLayoutMode() === "vertical" ? "horizontal" : "vertical");
});
setLayoutMode(readLayoutMode());

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
      lectureVariant: typeof value.lectureVariant === "string" ? value.lectureVariant : "",
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
      lectureVariant,
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

// --- 讲义自己的目录:独立面板,由讲义 markdown 的标题生成(见 renderLectureToc)---
function openLectureToc() { lectureTocPanel.hidden = false; lectureTocToggle.hidden = true; }
function closeLectureToc() { lectureTocPanel.hidden = true; lectureTocToggle.hidden = lectureTocBody.childElementCount === 0; }
function toggleLectureToc() {
  if (!lectureTocPanel.hidden) { closeLectureToc(); return; }
  if (lectureTocBody.childElementCount) openLectureToc();
}
lectureTocToggle.addEventListener("click", openLectureToc);
lectureTocPanel.querySelector(".pdf-toc-close").addEventListener("click", closeLectureToc);

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
    panel.openAnnotationClicked([annotation.id], mark.getBoundingClientRect());
  } else {
    window.location.href = `/paper/${annotation.paper_id}/study#annotation=${encodeURIComponent(annotation.id)}`;
  }
});

// --- 讲义里的 PDF 跳转链接 --------------------------------------------------
// 讲义可以写 [Ch8.7](#pdfsec=8.7) 或 [第 259 页](#pdf=259)，点了让左边 PDF 跳过去。
// 按书签标题查表（而不是把页码写死在 Markdown 里），这样重新合并 PDF、页码变了
// 也不用改讲义。
let flatOutline = [];
let pendingPdfHash = window.location.hash.slice(1).startsWith("pdf") ? window.location.hash.slice(1) : null;

function flattenOutline(items, out = []) {
  items.forEach((item) => {
    if (item.pageNumber) out.push({ title: String(item.title || "").trim(), pageNumber: item.pageNumber });
    if (item.items?.length) flattenOutline(item.items, out);
  });
  return out;
}

/** 找书签：先要求"以该编号加一个分隔符开头"，避免 8.1 命中 8.10。 */
function outlinePageFor(section) {
  const key = section.trim();
  if (!key) return null;
  const prefixed = flatOutline.find((item) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s:：、.]|$)`).test(item.title));
  if (prefixed) return prefixed.pageNumber;
  const loose = flatOutline.find((item) => item.title.includes(key));
  return loose ? loose.pageNumber : null;
}

lecture.addEventListener("click", (event) => {
  const link = event.target.closest('a[href*="#pdf"]');
  if (!link || !lecture.contains(link)) return;
  const href = link.getAttribute("href") || "";
  // 链接可以带完整路径(指向另一篇的 PDF，比如教材合订本)。指向别篇时就让浏览器
  // 正常跳过去，那边的 study 页读到同一个 hash 会自己滚到位。
  const [path, hash = ""] = href.split("#");
  if (path && !path.endsWith(`/paper/${paperId}/study`)) return;
  event.preventDefault();
  jumpToPdfTarget(hash, link);
});

/** hash 形如 pdfsec=8.7 或 pdf=259；找不到就把链接闪红，不做无声失败。 */
function jumpToPdfTarget(hash, link = null) {
  const bySection = hash.match(/^pdfsec=(.+)$/);
  const byPage = hash.match(/^pdf=(\d+)$/);
  if (!bySection && !byPage) return false;
  const page = bySection ? outlinePageFor(decodeURIComponent(bySection[1])) : Number(byPage[1]);
  if (!page || !pdfView) {
    if (link) {
      link.classList.add("pdf-jump-missing");
      window.setTimeout(() => link.classList.remove("pdf-jump-missing"), 1200);
    }
    return false;
  }
  // 只看讲义模式下 PDF 是 display:none，跳过去也看不见，先切回对照。
  if (studySplit.classList.contains("view-notes")) setViewMode("both");
  pdfView.scrollToPage(page);
  return true;
}

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
      lecture_slug: lectureVariant,
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
    .filter((annotation) => annotation.target_type === "lecture"
      && (annotation.anchor?.lecture_slug || "") === lectureVariant)
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
  // Jumping to a highlight that lives in one of the paper's other 讲义 has to
  // load that lecture first, otherwise its mark is simply not in the DOM.
  if (annotation.target_type === "lecture" && (annotation.anchor?.lecture_slug || "") !== lectureVariant) {
    switchLecture(annotation.anchor?.lecture_slug || "").then(() => navigateToAnnotation(annotation));
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
    pdfUrl: pdfFileSelect ? `/paper/${paperId}/pdf?file_id=${pdfFileSelect.value}` : `/paper/${paperId}/pdf`,
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
      if (outline.length) renderOutline(tocBody, outline, (pageNumber) => { pdfView.scrollToPage(pageNumber); });
      flatOutline = flattenOutline(outline);
      // 从别篇讲义点过来的 /paper/<id>/study#pdfsec=8.7：书签就绪后补跳一次。
      if (pendingPdfHash) {
        jumpToPdfTarget(pendingPdfHash);
        pendingPdfHash = null;
      }
    },
  });
  zoomDisplay.textContent = `${Math.round(pdfView.zoom * 100)}%`;
  syncPageLayoutToggle();
  // pdf-status is a single-line ellipsized pill (see its CSS) meant for
  // transient "loading" text, not a real error plus a clickable escape
  // hatch - pdf-fallback is the separate element for that. It also covers
  // the case (seen in Obsidian's built-in browser) where the worker
  // handshake succeeds and then goes silent partway through rendering, so
  // render() never resolves *or* rejects.
  const RENDER_TIMEOUT_MS = 60000;
  const renderTimeout = window.setTimeout(() => {
    if (pdfFallback.hidden) {
      showPdfFallback({ name: "Timeout", message: `超过 ${RENDER_TIMEOUT_MS / 1000} 秒仍未显示，当前浏览器环境可能不兼容内置的 PDF 渲染` });
    }
  }, RENDER_TIMEOUT_MS);
  return pdfView.render().then(() => {
    window.clearTimeout(renderTimeout);
  }).catch((error) => {
    window.clearTimeout(renderTimeout);
    console.error(error);
    showPdfFallback(error);
  });
}

function showPdfFallback(error) {
  pdfStatus.hidden = true;
  const name = error?.name || "Error";
  const message = error?.message || String(error ?? "unknown error");
  pdfFallbackMessage.textContent = `PDF 渲染失败（${name}）：${message}`;
  pdfFallback.hidden = false;
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

// --- 正文 / SI 等附件切换:整页导航到带 file_id 的 URL,而不是原地重建
// PdfView —— 原地重建需要先拆掉旧实例挂在 pdfPages 上的事件监听(contextmenu/
// click 等),否则新旧实例的监听会叠加,风险和收益不成比例,一次导航够用。 ---
pdfFileSelect?.addEventListener("change", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("file_id", pdfFileSelect.value);
  window.location.href = url.toString();
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
  if (annotation) panel.openAnnotationClicked([annotation.id], mark.getBoundingClientRect());
});

// 给标题分配稳定 id(没有的话就 slug 化文本),重名时追加序号消歧,
// 并且避开页面上已存在的任何 id(比如 pdf-toc/lecture-toc 之类的容器)。
function slugifyHeadingText(text) {
  const base = String(text || "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

function assignHeadingId(heading, usedIds) {
  if (heading.id && !usedIds.has(heading.id)) {
    usedIds.add(heading.id);
    return heading.id;
  }
  const base = slugifyHeadingText(heading.textContent);
  let candidate = base;
  let counter = 2;
  while (usedIds.has(candidate) || document.getElementById(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  usedIds.add(candidate);
  heading.id = candidate;
  return candidate;
}

// 把 #lecture 里的 h1/h2/h3 走一遍,按标题层级嵌套成 renderOutline 认识的
// {title, pageNumber, items} 结构 - pageNumber 这里就是标题的 id 字符串。
function collectLectureTocItems() {
  const usedIds = new Set();
  const root = [];
  const stack = []; // { level, item }
  lecture.querySelectorAll("h1, h2, h3").forEach((heading) => {
    const level = Number(heading.tagName[1]);
    const item = { title: heading.textContent || "—", pageNumber: assignHeadingId(heading, usedIds), items: [] };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].item.items.push(item);
    else root.push(item);
    stack.push({ level, item });
  });
  return root;
}

// 讲义每次(重新)渲染后都要重建目录:清空旧按钮,没有标题时收起入口。
function renderLectureToc() {
  lectureTocBody.replaceChildren();
  const items = collectLectureTocItems();
  if (items.length) {
    renderOutline(lectureTocBody, items, (headingId) => {
      const heading = document.getElementById(headingId);
      if (!heading) return;
      // Not heading.scrollIntoView(): html/body have overflow:hidden (see the
      // min-height:0 comment above) so they don't scroll via user input, but
      // scrollIntoView() can still programmatically nudge their scrollTop,
      // which visibly carries the fixed header off-screen. Scroll only the
      // notes pane itself instead.
      const delta = heading.getBoundingClientRect().top - notesPane.getBoundingClientRect().top;
      notesPane.scrollBy({ top: delta, behavior: "smooth" });
    });
  }
  lectureTocToggle.hidden = !items.length;
  if (!items.length) lectureTocPanel.hidden = true;
}

// 把 ```mermaid 代码块换成 <pre class="mermaid"> 再交给 mermaid 渲染。
// 必须在 sanitizeMarkdownHtml 之后跑：sanitize 只删危险标签/属性，class 会保留。
async function renderMermaidBlocks(root) {
  const codes = [...root.querySelectorAll("pre > code.language-mermaid")];
  if (!codes.length || !window.mermaid) return;
  window.mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "loose",
    flowchart: { htmlLabels: true, curve: "basis", useMaxWidth: true },
    sequence: { useMaxWidth: true }
  });
  const nodes = codes.map((code) => {
    const holder = document.createElement("pre");
    holder.className = "mermaid";
    holder.textContent = code.textContent;
    code.parentElement.replaceWith(holder);
    return holder;
  });
  try {
    await window.mermaid.run({ nodes });
  } catch (error) {
    console.error("mermaid 渲染失败", error);
  }
}

// --- 讲义嵌交互组件:```widget 块 → iframe ---
// 资产放 data/lectures/assets/<paperId>/,由 /paper/<id>/lecture-asset/ 路由供给;
// 块语法和 src 校验见 lecture-widget.mjs。
//
// sandbox 取舍:allow-scripts + allow-same-origin(+ allow-popups 给组件里的外链)。
// 这两个同开等于不隔离——组件能碰父页面的 DOM 和 localStorage。能接受是因为资产只能是
// 库主人自己放进 data/lectures/assets/ 的本地文件,信任级别等同 app 自己的 static;
// 而 same-origin 是刚需:不同源(opaque origin)时加载 /static/vendor/katex/ 的字体会被
// 字体 CORS 挡掉,也读不到 localStorage['mylibrary-theme']。src 只能拼成本站的
// lecture-asset 路由(widgetAssetUrl 拒绝协议/绝对 URL/..),外部页面进不来。
const WIDGET_SANDBOX = "allow-scripts allow-same-origin allow-popups";

// 父页面 → 组件的主题值:"light" | "dark" | "system"("system" = 没有显式选择,
// 组件自己按 prefers-color-scheme)。
function currentTheme() {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
}

function postThemeToWidget(frame) {
  frame.contentWindow?.postMessage({ type: "mylibrary-theme", theme: currentTheme() }, window.location.origin);
}

// 必须在 sanitizeMarkdownHtml 之后跑(同 mermaid:sanitize 会删 IFRAME),并且在
// renderLectureHighlights 之前——批注的文本偏移会把容器标题行/链接文字也算进去,
// 所以这里生成的文字只取决于 widget 块本身,每次渲染都一模一样。
function renderWidgetBlocks(root) {
  root.querySelectorAll("pre > code.language-widget").forEach((code) => {
    const box = document.createElement("div");
    box.className = "lecture-widget";
    let widget;
    try {
      widget = resolveWidgetBlock(paperId, code.textContent);
    } catch (error) {
      box.classList.add("lecture-widget-error");
      box.textContent = `交互组件无法加载：${error.message}`;
      code.parentElement.replaceWith(box);
      return;
    }
    const label = widget.title || "交互组件";
    const head = document.createElement("div");
    head.className = "lecture-widget-head";
    const title = document.createElement("span");
    title.className = "lecture-widget-title";
    title.textContent = label;
    const open = document.createElement("a");
    open.className = "lecture-widget-open";
    open.href = widget.url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "新标签页打开 ↗";
    head.append(title, open);
    const frame = document.createElement("iframe");
    frame.className = "lecture-widget-frame";
    frame.title = label;
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("sandbox", WIDGET_SANDBOX);
    frame.style.height = `${widget.height}px`;
    // 组件加载完先补发一次当前主题(同源组件也可以自己读 localStorage,两条路都通)。
    frame.addEventListener("load", () => postThemeToWidget(frame));
    frame.src = widget.url;
    box.append(head, frame);
    code.parentElement.replaceWith(box);
  });
}

// 组件 → 父页面:{type:"mylibrary-widget-height", height} 自报内容高度。只认讲义里
// widget iframe 发来的(event.source 比对 contentWindow),高度夹在 200–2400px;
// 组件不发就一直用 widget 块写的 height。
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== "mylibrary-widget-height") return;
  const frame = [...lecture.querySelectorAll("iframe.lecture-widget-frame")]
    .find((item) => item.contentWindow === event.source);
  if (!frame) return;
  const height = clampWidgetHeight(data.height, null);
  if (height !== null) frame.style.height = `${height}px`;
});

// 主题切换时通知所有组件。挂在 <html data-theme> 上而不是改 theme.mjs:theme.mjs
// 切换的效果就是改这个属性("system" 是删掉它),观察它不用动三个页面共用的模块
// (以及 app.js/reader.js 里它的 ?v=)。
new MutationObserver(() => {
  lecture.querySelectorAll("iframe.lecture-widget-frame").forEach(postThemeToWidget);
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

async function loadLecture() {
  try {
    const query = lectureVariant ? `?variant=${encodeURIComponent(lectureVariant)}` : "";
    const response = await fetch(`/paper/${paperId}/lecture.md${query}`);
    if (!response.ok) throw new Error(`讲义 HTTP ${response.status}`);
    window.marked.setOptions({ gfm: true, breaks: false });
    const tokenized = tokenizeMarkdownMath(linkifyWikilinks(await response.text()));
    lecture.innerHTML = window.marked.parse(tokenized.markdown);
    renderMathTokens(lecture, tokenized.formulas);
    sanitizeMarkdownHtml(lecture);
    await renderMermaidBlocks(lecture);
    renderWidgetBlocks(lecture);
    renderLectureHighlights();
    renderLectureToc();
  } catch (error) {
    lecture.replaceChildren();
    const message = document.createElement("p");
    message.className = "study-loading";
    message.textContent = `讲义加载失败：${error.message}`;
    lecture.append(message);
    lectureTocBody.replaceChildren();
    lectureTocToggle.hidden = true;
    lectureTocPanel.hidden = true;
  }
}

/** Load the lecture list and, when a paper has more than one, wire the picker. */
async function initLecturePicker() {
  let variants = [];
  try {
    const response = await fetch(`/api/papers/${paperId}/lectures`);
    if (response.ok) variants = await response.json();
  } catch (error) {
    console.error("讲义列表加载失败", error);
  }
  const slugs = variants.map((item) => item.slug);
  // A stored slug can go stale if the file was renamed or removed; fall back to
  // the main lecture rather than fetching a 404.
  if (savedSession && slugs.includes(savedSession.lectureVariant)) lectureVariant = savedSession.lectureVariant;
  if (variants.length < 2) return;
  lectureSelect.replaceChildren(...variants.map((item) => {
    const option = document.createElement("option");
    option.value = item.slug;
    option.textContent = item.title;
    option.selected = item.slug === lectureVariant;
    return option;
  }));
  lectureSelectWrap.hidden = false;
  lectureSelect.addEventListener("change", () => switchLecture(lectureSelect.value));
}

async function switchLecture(slug) {
  if (slug === lectureVariant) return;
  lectureVariant = slug;
  if (lectureSelect.value !== slug) lectureSelect.value = slug;
  notesPane.scrollTo({ top: 0, behavior: "auto" });
  await loadLecture();
  scheduleStudySessionSave();
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
  await initLecturePicker();
  await loadLecture();
  await pdfReady;
  const requestedAnnotation = new URLSearchParams(window.location.hash.slice(1)).get("annotation");
  const restoredAnnotation = requestedAnnotation || savedSession?.annotationId;
  // An explicit #annotation= link wins over everything: the caller asked for that
  // highlight, so switching lectures to reach it is the point. A session-restored
  // selection must not, though - it would yank the reader out of whichever 讲义
  // they last chose and back into the one that annotation happens to live in.
  const restoredIsElsewhere = !requestedAnnotation && annotations.some((item) =>
    item.id === restoredAnnotation
    && item.target_type === "lecture"
    && (item.anchor?.lecture_slug || "") !== lectureVariant);
  if (restoredAnnotation && !restoredIsElsewhere) panel.select(restoredAnnotation, true);
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
