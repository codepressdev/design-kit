/**
 * Clickable mockups: the author's inline scripts survive compose, the kit's
 * own scripts and handlers never do, and the behaviour layer is inlined once
 * when a page uses it. The browser half is test/browser/behaviours.test.mjs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compose, loadKit, sanitizeMarkup } from "../src/kit.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const kit = loadKit(FIXTURE);
const FRAME = "route:orchestrator@1280";

function page(main, options = {}) {
  return compose(kit, {
    frame: FRAME,
    slots: [{ name: "main", content: main }],
    ...options,
  });
}

const scripts = (html) => [...html.matchAll(/<script\b[^>]*>/gi)].map(String);

test("an author's inline script survives; the kit's scripts and every handler do not", () => {
  const html = page(
    `<p>New</p><script>window.authorRan = 1;</script>
<script type="module" id="wiring" onload="x()">window.moduleRan = 1;</script>
<button onclick="steal()">Go</button>
<kit-snippet id="story:primitives-dialog--open@1280"></kit-snippet>`,
  );
  assert.match(html, /<script>window\.authorRan = 1;<\/script>/);
  // Only type and id are kept on the tag; onload is a handler.
  assert.match(
    html,
    /<script type="module" id="wiring">window\.moduleRan = 1;<\/script>/,
  );
  // The captured dialog story carries <script>alert("x")</script> and
  // onclick="steal()"; the fragment's own onclick goes too.
  assert.match(html, /Dialog body/);
  assert.doesNotMatch(html, /alert\(/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.equal(scripts(html).length, 2);
  // No placeholder is left behind.
  assert.doesNotMatch(html, /kit-author-script/);
});

test("a fragment's remote script is removed, whether by src, href or xlink:href", () => {
  const html = page(
    `<script src="https://cdn.example.com/a.js"></script>
<script SRC="//cdn.example.com/b.js">window.inline = 1;</script>
<svg><script href="https://cdn.example.com/c.js"></script><script xlink:href="https://cdn.example.com/d.js"></script></svg>
<script>window.kept = 1;</script>`,
  );
  assert.doesNotMatch(html, /cdn\.example\.com/);
  assert.doesNotMatch(html, /window\.inline/);
  assert.deepEqual(scripts(html), ["<script>"]);
  assert.match(html, /window\.kept = 1/);
});

test("placeholder-shaped text in a fragment cannot claim an author script", () => {
  // The placeholder key is random per compose, so markup written ahead of
  // time cannot claim an author script's place, and a held script returns once.
  const html = page(
    `<script>window.a = 1;</script><!--kit-author-script 0 0--><!--kit-author-script 00000000000000000000000000000000 0-->`,
  );
  assert.equal((html.match(/window\.a = 1/g) ?? []).length, 1);
});

test("without behaviour attributes or author scripts, compose output is byte for byte what it was", () => {
  const slot = `<section data-kit-new class="new-panel">New panel</section>
<kit-snippet id="story:primitives-dialog--open@1280"></kit-snippet>`;
  // sha256 of each page as composed before behaviours existed (0.9.0).
  const cases = [
    [
      { frame: FRAME },
      "eabc1662665b27354e7f6ef4bdb6fb83bf73b238abc52ef420e4bba744c20926",
    ],
    [
      { frame: FRAME, theme: "dark", showNew: true },
      "3afe4328c4803914b7dedebf1573edc5bd6884c97d518ccb6c2b47d6f9c9e65f",
    ],
    [
      { frame: "story:primitives-dialog--open@1280" },
      "f82f029a64789167c4dd9aac3641209cbf593f354acd60e9a6ab9eeb8b86f66d",
    ],
    [
      {
        frame: "story:orchestrator-feed--long@1280",
        theme: "dark",
        showNew: true,
      },
      "650e7771f837386891644baf5fc9f7fc42ccfcb6af84376f5f4eb41832a74390",
    ],
    [
      { frame: FRAME, slots: [{ name: "main", content: slot }] },
      "f5143a3b0b6852d290fa59a25c5c9f534fd1bacb2114ce8d52d8d4df9d0ffc4e",
    ],
    [
      {
        frame: FRAME,
        slots: [{ name: "main", content: slot }],
        theme: "dark",
        showNew: true,
      },
      "30243e2dbfec229d57a2f2baf894de2bd116879ae1db7d596d8befbb03da7d21",
    ],
  ];
  for (const [options, expected] of cases) {
    const html = compose(kit, options);
    assert.equal(
      createHash("sha256").update(html).digest("hex"),
      expected,
      `compose ${JSON.stringify(options)} changed; a page without behaviours must compose exactly as before`,
    );
    assert.doesNotMatch(html, /data-kit-behaviours|data-kit-target/);
  }
});

test("tabs and a toggle inline the behaviour script once, with its CSS", () => {
  const html = page(`<div data-kit-tabs>
  <button data-kit-tab="one">One</button><button data-kit-tab="two">Two</button>
  <section data-kit-panel="one">First</section><section data-kit-panel="two" hidden>Second</section>
</div>
<button data-kit-toggle="menu">Menu</button><ul id="menu" hidden><li>Item</li></ul>`);
  assert.equal((html.match(/<script data-kit-behaviours>/g) ?? []).length, 1);
  assert.match(
    html,
    /\[data-kit-target\]\[hidden\]\{display:none !important\}/,
  );
  // The script sits after the content, just before </body>.
  assert.ok(html.indexOf("data-kit-behaviours") > html.indexOf('id="menu"'));
  assert.match(html, /<\/script>\n<\/body>/);
  // Behaviour attributes and `hidden` are plain attributes and survive.
  assert.match(html, /<section data-kit-panel="two" hidden>/);
  // Without --show-new, triggers carry no outline.
  assert.doesNotMatch(html, /#0090ff/);
});

test("a fragment that already carries a behaviour script still gets exactly one", () => {
  const first = page(
    `<button data-kit-set="g:b">B</button><div data-kit-state="g:a">A</div><div data-kit-state="g:b" hidden>B</div>`,
  );
  const body = first.slice(first.indexOf("<main"), first.indexOf("</body>"));
  const second = page(body);
  assert.equal((second.match(/<script data-kit-behaviours>/g) ?? []).length, 1);
  assert.equal(scripts(second).length, 1);
});

test("--show-new also outlines behaviour triggers", () => {
  const html = page(
    `<button data-kit-toggle="m">Menu</button><div id="m" hidden>x</div>`,
    {
      showNew: true,
    },
  );
  assert.match(
    html,
    /\[data-kit-toggle\],\[data-kit-tab\],\[data-kit-set\]\{outline:2px dashed #0090ff/,
  );
});

test("a <kit-snippet> passes hidden and behaviour attributes to each root it expands to", () => {
  const html = page(
    `<kit-snippet id="story:shell-iconrail--default@1280" data-kit-state="rail:closed" data-kit-set="rail:open"></kit-snippet>
<kit-snippet id="story:primitives-dialog--open@1280" data-kit-state="rail:open" data-kit-set="rail:closed" hidden></kit-snippet>`,
  );
  assert.match(
    html,
    /<nav data-kit-snippet="story:shell-iconrail--default@1280" data-kit-state="rail:closed" data-kit-set="rail:open" class="icon-rail"/,
  );
  // The dialog story has two roots (the trigger and its portal); both get it.
  assert.match(
    html,
    /<button data-kit-snippet="story:primitives-dialog--open@1280" hidden="" data-kit-state="rail:open" data-kit-set="rail:closed" type="button">/,
  );
  assert.match(
    html,
    /<div data-kit-snippet="story:primitives-dialog--open@1280" hidden="" data-kit-state="rail:open" data-kit-set="rail:closed" role="dialog"/,
  );
  assert.equal((html.match(/<script data-kit-behaviours>/g) ?? []).length, 1);
});

test("the sanitizer keeps native interactivity", () => {
  const markup = `<button popovertarget="p" popovertargetaction="toggle" aria-haspopup="menu" aria-expanded="false">Open</button>
<div id="p" popover="auto" role="menu" hidden>Menu</div>
<details open><summary aria-controls="d">More</summary><p id="d">Details</p></details>
<dialog open aria-modal="true">Dialog</dialog>
<form action="#"><label>Name <input name="n" type="text" value="x" required></label>
<select name="s"><option selected>a</option></select><textarea name="t">b</textarea>
<input type="checkbox" checked><input type="radio" name="r"><button type="submit" formaction="#">Send</button></form>`;
  assert.equal(sanitizeMarkup(markup), markup);
});

test("the sanitizer checks the attribute the browser uses when a name repeats", () => {
  // The browser keeps the first of two same-named attributes.
  const out = sanitizeMarkup(
    `<img src="https://cdn.example.com/x.png" src="a.png"><a href="javascript:alert(1)" href="#ok">x</a>`,
  );
  assert.doesNotMatch(out, /cdn\.example\.com|javascript:/);
});

test("the sanitizer ends a comment where the browser does", () => {
  // `--!>` closes a comment, and `<!-->` and `<!--->` are empty comments,
  // so what follows them is markup the sanitizer must see.
  for (const markup of [
    `<!-- --!><script>window.pwn = 1</script> --><p>x</p>`,
    `<!--><script>window.pwn = 1</script>--><p>x</p>`,
    `<!---><script>window.pwn = 1</script>--><p>x</p>`,
    `<!-- a <!--><script>window.pwn = 1</script>--><p>x</p>`,
    `<!-- --!> <img src="x.png" onerror="window.pwn = 1"> -->`,
  ]) {
    const out = sanitizeMarkup(markup);
    assert.doesNotMatch(out, /<script|onerror|window\.pwn/i, markup);
  }
  // An ordinary comment is kept as it was.
  assert.equal(
    sanitizeMarkup("<!-- note --><p>x</p>"),
    "<!-- note --><p>x</p>",
  );
});

test("a style, title or textarea holding markup is dropped, as SVG and MathML parse it", () => {
  for (const markup of [
    `<svg><style><img src="x.png" onerror="window.pwn = 1"></style></svg>`,
    `<math><title><img src="x.png" onerror="window.pwn = 1"></title></math>`,
    `<svg><textarea><script>window.pwn = 1</script></textarea></svg>`,
    `<svg><style><!--</style><img src="x.png" onerror="window.pwn = 1">--></style></svg>`,
  ]) {
    const out = sanitizeMarkup(markup);
    assert.doesNotMatch(out, /onerror|<script|window\.pwn/i, markup);
  }
  // CSS with no markup in it stays, sanitized as before.
  assert.equal(
    sanitizeMarkup(`<style>.a > .b { color: red }</style>`),
    `<style>.a > .b { color: red }</style>`,
  );
});
