/**
 * `figure --page` in a host page that fights it: the composed page's element
 * inside the figure's shadow root has the computed style it has on the
 * composed page opened alone (kit fonts, theme tokens on :root and html,
 * light and dark), and the host's own element is untouched by the figure.
 * Chromium and WebKit. Run with `pnpm test:browser`.
 */
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "@playwright/test";

import { compose, loadKit, pageFigureHtml } from "../../src/kit.mjs";

// The fixture kit with theme tokens on :root and html, body styles, a dark
// theme, a .btn the host hides, viewport units and a width media query, so
// every rewrite figure --page makes shows in a computed style.
const dir = mkdtempSync(join(tmpdir(), "design-kit-figure-browser-"));
cpSync(fileURLToPath(new URL("../fixtures/kit", import.meta.url)), dir, {
  recursive: true,
});
appendFileSync(
  join(dir, "css/routes.css"),
  `
:root{--brand:rgb(10,120,200);--surface:rgb(250,250,250)}
html{--ink:rgb(20,20,20)}
:root.dark{--brand:rgb(240,160,30);--surface:rgb(20,20,20)}
html.dark{--ink:rgb(235,235,235)}
html{font-size:16px}
body{margin:0;font-family:"Geist",sans-serif;font-size:14px;line-height:1.5;color:var(--ink);background:var(--surface)}
.btn{display:inline-block;padding:6px 12px;border:1px solid var(--brand);border-radius:6px;color:var(--brand);font-weight:600}
.tall{height:50vh;width:25vw}
@media (min-width:1024px){.btn{letter-spacing:1px}}
@media (max-width:640px){.btn{text-transform:uppercase}}
`,
);
const kit = loadKit(dir);
after(() => rmSync(dir, { recursive: true, force: true }));

const SLOT = `<div class="surface"><span class="btn" data-testid="probe">Deploy</span><div class="tall" data-testid="tall"></div></div>`;

// What a plan page might set that must not reach the figure, and what the
// figure must not change.
const HOST_CSS = `body{font:30px serif;color:red}.btn{display:none}`;
const HOST_BODY = `<p class="host-note" data-testid="host">Host text</p>`;

const PROPERTIES = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-transform",
  "display",
  "padding-top",
  "padding-left",
  "border-top-style",
  "border-top-width",
  "border-top-color",
  "border-top-left-radius",
  "width",
  "height",
];

function styleOf(element, names) {
  const style = getComputedStyle(element);
  return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n)]));
}

async function open(browser, html, width = 1280) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return { page, context };
}

/** Computed styles of probe elements on the composed page opened alone. */
async function standalone(browser, html) {
  const { page, context } = await open(browser, html);
  try {
    return await page.evaluate(
      ({ names, fn }) => {
        const styleOf = new Function(`return ${fn}`)();
        return {
          probe: styleOf(
            document.querySelector('[data-testid="probe"]'),
            names,
          ),
          tall: styleOf(document.querySelector('[data-testid="tall"]'), [
            "width",
            "height",
          ]),
        };
      },
      { names: PROPERTIES, fn: styleOf.toString() },
    );
  } finally {
    await context.close();
  }
}

/** The same probes inside the figure, and the host's own element. */
async function inHost(browser, fragment, withFigure = true) {
  const html = `<!doctype html><html><head><style>${HOST_CSS}</style></head><body>${HOST_BODY}${withFigure ? fragment : ""}</body></html>`;
  // A narrow host viewport: the figure's media queries follow its own
  // design width, not this.
  const { page, context } = await open(browser, html, 800);
  try {
    return await page.evaluate(
      ({ names, fn }) => {
        const styleOf = new Function(`return ${fn}`)();
        const hostEl = document.querySelector('[data-testid="host"]');
        const host = styleOf(hostEl, [...getComputedStyle(hostEl)]);
        const figure = document.querySelector("[data-kit-figure-page]");
        if (!figure) return { host };
        const root = figure.shadowRoot;
        return {
          host,
          shadow: Boolean(root),
          probe:
            root && styleOf(root.querySelector('[data-testid="probe"]'), names),
          tall:
            root &&
            styleOf(root.querySelector('[data-testid="tall"]'), [
              "width",
              "height",
            ]),
          box: figure.getBoundingClientRect().toJSON(),
          // The hoisted @font-face rules reach the document's font set.
          fonts: [...document.fonts].map((face) => face.family),
        };
      },
      { names: PROPERTIES, fn: styleOf.toString() },
    );
  } finally {
    await context.close();
  }
}

for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  test(`${name}: the figure renders the composed page's styles, the host keeps its own`, async () => {
    const browser = await engine.launch();
    try {
      const seen = {};
      for (const theme of ["light", "dark"]) {
        const page = compose(kit, {
          frame: "route:orchestrator@1280",
          slots: [{ name: "main", content: SLOT }],
          theme,
        });
        const alone = await standalone(browser, page);
        const { html } = pageFigureHtml(page, { fit: 640 });
        const hosted = await inHost(browser, html);
        assert.equal(
          hosted.shadow,
          true,
          `${name} ${theme}: shadow root built`,
        );
        assert.deepEqual(hosted.probe, alone.probe, `${name} ${theme}: probe`);
        assert.deepEqual(hosted.tall, alone.tall, `${name} ${theme}: vh/vw`);
        assert.ok(
          hosted.fonts.some((family) => /Geist/.test(family)),
          `${name} ${theme}: kit fonts registered (${hosted.fonts})`,
        );
        assert.equal(hosted.box.width, 640);
        assert.equal(hosted.box.height, 400);
        // The host's element is styled by the host alone.
        const bare = await inHost(browser, html, false);
        assert.deepEqual(hosted.host, bare.host, `${name} ${theme}: host`);
        assert.equal(hosted.host.display, "block");
        assert.equal(hosted.host["font-size"], "30px");
        seen[theme] = alone.probe;
      }
      // The themes differ, so matching each is not matching neither.
      assert.notEqual(seen.light.color, seen.dark.color);
      assert.equal(seen.light.color, "rgb(10, 120, 200)");
      assert.equal(seen.dark.color, "rgb(240, 160, 30)");
      assert.match(seen.light["font-family"], /Geist/);
      assert.equal(seen.light["letter-spacing"], "1px");
      assert.equal(seen.light["text-transform"], "none");
    } finally {
      await browser.close();
    }
  });
}
