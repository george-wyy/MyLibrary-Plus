import assert from "node:assert/strict";

import { plainMarkdownPreview, tokenizeMarkdownMath } from "../src/mylibrary/web/static/math-markdown.mjs";

function test(name, run) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("tokenizes display and inline LaTeX without treating currency as math", () => {
  const result = tokenizeMarkdownMath([
    "$$X'=V$$",
    "\\[ F = ma \\]",
    "速度 $v = x/t$，且 \\(a=b\\)。",
    "价格是 $5，不是公式。",
  ].join("\n\n"));

  assert.equal(result.formulas.length, 4);
  assert.deepEqual(result.formulas.map(({ source, display }) => ({ source, display })), [
    { source: "X'=V", display: true },
    { source: "F = ma", display: true },
    { source: "v = x/t", display: false },
    { source: "a=b", display: false },
  ]);
  assert.match(result.markdown, /价格是 \$5，不是公式。/);
  assert.doesNotMatch(result.markdown, /X'=V/);
});

test("does not tokenize LaTeX inside fenced code blocks", () => {
  const source = "普通 $x$\n\n```latex\n$$x^2$$\n\\(y\\)\n```\n\n\\[z\\]";
  const result = tokenizeMarkdownMath(source);

  assert.equal(result.formulas.length, 2);
  assert.match(result.markdown, /\$\$x\^2\$\$/);
  assert.ok(result.markdown.includes("\\(y\\)"));
});

test("plain annotation previews keep formulas readable without a KaTeX DOM", () => {
  assert.doesNotThrow(() => plainMarkdownPreview("速度 $v=x/t$，块公式 $$F=ma$$"));
  assert.equal(plainMarkdownPreview("速度 $v=x/t$，块公式 $$F=ma$$"), "速度 $v=x/t$，块公式 $$F=ma$$");
  assert.equal(plainMarkdownPreview("**普通** 批注"), "普通 批注");
});
