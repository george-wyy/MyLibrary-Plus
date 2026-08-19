import {
  annotationFloatModeStorageKey,
  annotationCandidateTabLabels,
  chooseFloatModeActivation,
  chooseNextAnnotationCandidate,
  isForbiddenAnnotationAttribute,
  normalizeCjkStrongBoundaries,
  readAnnotationFloatMode,
  reconcileFloatingAnnotationSelection,
  scrollAnnotationIntoView,
  setAnnotationReadingMode,
  sortAnnotationCandidates,
  shouldAdoptDeletedAnnotationSurvivor,
  writeAnnotationFloatMode,
} from "/static/annotation-interaction.mjs?v=6";
import {
  collectAnnotationTags,
  formatAnnotationDateTime,
  formatAnnotationTime,
  isActiveAnnotationTagEdit,
  matchesAnnotation,
  parseAnnotationTags,
  reconcileAnnotationPanelSelection,
  resolveAnnotationMutationUi,
} from "/static/annotation-metadata.mjs?v=4";
import { lockAnnotationForm } from "/static/annotation-form-state.mjs?v=1";
import { ANNOTATION_COLORS } from "/static/annotation-colors.mjs?v=1";
import { createFloatingWindow } from "/static/floating-window.mjs?v=2";
import { plainMarkdownPreview, renderMathTokens, tokenizeMarkdownMath } from "/static/math-markdown.mjs?v=2";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Markdown in annotation bodies and replies -------------------------------
// Notes are written (by hand or by an agent) in Markdown, so render them
// instead of showing the raw syntax. `$…$` spans are masked first: Markdown
// would otherwise eat the underscores and asterisks inside formulas.
const FORBIDDEN_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "APPLET", "FORM", "INPUT", "LINK", "META", "BASE", "SVG", "TEMPLATE", "VIDEO", "AUDIO", "SOURCE", "TRACK"]);

function sanitize(root) {
  root.querySelectorAll("*").forEach((node) => {
    if (FORBIDDEN_TAGS.has(node.tagName)) {
      node.remove();
      return;
    }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (isForbiddenAnnotationAttribute(name, value, node.tagName)) {
        node.removeAttribute(attribute.name);
      }
    });
    if (node.tagName === "A") {
      node.target = "_blank";
      node.rel = "noopener noreferrer";
    }
  });
  return root;
}

export function renderMarkdown(text, className = "annotation-md") {
  const raw = String(text ?? "");
  const container = element("div", className);
  if (!window.marked?.parse) {
    // Without the Markdown library the raw text is still readable.
    container.textContent = raw;
    container.style.whiteSpace = "pre-wrap";
    return container;
  }
  const { markdown, formulas } = tokenizeMarkdownMath(raw);
  const html = window.marked.parse(normalizeCjkStrongBoundaries(markdown), { gfm: true, breaks: true });
  container.innerHTML = html;
  renderMathTokens(container, formulas);
  return sanitize(container);
}

/** One-line, syntax-free version of a note for the list preview. */
function plainPreview(text) {
  return plainMarkdownPreview(text);
}

function annotationTagNames(annotation) {
  return Array.isArray(annotation?.tags)
    ? annotation.tags.map((tag) => typeof tag === "string" ? tag : tag?.name).filter(Boolean)
    : [];
}

function renderTagChips(tags, limit = Infinity) {
  const group = element("span", "annotation-tags");
  tags.slice(0, limit).forEach((tag) => group.append(element("span", "annotation-tag-chip", tag)));
  return group;
}

function renderTimestamp(value, label = "") {
  const formatted = formatAnnotationTime(value);
  if (!formatted) return null;
  const timestamp = element("time", "annotation-timestamp", `${label}${formatted}`);
  timestamp.dateTime = value;
  timestamp.title = value;
  return timestamp;
}

function renderExactTimestamp(value, label = "") {
  const formatted = formatAnnotationDateTime(value);
  if (!formatted) return null;
  const timestamp = element("time", "annotation-timestamp annotation-timestamp-exact", `${label}${formatted}`);
  timestamp.dateTime = value;
  timestamp.title = value;
  return timestamp;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  if (response.ok) {
    if (response.status === 204) return null;
    return response.json();
  }
  let message = `HTTP ${response.status}`;
  try {
    const payload = await response.json();
    message = payload.detail || message;
  } catch (_error) {
    // Keep the status fallback for non-JSON failures.
  }
  throw new Error(message);
}

export class AnnotationPanel {
  constructor({ paperId, annotations = [], onNavigate, onMutation, onSelectionChange }) {
    this.paperId = paperId;
    this.currentAnnotations = annotations;
    this.allAnnotations = null;
    this.scope = "current";
    this.onNavigate = onNavigate || (() => {});
    this.onMutation = onMutation || (() => {});
    this.onSelectionChange = onSelectionChange || (() => {});
    this.currentId = null;
    this.candidateIds = [];
    this.draft = null;
    this.editing = false;
    this.editingTags = false;
    this.tagEditSequence = 0;
    this.activeTagEditToken = null;
    this.uiRevision = 0;
    this.readingMode = false;
    this.floatModeStorageKey = annotationFloatModeStorageKey(paperId);
    this.floatMode = readAnnotationFloatMode(window.localStorage, this.floatModeStorageKey);
    this.floatOpen = false;
    this.floatCandidateIds = [];
    this.floatCleanup = null;
    this.suppressFloatOutsideClose = false;
    this.inlineOpen = false;
    this.inlineMode = null;
    this.inlineDraft = null;
    this.inlineAnnotationId = null;
    this.inlineColor = null;
    this.inlineLastSavedNote = "";
    this.inlineToken = 0;
    this.inlineNoteSaveTimer = null;
    this.inlineCommitting = false;
    this.suppressInlineOutsideClose = false;
    this.lastDeletedAnnotation = null;
    this.undoExpireTimer = null;
    this.query = "";
    this.selectedTag = "";
    this.mount();
    this.render();
  }

  mount() {
    this.toggle = element("button", "annotation-toggle");
    this.toggle.type = "button";
    this.toggle.setAttribute("aria-label", "打开批注");
    this.toggle.innerHTML = '<span aria-hidden="true">批注</span><b>0</b>';

    this.panel = element("aside", "annotation-panel");
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "论文批注");
    const readingModeButton = document.body.classList.contains("study-page")
      ? '<button type="button" data-panel-action="reading" aria-pressed="false" title="切换批注阅读模式">宽读</button>'
      : "";
    this.panel.innerHTML = `
      <header class="annotation-panel-head">
        <div><strong>批注</strong><span>PDF 与讲义</span></div>
        <label class="annotation-scope">
          <span>显示范围</span>
          <select data-panel-scope>
            <option value="current">当前论文</option>
            <option value="all">全部批注</option>
          </select>
        </label>
        ${readingModeButton}
        <button type="button" data-panel-action="float" aria-pressed="false" title="以浮窗阅读当前批注">浮窗</button>
        <button type="button" data-panel-action="copy" title="复制 AI 上下文">复制</button>
        <button type="button" data-panel-action="close" aria-label="关闭批注">×</button>
      </header>
      <div class="annotation-panel-status" role="status" aria-live="polite"></div>
      <div class="annotation-panel-filters" aria-label="筛选批注">
        <label class="annotation-query-field">
          <span>搜索批注</span>
          <input type="search" data-annotation-query placeholder="搜索正文、批注或回复" autocomplete="off">
        </label>
        <label class="annotation-tag-field">
          <span>标签</span>
          <select data-annotation-tag-filter>
            <option value="">全部标签</option>
          </select>
        </label>
      </div>
      <div class="annotation-panel-list" aria-label="批注列表"></div>
      <div class="annotation-panel-detail"></div>
    `;
    document.body.append(this.toggle, this.panel);
    this.list = this.panel.querySelector(".annotation-panel-list");
    this.detail = this.panel.querySelector(".annotation-panel-detail");
    this.status = this.panel.querySelector(".annotation-panel-status");
    this.readingButton = this.panel.querySelector('[data-panel-action="reading"]');
    this.floatButton = this.panel.querySelector('[data-panel-action="float"]');
    this.queryInput = this.panel.querySelector("[data-annotation-query]");
    this.tagFilter = this.panel.querySelector("[data-annotation-tag-filter]");

