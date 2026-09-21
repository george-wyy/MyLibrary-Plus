// Small, dependency-free bridge between Marked and the locally bundled KaTeX.
// Marked deliberately does not parse TeX, so protect formulas before Markdown
// parsing and replace those harmless markers only after the resulting HTML has
// entered the DOM.
const TOKEN_PREFIX = "@@MYLIBRARY_MATH_";
const TOKEN_PATTERN = /@@MYLIBRARY_MATH_(\d+)@@/g;

function token(index) {
  return `${TOKEN_PREFIX}${index}@@`;
}

function replaceFormulas(source, formulas) {
  return source.replace(
    /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s\d])([^\n$]+?)\$/g,
    (_whole, dollarDisplay, bracketDisplay, parenInline, dollarInline) => {
      const display = dollarDisplay !== undefined || bracketDisplay !== undefined;
      const content = dollarDisplay ?? bracketDisplay ?? parenInline ?? dollarInline;
      formulas.push({ source: String(content).trim(), display });
      return token(formulas.length - 1);
    },
  );
}

/**
 * Turn supported TeX delimiters into inert placeholders before Marked runs.
 * Fenced code remains literal source, including ```latex blocks.
 */
export function tokenizeMarkdownMath(markdown) {
  const formulas = [];
  const lines = String(markdown ?? "").split(/(?<=\n)/);
  const output = [];
  let fence = null;
  let prose = "";

  const flushProse = () => {
    if (!prose) return;
    output.push(replaceFormulas(prose, formulas));
    prose = "";
  };

  for (const line of lines) {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && opening) {
      flushProse();
      fence = opening[1];
      output.push(line);
    } else if (fence) {
      output.push(line);
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line.trimEnd())) fence = null;
    } else {
      prose += line;
    }
  }
  flushProse();
  return { markdown: output.join(""), formulas };
}

/** A list-safe Markdown preview that needs neither the DOM nor KaTeX. */
export function plainMarkdownPreview(markdown) {
  const { markdown: protectedMarkdown, formulas } = tokenizeMarkdownMath(markdown);
  return protectedMarkdown
    .replace(TOKEN_PATTERN, (_whole, index) => `\uE000${index}\uE001`)
    .replace(/```[\s\S]*?```/g, " 代码 ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " 图 ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "· ")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\uE000(\d+)\uE001/g, (_whole, index) => rawFormula(formulas[Number(index)] || { source: "", display: false }))
    .trim();
}

function rawFormula(formula) {
  return formula.display ? `$$${formula.source}$$` : `$${formula.source}$`;
}

function isInsideCode(node) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "CODE" || parent.tagName === "PRE") return true;
  }
  return false;
}

/** Replace protected placeholders in a Marked HTML container with KaTeX. */
export function renderMathTokens(root, formulas) {
  if (!root?.ownerDocument || !Array.isArray(formulas) || !formulas.length) return root;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node);

  textNodes.forEach((node) => {
    TOKEN_PATTERN.lastIndex = 0;
    if (!TOKEN_PATTERN.test(node.data)) return;
    TOKEN_PATTERN.lastIndex = 0;
    if (isInsideCode(node)) {
      node.data = node.data.replace(TOKEN_PATTERN, (_whole, index) => rawFormula(formulas[Number(index)] || { source: "", display: false }));
      return;
    }

    const fragment = root.ownerDocument.createDocumentFragment();
    let cursor = 0;
    node.data.replace(TOKEN_PATTERN, (whole, index, offset) => {
      if (offset > cursor) fragment.append(root.ownerDocument.createTextNode(node.data.slice(cursor, offset)));
      const formula = formulas[Number(index)];
      const target = root.ownerDocument.createElement("span");
      target.className = formula?.display ? "annotation-math annotation-math-display" : "annotation-math";
      if (!formula || !window.katex?.render) {
        target.textContent = formula ? rawFormula(formula) : whole;
      } else {
        try {
          window.katex.render(formula.source, target, { displayMode: formula.display, throwOnError: false });
        } catch (_error) {
          target.classList.add("annotation-math-error");
          target.textContent = rawFormula(formula);
        }
      }
      fragment.append(target);
      cursor = offset + whole.length;
      return whole;
    });
    if (cursor < node.data.length) fragment.append(root.ownerDocument.createTextNode(node.data.slice(cursor)));
    node.replaceWith(fragment);
  });
  return root;
}

const FORBIDDEN_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "APPLET", "FORM", "INPUT", "LINK", "META", "BASE", "SVG", "TEMPLATE", "VIDEO", "AUDIO", "SOURCE", "TRACK"]);

/** Conservative final pass for lecture/concept Markdown after KaTeX insertion. */
export function sanitizeMarkdownHtml(root) {
  root.querySelectorAll("*").forEach((node) => {
    if (FORBIDDEN_TAGS.has(node.tagName)) {
      node.remove();
      return;
    }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      // 位图 data URI 放行(讲义里内嵌论文插图用)——只放行 img 的 src，且只允许这几种位图格式。
      // 故意不含 svg+xml：SVG 可以携带脚本，而位图不能。
      const isInlineBitmap = node.tagName === "IMG" && name === "src"
        && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(value);
      if (name.startsWith("on") || name === "srcdoc"
        || (/(href|src|action|formaction|xlink:href)/.test(name) && /^(?:javascript|data):/i.test(value) && !isInlineBitmap)) {
        node.removeAttribute(attribute.name);
      }
    });
    // In-page hash links (讲义里的 #pdfsec= / #pdf= 跳转) are handled by the page
    // itself; opening them in a new tab would break the jump.
    const anchorHref = node.tagName === "A" ? (node.getAttribute("href") || "") : "";
    if (node.tagName === "A" && !anchorHref.startsWith("#") && !anchorHref.includes("#pdf")) {
      node.target = "_blank";
      node.rel = "noopener noreferrer";
    }
  });
  return root;
}
