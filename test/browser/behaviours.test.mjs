/**
 * The behaviour layer in Chromium, inside a `sandbox="allow-scripts"` srcdoc
 * frame (an opaque origin, as plan pages are drawn): tabs, a toggle with Esc
 * and outside click, and two captured stories as states of a group, by mouse
 * at desktop width and by tap at 390×844. Run with `pnpm test:browser`.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { compose, loadKit } from "../../src/kit.mjs";

const kit = loadKit(fileURLToPath(new URL("../fixtures/kit", import.meta.url)));

const FRAGMENT = `<div data-kit-tabs>
  <button data-kit-tab="one" data-testid="tab-one">One</button>
  <button data-kit-tab="two" data-testid="tab-two">Two</button>
  <section data-kit-panel="one" data-testid="panel-one">First panel</section>
  <section data-kit-panel="two" data-testid="panel-two" hidden>Second panel</section>
</div>
<button data-kit-toggle="menu" data-testid="menu-button">Menu</button>
<ul id="menu" data-testid="menu" hidden><li>Rename</li></ul>
<p data-testid="outside">Outside</p>
<kit-snippet id="story:shell-iconrail--default@1280" data-kit-state="rail:closed" data-kit-set="rail:open"></kit-snippet>
<kit-snippet id="story:primitives-dialog--open@1280" data-kit-state="rail:open" data-kit-set="rail:closed" hidden></kit-snippet>
<script>document.body.setAttribute("data-author-ran", String(window.origin));</script>`;

const html = compose(kit, {
  frame: "route:orchestrator@1280",
  slots: [{ name: "main", content: FRAGMENT }],
});
const host = `<!doctype html><iframe sandbox="allow-scripts" style="width:100%;height:100vh;border:0" srcdoc="${html
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")}"></iframe>`;

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function open(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.setContent(host);
  const frame = page.frameLocator("iframe");
  await frame.locator("body[data-author-ran]").waitFor({ state: "attached" });
  return { context, frame };
}

const visible = (frame, id) => frame.getByTestId(id).isVisible();

test("clicks switch tabs, open and close a menu, and swap captured story states", async () => {
  const { context, frame } = await open({
    viewport: { width: 1280, height: 800 },
  });
  try {
    // The author's script ran, in an opaque origin.
    assert.equal(
      await frame.locator("body").getAttribute("data-author-ran"),
      "null",
    );

    assert.equal(await visible(frame, "panel-one"), true);
    assert.equal(await visible(frame, "panel-two"), false);
    await frame.getByTestId("tab-two").click();
    assert.equal(await visible(frame, "panel-one"), false);
    assert.equal(await visible(frame, "panel-two"), true);
    assert.equal(
      await frame.getByTestId("tab-two").getAttribute("aria-selected"),
      "true",
    );

    const button = frame.getByTestId("menu-button");
    assert.equal(await button.getAttribute("aria-expanded"), "false");
    await button.click();
    assert.equal(await visible(frame, "menu"), true);
    assert.equal(await button.getAttribute("aria-expanded"), "true");
    await button.press("Escape");
    assert.equal(await visible(frame, "menu"), false);
    assert.equal(await button.getAttribute("aria-expanded"), "false");
    await button.click();
    assert.equal(await visible(frame, "menu"), true);
    await frame.getByTestId("outside").click();
    assert.equal(await visible(frame, "menu"), false);

    // Two captured stories as the closed and open states of one group.
    const rail = frame.locator('nav[data-kit-state="rail:closed"]');
    const dialog = frame.locator('[role="dialog"][data-kit-state="rail:open"]');
    assert.equal(await rail.isVisible(), true);
    assert.equal(await dialog.isVisible(), false);
    // On one of the captured story's own links: it switches state and does
    // not navigate the frame away.
    await rail.getByRole("link", { name: "Settings" }).click();
    assert.equal(await rail.isVisible(), false);
    assert.equal(await dialog.isVisible(), true);
    await dialog.click();
    assert.equal(await rail.isVisible(), true);
  } finally {
    await context.close();
  }
});

test("taps work the same at 390×844 on a touch screen", async () => {
  const { context, frame } = await open({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    await frame.getByTestId("tab-two").tap();
    assert.equal(await visible(frame, "panel-two"), true);
    assert.equal(await visible(frame, "panel-one"), false);
    await frame.getByTestId("menu-button").tap();
    assert.equal(await visible(frame, "menu"), true);
    await frame.getByTestId("outside").tap();
    assert.equal(await visible(frame, "menu"), false);
  } finally {
    await context.close();
  }
});
