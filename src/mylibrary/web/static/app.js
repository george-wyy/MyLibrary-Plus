document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".done-toggle-form");
  if (!form) return;

  event.preventDefault();
  const button = form.querySelector(".done-toggle");
  const value = form.querySelector('input[name="done"]');
  button.disabled = true;

  try {
    const response = await fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { "X-Requested-With": "MyLibrary" },
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const result = await response.json();
    button.classList.toggle("complete", result.done);
    button.textContent = result.done ? "✓" : "";
    button.title = result.done ? "Mark as unread" : "Mark as read";
    button.setAttribute("aria-label", button.title);
    value.value = result.done ? "false" : "true";
  } catch (error) {
    console.error(error);
    window.alert("Could not update the paper's read status.");
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".marker-form");
  if (!form) return;

  event.preventDefault();
  const picker = form.closest(".marker-picker");
  const button = event.submitter;
  if (!picker || !button) return;
  button.disabled = true;

  try {
    const body = new FormData(form);
    body.set("marker", button.value);
    const response = await fetch(form.action, {
      method: "POST",
      body,
      headers: { "X-Requested-With": "MyLibrary" },
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const result = await response.json();
    const summary = picker.querySelector("summary");
    summary.innerHTML = button.innerHTML;
    picker.className = `marker-picker marker-${result.marker || "empty"}`;
    picker.open = false;
  } catch (error) {
    console.error(error);
    window.alert("Could not update the paper marker.");
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-preview-source]");
  if (!button) return;

  const preview = button.closest("[data-paper-preview]");
  const image = preview?.querySelector("img");
  const link = preview?.querySelector("[data-preview-link]");
  if (!image) return;

  image.src = button.dataset.previewSource;
  image.alt = `${button.textContent.trim()} preview`;
  if (link) {
    const source = button.dataset.previewName;
    link.dataset.previewMode = source;
    link.href = source === "page-1" ? link.dataset.readerUrl : (button.dataset.previewFull || button.dataset.previewSource);
    link.title = source === "page-1" ? "Open in MyLibrary reader" : "View larger figure";
  }
  preview.querySelectorAll("[data-preview-source]").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
});

// --- Full-screen figure lightbox (its own carousel) --------------------------
const lightboxState = { items: [], index: 0, token: 0 };

