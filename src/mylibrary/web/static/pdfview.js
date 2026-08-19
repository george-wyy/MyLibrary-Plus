import * as pdfjs from "/static/vendor/pdfjs/pdf.mjs";
import { hitTestPdfAnnotations } from "/static/annotation-interaction.mjs?v=1";
import { annotationMarkColor } from "/static/annotation-colors.mjs?v=1";

pdfjs.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.mjs";
const IGNORE_SELECTOR = ".saved-highlight, .figure-hotspot, .annotation-panel, .annotation-toggle, .annotation-inline-composer, .annotation-float";

/**
 * The pdf.js viewer used by both the full-page reader and the study split view.
 *
 * Both surfaces annotate the same `target_type="pdf"` records, so the rendering,
 * text-selection capture and figure hotspots live here instead of being copied
 * per page. `scroller` is whatever actually scrolls the pages: the window in the
 * reader, the left pane element in the study view.
 */
export class PdfView {
  constructor({
    container,
    scroller = window,
    paperId,
    pdfUrl,
    annotations = [],
    zoomStorageKey = null,
    pageLayoutStorageKey = null,
    maxWidth = 980,
    keyboardZoom = true,
    onStatus = () => {},
    onSelection = () => {},
    onAnnotationClick = () => {},
    onZoomChange = () => {},
    onOutlineReady = () => {},
  }) {
    this.container = container;
    this.scroller = scroller;
    this.isWindow = scroller === window;
    this.paperId = paperId;
    this.pdfUrl = pdfUrl;
    this.annotations = annotations;
    this.zoomStorageKey = zoomStorageKey;
    this.pageLayoutStorageKey = pageLayoutStorageKey;
    this.maxWidth = maxWidth;
    this.keyboardZoom = keyboardZoom;
    this.onStatus = onStatus;
    this.onSelection = onSelection;
    this.onAnnotationClick = onAnnotationClick;
    this.onZoomChange = onZoomChange;
    this.onOutlineReady = onOutlineReady;

    this.document = null;
    this.pageStates = new Map();
    this.figuresByPage = new Map();
    this.pageObserver = null;
    this.fitWidth = maxWidth;
    // Rendering a page rasterizes it to a canvas at full device pixel ratio -
    // expensive enough that letting the IntersectionObserver fire off every
    // newly-visible page at once (e.g. on initial layout, or after a resize)
    // pegs every core at once. Throttle to a couple of pages in flight so the
    // work spreads out instead of bursting.
    this.renderQueue = [];
    this.activeRenders = 0;
    this.maxConcurrentRenders = 2;
    this.zoomTimer = null;
    this.zoom = this.loadSavedZoom();
    this.pagesPerRow = this.loadSavedPageLayout();
    this.container.classList.toggle("pdf-pages-2up", this.pagesPerRow === 2);

    this.bindEvents();
  }

  // --- viewport helpers: the scroller is either the window or a pane ---------
  viewportRect() {
    if (this.isWindow) {
      return { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth, width: window.innerWidth, height: window.innerHeight };
    }
    // clientWidth/Height rather than the border box, so a scrollbar does not
    // get counted as usable width and force a sliver of horizontal scroll.
    const rect = this.scroller.getBoundingClientRect();
    const { clientWidth, clientHeight } = this.scroller;
    return { top: rect.top, left: rect.left, bottom: rect.top + clientHeight, right: rect.left + clientWidth, width: clientWidth, height: clientHeight };
  }

  get scrollX() { return this.isWindow ? window.scrollX : this.scroller.scrollLeft; }

  get scrollY() { return this.isWindow ? window.scrollY : this.scroller.scrollTop; }

  loadSavedZoom() {
    try {
      const saved = Number(window.localStorage.getItem(this.zoomStorageKey));
      return Number.isFinite(saved) && saved >= 0.6 && saved <= 3 ? saved : 1;
    } catch (_error) {
      return 1;
    }
  }

