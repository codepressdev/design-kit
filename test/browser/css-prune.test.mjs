/**
 * Pruned CSS draws the same pixels as the full CSS: every fixture frame at
 * 1280 and 390, light and dark, and after the interactions that show what
 * compose saw hidden (a data-kit-state panel, a data-kit-toggle menu, a class
 * only an author script adds). Run with `pnpm test:browser`.
 */
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { compose, loadKit } from "../../src/kit.mjs";

// The fixture kit plus visible styles for the parts the interactions show,
// and theme rules, so a wrongly pruned rule changes pixels.
const dir = mkdtempSync(join(tmpdir(), "design-kit-prune-browser-"));
cpSync(fileURLToPath(new URL("../fixtures/kit", import.meta.url)), dir, {
  recursive: true,
});
appendFileSync(
  join(dir, "css/routes.css"),
  `
.light body,.light .surface{background:rgb(250,250,250)}
.dark body,.dark .surface{background:rgb(20,20,20);color:white}
.surface{display:block;padding:12px}
.state-panel{display:block;width:120px;height:40px;background:rgb(200,40,40)}
.menu-list{width:160px;height:60px;background:rgb(40,160,40);margin:0}
.script-only{width:200px;height:30px;background:rgb(40,40,200)}
@media (max-width:500px){.state-panel{width:60px}}
.never-used{display:none!important}
`,
);
appendFileSync(
  join(dir, "css/stories.css"),
  "\n.icon-rail{min-height:40px;border:4px solid rgb(120,0,120)}\n",
);
const kit = loadKit(dir);
after(() => rmSync(dir, { recursive: true, force: true }));

const FRAGMENT = `<div class="surface">
  <button data-kit-set="view:two" data-testid="set-two">Two</button>
  <div class="state-panel" data-kit-state="view:one">one</div>
  <div class="state-panel" data-kit-state="view:two" hidden>two</div>
  <button data-kit-toggle="menu" data-testid="menu-button">Menu</button>
  <ul id="menu" class="menu-list" hidden><li>Rename</li></ul>
  <p data-testid="script-target">styled by a script</p>
</div>
<script>document.querySelector('[data-testid="script-target"]').classList.add("script-only");</script>`;

const FRAMES = [
  ["route:orchestrator@1280", [{ name: "main", content: FRAGMENT }]],
  ["story:orchestrator-feed--long@1280", []],
  ["story:primitives-dialog--open@1280", []],
  ["story:shell-iconrail--default@1280", []],
];

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function shoot(html, width, act) {
  const context = await browser.newContext({
    viewport: { width, height: 700 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (act) await act(page);
    return await page.screenshot({ fullPage: true });
  } finally {
    await context.close();
  }
}

test("pruned and full CSS draw the same pixels for every fixture frame", async () => {
  for (const [frame, slots] of FRAMES) {
    for (const theme of ["light", "dark"]) {
      const pruned = compose(kit, { frame, slots, theme });
      const full = compose(kit, { frame, slots, theme, css: "full" });
      assert.ok(pruned.length < full.length, `${frame} pruned is smaller`);
      for (const width of [1280, 390]) {
        const [a, b] = [await shoot(pruned, width), await shoot(full, width)];
        assert.ok(a.equals(b), `${frame} ${theme} ${width}: pixels differ`);
      }
    }
  }
});

test("after showing a hidden state, opening a toggle menu and an author script's class, pruned draws as full", async () => {
  const [frame, slots] = FRAMES[0];
  const act = async (page) => {
    await page.getByTestId("set-two").click();
    await page.getByTestId("menu-button").click();
    await page.locator("#menu").waitFor({ state: "visible" });
  };
  for (const theme of ["light", "dark"]) {
    const pruned = compose(kit, { frame, slots, theme });
    const full = compose(kit, { frame, slots, theme, css: "full" });
    assert.doesNotMatch(pruned, /never-used/);
    for (const width of [1280, 390]) {
      const a = await shoot(pruned, width, act);
      const b = await shoot(full, width, act);
      assert.ok(a.equals(b), `${theme} ${width}: pixels differ`);
    }
  }
  // And the styles really applied, so the comparison saw them.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 700 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(compose(kit, { frame, slots }), {
      waitUntil: "load",
    });
    await act(page);
    const backgrounds = await page.evaluate(() =>
      [
        '[data-kit-state="view:two"]',
        "#menu",
        '[data-testid="script-target"]',
      ].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor),
    );
    assert.deepEqual(backgrounds, [
      "rgb(200, 40, 40)",
      "rgb(40, 160, 40)",
      "rgb(40, 40, 200)",
    ]);
  } finally {
    await context.close();
  }
});