function lightboxShow(index) {
  const lightbox = document.querySelector("[data-figure-lightbox]");
  const { items } = lightboxState;
  if (!lightbox || !items.length) return;
  const total = items.length;
  const next = ((index % total) + total) % total;
  lightboxState.index = next;
  const item = items[next];
  const image = lightbox.querySelector("[data-lightbox-image]");
  image.alt = item.alt || "Large paper figure";
  // Show the small card copy first — it is usually already cached, so the
  // figure appears instantly — then swap in the full-resolution original.
  const token = ++lightboxState.token;
  image.src = item.thumb || item.full;
  if (item.full && item.full !== item.thumb) {
    const full = new Image();
    full.onload = () => { if (lightboxState.token === token) image.src = item.full; };
    full.src = item.full;
  }
  const many = total > 1;
  lightbox.querySelector("[data-lightbox-prev]").hidden = !many;
  lightbox.querySelector("[data-lightbox-next]").hidden = !many;
  lightbox.querySelector("[data-lightbox-counter]").textContent = many ? `${next + 1}/${total}` : "";
  lightbox.querySelector("[data-lightbox-label]").textContent = item.label || "";
  lightbox.querySelectorAll("[data-lightbox-thumb]").forEach((thumb, i) => {
    thumb.classList.toggle("active", i === next);
    if (i === next) thumb.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function lightboxOpen(items, index) {
  const lightbox = document.querySelector("[data-figure-lightbox]");
  if (!lightbox || !items.length) return;
  lightboxState.items = items;
  const strip = lightbox.querySelector("[data-lightbox-strip]");
  strip.innerHTML = items.length > 1
    ? items.map((item, i) => `<button type="button" class="lightbox-thumb" data-lightbox-thumb="${i}" title="${item.label || `Figure ${i + 1}`}" aria-label="${item.label || `Figure ${i + 1}`}"><img src="${item.thumb || item.full}" alt=""></button>`).join("")
    : "";
  lightboxShow(index);
  if (!lightbox.open) lightbox.showModal();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-preview-link]");
  if (!link || link.dataset.previewMode === "page-1") return;
  event.preventDefault();
  // Gather every preview this paper offers so the lightbox can page through them.
  const preview = link.closest("[data-paper-preview]");
  const buttons = [...(preview?.querySelectorAll("[data-preview-source]") || [])];
  const items = buttons.map((button) => ({
    full: button.dataset.previewFull || button.dataset.previewSource,
    thumb: button.dataset.previewSource,
    alt: `${button.dataset.previewName.replaceAll("-", " ")} large preview`,
    label: button.textContent.trim(),
  }));
  const current = items.findIndex((item) => item.full === link.getAttribute("href"));
  if (items.length) lightboxOpen(items, current < 0 ? 0 : current);
  else lightboxOpen([{ full: link.href, alt: `${link.dataset.previewMode.replaceAll("-", " ")} large preview` }], 0);
});

document.addEventListener("click", (event) => {
  const lightbox = event.target.closest("[data-figure-lightbox]");
  if (!lightbox) return;
  const thumb = event.target.closest("[data-lightbox-thumb]");
  if (thumb) {
    lightboxShow(parseInt(thumb.dataset.lightboxThumb, 10) || 0);
  } else if (event.target.closest("[data-lightbox-prev]")) {
    lightboxShow(lightboxState.index - 1);
  } else if (event.target.closest("[data-lightbox-next]")) {
    lightboxShow(lightboxState.index + 1);
  } else if (event.target.closest("[data-close-lightbox]") || event.target === lightbox || event.target.closest("[data-lightbox-stage]") === event.target) {
    lightbox.close();
  }
});

document.addEventListener("keydown", (event) => {
  const lightbox = document.querySelector("[data-figure-lightbox]");
  if (!lightbox?.open || lightboxState.items.length < 2) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); lightboxShow(lightboxState.index - 1); }
  else if (event.key === "ArrowRight") { event.preventDefault(); lightboxShow(lightboxState.index + 1); }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-default-source]");
  if (!button) return;

  event.preventDefault();
  button.disabled = true;
  try {
    const body = new FormData();
    body.set("source", button.dataset.defaultSource);
    const response = await fetch(button.dataset.defaultUrl, {
      method: "POST",
      body,
      headers: { "X-Requested-With": "MyLibrary" },
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const result = await response.json();
    const preview = button.closest("[data-paper-preview]");
    preview?.querySelectorAll("[data-default-source]").forEach((item) => {
      const selected = item.dataset.defaultSource === result.thumbnail_source;
      item.classList.toggle("selected", selected);
      item.title = selected ? "Timeline default" : "Use as timeline default";
      item.setAttribute("aria-label", selected
        ? "Timeline default"
        : `Use ${item.dataset.defaultSource.replaceAll("-", " ")} as timeline default`);
    });
  } catch (error) {
    console.error(error);
    window.alert("Could not change the timeline preview.");
  } finally {
    button.disabled = false;
  }
});

// --- Timeline card figure carousel -------------------------------------------
// Only the visible slide ships an src; the rest carry data-src and load the
// first time they are shown, so a long timeline does not fetch every figure.
function carouselHydrate(slide) {
  if (slide?.dataset.src) {
    slide.src = slide.dataset.src;
    delete slide.dataset.src;
  }
}

