/**
 * compose keeps only the CSS a page can use: pruneCss on its own, and the
 * names compose collects from the page.
 */
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { compose, loadKit, pruneCss } from "../src/kit.mjs";

const kit = loadKit(fileURLToPath(new URL("./fixtures/kit", import.meta.url)));

const names = (...list) => new Set(list);

test("hover, focus and arbitrary-value variants stay when their class is on the page", () => {
  const css = [
    ".hover\\:bg-muted:hover{background:gray}",
    ".focus-visible\\:ring-2:focus-visible{outline:2px}",
    ".w-\\[38px\\]{width:38px}",
    ".w-1\\.5{width:6px}",
    ".\\31 0x{color:red}",
    ".gone:hover{color:blue}",
  ].join("\n");
  const out = pruneCss(
    css,
    names("hover:bg-muted", "focus-visible:ring-2", "w-[38px]", "w-1.5", "10x"),
  );
  assert.match(out, /\.hover\\:bg-muted:hover\{background:gray\}/);
  assert.match(out, /\.focus-visible\\:ring-2:focus-visible/);
  assert.match(out, /\.w-\\\[38px\\\]\{width:38px\}/);
  assert.match(out, /\.w-1\\\.5\{width:6px\}/);
  assert.match(out, /\.\\31 0x\{color:red\}/);
  assert.doesNotMatch(out, /\.gone/);
  // Absent from the page, the variant goes.
  assert.doesNotMatch(pruneCss(css, names()), /hover\\:bg-muted/);
});