  saveZoom() {
    if (!this.zoomStorageKey) return;
    try {
      window.localStorage.setItem(this.zoomStorageKey, String(this.zoom));
    } catch (_error) {
      // The viewer still works when browser storage is disabled.
    }
  }

  loadSavedPageLayout() {
    try {
      return Number(window.localStorage.getItem(this.pageLayoutStorageKey)) === 2 ? 2 : 1;
    } catch (_error) {
      return 1;
    }
  }

  savePageLayout() {
    if (!this.pageLayoutStorageKey) return;
    try {
      window.localStorage.setItem(this.pageLayoutStorageKey, String(this.pagesPerRow));
    } catch (_error) {
      // The viewer still works when browser storage is disabled.
    }
  }

  /** Per-page width for the current row layout: the full row width, or half
   * of it (minus the grid's own gap) when two pages share a row. */
  computeFitWidth(rawWidth) {
    if (rawWidth <= 0) return this.maxWidth;
    if (this.pagesPerRow !== 2) return Math.min(rawWidth, this.maxWidth);
    const gap = parseFloat(getComputedStyle(this.container).columnGap) || 22;
    return Math.min((rawWidth - gap) / 2, this.maxWidth);
  }

  // --- rendering -------------------------------------------------------------
  async render() {
    this.document = await pdfjs.getDocument({ url: this.pdfUrl }).promise;
    this.loadFigureRegions();
    this.loadOutline().then((outline) => this.onOutlineReady(outline));
    // The container can be zero-width at first render (e.g. its pane starts
    // hidden by a view-mode toggle) - fall back to maxWidth rather than
    // sizing every page down to nothing; refit() picks up the real size once
    // the container becomes visible and its ResizeObserver fires.
    this.fitWidth = this.computeFitWidth(this.viewportRect().width - 32);
    this.onStatus(`Preparing ${this.document.numPages} pages…`);
    this.pageObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const state = this.pageStates.get(Number(entry.target.dataset.pageNumber));
        if (entry.isIntersecting) {
          this.queueRender(state);
        } else {
          // Scrolled back out before its turn came up - drop it rather than
          // spend a render slot on a page the reader can no longer see.
          const pending = this.renderQueue.indexOf(state);
          if (pending !== -1) this.renderQueue.splice(pending, 1);
        }
      });
    }, { root: this.isWindow ? null : this.scroller, rootMargin: "120% 0px" });

    for (let pageNumber = 1; pageNumber <= this.document.numPages; pageNumber += 1) {
      const page = await this.document.getPage(pageNumber);
      const unscaled = page.getViewport({ scale: 1 });
      const state = { pageNumber, page, ratio: unscaled.height / unscaled.width, shell: null, renderedZoom: null, renderedWidth: null, token: 0 };
      const shell = document.createElement("section");
      shell.className = "pdf-page";
      shell.dataset.pageNumber = String(pageNumber);
      state.shell = shell;
      this.pageStates.set(pageNumber, state);
      this.sizePage(state);
      this.container.append(shell);
      this.pageObserver.observe(shell);
    }
    await this.renderPage(this.pageStates.get(1));
    this.onStatus(null);
  }

  sizePage(state) {
    const width = this.fitWidth * this.zoom;
    state.shell.style.width = `${width}px`;
    state.shell.style.height = `${width * state.ratio}px`;
    const content = state.shell.querySelector(".page-content");
    if (content && state.renderedZoom) {
      // Stretch the already-rendered canvas until the sharp re-render lands.
      content.style.transform = `scale(${width / (state.renderedWidth * state.renderedZoom)})`;
    }
  }

  /** Re-fit to the container after a resize (window, or the study pane). */
  refit() {
    // A hidden pane (e.g. a view-mode toggle) reports 0 clientWidth - wait
    // for it to become visible again rather than sizing pages down to nothing.
    const rawWidth = this.viewportRect().width - 32;
    if (rawWidth <= 0) return;
    const width = this.computeFitWidth(rawWidth);
    if (Math.abs(width - this.fitWidth) < 8) return;
    this.fitWidth = width;
    this.container.style.minWidth = "";
    this.pageStates.forEach((state) => this.sizePage(state));
    window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.renderVisiblePages().catch((error) => console.error(error)), 200);
  }

  async renderPage(state) {
    if (!state || (state.renderedZoom === this.zoom && state.renderedWidth === this.fitWidth)) return;
    const targetZoom = this.zoom;
    const targetWidth = this.fitWidth;
    const token = ++state.token;
    const unscaled = state.page.getViewport({ scale: 1 });
    const scale = targetWidth / unscaled.width * targetZoom;
    const viewport = state.page.getViewport({ scale });
    const pixelRatio = window.devicePixelRatio || 1;
    const content = document.createElement("div");
    content.className = "page-content";
    content.style.width = `${viewport.width}px`;
    content.style.height = `${viewport.height}px`;
    content.style.setProperty("--total-scale-factor", String(scale));

    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      content.append(canvas);

      const highlightLayer = document.createElement("div");
      highlightLayer.className = "highlight-layer";
      content.append(highlightLayer);

      const textLayerElement = document.createElement("div");
      textLayerElement.className = "textLayer";
      content.append(textLayerElement);

      await state.page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      }).promise;
      if (token !== state.token || targetZoom !== this.zoom || targetWidth !== this.fitWidth) return;
      const textLayer = new pdfjs.TextLayer({
        textContentSource: await state.page.getTextContent(),
        container: textLayerElement,
        viewport,
      });
      await textLayer.render();
      if (token !== state.token || targetZoom !== this.zoom || targetWidth !== this.fitWidth) return;
      this.annotations
        .filter((item) => item.page_number === state.pageNumber)
        .forEach((item) => this.paintAnnotation(item, content));
      state.shell.replaceChildren(content);
      state.renderedZoom = targetZoom;
      state.renderedWidth = targetWidth;
      this.addFigureHotspots(state);
    } catch (error) {
      if (token === state.token) console.error(`Could not render page ${state.pageNumber}`, error);
    }
  }

  async renderVisiblePages() {
    const box = this.viewportRect();
    const margin = box.height * 1.2;
    const visible = [...this.pageStates.values()].filter((state) => {
      const rect = state.shell.getBoundingClientRect();
      return rect.bottom >= box.top - margin && rect.top <= box.bottom + margin;
    });
    visible.forEach((state) => this.queueRender(state));
    this.onStatus(null);
  }

  /** Queue a page render behind `maxConcurrentRenders` others instead of
   * kicking it off immediately - keeps a burst of newly-visible pages from
   * all rasterizing at once. */
  queueRender(state) {
    if (!state || this.renderQueue.includes(state)) return;
    this.renderQueue.push(state);
    this.drainRenderQueue();
  }

  drainRenderQueue() {
    while (this.activeRenders < this.maxConcurrentRenders && this.renderQueue.length) {
      const state = this.renderQueue.shift();
      this.activeRenders += 1;
      this.renderPage(state).finally(() => {
        this.activeRenders -= 1;
        this.drainRenderQueue();
      });
    }
  }

  // --- annotations -----------------------------------------------------------
  paintAnnotation(annotation, root = this.container) {
    if (annotation.target_type && annotation.target_type !== "pdf") return;
    const page = root.matches?.(`[data-page-number="${annotation.page_number}"]`)
      ? root
      : root.querySelector(`[data-page-number="${annotation.page_number}"]`);
    const layer = root.classList?.contains("page-content")
      ? root.querySelector(".highlight-layer")
      : page?.querySelector(".highlight-layer");
    if (!layer) return;
    annotation.rects.forEach((rect) => {
      const mark = document.createElement("div");
      mark.className = "saved-highlight";
      mark.dataset.annotationId = annotation.id;
      mark.style.left = `${rect.x * 100}%`;
      mark.style.top = `${rect.y * 100}%`;
      mark.style.width = `${rect.width * 100}%`;
      mark.style.height = `${rect.height * 100}%`;
      mark.style.background = annotationMarkColor(annotation.color);
      layer.append(mark);
    });
  }

  addAnnotation(annotation) {
    this.paintAnnotation(annotation);
  }

  removeAnnotation(annotation) {
    this.container.querySelectorAll(`[data-annotation-id="${annotation.id}"]`).forEach((mark) => mark.remove());
  }

  navigateTo(annotation) {
    const state = this.pageStates.get(annotation.page_number);
    if (!state) return;
    state.shell.scrollIntoView({ behavior: "smooth", block: "center" });
    this.renderPage(state).then(() => {
      state.shell.querySelectorAll(`[data-annotation-id="${annotation.id}"]`).forEach((mark) => {
        mark.classList.remove("annotation-flash");
        void mark.offsetWidth;
        mark.classList.add("annotation-flash");
      });
    });
  }

  scrollToPage(pageNumber) {
    const state = this.pageStates.get(pageNumber);
    if (!state) return;
    state.shell.scrollIntoView({ behavior: "smooth", block: "start" });
    this.renderPage(state);
  }

  // --- outline / table of contents (pdf.js' own getOutline(), not custom parsing) ---
  loadOutline() {
    if (!this._outlinePromise) {
      this._outlinePromise = this.document.getOutline()
        .then((raw) => (raw?.length ? this.resolveOutlineItems(raw) : []))
        .catch((error) => {
          console.error("Could not load PDF outline", error);
          return [];
        });
    }
    return this._outlinePromise;
  }

  async resolveOutlineItems(items) {
    const resolved = await Promise.all(items.map(async (item) => {
      const pageNumber = await this.resolveDestPage(item.dest);
      const children = item.items?.length ? await this.resolveOutlineItems(item.items) : [];
      if (pageNumber === null && !children.length) return null;
      return { title: item.title, pageNumber, items: children };
    }));
    return resolved.filter(Boolean);
  }

  async resolveDestPage(dest) {
    try {
      const explicit = typeof dest === "string" ? await this.document.getDestination(dest) : dest;
      const ref = Array.isArray(explicit) ? explicit[0] : null;
      if (ref === null || ref === undefined) return null;
      const pageIndex = typeof ref === "object" ? await this.document.getPageIndex(ref) : ref;
      return pageIndex + 1;
    } catch (_error) {
      return null;
    }
  }

  annotationsAtPoint(clientX, clientY) {
    const page = document.elementFromPoint(clientX, clientY)?.closest(".pdf-page");
    if (!page || !this.container.contains(page)) return [];
    const box = page.getBoundingClientRect();
    const x = (clientX - box.left) / box.width;
    const y = (clientY - box.top) / box.height;
    const pageNumber = Number(page.dataset.pageNumber);
    return hitTestPdfAnnotations(this.annotations, pageNumber, x, y);
  }

  // --- figure hotspots -------------------------------------------------------
  async loadFigureRegions() {
    try {
      const response = await fetch(`/paper/${this.paperId}/figures`);
      if (!response.ok) return;
      (await response.json()).forEach((region) => {
        const list = this.figuresByPage.get(region.page_number) || [];
        list.push(region);
        this.figuresByPage.set(region.page_number, list);
      });
      // Pages may already be rendered before regions arrive; refresh their hotspots.
      this.pageStates.forEach((state) => {
        if (state.renderedZoom !== null) this.addFigureHotspots(state);
      });
    } catch (error) {
      console.error("Could not load figure regions", error);
    }
  }

  addFigureHotspots(state) {
    const content = state.shell.querySelector(".page-content");
    if (!content) return;
    content.querySelector(".figure-layer")?.remove();
    const regions = this.figuresByPage.get(state.pageNumber) || [];
    if (!regions.length) return;
    const layer = document.createElement("div");
    layer.className = "figure-layer";
    regions.forEach((region) => {
      const hot = document.createElement("button");
      hot.type = "button";
      hot.className = "figure-hotspot";
      hot.title = "点一下把整张图标注下来";
      hot.style.left = `${region.x * 100}%`;
      hot.style.top = `${region.y * 100}%`;
      hot.style.width = `${region.width * 100}%`;
      hot.style.height = `${region.height * 100}%`;
      hot.dataset.fx = region.x;
      hot.dataset.fy = region.y;
      hot.dataset.fw = region.width;
      hot.dataset.fh = region.height;
      layer.append(hot);
    });
    content.append(layer);
  }

  // --- zoom ------------------------------------------------------------------
  zoomAnchor(clientX, clientY) {
    const page = document.elementFromPoint(clientX, clientY)?.closest(".pdf-page");
    if (!page || !this.container.contains(page)) return null;
    const box = page.getBoundingClientRect();
    return { pageNumber: Number(page.dataset.pageNumber), x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height };
  }

  /** Width of a full row at the current zoom - one page, or two side by side. */
  rowWidth() {
    if (this.pagesPerRow !== 2) return this.fitWidth * this.zoom + 32;
    const gap = parseFloat(getComputedStyle(this.container).columnGap) || 22;
    return this.fitWidth * this.zoom * 2 + gap + 32;
  }

  setPagesPerRow(value) {
    const next = value === 2 ? 2 : 1;
    if (next === this.pagesPerRow) return;
    this.pagesPerRow = next;
    this.savePageLayout();
    this.container.classList.toggle("pdf-pages-2up", next === 2);
    const box = this.viewportRect();
    this.fitWidth = this.computeFitWidth(box.width - 32);
    this.pageStates.forEach((state) => {
      state.token += 1;
      this.sizePage(state);
    });
    this.container.style.minWidth = `${Math.max(box.width, this.rowWidth())}px`;
    window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.renderVisiblePages().catch((error) => {
      console.error(error);
      this.onStatus(`Could not switch page layout: ${error?.message || error}`);
    }), 180);
  }

  setZoom(value, anchorX = null, anchorY = null) {
    const next = Math.min(3, Math.max(0.6, Math.round(value * 10) / 10));
    if (next === this.zoom) return;
    const box = this.viewportRect();
    const pointX = anchorX === null ? box.left + box.width / 2 : anchorX;
    const pointY = anchorY === null ? box.top + box.height / 2 : anchorY;
    const anchor = this.zoomAnchor(pointX, pointY);
    const previousZoom = this.zoom;
    const centerX = this.scrollX + box.width / 2;
    const centerY = this.scrollY + box.height / 2;
    this.zoom = next;
    this.saveZoom();
    this.onZoomChange(next);
    this.pageStates.forEach((state) => {
      state.token += 1;
      this.sizePage(state);
    });
    this.container.style.minWidth = `${Math.max(box.width, this.rowWidth())}px`;
    if (anchor) {
      const anchored = this.pageStates.get(anchor.pageNumber)?.shell?.getBoundingClientRect();
      if (anchored) this.scroller.scrollBy(anchored.left + anchored.width * anchor.x - pointX, anchored.top + anchored.height * anchor.y - pointY);
    } else {
      const factor = this.zoom / previousZoom;
      this.scroller.scrollTo(Math.max(0, centerX * factor - box.width / 2), Math.max(0, centerY * factor - box.height / 2));
    }
    window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.renderVisiblePages().catch((error) => {
      console.error(error);
      this.onStatus(`Could not zoom this PDF: ${error?.message || error}`);
    }), 180);
  }

  // --- selection -------------------------------------------------------------
  captureSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return null;
    const range = selection.getRangeAt(0);
    const startPage = range.startContainer.parentElement?.closest(".pdf-page");
    const endPage = range.endContainer.parentElement?.closest(".pdf-page");
    if (!startPage || startPage !== endPage || !this.container.contains(startPage)) return null;
    const pageBox = startPage.getBoundingClientRect();
    const rects = [...range.getClientRects()]
      .map((rect) => ({
        x: Math.max(0, rect.left - pageBox.left) / pageBox.width,
        y: Math.max(0, rect.top - pageBox.top) / pageBox.height,
        width: Math.min(rect.width, pageBox.right - rect.left) / pageBox.width,
        height: rect.height / pageBox.height,
      }))
      .filter((rect) => rect.width > 0.001 && rect.height > 0.001 && rect.x < 1 && rect.y < 1);
    if (!rects.length) return null;
    return {
      target_type: "pdf",
      page_number: Number(startPage.dataset.pageNumber),
      selected_text: selection.toString().trim(),
      rects,
      box: range.getBoundingClientRect(),
    };
  }

  bindEvents() {
    document.addEventListener("mouseup", (event) => {
      if (event.target.closest(IGNORE_SELECTOR)) return;
      this.onSelection(this.captureSelection());
    });

    this.container.addEventListener("contextmenu", (event) => this.openAnnotationAt(event));
    this.container.addEventListener("click", (event) => {
      if (window.getSelection()?.toString().trim()) return;
      // Existing annotations take precedence over the transparent figure
      // hotspot. Only an unannotated image starts a new figure annotation.
      if (this.openAnnotationAt(event)) return;
      const hot = event.target.closest(".figure-hotspot");
      const page = hot?.closest(".pdf-page");
      if (!page) return;
      this.onSelection({
        target_type: "pdf",
        page_number: Number(page.dataset.pageNumber),
        selected_text: `图片区域 · 第 ${page.dataset.pageNumber} 页`,
        rects: [{ x: +hot.dataset.fx, y: +hot.dataset.fy, width: +hot.dataset.fw, height: +hot.dataset.fh }],
        box: hot.getBoundingClientRect(),
      });
    });

    // The pane narrows when the annotation panel opens, and the window can be
    // resized; keep the page width fitted to whatever space is left.
    if (this.isWindow) {
      window.addEventListener("resize", () => this.refit());
    } else {
      new ResizeObserver(() => this.refit()).observe(this.scroller);
    }

    const wheelTarget = this.isWindow ? window : this.scroller;
    wheelTarget.addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      this.setZoom(this.zoom + (event.deltaY < 0 ? 0.1 : -0.1), event.clientX, event.clientY);
    }, { passive: false });

    // The study view drives Ctrl +/-/0 itself so both panes zoom together.
    if (!this.keyboardZoom) return;
    window.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (["+", "="].includes(event.key)) {
        event.preventDefault();
        this.setZoom(this.zoom + 0.1);
      } else if (event.key === "-") {
        event.preventDefault();
        this.setZoom(this.zoom - 0.1);
      } else if (event.key === "0") {
        event.preventDefault();
        this.setZoom(1);
      }
    });
  }

  openAnnotationAt(event) {
    const annotations = this.annotationsAtPoint(event.clientX, event.clientY);
    if (!annotations.length) return false;
    event.preventDefault();
    // Highlight marks are pointer-events:none (clicks must reach the text
    // layer underneath for selection to work), so there's no mark element to
    // read a rect from - anchor the editor at the click point itself instead.
    const anchor = { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY };
    this.onAnnotationClick(annotations.map((annotation) => annotation.id), anchor);
    return true;
  }
}

/** Fills a `.pdf-toc-body` container with a flat, indented outline list. Shared
 * by the full-page reader and the study split view so both render it the same way. */
export function renderOutline(container, items, onPick, depth = 0) {
  items.forEach((item) => {
    if (item.pageNumber !== null) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pdf-toc-item";
      button.style.paddingLeft = `${0.9 + depth * 0.9}rem`;
      button.textContent = item.title || "—";
      button.addEventListener("click", () => onPick(item.pageNumber));
      container.append(button);
    }
    if (item.items?.length) renderOutline(container, item.items, onPick, depth + 1);
  });
}
