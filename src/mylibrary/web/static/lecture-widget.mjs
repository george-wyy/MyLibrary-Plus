// 讲义里的 ```widget 围栏块 → iframe 交互组件。这里只放纯函数(解析 + src 校验),
// DOM 替换在 study.js 的 renderWidgetBlocks();拆出来是为了能直接用 node 测
// (tests/test_lecture_widget.mjs),不必起浏览器。
//
// 块内容是简单的 `key: value` 行(按第一个半角冒号切,空行和 # 开头的行忽略):
//   src: dragcal-explorer.html#step=gating   必填,相对 data/lectures/assets/<paper_id>/
//   height: 640                               可选,默认 600,夹在 200–2400
//   title: 交互：四道门控                      可选

export const WIDGET_DEFAULT_HEIGHT = 600;
export const WIDGET_MIN_HEIGHT = 200;
export const WIDGET_MAX_HEIGHT = 2400;

export function clampWidgetHeight(value, fallback = WIDGET_DEFAULT_HEIGHT) {
  const number = Number(value);
  if (!Number.isFinite(number) || String(value ?? "").trim() === "") return fallback;
  return Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, Math.ceil(number)));
}

export function parseWidgetSpec(text) {
  const spec = {};
  String(text ?? "").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    // 同一个 key 写了两次以第一次为准,和"从上往下读"的直觉一致。
    if (!(key in spec)) spec[key] = trimmed.slice(colon + 1).trim();
  });
  return spec;
}

/**
 * 把 src 拼成本站的 /paper/<paperId>/lecture-asset/<path>,?query 与 #hash 原样透传。
 * 不合法就抛 Error(消息会直接显示在讲义里)。服务端路由自己也防穿越,这里是第一道:
 * 拒绝 `..`/`.`/空路径段、绝对路径、任何带协议的东西(https:/javascript:/data:…),
 * 百分号编码过的 `%2e%2e`、`%2F` 也先解码再判断。
 */
export function widgetAssetUrl(paperId, src) {
  const raw = String(src ?? "").trim();
  if (!paperId) throw new Error("缺少论文 id");
  if (!raw) throw new Error("缺少 src");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error("src 含控制字符");
  const cut = raw.search(/[?#]/);
  const path = cut === -1 ? raw : raw.slice(0, cut);
  const rest = cut === -1 ? "" : raw.slice(cut);
  if (!path) throw new Error("src 缺少文件路径");
  if (path.includes(":")) throw new Error("src 不能带协议或写成绝对 URL，只能写相对资产目录的路径");
  if (path.startsWith("/") || path.includes("\\") || /\s/.test(path)) throw new Error("src 必须是相对资产目录的路径");
  const segments = path.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch (_error) {
      throw new Error("src 含非法的百分号编码");
    }
  });
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."
    || /[/\\:\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error("src 不能含 ..、. 或空路径段");
  }
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `/paper/${encodeURIComponent(paperId)}/lecture-asset/${encoded}${rest}`;
}

/** 一个 widget 块 → { url, height, title };src 不合法时抛 Error。 */
export function resolveWidgetBlock(paperId, text) {
  const spec = parseWidgetSpec(text);
  return {
    url: widgetAssetUrl(paperId, spec.src),
    height: clampWidgetHeight(spec.height),
    title: spec.title || "",
  };
}