function carouselShow(carousel, index) {
  const slides = carousel.querySelectorAll(".carousel-slide");
  const dots = carousel.querySelectorAll("[data-carousel-dot]");
  const total = slides.length;
  if (!total) return;
  const next = ((index % total) + total) % total;
  carouselHydrate(slides[next]);
  slides.forEach((slide, i) => slide.classList.toggle("active", i === next));
  dots.forEach((dot, i) => dot.classList.toggle("active", i === next));
  const counter = carousel.querySelector("[data-carousel-current]");
  if (counter) counter.textContent = String(next + 1);
  carousel.dataset.index = String(next);
}

function carouselIndex(carousel) {
  return parseInt(carousel.dataset.index || "0", 10) || 0;
}

document.addEventListener("click", (event) => {
  const prev = event.target.closest("[data-carousel-prev]");
  const next = event.target.closest("[data-carousel-next]");
  const dot = event.target.closest("[data-carousel-dot]");
  if (prev) {
    const carousel = prev.closest("[data-carousel]");
    carouselShow(carousel, carouselIndex(carousel) - 1);
  } else if (next) {
    const carousel = next.closest("[data-carousel]");
    carouselShow(carousel, carouselIndex(carousel) + 1);
  } else if (dot) {
    const carousel = dot.closest("[data-carousel]");
    carouselShow(carousel, parseInt(dot.dataset.carouselDot, 10) || 0);
  }
});

// Tap/click a figure to open the whole card's figures full size in the lightbox.
document.addEventListener("click", (event) => {
  const slide = event.target.closest(".carousel-slide");
  if (!slide) return;
  const carousel = slide.closest("[data-carousel]");
  const slides = [...(carousel?.querySelectorAll(".carousel-slide") || [slide])];
  const items = slides.map((item) => ({
    full: item.dataset.full || item.currentSrc || item.src,
    thumb: item.dataset.card,
    alt: item.alt || "Large paper figure",
    label: item.dataset.label || "",
  }));
  // Start from the slide the card is actually showing, not from DOM order.
  lightboxOpen(items, carousel ? carouselIndex(carousel) : Math.max(0, slides.indexOf(slide)));
});

// Horizontal swipe to move between figures on touch devices.
document.addEventListener("touchstart", (event) => {
  const carousel = event.target.closest("[data-carousel]");
  if (!carousel || event.touches.length !== 1) return;
  carousel.dataset.touchX = String(event.touches[0].clientX);
  carousel.dataset.touchY = String(event.touches[0].clientY);
}, { passive: true });

document.addEventListener("touchend", (event) => {
  const carousel = event.target.closest("[data-carousel]");
  if (!carousel || carousel.dataset.touchX === undefined) return;
  const startX = parseFloat(carousel.dataset.touchX);
  const startY = parseFloat(carousel.dataset.touchY || "0");
  delete carousel.dataset.touchX;
  delete carousel.dataset.touchY;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - startX;
  const dy = touch.clientY - startY;
  if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return; // ignore taps / vertical scroll
  carouselShow(carousel, carouselIndex(carousel) + (dx < 0 ? 1 : -1));
}, { passive: true });

// Swipe between figures inside the lightbox on touch devices.
document.addEventListener("touchstart", (event) => {
  const lightbox = event.target.closest("[data-figure-lightbox]");
  if (!lightbox || event.touches.length !== 1) return;
  lightbox.dataset.touchX = String(event.touches[0].clientX);
  lightbox.dataset.touchY = String(event.touches[0].clientY);
}, { passive: true });

document.addEventListener("touchend", (event) => {
  const lightbox = event.target.closest("[data-figure-lightbox]");
  if (!lightbox || lightbox.dataset.touchX === undefined) return;
  const startX = parseFloat(lightbox.dataset.touchX);
  const startY = parseFloat(lightbox.dataset.touchY || "0");
  delete lightbox.dataset.touchX;
  delete lightbox.dataset.touchY;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - startX;
  const dy = touch.clientY - startY;
  if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
  lightboxShow(lightboxState.index + (dx < 0 ? 1 : -1));
}, { passive: true });
