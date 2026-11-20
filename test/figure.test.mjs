import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIGURE_WARN_BYTES,
  compose,
  decodeEntities,
  elements,
  loadKit,
  figureSelectorCanMatch,
  mediaMatches,
  pageSelector,
  run,
  viewportToPixels,
} from "../src/kit.mjs";

const dir = mkdtempSync(join(tmpdir(), "design-kit-figure-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function figure(args) {
  const out = [];
  const err = [];
  const code = run(["figure", ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("figure writes a self-contained <figure>: the image as a data URI, linked to the plan page, the caption escaped", () => {
  const img = join(dir, "shot.png");
  writeFileSync(img, PNG);
  const out = join(dir, "figure.html");
  const result = figure([
    "--img",
    img,
    "--href",
    "#cp-page:orchestrator-plan",
    "--caption",
    'New <Card> & "chip"',
    "--width",
    "640",
    "--out",
    out,
  ]);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.match(result.out, /figure\.html {2}\d/);
  const html = readFileSync(out, "utf8");
  const tags = elements(html);
  assert.deepEqual(
    tags.map((node) => node.name),
    ["figure", "a", "img", "figcaption"],
  );
  const link = tags.find((node) => node.name === "a");
  assert.equal(link.attrs.href, "#cp-page:orchestrator-plan");
  const image = tags.find((node) => node.name === "img");
  const src = image.attrs.src;
  assert.ok(src.startsWith("data:image/png;base64,"));
  assert.deepEqual(Buffer.from(src.split(",")[1], "base64"), PNG);
  assert.match(image.attrs.style, /^width:640px;max-width:100%/);
  assert.equal(decodeEntities(image.attrs.alt), 'New <Card> & "chip"');
  assert.match(
    html,
    /<figcaption>New &lt;Card&gt; &amp; &quot;chip&quot;<\/figcaption>/,
  );
  assert.doesNotMatch(html, /<Card>/);
});

test("figure without --href or --caption is the image alone; --alt wins", () => {
  const img = join(dir, "plain.webp");
  writeFileSync(img, PNG);
  const out = join(dir, "plain.html");
  assert.equal(figure(["--img", img, "--alt", "a <b>", "--out", out]).code, 0);
  const html = readFileSync(out, "utf8");
  assert.match(html, /src="data:image\/webp;base64,/);
  assert.match(html, /alt="a &lt;b&gt;"/);
  assert.doesNotMatch(html, /<a |<figcaption>/);
});

test("figure warns on stderr above 1 MB and still writes the page", () => {
  const img = join(dir, "big.jpg");
  writeFileSync(img, Buffer.alloc(FIGURE_WARN_BYTES + 1));
  const out = join(dir, "big.html");
  const result = figure(["--img", img, "--out", out]);
  assert.equal(result.code, 0);
  assert.match(result.err, /^kit: warning: .*big\.jpg is .*below 1 MB/);
  assert.match(readFileSync(out, "utf8"), /data:image\/jpeg;base64,/);
});

test("figure refuses another image type, a script link and a bad width", () => {
  const img = join(dir, "shot.png");
  writeFileSync(img, PNG);
  const out = join(dir, "x.html");
  const gif = join(dir, "a.gif");
  writeFileSync(gif, PNG);
  for (const [args, reason] of [
    [["--img", gif, "--out", out], /use a \.png, \.jpg or \.webp/],
    [["--img", img, "--href", "javascript:alert(1)", "--out", out], /--href/],
    [["--img", img, "--width", "wide", "--out", out], /--width wide/],
    [["--img", img], /needs --out/],
    [["--out", out], /needs --img/],
  ]) {
    const result = figure(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.err, reason);
  }
});

// ── --page ──────────────────────────────────────────────────────────────────

const KIT = fileURLToPath(new URL("./fixtures/kit", import.meta.url));

function composedPage(
  theme = "light",
  content = '<p class="route-only">New</p>',
) {
  return compose(loadKit(KIT), {
    frame: "route:orchestrator@1280",
    slots: [{ name: "main", content }],
    theme,
  });
}

/** Every http:, https: or protocol-relative URL in the markup. */
function externalUrls(html) {
  return new Set(html.match(/(?:https?:)?\/\/[^\s"'<>)]+/gi) ?? []);
}

test("figure --page writes a <figure> holding the page in a declarative shadow root, linked and captioned", () => {
  const page = join(dir, "page.html");
  writeFileSync(page, composedPage("dark"));
  const out = join(dir, "page-figure.html");
  const result = figure([
    "--page",
    page,
    "--href",
    "#cp-page:screen",
    "--caption",
    "Screen <preview>",
    "--out",
    out,
  ]);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.match(result.out, /page-figure\.html {2}\d/);
  const html = readFileSync(out, "utf8");
  const tags = elements(html);
  assert.equal(tags[0].name, "figure");
  const link = tags.find((node) => node.name === "a");
  assert.equal(link.attrs.href, "#cp-page:screen");
  const view = tags.find((node) => "data-kit-figure-page" in node.attrs);
  assert.equal(decodeEntities(view.attrs["aria-label"]), "Screen <preview>");
  assert.match(view.attrs.style, /width:640px;.*height:400px/);
  const template = tags.find((node) => node.name === "template");
  assert.equal(template.attrs.shadowrootmode, "open");
  // @font-face sits outside the shadow root, where fonts load.
  const fontStyle = tags.find((node) => node.name === "style");
  assert.ok(fontStyle.start < template.start);
  assert.match(html.slice(fontStyle.start, fontStyle.end), /@font-face/);
  assert.doesNotMatch(html.slice(template.start, template.end), /@font-face/);
  // <html> and <body> carry their theme onto the stand-ins.
  assert.match(html, /<cp-page-html class="cp-page-root geist dark"/);
  assert.match(
    html,
    /<cp-page-body class="bg-background font-sans antialiased dark"/,
  );
  assert.match(html, /data-kit-id="route:orchestrator@1280"/);
  assert.match(html, /transform:scale\(0\.5\)/);
  assert.match(html, /<figcaption>Screen &lt;preview&gt;<\/figcaption>/);
});

test("figure --page leaves no iframe, CSP meta, script or new external URL", () => {
  const source = `<!doctype html>
<html class="dark"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.example.com/a.css">
<script src="https://cdn.example.com/a.js"></script>
<style>body{background:url(https://img.example.com/bg.png)}.a{color:red}</style>
</head><body>
<svg xmlns="http://www.w3.org/2000/svg"></svg>
<iframe src="https://frame.example.com/"></iframe>
<object data="https://obj.example.com/x"></object>
<img src="//cdn.example.com/x.png" onerror="alert(1)">
<a href="javascript:alert(1)" class="a">x</a>
<script>document.body.className = "x";</script>
<p class="a">kept</p>
</body></html>`;
  const page = join(dir, "scripted.html");
  writeFileSync(page, source);
  const out = join(dir, "scripted-figure.html");
  const result = figure(["--page", page, "--out", out]);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err.split("\n").length, 1);
  assert.match(
    result.err,
    /^kit: warning: dropped 2 <script> elements from .*scripted\.html/,
  );
  const html = readFileSync(out, "utf8");
  const names = new Set(elements(html).map((node) => node.name));
  for (const name of [
    "iframe",
    "frame",
    "object",
    "embed",
    "script",
    "meta",
    "link",
  ])
    assert.ok(!names.has(name), `no <${name}>`);
  assert.doesNotMatch(
    html,
    /http-equiv|Content-Security-Policy|onerror|javascript:/i,
  );
  assert.match(html, /<p class="a">kept<\/p>/);
  const before = externalUrls(source);
  for (const url of externalUrls(html))
    assert.ok(before.has(url), `${url} was not in the page`);
  // Remote URLs the page had are dropped too; the svg namespace is no fetch.
  assert.deepEqual([...externalUrls(html)], ["http://www.w3.org/2000/svg"]);
});

test("figure --page on a composed page has no <script> and does not warn", () => {
  const page = join(dir, "plain.html");
  writeFileSync(page, composedPage());
  const result = figure([
    "--page",
    page,
    "--out",
    join(dir, "plain-figure.html"),
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
});

test("figure --page on a composed interactive page strips <script> and renders only the initial visible state", () => {
  const interactive = composedPage(
    "light",
    `<button data-kit-set="save:loading">Save</button>
<div data-kit-state="save:idle">Idle state</div>
<div data-kit-state="save:loading" data-kit-after="60:done" hidden>Loading state</div>
<div data-kit-state="save:done" hidden>Done state</div>`,
  );
  assert.match(interactive, /<script data-kit-behaviours>/);
  const page = join(dir, "interactive.html");
  writeFileSync(page, interactive);
  const out = join(dir, "interactive-figure.html");
  const result = figure(["--page", page, "--out", out]);
  assert.equal(result.code, 0, result.err);
  assert.match(
    result.err,
    /^kit: warning: dropped 1 <script> element from .*interactive\.html; the figure is static$/,
  );
  const html = readFileSync(out, "utf8");
  const tags = elements(html);
  assert.ok(!tags.some((node) => node.name === "script"), "no <script> left");
  assert.match(
    html,
    /\[data-kit-state\]\[hidden\][^{]*\{display:none !important\}/,
  );
  const states = tags.filter((node) => "data-kit-state" in node.attrs);
  const byState = Object.fromEntries(
    states.map((node) => [node.attrs["data-kit-state"], node]),
  );
  assert.ok(!("hidden" in byState["save:idle"].attrs));
  assert.ok("hidden" in byState["save:loading"].attrs);
  assert.ok("hidden" in byState["save:done"].attrs);
});

test("figure --page sizes: the frame's width, else 1280; --width, --fit and --height", () => {
  const sized = (page, extra = []) => {
    const file = join(dir, "sized.html");
    writeFileSync(file, page);
    const out = join(dir, "sized-figure.html");
    assert.equal(figure(["--page", file, ...extra, "--out", out]).code, 0);
    const html = readFileSync(out, "utf8");
    return {
      outer: /data-kit-figure-page[^>]*style="([^"]*)"/.exec(html)[1],
      inner: /class="cp-page-box" inert style="([^"]*)"/.exec(html)[1],
    };
  };
  const phone = composedPage().replace(
    'data-kit-id="route:orchestrator@1280"',
    'data-kit-id="route:orchestrator@390"',
  );
  let box = sized(phone, ["--fit", "195"]);
  assert.match(box.inner, /width:390px;height:243\.75px;.*scale\(0\.5\)/);
  assert.match(box.outer, /width:195px;.*height:121\.875px/);
  box = sized("<p>bare</p>");
  assert.match(box.inner, /width:1280px;height:800px;/);
  box = sized(composedPage(), [
    "--width",
    "1000",
    "--height",
    "500",
    "--fit",
    "250",
  ]);
  assert.match(box.inner, /width:1000px;height:500px;.*scale\(0\.25\)/);
  assert.match(box.outer, /width:250px;.*height:125px/);
});

test("figure --page refuses --img with it, a missing file, bad sizes and a script link", () => {
  const page = join(dir, "refuse.html");
  writeFileSync(page, composedPage());
  const img = join(dir, "refuse.png");
  writeFileSync(img, PNG);
  const out = join(dir, "refuse-figure.html");
  for (const [args, reason] of [
    [["--page", page, "--img", img, "--out", out], /--img or --page, not both/],
    [
      ["--page", join(dir, "nope.html"), "--out", out],
      /--page .*nope\.html: no such file/,
    ],
    [
      ["--page", page, "--fit", "0", "--out", out],
      /--fit 0: use a positive number/,
    ],
    [
      ["--page", page, "--width", "-1", "--out", out],
      /--width -1: use a positive number/,
    ],
    [["--page", page, "--height", "tall", "--out", out], /--height tall/],
    [["--page", page, "--href", "https://x.example", "--out", out], /--href/],
    [
      ["--img", img, "--fit", "300", "--out", out],
      /--fit and --height go with --page/,
    ],
    [["--page", page], /needs --out/],
  ]) {
    const result = figure(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.err, reason);
  }
});

test("figure --page warns on stderr above 1 MB and still writes the figure", () => {
  const page = join(dir, "big-page.html");
  writeFileSync(page, `<p>${"x".repeat(FIGURE_WARN_BYTES + 1)}</p>`);
  const out = join(dir, "big-page-figure.html");
  const result = figure(["--page", page, "--out", out]);
  assert.equal(result.code, 0);
  assert.match(result.err, /^kit: warning: the figure is .*below 1 MB/);
  assert.match(readFileSync(out, "utf8"), /shadowrootmode/);
});

test("pageSelector points :root, html and body at the stand-ins and nothing else", () => {
  for (const [from, to] of [
    [":root", ".cp-page-root"],
    [":root.dark", ".cp-page-root.dark"],
    ["html.dark body > .a", "cp-page-html.dark cp-page-body > .a"],
    ["HTML, Body", "cp-page-html, cp-page-body"],
    [":is(html, body) .x", ":is(cp-page-html, cp-page-body) .x"],
    [
      ".body .html #body [data-x=body] ::root",
      ".body .html #body [data-x=body] ::root",
    ],
    ["body-x html-y .tbody", "body-x html-y .tbody"],
    ["tbody, a:root-ish", "tbody, a:root-ish"],
  ])
    assert.equal(pageSelector(from), to, from);
});

test("mediaMatches decides size queries against the design box and leaves the rest", () => {
  for (const [query, expected] of [
    ["@media (min-width: 1024px)", true],
    ["@media (min-width:64rem)", true],
    ["@media (min-width: 80.0625rem)", false],
    ["@media (max-width: 640px)", false],
    ["@media screen and (min-width: 768px) and (max-width: 1280px)", true],
    ["@media only screen and (max-width: 500px)", false],
    ["@media print", false],
    ["@media (width >= 48rem)", true],
    ["@media (width < 48rem)", false],
    ["@media (40rem <= width < 96rem)", true],
    ["@media (height > 900px)", false],
    ["@media (orientation: landscape)", true],
    ["@media (max-width: 500px), (min-width: 1000px)", true],
    ["@media (prefers-color-scheme: dark)", null],
    ["@media (hover: hover) and (min-width: 10px)", null],
    ["@media not all and (min-width: 10px)", false],
    ["@media not all and (width >= 96rem)", true],
    ["@media not (hover: hover)", null],
    ["@media (min-width: 50%)", null],
  ])
    assert.equal(mediaMatches(query, 1280, 800), expected, query);
});

test("viewportToPixels turns viewport units into design-box pixels, never inside strings, urls or names", () => {
  assert.equal(
    viewportToPixels(
      ".a{height:100vh;width:50vw;min-height:calc(100dvh - 2rem);margin:-10svh .5vmin 1vmax}",
      1280,
      800,
    ),
    ".a{height:800px;width:640px;min-height:calc(800px - 2rem);margin:-80px 4px 12.8px}",
  );
  const untouched =
    '.h-100vh{content:"100vh";background:url(data:x/y;base64,AA9vhB);--x-2vh:1}' +
    ".h-\\[100dvh\\]{color:red}[data-h=50vh]{color:blue}";
  assert.equal(viewportToPixels(untouched, 1280, 800), untouched);
});

test("figureSelectorCanMatch drops what a static, inert figure never shows", () => {
  const names = new Set(["cp-page-root", "btn", "light"]);
  for (const [selector, expected] of [
    [".btn", true],
    [".missing", false],
    [".btn:hover", false],
    [".btn:focus-visible", false],
    [".btn:not(:hover)", true],
    [".dark\\:text-red:is(.dark *)", false],
    [".btn:is(.light *)", true],
    [":where(.dark, .light) .btn", true],
    [".dark :where(.btn)", false],
    [".btn:has(.missing)", false],
    [".btn::before", true],
    ["[data-state=open] .btn", true],
  ])
    assert.equal(figureSelectorCanMatch(selector, names), expected, selector);
});
