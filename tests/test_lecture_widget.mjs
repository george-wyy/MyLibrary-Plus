import assert from "node:assert/strict";

import {
  clampWidgetHeight,
  parseWidgetSpec,
  resolveWidgetBlock,
  widgetAssetUrl,
} from "../src/mylibrary/web/static/lecture-widget.mjs";

function test(name, run) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const PAPER = "0eea1a69-8c72-4bdb-b0b8-27f3d91ec802";

test("parses key: value lines and passes query/hash through verbatim", () => {
  const widget = resolveWidgetBlock(PAPER, [
    "src: dragcal-explorer.html#step=gating",
    "height: 640",
    "title: 交互：四道门控",
    "",
  ].join("\n"));
  assert.deepEqual(widget, {
    url: `/paper/${PAPER}/lecture-asset/dragcal-explorer.html#step=gating`,
    height: 640,
    title: "交互：四道门控",
  });
  assert.equal(
    widgetAssetUrl(PAPER, "sub/图.html?mode=a&k=1#step=x"),
    `/paper/${PAPER}/lecture-asset/sub/%E5%9B%BE.html?mode=a&k=1#step=x`,
  );
});

test("ignores blank/comment lines and keeps the first value of a repeated key", () => {
  assert.deepEqual(parseWidgetSpec("# 注释\n\nSRC: a.html\nsrc: b.html\nnot a pair\n"), { src: "a.html" });
});

test("height defaults to 600 and is clamped to 200-2400", () => {
  assert.equal(resolveWidgetBlock(PAPER, "src: a.html").height, 600);
  assert.equal(resolveWidgetBlock(PAPER, "src: a.html\nheight: abc").height, 600);
  assert.equal(resolveWidgetBlock(PAPER, "src: a.html\nheight: 50").height, 200);
  assert.equal(resolveWidgetBlock(PAPER, "src: a.html\nheight: 99999").height, 2400);
  assert.equal(clampWidgetHeight(812.2), 813);
  assert.equal(clampWidgetHeight(undefined, null), null);
  assert.equal(clampWidgetHeight("", null), null);
});

test("rejects traversal, absolute paths and anything with a scheme", () => {
  const bad = [
    "../x.html", "a/../../x.html", "./x.html", "a//b.html", "%2e%2e/x.html", "a%2F..%2Fb.html",
    "/abs.html", "//evil.example/x.html", "https://evil.example/x.html", "http:x.html",
    "javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>1</script>",
    "a\\b.html", "a b.html", "a%ZZ.html", "?x=1", "#hash", "", "   ", "a.html\u0000",
  ];
  bad.forEach((src) => assert.throws(() => widgetAssetUrl(PAPER, src), Error, JSON.stringify(src)));
  assert.throws(() => resolveWidgetBlock(PAPER, "height: 300\ntitle: 没写 src"), /缺少 src/);
  assert.throws(() => widgetAssetUrl("", "a.html"), /论文 id/);
});