    this.toggle.addEventListener("click", () => this.open());
    this.panel.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.panel.addEventListener("click", (event) => this.handleClick(event));
    this.panel.addEventListener("input", (event) => this.handleInput(event));
    this.panel.addEventListener("change", (event) => this.handleChange(event));
    this.panel.addEventListener("submit", (event) => this.handleSubmit(event));
    this.mountFloat();
    this.mountInline();
    window.addEventListener("resize", () => this.reconcileFloatAvailability());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.floatOpen) { this.closeFloat(); return; }
      if (event.key === "Escape" && this.inlineOpen) { this.closeInlineComposer(); return; }
      // Option/Alt+R toggles the annotation sidebar. Cmd/Ctrl+R was the first
      // choice but Chrome fires its native reload regardless of preventDefault;
      // Option/Alt isn't claimed by any browser or OS shortcut, so it's reliable.
      // event.code (not .key) - macOS remaps Option+letter to produce an
      // accented/special character in .key (Option+R -> "®"), but .code
      // still reports the physical key regardless of modifiers.
      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.repeat && event.code === "KeyR") {
        event.preventDefault();
        if (this.panel.hidden) this.open(); else this.close();
        return;
      }
      // Cmd/Ctrl+Z undoes a just-deleted annotation - only intercepted while
      // there's actually something to undo (lastDeletedAnnotation expires on
      // its own after a few seconds), so native undo elsewhere on the page
      // - e.g. in a text field - is never hijacked once the window has passed.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.repeat
        && event.key.toLowerCase() === "z" && this.lastDeletedAnnotation) {
        event.preventDefault();
        this.undoLastDelete();
      }
    });
    // Same dismiss pattern as the study page's concept-note popover: click
    // anywhere outside the card closes it. Opening the float (a highlight
    // click, a panel-list selection, ...) is itself a click that reaches this
    // same listener on the way up, so suppressFloatOutsideClose swallows
    // exactly that one bubbled event instead of instantly closing what just opened.
    document.addEventListener("click", (event) => {
      if (!this.floatOpen) return;
      if (this.suppressFloatOutsideClose) { this.suppressFloatOutsideClose = false; return; }
      if (event.target.closest(".annotation-float, .annotation-panel, .annotation-toggle, .annotation-inline-composer")) return;
      this.closeFloat();
    });
    // Clicking a color swatch or typing a note commits immediately (see
    // chooseInlineColor/flushInlineNote) - an outside click just closes the
    // card. If nothing was ever picked or typed, closeInlineComposer's flush
    // is a no-op, so an idle selection is silently dropped, matching Zotero.
    document.addEventListener("click", (event) => {
      if (!this.inlineOpen) return;
      if (this.suppressInlineOutsideClose) { this.suppressInlineOutsideClose = false; return; }
      if (event.target.closest(".annotation-inline-composer")) return;
      this.closeInlineComposer();
    });
  }

  mountFloat() {
    this.float = element("section", "annotation-float");
    this.float.hidden = true;
    this.float.setAttribute("aria-label", "当前批注浮窗");
    this.float.innerHTML = `<header class="annotation-float-head"><strong>当前批注</strong><div class="annotation-float-head-actions"><button type="button" data-float-action="sidebar">在侧栏打开</button><button type="button" data-float-action="close" aria-label="关闭批注浮窗">×</button></div></header><div class="annotation-float-tabs" role="tablist" aria-label="同位置批注"></div><div class="annotation-float-content" role="tabpanel"></div>`;
    document.body.append(this.float);
    this.floatTabs = this.float.querySelector(".annotation-float-tabs");
    this.floatContent = this.float.querySelector(".annotation-float-content");
    this.floatHead = this.float.querySelector(".annotation-float-head");
    this.float.addEventListener("click", (event) => this.handleFloatClick(event));
    this.float.addEventListener("keydown", (event) => this.handleFloatKeydown(event));
    this.floatCleanup = createFloatingWindow({
      element: this.float, dragHandle: this.floatHead,
      storageKey: `mylibrary.annotation.float-window.${this.paperId}`,
      defaultGeometry: ({ width, height }) => {
        const defaultWidth = Math.min(480, width - 24);
        const defaultHeight = Math.min(600, height - 24);
        return { width: defaultWidth, height: defaultHeight, left: Math.max(12, Math.round((width - defaultWidth) / 2)), top: Math.max(12, Math.round((height - defaultHeight) / 2)) };
      },
      minWidth: 330, minHeight: 260, baseZIndex: 140,
      onInteractionEnd: ({ event }) => {
        // Releasing a drag/resize outside the card's original bounds can
        // surface as a click on whatever is now underneath the pointer;
        // don't treat that release as an intentional click-away close.
        if (event?.type === "pointerup") this.suppressFloatOutsideClose = true;
      },
    });
    this.reconcileFloatAvailability();
  }

  // --- inline composer: a Zotero-style color+note popup at the selection,
  // for creating a new annotation without leaving the sidebar closed.
  //
  // Interaction model mirrors Zotero's highlight popup: nothing is pre-chosen
  // when it opens. Clicking a color commits immediately (creates the
  // highlight on first click, re-colors it on later clicks) - the mark on
  // the page is real the instant you click, not deferred to some later save.
  // Typing a note behaves the same way: it commits on first input (using a
  // color if one was picked, otherwise the default) and patches afterward.
  // An outside click with neither ever touched just closes the card and
  // nothing is created - there is nothing to flush.
  mountInline() {
    this.inline = element("div", "annotation-inline-composer");
    this.inline.hidden = true;
    this.inline.tabIndex = -1; // focusable as a unit, so Backspace-to-delete works without focusing the textarea
    this.inline.setAttribute("role", "dialog");
    this.inline.setAttribute("aria-label", "批注");

    const colors = element("div", "annotation-inline-colors");
    ANNOTATION_COLORS.forEach(({ key, swatch }) => {
      const button = element("button", "annotation-color-swatch");
      button.type = "button";
      button.dataset.color = key;
      button.style.background = swatch;
      button.title = key;
      button.setAttribute("aria-label", key);
      colors.append(button);
    });
    this.inlineColors = colors;

    this.inlineNote = document.createElement("textarea");
    this.inlineNote.className = "annotation-inline-note";
    this.inlineNote.placeholder = "记录你的理解、疑问或线索…(留空则只高亮)";
    this.inlineNote.rows = 3;
    this.inlineNote.maxLength = 10000;

    const actions = element("div", "annotation-inline-actions");
    this.inlineHint = element("span", "annotation-inline-hint", "点颜色即高亮 · 点击外部完成 · Esc 关闭");
    this.inlineDelete = element("button", "annotation-inline-delete", "删除批注");
    this.inlineDelete.type = "button";
    this.inlineDelete.hidden = true;
    actions.append(this.inlineHint, this.inlineDelete);

    this.inline.append(colors, this.inlineNote, actions);
    document.body.append(this.inline);

    // Keeps the native text selection visible behind the card until a color
    // is actually picked - clicking a swatch would otherwise collapse it
    // immediately via the browser's default mousedown behavior.
    colors.addEventListener("mousedown", (event) => event.preventDefault());
    colors.addEventListener("click", (event) => {
      const swatch = event.target.closest("[data-color]");
      if (swatch) this.chooseInlineColor(swatch.dataset.color);
    });
    this.inlineDelete.addEventListener("click", () => this.deleteInlineAnnotation());
    this.inlineNote.addEventListener("input", () => this.scheduleInlineNoteSave());
    this.inlineNote.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeInlineComposer();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.isComposing || event.keyCode === 229) return; // IME candidate accept
      event.preventDefault();
      this.closeInlineComposer(); // flushes the note, then closes - a "done" shortcut
    });
    // Backspace deletes the whole annotation, but only when the CARD itself
    // is focused (editing mode's initial focus) - not while typing in the
    // note, where Backspace must behave as normal text editing. Checking
    // event.target (not just that the listener is on this.inline, since
    // keydown bubbles from the textarea too) is what makes that distinction.
    this.inline.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && event.target === this.inline && this.inlineMode === "edit") {
        event.preventDefault();
        this.deleteInlineAnnotation();
      }
    });
  }

  markInlineColorSelected(key) {
    this.inlineColors.querySelectorAll("[data-color]").forEach((button) => {
      button.classList.toggle("is-selected", button.dataset.color === key);
    });
  }

  positionInline(anchorRect) {
    const margin = 10;
    const width = this.inline.offsetWidth || 300;
    const height = this.inline.offsetHeight || 200;
    const left = Math.min(window.innerWidth - width - margin, Math.max(margin, anchorRect.left));
    let top = anchorRect.bottom + 8;
    if (top + height > window.innerHeight - margin) top = anchorRect.top - height - 8;
    top = Math.min(window.innerHeight - height - margin, Math.max(margin, top));
    this.inline.style.left = `${left}px`;
    this.inline.style.top = `${top}px`;
  }

  // rawDraft is whatever the selection-capture returned - still carrying its
  // `box` (used only to position the card, then dropped so it never leaks
  // into the POST body).
  openInlineComposer(rawDraft) {
    if (!rawDraft) return;
    const { box: anchorRect, ...draft } = rawDraft;
    if (!anchorRect) return;
    // A previous inline card left open (a new selection was made before
    // finishing the last one) gets its pending note flushed, not discarded.
    if (this.inlineOpen) this.closeInlineComposer();
    this.inlineMode = "create";
    this.inlineDraft = draft;
    this.inlineAnnotationId = null;
    this.inlineColor = null;
    this.inlineLastSavedNote = "";
    this.inlineCommitting = false;
    this.inlineToken += 1;
    this.inlineOpen = true;
    this.inlineNote.value = "";
    this.markInlineColorSelected(null);
    this.inlineDelete.hidden = true;
    this.inlineHint.textContent = "点颜色即高亮 · 点击外部完成 · Esc 关闭";
    this.inline.hidden = false;
    this.positionInline(anchorRect);
    window.setTimeout(() => this.inlineNote.focus(), 0);
    // The click that triggered this open (the "添加批注" toolbar button) is
    // still bubbling and will reach the outside-click listener next.
    this.suppressInlineOutsideClose = true;
    window.setTimeout(() => { this.suppressInlineOutsideClose = false; }, 0);
  }

  // Reopens the same card to edit an EXISTING annotation - color and note
  // are already committed, so a color click PATCHes instead of creating,
  // and Backspace (with the card itself focused, not the textarea) deletes it.
  openInlineEditor(annotation, anchorRect) {
    if (!annotation || !anchorRect) return;
    if (this.inlineOpen) this.closeInlineComposer();
    this.inlineMode = "edit";
    this.inlineDraft = null;
    this.inlineAnnotationId = annotation.id;
    this.inlineColor = annotation.color;
    this.inlineLastSavedNote = annotation.note || "";
    this.inlineCommitting = false;
    this.inlineToken += 1;
    this.inlineOpen = true;
    this.inlineNote.value = annotation.note || "";
    this.markInlineColorSelected(annotation.color);
    this.inlineDelete.hidden = false;
    this.inlineHint.textContent = "Backspace 删除 · 点击外部完成 · Esc 关闭";
    this.inline.hidden = false;
    this.positionInline(anchorRect);
    // Focus the card, not the textarea, so Backspace deletes the annotation
    // by default; clicking into the note switches to normal text editing.
    window.setTimeout(() => this.inline.focus(), 0);
    this.suppressInlineOutsideClose = true;
    window.setTimeout(() => { this.suppressInlineOutsideClose = false; }, 0);

    // The inline card is now the primary surface for this click, but the
    // sidebar (if open) should still track and scroll to whatever was just
    // clicked - and onSelectionChange keeps "last open annotation" in sync
    // for session restore on reload, same as clicking a sidebar list item.
    this.advanceUiRevision();
    this.currentId = annotation.id;
    this.candidateIds = [];
    this.editing = false;
    this.editingTags = false;
    this.activeTagEditToken = null;
    this.onSelectionChange(annotation);
    this.render();
    if (!this.panel.hidden) scrollAnnotationIntoView(this.list, annotation.id);
  }

  closeInlineComposer() {
    this.flushInlineNote();
    this.inlineOpen = false;
    this.inlineDraft = null;
    this.inline.hidden = true;
  }

  async deleteInlineAnnotation() {
    const annotationId = this.inlineAnnotationId;
    if (!annotationId) return;
    const annotation = this.findAnnotation(annotationId);
    if (!annotation) return;
    window.clearTimeout(this.inlineNoteSaveTimer);
    const snapshot = { ...annotation };
    try {
      await this.deleteAnnotationRecord(annotation);
    } catch (error) {
      this.setStatus(`删除失败：${error.message}`);
      return;
    }
    this.rememberDeletedAnnotation(snapshot);
    this.setStatus("批注已删除 · Cmd/Ctrl+Z 撤销");
    if (this.currentId === annotationId) this.currentId = null;
    this.floatCandidateIds = this.floatCandidateIds.filter((id) => id !== annotationId);
    this.render();
    // Close without flushing - the annotation is gone, there's nothing left to save.
    this.inlineOpen = false;
    this.inlineAnnotationId = null;
    this.inline.hidden = true;
  }

  rememberDeletedAnnotation(annotation) {
    this.lastDeletedAnnotation = annotation;
    window.clearTimeout(this.undoExpireTimer);
    // A short, self-expiring window - long enough to catch a "wait, no" but
    // short enough that Cmd/Ctrl+Z reverts to native undo everywhere else
    // once it's stale, rather than staying hijacked indefinitely.
    this.undoExpireTimer = window.setTimeout(() => { this.lastDeletedAnnotation = null; }, 8000);
  }

  async undoLastDelete() {
    const annotation = this.lastDeletedAnnotation;
    if (!annotation) return;
    this.lastDeletedAnnotation = null;
    window.clearTimeout(this.undoExpireTimer);
    try {
      const restored = await this.createAnnotation({
        target_type: annotation.target_type,
        page_number: annotation.page_number,
        selected_text: annotation.selected_text,
        rects: annotation.rects,
        anchor: annotation.anchor,
        color: annotation.color,
        tags: annotation.tags,
      }, annotation.note);
      this.registerCreatedAnnotation(restored);
      this.setStatus("已撤销删除");
      this.render();
    } catch (error) {
      this.setStatus(`撤销失败：${error.message}`);
    }
  }

  async chooseInlineColor(key) {
    if (!this.inlineOpen) return;
    this.markInlineColorSelected(key);
    if (!this.inlineAnnotationId) {
      await this.commitInline(key, this.inlineNote.value.trim());
      return;
    }
    if (key === this.inlineColor) return;
    const annotationId = this.inlineAnnotationId;
    const updated = await this.patchInline(annotationId, { color: key });
    if (updated && this.inlineAnnotationId === annotationId) this.inlineColor = key;
  }

  scheduleInlineNoteSave() {
    window.clearTimeout(this.inlineNoteSaveTimer);
    this.inlineNoteSaveTimer = window.setTimeout(() => this.flushInlineNote(), 500);
  }

  async flushInlineNote() {
    window.clearTimeout(this.inlineNoteSaveTimer);
    if (!this.inlineOpen) return;
    const note = this.inlineNote.value.trim();
    if (!this.inlineAnnotationId) {
      if (!note) return; // nothing picked, nothing typed - nothing to save
      await this.commitInline(this.inlineColor || ANNOTATION_COLORS[0].key, note);
      return;
    }
    if (note === this.inlineLastSavedNote) return;
    const annotationId = this.inlineAnnotationId;
    const updated = await this.patchInline(annotationId, { note });
    if (updated && this.inlineAnnotationId === annotationId) this.inlineLastSavedNote = note;
  }

  async commitInline(color, note) {
    // Guards against a fast double-click on two different swatches before the
    // first POST resolves - without this, both clicks would see no
    // inlineAnnotationId yet and each create a separate annotation.
    if (this.inlineCommitting) return;
    const draft = this.inlineDraft;
    const token = this.inlineToken;
    if (!draft) return;
    this.inlineCommitting = true;
    try {
      const annotation = await this.createAnnotation({ ...draft, color }, note);
      this.registerCreatedAnnotation(annotation);
      // The colored mark now stands in for the native selection - hand off
      // to it rather than showing both at once.
      window.getSelection()?.removeAllRanges();
      if (this.inlineToken === token) {
        this.inlineAnnotationId = annotation.id;
        this.inlineColor = color;
        this.inlineLastSavedNote = note;
        this.markInlineColorSelected(color);
      }
      this.currentId = annotation.id;
      this.onSelectionChange(annotation);
      this.render();
      if (!this.panel.hidden) scrollAnnotationIntoView(this.list, annotation.id);
    } catch (error) {
      this.setStatus(`保存失败：${error.message}`);
    } finally {
      this.inlineCommitting = false;
    }
  }

  async patchInline(annotationId, fields) {
    try {
      const updated = await apiRequest(`/api/papers/${this.paperId}/annotations/${annotationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const annotation = this.findAnnotation(annotationId) || updated;
      Object.assign(annotation, updated);
      this.syncAnnotation(annotation);
      this.onMutation("updated", annotation);
      return updated;
    } catch (error) {
      this.setStatus(`更新失败：${error.message}`);
      return null;
    }
  }

  async createAnnotation(draft, note) {
    return apiRequest(`/api/papers/${this.paperId}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, note }),
    });
  }

  registerCreatedAnnotation(annotation) {
    this.currentAnnotations.push(annotation);
    if (this.allAnnotations) {
      this.allAnnotations.push({ ...annotation, paper_title: document.title.replace(/^(Read|对照阅读) · /, "") });
    }
    this.onMutation("created", annotation);
  }

  async deleteAnnotationRecord(annotation) {
    await apiRequest(`/api/papers/${annotation.paper_id}/annotations/${annotation.id}`, { method: "DELETE" });
    [this.currentAnnotations, this.allAnnotations || []].forEach((collection) => {
      const index = collection.findIndex((item) => item.id === annotation.id);
      if (index !== -1) collection.splice(index, 1);
    });
    this.onMutation("deleted", annotation);
  }

  canFloat() { return !window.matchMedia("(max-width: 640px)").matches; }

  reconcileFloatAvailability() {
    const available = this.canFloat();
    this.floatButton.disabled = !available;
    this.floatButton.title = available ? "以浮窗阅读当前批注" : "窄屏时请使用右侧批注栏";
    if (!available) {
      this.closeFloat();
      if (this.floatMode && this.floatCandidateIds.length > 1) this.restoreSidebarCandidates();
    }
    this.floatButton.setAttribute("aria-pressed", String(this.floatMode && available));
  }

  visibleAnnotations() {
    return this.scope === "all" && this.allAnnotations
      ? this.allAnnotations
      : this.currentAnnotations;
  }

  filteredAnnotations() {
    return this.visibleAnnotations().filter((annotation) => (
      matchesAnnotation(annotation, this.query, this.selectedTag)
    ));
  }

  renderFilters() {
    const availableTags = collectAnnotationTags(this.visibleAnnotations());
    if (this.selectedTag && !availableTags.includes(this.selectedTag)) this.selectedTag = "";
    this.queryInput.value = this.query;
    this.tagFilter.replaceChildren(new Option("全部标签", ""));
    availableTags.forEach((tag) => this.tagFilter.add(new Option(tag, tag)));
    this.tagFilter.value = this.selectedTag;
  }

  reconcileFilterSelection() {
    const previous = {
      currentId: this.currentId,
      candidateIds: [...this.candidateIds],
      editing: this.editing,
      editingTags: this.editingTags,
    };
    const next = reconcileAnnotationPanelSelection(this.filteredAnnotations(), {
      currentId: this.currentId,
      candidateIds: this.candidateIds,
      editing: this.editing,
      editingTags: this.editingTags,
    });
    this.currentId = next.currentId;
    this.candidateIds = next.candidateIds;
    this.editing = next.editing;
    this.editingTags = next.editingTags;
    if (!this.editingTags) this.activeTagEditToken = null;
    return previous.currentId !== next.currentId
      || previous.editing !== next.editing
      || previous.editingTags !== next.editingTags
      || previous.candidateIds.length !== next.candidateIds.length
      || previous.candidateIds.some((annotationId, index) => annotationId !== next.candidateIds[index]);
  }

  advanceUiRevision() {
    this.uiRevision += 1;
  }

  reconcileAfterAsync(operationRevision) {
    const next = resolveAnnotationMutationUi(this.filteredAnnotations(), {
      currentId: this.currentId,
      candidateIds: this.candidateIds,
      editing: this.editing,
      editingTags: this.editingTags,
      uiRevision: this.uiRevision,
    }, operationRevision);
    this.currentId = next.currentId;
    this.candidateIds = next.candidateIds;
    this.editing = next.editing;
    this.editingTags = next.editingTags;
    if (!this.editingTags) this.activeTagEditToken = null;
    return next.shouldRender;
  }

  findAnnotation(annotationId) {
    return (this.allAnnotations || []).find((item) => item.id === annotationId)
      || this.currentAnnotations.find((item) => item.id === annotationId);
  }

  syncAnnotation(updated) {
    [this.currentAnnotations, this.allAnnotations || []].forEach((collection) => {
      const existing = collection.find((item) => item.id === updated.id);
      if (existing && existing !== updated) Object.assign(existing, updated);
    });
  }

  open() {
    this.panel.hidden = false;
    document.body.classList.add("annotation-panel-open");
    setAnnotationReadingMode(document.body, this.readingButton, this.readingMode);
    const visible = this.filteredAnnotations();
    if (!this.currentId && !this.draft && !this.candidateIds.length && visible.length) {
      this.currentId = visible[visible.length - 1].id;
    }
    this.render();
  }

  close() {
    this.panel.hidden = true;
    document.body.classList.remove("annotation-panel-open");
    document.body.classList.remove("annotation-reading-mode");
  }

  openComposer(draft) {
    this.advanceUiRevision();
    this.draft = { ...draft };
    this.currentId = null;
    this.candidateIds = [];
    this.editing = false;
    this.editingTags = false;
    this.activeTagEditToken = null;
    this.open();
    window.setTimeout(() => this.detail.querySelector("textarea")?.focus(), 0);
  }

  select(annotationId, navigate = false) {
    const annotation = this.findAnnotation(annotationId);
    if (!annotation) return;
    this.advanceUiRevision();
    this.draft = null;
    this.currentId = annotation.id;
    this.candidateIds = [];
    this.editing = false;
    this.editingTags = false;
    this.activeTagEditToken = null;
    this.onSelectionChange(annotation);
    this.open();
    scrollAnnotationIntoView(this.list, annotation.id);
    if (navigate) this.onNavigate(annotation);
    if (this.floatMode && this.canFloat()) this.openFloat(annotation, [annotation.id]);
  }

  // Click on an existing highlight/mark in the content (PDF, lecture, or a
  // concept note): a single hit opens the quick inline editor at anchorRect;
  // several overlapping annotations fall back to the existing picker (float
  // tabs or sidebar candidate list) since there's no single mark to anchor to.
  openAnnotationClicked(annotationIds, anchorRect) {
    const candidates = sortAnnotationCandidates([...new Set(annotationIds || [])]
      .map((annotationId) => this.findAnnotation(annotationId))
      .filter(Boolean));
    if (!candidates.length) return;
    if (candidates.length === 1 && anchorRect) {
      this.openInlineEditor(candidates[0], anchorRect);
      return;
    }
    this.choose(annotationIds);
  }

  choose(annotationIds) {
    const candidates = sortAnnotationCandidates([...new Set(annotationIds || [])]
      .map((annotationId) => this.findAnnotation(annotationId))
      .filter(Boolean));
    if (!candidates.length) return;
    if (candidates.length === 1) {
      this.select(candidates[0].id);
      return;
    }
    if (this.floatMode && this.canFloat()) {
      this.advanceUiRevision();
      this.draft = null;
      this.currentId = candidates[0].id;
      this.candidateIds = [];
      this.onSelectionChange(candidates[0]);
      this.editing = false;
      this.editingTags = false;
      this.activeTagEditToken = null;
      this.open();
      scrollAnnotationIntoView(this.list, this.currentId);
      this.openFloat(candidates[0], candidates.map((annotation) => annotation.id));
      return;
    }
    this.advanceUiRevision();
    this.draft = null;
    this.currentId = null;
    this.candidateIds = candidates.map((annotation) => annotation.id);
    this.onSelectionChange(candidates[0]);
    this.editing = false;
    this.editingTags = false;
    this.activeTagEditToken = null;
    this.open();
    scrollAnnotationIntoView(this.list, this.candidateIds[0]);
  }

  floatCandidates() {
    return sortAnnotationCandidates(this.floatCandidateIds.map((annotationId) => this.findAnnotation(annotationId)).filter(Boolean));
  }

  openFloat(annotation, candidateIds = null) {
    if (!this.floatMode || !this.canFloat() || !annotation) return;
    this.floatCandidateIds = candidateIds || this.floatCandidateIds.length ? (candidateIds || this.floatCandidateIds) : [annotation.id];
    if (!this.floatCandidateIds.includes(annotation.id)) this.floatCandidateIds = [annotation.id];
    this.floatOpen = true;
    this.float.hidden = false;
    this.renderFloat(annotation.id);
    // The click that triggered this open (a highlight, a panel-list item, ...)
    // is still bubbling and will reach the outside-click listener next.
    this.suppressFloatOutsideClose = true;
    window.setTimeout(() => { this.suppressFloatOutsideClose = false; }, 0);
  }

  closeFloat() {
    this.floatOpen = false;
    if (this.float) this.float.hidden = true;
  }

  restoreSidebarCandidates() {
    const candidates = this.floatCandidates();
    if (candidates.length > 1) {
      this.currentId = null;
      this.candidateIds = candidates.map((annotation) => annotation.id);
      this.render();
    }
  }

  renderFloat(activeId = this.currentId) {
    if (!this.floatOpen || !this.floatMode || !this.canFloat()) return this.closeFloat();
    const candidates = this.floatCandidates();
    const annotation = candidates.find((item) => item.id === activeId) || candidates[0];
    if (!annotation) return this.closeFloat();
    if (this.currentId !== annotation.id) this.currentId = annotation.id;
    const labels = annotationCandidateTabLabels(candidates);
    this.floatTabs.replaceChildren();
    if (candidates.length > 1) candidates.forEach((candidate, index) => {
      const tab = element("button", "annotation-float-tab", labels[index].text);
      tab.type = "button";
      tab.dataset.annotationId = candidate.id;
      tab.id = `annotation-float-tab-${this.paperId}-${candidate.id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `annotation-float-panel-${this.paperId}`);
      tab.setAttribute("aria-selected", String(candidate.id === annotation.id));
      tab.setAttribute("aria-label", labels[index].label);
      tab.title = labels[index].label;
      if (candidate.id === annotation.id) tab.classList.add("is-active");
      this.floatTabs.append(tab);
    });
    this.floatTabs.hidden = candidates.length < 2;
    this.floatContent.id = `annotation-float-panel-${this.paperId}`;
    this.floatContent.setAttribute("aria-labelledby", candidates.length > 1
      ? `annotation-float-tab-${this.paperId}-${annotation.id}`
      : "");
    const location = annotation.target_type === "lecture" ? "讲义原文" : annotation.target_type === "note" ? `概念笔记:${annotation.anchor?.note_slug || ""}` : `PDF 第 ${annotation.page_number} 页`;
    const article = element("article", "annotation-float-thread");
    article.append(element("span", "annotation-location", location), element("blockquote", "", annotation.selected_text));
    const metadata = element("div", "annotation-thread-metadata");
    const createdAt = renderExactTimestamp(annotation.created_at, "创建 ");
    const updatedAt = renderExactTimestamp(annotation.updated_at, "更新 ");
    if (createdAt) metadata.append(createdAt);
    if (updatedAt) metadata.append(updatedAt);
    article.append(metadata);
    const tags = annotationTagNames(annotation);
    if (tags.length) article.append(renderTagChips(tags));
    article.append(annotation.note ? renderMarkdown(annotation.note, "annotation-md annotation-root-note") : element("p", "annotation-root-note", "这条旧高亮还没有批注内容。"));
    const replies = element("div", "annotation-replies");
    (annotation.replies || []).forEach((reply) => {
      const item = element("div", `annotation-reply role-${reply.role}`);
      const replyMeta = element("div", "annotation-reply-meta");
      replyMeta.append(element("span", "annotation-reply-role", reply.role === "assistant" ? "AI" : "我"));
      const timestamp = renderTimestamp(reply.created_at);
      if (timestamp) replyMeta.append(timestamp);
      item.append(replyMeta, renderMarkdown(reply.content));
      replies.append(item);
    });
    article.append(replies);
    this.floatContent.replaceChildren(article);
  }

  handleFloatClick(event) {
    const action = event.target.closest("[data-float-action]")?.dataset.floatAction;
    if (action === "close") return this.closeFloat();
    if (action === "sidebar") {
      this.open();
      scrollAnnotationIntoView(this.list, this.currentId);
      return;
    }
    const tab = event.target.closest("[data-annotation-id]");
    if (!tab) return;
    this.advanceUiRevision();
    this.currentId = tab.dataset.annotationId;
    this.candidateIds = [];
    const selected = this.findAnnotation(this.currentId);
    if (selected) this.onSelectionChange(selected);
    this.editing = false;
    this.editingTags = false;
    this.render();
    scrollAnnotationIntoView(this.list, this.currentId);
    const annotation = selected || this.findAnnotation(this.currentId);
    if (annotation) this.onNavigate(annotation);
    this.renderFloat(this.currentId);
  }

  handleFloatKeydown(event) {
    const tab = event.target.closest("[role=tab][data-annotation-id]");
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...this.floatTabs.querySelectorAll("[role=tab][data-annotation-id]")];
    const currentIndex = tabs.indexOf(tab);
    if (currentIndex < 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  }

  setStatus(message) {
    this.status.textContent = message;
    if (message) window.setTimeout(() => {
      if (this.status.textContent === message) this.status.textContent = "";
    }, 2600);
  }

  render() {
    this.toggle.querySelector("b").textContent = String(this.visibleAnnotations().length);
    this.renderFilters();
    this.renderList();
    this.renderDetail();
    this.syncFloat();
  }

  syncFloat() {
    if (!this.floatOpen) return;
    const visible = this.filteredAnnotations();
    const next = reconcileFloatingAnnotationSelection(visible, {
      floatOpen: this.floatOpen,
      currentId: this.currentId,
      candidateIds: this.floatCandidateIds,
    });
    this.floatCandidateIds = next.candidateIds;
    if (next.close) return this.closeFloat();
    const active = this.findAnnotation(this.currentId);
    this.renderFloat(active.id);
  }

  renderList() {
    this.list.replaceChildren();
    const visible = this.visibleAnnotations();
    if (!visible.length) {
      const empty = element("p", "annotation-empty", "选中 PDF 或讲义中的文字，即可添加第一条批注。");
      this.list.append(empty);
      return;
    }
    const filtered = this.filteredAnnotations();
    if (!filtered.length) {
      this.list.append(element("p", "annotation-empty annotation-filter-empty", "没有符合当前筛选条件的批注。"));
      return;
    }
    [...filtered].reverse().forEach((annotation) => {
      const button = element("button", "annotation-list-item");
      button.type = "button";
      button.dataset.annotationId = annotation.id;
      if (annotation.id === this.currentId) button.classList.add("is-active");
      if (this.candidateIds.includes(annotation.id)) button.classList.add("is-candidate");
      const location = annotation.target_type === "lecture"
        ? "讲义"
        : annotation.target_type === "note"
        ? `概念:${annotation.anchor?.note_slug || ""}`
        : `PDF · 第 ${annotation.page_number} 页`;
      const label = this.scope === "all" && annotation.paper_title
        ? `${annotation.paper_title} · ${location}`
        : location;
      const listMeta = element("span", "annotation-list-meta");
      listMeta.append(element("span", "annotation-location", label));
      const updatedAt = renderTimestamp(annotation.updated_at, "更新 ");
      if (updatedAt) listMeta.append(updatedAt);
      button.append(
        listMeta,
        element("q", "", annotation.selected_text),
        element("span", "annotation-preview", plainPreview(annotation.note) || "仅高亮"),
      );
      const tags = annotationTagNames(annotation);
      if (tags.length) button.append(renderTagChips(tags, 3));
      this.list.append(button);
    });
  }

  renderDetail() {
    this.detail.replaceChildren();
    if (this.draft) {
      this.detail.append(this.renderComposer());
      return;
    }
    if (this.candidateIds.length) {
      this.detail.append(this.renderCandidatePicker());
      return;
    }
    const annotation = this.findAnnotation(this.currentId);
    if (!annotation) {
      this.detail.append(element("p", "annotation-empty", "从列表选择一条批注查看详情。"));
      return;
    }

    const article = element("article", "annotation-thread");
    const location = annotation.target_type === "lecture"
      ? "讲义原文"
      : annotation.target_type === "note"
      ? `概念笔记:${annotation.anchor?.note_slug || ""}`
      : `PDF 第 ${annotation.page_number} 页`;
    const locationButton = element("button", "annotation-thread-location", location);
    locationButton.type = "button";
    locationButton.dataset.threadAction = "navigate";
    article.append(locationButton, element("blockquote", "", annotation.selected_text));

    const metadata = element("div", "annotation-thread-metadata");
    const createdAt = renderExactTimestamp(annotation.created_at, "创建 ");
    const updatedAt = renderExactTimestamp(annotation.updated_at, "更新 ");
    if (createdAt) metadata.append(createdAt);
    if (updatedAt) metadata.append(updatedAt);
    article.append(metadata);

    const tagSection = element("section", "annotation-thread-tags");
    if (this.editingTags) {
      const form = element("form", "annotation-tags-form");
      form.dataset.form = "tags";
      const label = element("label", "", "标签（用逗号分隔）");
      const input = document.createElement("input");
      input.name = "tags";
      input.type = "text";
      input.maxLength = 2040;
      input.value = annotationTagNames(annotation).join(", ");
      input.placeholder = "例如：方法, 证据, 待确认";
      label.append(input);
      const actions = element("div", "annotation-form-actions");
      const save = element("button", "primary", "保存标签");
      save.type = "submit";
      const cancel = element("button", "", "取消");
      cancel.type = "button";
      cancel.dataset.threadAction = "cancel-tags";
      actions.append(save, cancel, element("span", "annotation-hint", "Enter 保存 · Esc 取消"));
      form.append(label, actions);
      tagSection.append(form);
    } else {
      const tagRow = element("div", "annotation-thread-tag-row");
      const tags = annotationTagNames(annotation);
      tagRow.append(tags.length
        ? renderTagChips(tags)
        : element("span", "annotation-no-tags", "尚无标签"));
      const editTags = element("button", "annotation-edit-tags", "编辑标签");
      editTags.type = "button";
      editTags.dataset.threadAction = "edit-tags";
      tagRow.append(editTags);
      tagSection.append(tagRow);
    }
    article.append(tagSection);

    if (this.editing) {
      const form = element("form", "annotation-edit-form");
      form.dataset.form = "edit";
      const textarea = document.createElement("textarea");
      textarea.name = "note";
      textarea.required = true;
      textarea.maxLength = 10000;
      textarea.rows = 4;
      textarea.value = annotation.note || "";
      const actions = element("div", "annotation-form-actions");
      const save = element("button", "primary", "保存");
      save.type = "submit";
      const cancel = element("button", "", "取消");
      cancel.type = "button";
      cancel.dataset.threadAction = "cancel-edit";
      actions.append(save, cancel, element("span", "annotation-hint", "Enter 保存 · Shift+Enter 换行 · Esc 取消"));
      form.append(textarea, actions);
      article.append(form);
    } else {
      article.append(annotation.note
        ? renderMarkdown(annotation.note, "annotation-md annotation-root-note")
        : element("p", "annotation-root-note", "这条旧高亮还没有批注内容。"));
      const actions = element("div", "annotation-thread-actions");
      const edit = element("button", "", "编辑");
      edit.type = "button";
      edit.dataset.threadAction = "edit";
      const remove = element("button", "danger", "删除");
      remove.type = "button";
      remove.dataset.threadAction = "delete";
      actions.append(edit, remove);
      article.append(actions);
    }

    const replies = element("div", "annotation-replies");
    (annotation.replies || []).forEach((reply) => {
      const item = element("div", `annotation-reply role-${reply.role}`);
      const replyMeta = element("div", "annotation-reply-meta");
      replyMeta.append(element("span", "annotation-reply-role", reply.role === "assistant" ? "AI" : "我"));
      const replyTimestamp = renderTimestamp(reply.created_at);
      if (replyTimestamp) replyMeta.append(replyTimestamp);
      item.append(replyMeta, renderMarkdown(reply.content));
      replies.append(item);
    });
    article.append(replies);

    const replyForm = element("form", "annotation-reply-form");
    replyForm.dataset.form = "reply";
    const reply = document.createElement("textarea");
    reply.name = "content";
    reply.required = true;
    reply.maxLength = 10000;
    reply.rows = 2;
    reply.placeholder = "继续批注…（Enter 发送，Shift+Enter 换行）";
    const submit = element("button", "primary", "回复");
    submit.type = "submit";
    replyForm.append(reply, submit);
    article.append(replyForm);
    this.detail.append(article);
  }

  renderCandidatePicker() {
    const section = element("section", "annotation-candidate-picker");
    section.append(
      element("strong", "annotation-candidate-title", `此处有 ${this.candidateIds.length} 条批注`),
      element("p", "annotation-candidate-hint", "选择一条查看正文与回复。"),
    );
    const choices = element("div", "annotation-candidate-choices");
    this.candidateIds.forEach((annotationId) => {
      const annotation = this.findAnnotation(annotationId);
      if (!annotation) return;
      const button = element("button", "annotation-candidate-choice");
      button.type = "button";
      button.dataset.annotationId = annotation.id;
      button.append(
        element("span", "annotation-preview", plainPreview(annotation.note) || "仅高亮"),
        element("q", "", annotation.selected_text),
      );
      choices.append(button);
    });
    section.append(choices);
    return section;
  }

  renderComposer() {
    const form = element("form", "annotation-compose");
    form.dataset.form = "create";
    const target = this.draft.target_type === "lecture"
      ? "讲义原文"
      : `PDF 第 ${this.draft.page_number} 页`;
    form.append(
      element("span", "annotation-location", target),
      element("blockquote", "", this.draft.selected_text),
    );
    const label = element("label", "", "批注内容");
    const textarea = document.createElement("textarea");
    textarea.name = "note";
    textarea.required = true;
    textarea.maxLength = 10000;
    textarea.rows = 5;
    textarea.placeholder = "记录你的理解、疑问或线索…";
    label.append(textarea);
    const actions = element("div", "annotation-form-actions");
    const save = element("button", "primary", "保存批注");
    save.type = "submit";
    const cancel = element("button", "", "取消");
    cancel.type = "button";
    cancel.dataset.threadAction = "cancel-create";
    actions.append(save, cancel, element("span", "annotation-hint", "Enter 保存 · Shift+Enter 换行 · Esc 取消"));
    form.append(label, actions);
    return form;
  }

  /** Enter saves, Shift+Enter breaks the line, Escape backs out. */
  handleKeydown(event) {
    const field = event.target.closest("textarea, input");
    const form = field?.closest("form[data-form]");
    if (!form) return;
    if (form.getAttribute("aria-busy") === "true") {
      if (["Enter", "Escape"].includes(event.key)) event.preventDefault();
      return;
    }

    if (event.key === "Escape") {
      if (form.dataset.form === "create") {
        event.preventDefault();
        this.advanceUiRevision();
        this.draft = null;
        this.render();
      } else if (form.dataset.form === "edit") {
        event.preventDefault();
        this.advanceUiRevision();
        this.editing = false;
        this.renderDetail();
      } else if (form.dataset.form === "tags") {
        event.preventDefault();
        this.advanceUiRevision();
        this.editingTags = false;
        this.activeTagEditToken = null;
        this.renderDetail();
      } else {
        field.blur();
      }
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    // A Chinese IME uses Enter to accept candidates — never submit mid-composition.
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  async handleClick(event) {
    const panelAction = event.target.closest("[data-panel-action]")?.dataset.panelAction;
    if (panelAction === "close") return this.close();
    if (panelAction === "copy") return this.copyAiContext();
    if (panelAction === "reading") {
      this.readingMode = !this.readingMode;
      setAnnotationReadingMode(document.body, this.readingButton, this.readingMode);
      scrollAnnotationIntoView(this.list, this.currentId || this.candidateIds[0]);
      return;
    }
    if (panelAction === "float") {
      if (!this.canFloat()) return;
      this.floatMode = !this.floatMode;
      writeAnnotationFloatMode(window.localStorage, this.floatModeStorageKey, this.floatMode);
      this.reconcileFloatAvailability();
      if (this.floatMode) {
        const activation = chooseFloatModeActivation(
          this.currentId,
          this.candidateIds,
          this.visibleAnnotations(),
        );
        if (activation.annotation) {
          this.currentId = activation.annotation.id;
          this.candidateIds = [];
          this.editing = false;
          this.editingTags = false;
          this.open();
          scrollAnnotationIntoView(this.list, activation.annotation.id);
          this.openFloat(activation.annotation, activation.candidateIds);
        }
      } else {
        this.closeFloat();
        this.restoreSidebarCandidates();
      }
      return;
    }

    const listItem = event.target.closest("[data-annotation-id]");
    if (listItem) return this.select(listItem.dataset.annotationId, true);

    const action = event.target.closest("[data-thread-action]")?.dataset.threadAction;
    if (!action) return;
    const annotation = this.findAnnotation(this.currentId);
    if (action === "cancel-create") {
      this.advanceUiRevision();
      this.draft = null;
      this.render();
    } else if (action === "edit") {
      this.advanceUiRevision();
      this.editing = true;
      this.editingTags = false;
      this.activeTagEditToken = null;
      this.renderDetail();
      this.detail.querySelector("textarea")?.focus();
    } else if (action === "cancel-edit") {
      this.advanceUiRevision();
      this.editing = false;
      this.renderDetail();
    } else if (action === "edit-tags") {
      this.advanceUiRevision();
      this.editingTags = true;
      this.editing = false;
      this.tagEditSequence += 1;
      this.activeTagEditToken = this.tagEditSequence;
      this.renderDetail();
      this.detail.querySelector('form[data-form="tags"] input')?.focus();
    } else if (action === "cancel-tags") {
      this.advanceUiRevision();
      this.editingTags = false;
      this.activeTagEditToken = null;
      this.renderDetail();
    } else if (action === "navigate" && annotation) {
      this.onNavigate(annotation);
    } else if (action === "delete" && annotation) {
      if (!window.confirm("删除这条批注及其全部回复？")) return;
      const operationRevision = this.uiRevision;
      try {
        const nextFloatAnnotation = chooseNextAnnotationCandidate(this.floatCandidates(), annotation.id);
        await this.deleteAnnotationRecord(annotation);
        this.rememberDeletedAnnotation({ ...annotation });
        this.floatCandidateIds = this.floatCandidateIds.filter((annotationId) => annotationId !== annotation.id);
        this.setStatus("批注已删除 · Cmd/Ctrl+Z 撤销");
        const adoptsSurvivor = shouldAdoptDeletedAnnotationSurvivor(this, operationRevision, annotation.id);
        if (this.floatOpen && nextFloatAnnotation && adoptsSurvivor) {
          this.currentId = nextFloatAnnotation.id;
          this.candidateIds = [];
          this.render();
          scrollAnnotationIntoView(this.list, nextFloatAnnotation.id);
        } else if (this.floatOpen && adoptsSurvivor) {
          this.closeFloat();
          if (this.reconcileAfterAsync(operationRevision)) this.render();
        } else {
          const shouldRender = this.reconcileAfterAsync(operationRevision);
          if (shouldRender) this.render();
          else {
            this.renderList();
            this.syncFloat();
          }
        }
      } catch (error) {
        this.setStatus(`删除失败：${error.message}`);
      }
    }
  }

  handleInput(event) {
    if (!event.target.matches("[data-annotation-query]")) return;
    this.advanceUiRevision();
    this.query = event.target.value;
    const selectionChanged = this.reconcileFilterSelection();
    this.renderList();
    if (selectionChanged) this.renderDetail();
    this.syncFloat();
  }

  async handleChange(event) {
    if (event.target.matches("[data-annotation-tag-filter]")) {
      this.advanceUiRevision();
      this.selectedTag = event.target.value;
      const selectionChanged = this.reconcileFilterSelection();
      this.renderList();
      if (selectionChanged) this.renderDetail();
      this.syncFloat();
      return;
    }
    const scope = event.target.closest("[data-panel-scope]")?.value;
    if (!scope) return;
    this.advanceUiRevision();
    const operationRevision = this.uiRevision;
    this.scope = scope;
    this.currentId = null;
    this.candidateIds = [];
    this.draft = null;
    this.editing = false;
    this.editingTags = false;
    this.activeTagEditToken = null;
    if (scope === "all" && !this.allAnnotations) {
      this.setStatus("正在加载全部批注…");
      try {
        this.allAnnotations = await apiRequest("/api/annotations");
      } catch (error) {
        if (this.uiRevision === operationRevision) {
          this.scope = "current";
          event.target.value = "current";
        }
        this.setStatus(`加载失败：${error.message}`);
      }
    }
    if (this.uiRevision === operationRevision) this.render();
  }

  async handleSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    if (form.getAttribute("aria-busy") === "true") return;
    const pendingForm = lockAnnotationForm(form);
    const operationRevision = this.uiRevision;
    try {
      if (form.dataset.form === "create") {
        const annotation = await this.createAnnotation(this.draft, form.elements.note.value);
        this.registerCreatedAnnotation(annotation);
        if (this.uiRevision === operationRevision) {
          this.draft = null;
          this.currentId = annotation.id;
          this.candidateIds = [];
          this.editing = false;
          this.editingTags = false;
          this.activeTagEditToken = null;
        }
        this.setStatus("批注已保存");
      } else if (form.dataset.form === "edit") {
        const annotation = this.findAnnotation(this.currentId);
        const submittedAnnotationId = annotation.id;
        const updated = await apiRequest(`/api/papers/${annotation.paper_id}/annotations/${annotation.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: form.elements.note.value }),
        });
        Object.assign(annotation, updated);
        this.syncAnnotation(annotation);
        if (this.uiRevision === operationRevision && this.currentId === submittedAnnotationId) {
          this.editing = false;
        }
        this.onMutation("updated", annotation);
        this.setStatus("批注已更新");
      } else if (form.dataset.form === "tags") {
        const annotation = this.findAnnotation(this.currentId);
        const submittedAnnotationId = annotation.id;
        const submittedEditToken = this.activeTagEditToken;
        const tags = parseAnnotationTags(form.elements.tags.value);
        const updated = await apiRequest(`/api/papers/${annotation.paper_id}/annotations/${annotation.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags }),
        });
        Object.assign(annotation, updated);
        this.syncAnnotation(annotation);
        const ownsEditor = this.uiRevision === operationRevision && isActiveAnnotationTagEdit({
          currentId: this.currentId,
          editingTags: this.editingTags,
          activeTagEditToken: this.activeTagEditToken,
        }, submittedAnnotationId, submittedEditToken);
        if (ownsEditor) {
          this.editingTags = false;
          this.activeTagEditToken = null;
        }
        this.onMutation("updated", annotation);
        this.setStatus("标签已更新");
      } else if (form.dataset.form === "reply") {
        const annotation = this.findAnnotation(this.currentId);
        const reply = await apiRequest(`/api/papers/${annotation.paper_id}/annotations/${annotation.id}/replies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: form.elements.content.value, role: "user" }),
        });
        annotation.replies = annotation.replies || [];
        annotation.replies.push(reply);
        if (reply.created_at) annotation.updated_at = reply.created_at;
        this.syncAnnotation(annotation);
        this.onMutation("replied", annotation);
        this.setStatus("回复已添加");
      }
      if (this.reconcileAfterAsync(operationRevision)) this.render();
    } catch (error) {
      this.setStatus(`保存失败：${error.message}`);
    } finally {
      pendingForm.restore();
    }
  }

  async copyAiContext() {
    try {
      const selected = this.findAnnotation(this.currentId);
      const contextPaperId = selected?.paper_id || this.paperId;
      const context = await apiRequest(`/api/papers/${contextPaperId}/annotations/context`);
      await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
      this.setStatus("AI 上下文已复制");
    } catch (error) {
      this.setStatus(`复制失败：${error.message}`);
    }
  }
}