test("@font-face, @keyframes and @property survive; an @media of unused rules disappears", () => {
  const css = `@font-face{font-family:A;src:url("data:font/woff2;base64,AA==")}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(1turn)}}
@property --tw-rotate{syntax:"*";inherits:false}
@media (min-width:640px){.sm\\:flex{display:flex}.sm\\:grid{display:grid}}
@media (min-width:768px){.md\\:hidden{display:none}.used{color:red}}
@supports (display:grid){@media print{.unused{color:red}}}
.unused{color:blue}`;
  const out = pruneCss(css, names("used"));
  assert.match(out, /@font-face\{font-family:A/);
  assert.match(out, /@keyframes spin\{from\{transform:rotate\(0\)\}to/);
  assert.match(out, /@property --tw-rotate\{syntax:"\*"/);
  assert.doesNotMatch(out, /min-width:640px/);
  assert.match(out, /@media \(min-width:768px\)\{\n\.used\{color:red\}\n\}/);
  assert.doesNotMatch(out, /md\\:hidden/);
  // Nested wrappers left empty go too.
  assert.doesNotMatch(out, /@supports|@media print/);
  assert.doesNotMatch(out, /unused/);
});

test("a rule goes only when every selector needs a missing class or id", () => {
  const css = `.a, .missing{color:red}
.missing, #nope{color:blue}
:root{--x:1}
*,::before{box-sizing:border-box}
body > div{margin:0}
[data-state=open]{opacity:1}
.a:not(.missing){top:0}
.a:is(.missing, .other) .b{left:0}
:where(.missing) .a{right:0}
.dark .a:has(> .missing){bottom:0}
.a .missing:hover{z-index:1}
#main.a{order:1}
#other.a{order:2}
.a::part(.missing){inset:0}`;
  const out = pruneCss(css, names("a", "b", "dark", "main"));
  for (const kept of [
    ".a, .missing{",
    ":root{",
    "*,::before{",
    "body > div{",
    "[data-state=open]{",
    ".a:not(.missing){",
    ".a:is(.missing, .other) .b{",
    ":where(.missing) .a{",
    ".dark .a:has(> .missing){",
    "#main.a{",
    ".a::part(.missing){",
  ]) {
    assert.ok(out.includes(kept), `kept ${kept}`);
  }
  for (const gone of [".missing, #nope", ".a .missing:hover", "#other.a"]) {
    assert.ok(!out.includes(gone), `dropped ${gone}`);
  }
});

test("strings, comments, escapes and url() never end a rule early", () => {
  const css = `.a::after{content:"}{ .b{"}
/* } .c{color:red} */
.b{background:url(data:image/svg+xml;utf8,<svg>{}</svg>)}
.\\{x\\}{color:red}
.a{content:'\\'}'}`;
  const out = pruneCss(css, names("a", "{x}"));
  assert.match(out, /\.a::after\{content:"\}\{ \.b\{"\}/);
  assert.match(out, /\.\\\{x\\\}\{color:red\}/);
  assert.match(out, /\.a\{content:'\\'\}'\}/);
  assert.doesNotMatch(out, /url\(data/);
  assert.doesNotMatch(out, /\.c\{/);
});

test("a repeated rule is written once, its last copy, per at-rule context", () => {
  const css = `:root{--x:1}
.a{color:red}
:root {
  --x:1 }
@media (min-width:640px){:root{--x:1}}
@media (min-width:640px){:root{--x:1}}
@layer base{.a{color:red}}
@layer{.a{color:red}}
@layer{.a{color:red}}
:root{--x:"a  b"}
:root{--x:"a b"}`;
  const out = pruneCss(css, names("a"));
  // Whitespace outside strings does not make a copy different; the last
  // copy keeps its place after .a.
  assert.equal(out.match(/:root\s*\{\s*--x:1\s*\}/g).length, 2);
  assert.ok(out.indexOf(".a{color:red}") < out.indexOf(":root {\n  --x:1 }"));
  // One copy in the media query: the first block, now empty, goes.
  assert.equal(out.match(/@media/g).length, 1);
  // A named layer and each unnamed layer are contexts of their own.
  assert.equal(out.match(/\.a\{color:red\}/g).length, 4);
  // A space after an escaped brace is a combinator and counts.
  const escaped = pruneCss(".\\{ .a{top:0}\n.\\{.a{top:0}", names("a", "{"));
  assert.equal(escaped, ".\\{ .a{top:0}\n.\\{.a{top:0}");
  // Whitespace inside strings counts.
  assert.match(out, /--x:"a {2}b"/);
  assert.match(out, /--x:"a b"/);
});

test("an emptied named @layer stays, since it sets the layer order", () => {
  const out = pruneCss(
    "@layer theme, base;\n@layer base{.unused{color:red}}\n@layer theme{:root{--x:1}}",
    names(),
  );
  assert.match(out, /^@layer theme, base;/);
  assert.match(out, /@layer base\{\n\n\}/);
  assert.match(out, /@layer theme\{\n:root\{--x:1\}\n\}/);
});

test("compose keeps the CSS of hidden elements, templates, author scripts and the theme", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-kit-prune-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(kit.dir, dir, { recursive: true });
  appendFileSync(
    join(dir, "css/routes.css"),
    [
      ".in-hidden{color:red}",
      ".in-template{color:red}",
      "#menu-panel{color:red}",
      ".script-added{color:red}",
      ".script-selector{color:red}",
      ".dark .themed{color:red}",
      ".light .themed{color:blue}",
      ".nowhere{color:red}",
    ].join("\n"),
  );
  const fragment = `<div class="themed" hidden><span class="in-hidden">x</span></div>
<template><p class="in-template">t</p></template>
<ul id="menu-panel" hidden></ul>
<script>document.querySelector(".script-selector").classList.add('script-added');</script>`;
  const options = {
    frame: "route:orchestrator@1280",
    slots: [{ name: "main", content: fragment }],
  };
  const page = compose(loadKit(dir), options);
  for (const rule of [
    ".in-hidden{",
    ".in-template{",
    "#menu-panel{",
    ".script-added{",
    ".script-selector{",
    ".dark .themed{",
    ".light .themed{",
    "@font-face",
  ]) {
    assert.ok(page.includes(rule), `kept ${rule}`);
  }
  assert.ok(!page.includes(".nowhere"));
  assert.ok(!page.includes(".route-only"));
  // --css full keeps every rule.
  const full = compose(loadKit(dir), { ...options, css: "full" });
  assert.ok(full.includes(".nowhere{") && full.includes(".route-only"));
});

test("compose refuses an unknown css mode", () => {
  assert.throws(
    () => compose(kit, { frame: "route:orchestrator@1280", css: "some" }),
    /unknown css "some"/,
  );
});
