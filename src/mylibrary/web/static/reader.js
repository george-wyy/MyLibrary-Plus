import { AnnotationPanel } from "/static/annotations.js?v=28";
import { PdfView, renderOutline } from "/static/pdfview.js?v=12";

const body = document.body;
const paperId = body.dataset.paperId;
const pages = document.querySelector("#pdf-pages");
const status = document.querySelector("#reader-status");
const zoomControls = document.querySelector("#zoom-controls");
const zoomDisplay = document.querySelector("#zoom-display");
const chatGptButton = document.querySelector("#open-chatgpt");
const tocToggle = document.querySelector("#toc-toggle");
const tocPanel = document.querySelector("#pdf-toc");
const tocBody = tocPanel.querySelector(".pdf-toc-body");
const pageLayoutToggle = document.querySelector("#page-layout-toggle");
const annotations = JSON.parse(document.querySelector("#initial-annotations").textContent);
const sessionStorageKey = `mylibrary.reader.session.${paperId}`;
let savedSession = readReaderSession();
let selectedAnnotationId = savedSession?.annotationId || null;
let saveTimer = null;

const annotationPanel = new AnnotationPanel({
  paperId,
  annotations,
  onNavigate: navigateToAnnotation,
  onMutation: handleAnnotationMutation,
  onSelectionChange: (annotation) => {
    selectedAnnotationId = annotation.id;
    saveReaderSession();
  },
});

const pdfView = new PdfView({
  container: pages,
  scroller: window,
  paperId,
  pdfUrl: body.dataset.pdfUrl,
  annotations,
  zoomStorageKey: `mylibrary.reader.zoom.${paperId}`,
  pageLayoutStorageKey: "mylibrary.reader.page-layout",
  onStatus: showStatus,
  onSelection: (draft) => annotationPanel.openInlineComposer(draft),
  onAnnotationClick: (ids, anchor) => annotationPanel.openAnnotationClicked(ids, anchor),
  onZoomChange: (zoom) => { zoomDisplay.textContent = `${Math.round(zoom * 100)}%`; },
  onOutlineReady: (outline) => {
    tocToggle.hidden = !outline.length;
    if (outline.length) renderOutline(tocBody, outline, (pageNumber) => { pdfView.scrollToPage(pageNumber); closeToc(); });
  },
});

function syncPageLayoutToggle() {
  const isTwoUp = pdfView.pagesPerRow === 2;
  pageLayoutToggle.classList.toggle("is-active", isTwoUp);
  pageLayoutToggle.setAttribute("aria-pressed", String(isTwoUp));
}
syncPageLayoutToggle();
pageLayoutToggle.addEventListener("click", () => {
  pdfView.setPagesPerRow(pdfView.pagesPerRow === 2 ? 1 : 2);
  syncPageLayoutToggle();
});

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

zoomDisplay.textContent = `${Math.round(pdfView.zoom * 100)}%`;

function showStatus(message) {
  if (message === null) {
    status.hidden = true;
    return;
  }
  status.hidden = false;
  status.textContent = message;
}

zoomControls.addEventListener("click", (event) => {
  const button = event.target.closest("[data-zoom]");
  if (!button) return;
  if (button.dataset.zoom === "in") pdfView.setZoom(pdfView.zoom + 0.1);
  else if (button.dataset.zoom === "out") pdfView.setZoom(pdfView.zoom - 0.1);
  else pdfView.setZoom(1);
});

function navigateToAnnotation(annotation) {
  if (annotation.paper_id !== paperId) {
    const destination = annotation.target_type === "pdf" ? "read" : "study";
    window.location.href = `/paper/${annotation.paper_id}/${destination}#annotation=${encodeURIComponent(annotation.id)}`;
    return;
  }
  if (annotation.target_type && annotation.target_type !== "pdf") {
    window.location.href = `/paper/${paperId}/study#annotation=${encodeURIComponent(annotation.id)}`;
    return;
  }
  pdfView.navigateTo(annotation);
}

function handleAnnotationMutation(type, annotation) {
  if (annotation.target_type && annotation.target_type !== "pdf") return;
  if (type === "created") pdfView.addAnnotation(annotation);
  if (type === "deleted") pdfView.removeAnnotation(annotation);
  // A color change (inline composer re-picking a color) needs a repaint;
  // a plain note edit is a harmless no-op repaint since it doesn't touch color.
  if (type === "updated") { pdfView.removeAnnotation(annotation); pdfView.addAnnotation(annotation); }
}

function readReaderSession() {
  try {
    const value = JSON.parse(window.localStorage.getItem(sessionStorageKey) || "null");
    if (!value || !Number.isFinite(value.scrollY) || value.scrollY < 0) return null;
    return { scrollY: value.scrollY, annotationId: typeof value.annotationId === "string" ? value.annotationId : null };
  } catch (_error) {
    return null;
  }
}

function saveReaderSession() {
  try {
    window.localStorage.setItem(sessionStorageKey, JSON.stringify({ scrollY: window.scrollY, annotationId: selectedAnnotationId }));
  } catch (_error) {
    // Reading position is a convenience; private-mode storage may be unavailable.
  }
}

function scheduleReaderSessionSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveReaderSession, 150);
}

window.addEventListener("scroll", scheduleReaderSessionSave, { passive: true });
window.addEventListener("pagehide", saveReaderSession);

chatGptButton.addEventListener("click", () => {
  // A browser cannot populate another site's file picker. Download first,
  // then open ChatGPT so the file is ready to attach manually.
  const download = document.createElement("a");
  download.href = chatGptButton.dataset.downloadUrl;
  download.download = "";
  document.body.append(download);
  download.click();
  download.remove();
  window.open("https://chatgpt.com/", "_blank", "noopener,noreferrer");
  showStatus("PDF downloaded · attach it in the new ChatGPT conversation");
  window.setTimeout(() => { status.hidden = true; }, 3500);
});

pdfView.render().then(() => {
  const requested = new URLSearchParams(window.location.hash.slice(1)).get("annotation");
  const restored = requested || savedSession?.annotationId;
  if (restored) annotationPanel.select(restored, true);
  if (savedSession) window.requestAnimationFrame(() => window.scrollTo({ top: savedSession.scrollY, behavior: "auto" }));
  savedSession = null;
}).catch((error) => {
  console.error(error);
  showStatus(`Could not display this PDF: ${error?.message || error}`);
});
