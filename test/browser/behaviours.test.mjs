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

const AFTER_FRAGMENT = `<button data-kit-set="save:loading" data-testid="save-btn">Save</button>
<button data-kit-set="save:idle" data-testid="reset-btn">Reset</button>
<div data-kit-state="save:idle" data-testid="save-idle">Idle</div>
<div data-kit-state="save:loading" data-kit-after="60:done" data-testid="save-loading" hidden>Saving…</div>
<div data-kit-state="save:done" data-testid="save-done" hidden>Saved</div>

<div data-kit-state="boot:initial" data-kit-after="60:changed" data-testid="boot-initial">Initial</div>
<div data-kit-state="boot:changed" data-testid="boot-changed" hidden>Changed</div>

<button data-kit-set="cross:go" data-testid="cross-btn">Cross</button>
<button data-kit-set="cross:idle" data-testid="cross-reset">Cross Reset</button>
<div data-kit-state="cross:idle" data-testid="cross-idle">Cross Idle</div>
<div data-kit-state="cross:go" data-kit-after="60:toast:shown" data-testid="cross-go" hidden>Cross Go</div>
<div data-kit-state="toast:hidden" data-testid="toast-hidden">No toast</div>
<div data-kit-state="toast:shown" data-testid="toast-shown" hidden>Toast shown</div>

<button data-kit-set="clamp:go" data-testid="clamp-btn">Clamp</button>
<div data-kit-state="clamp:idle" data-testid="clamp-idle">Clamp Idle</div>
<div data-kit-state="clamp:go" data-kit-after="10:done" data-testid="clamp-go" hidden>Clamp Go</div>
<div data-kit-state="clamp:done" data-testid="clamp-done" hidden>Clamp Done</div>

<button data-kit-set="bad:a" data-testid="bad-a-btn">Bad A</button>
<button data-kit-set="bad:b" data-testid="bad-b-btn">Bad B</button>
<button data-kit-set="bad:c" data-testid="bad-c-btn">Bad C</button>
<div data-kit-state="bad:idle" data-testid="bad-idle">Bad Idle</div>
<div data-kit-state="bad:a" data-kit-after="abc:done" data-testid="bad-a" hidden>Bad A</div>
<div data-kit-state="bad:b" data-kit-after="" data-testid="bad-b" hidden>Bad B</div>
<div data-kit-state="bad:c" data-kit-after="100:" data-testid="bad-c" hidden>Bad C</div>
<div data-kit-state="bad:done" data-testid="bad-done" hidden>Bad Done</div>
<script>document.body.setAttribute("data-after-ready", "1");</script>`;

const afterHtml = compose(kit, {
  frame: "route:orchestrator@1280",
  slots: [{ name: "main", content: AFTER_FRAGMENT }],
});
const afterHost = `<!doctype html><iframe sandbox="allow-scripts" style="width:100%;height:100vh;border:0" srcdoc="${afterHtml
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")}"></iframe>`;

async function openAfter({ fakeClock = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err));
  if (fakeClock) {
    await page.clock.install({ time: 1000 });
    await page.clock.pauseAt(1000);
  }
  await page.setContent(afterHost);
  const frame = page.frameLocator("iframe");
  await frame.locator("body[data-after-ready]").waitFor({ state: "attached" });
  return { context, page, frame, errors };
}

test("data-kit-after transitions on user action, cancels on reset, skips boot, supports cross-group, clamps delay, and ignores malformed values", async () => {
  const { context, page, frame, errors } = await openAfter({ fakeClock: true });
  try {
    // Initial boot does NOT auto-fire data-kit-after on an initially visible state.
    assert.equal(await visible(frame, "boot-initial"), true);
    assert.equal(await visible(frame, "boot-changed"), false);
    await page.clock.runFor(500);
    assert.equal(await visible(frame, "boot-initial"), true);
    assert.equal(await visible(frame, "boot-changed"), false);

    // Click -> loading -> auto-transition to done -> Reset back to idle.
    assert.equal(await visible(frame, "save-idle"), true);
    await frame.getByTestId("save-btn").click();
    assert.equal(await visible(frame, "save-loading"), true);
    assert.equal(await visible(frame, "save-done"), false);
    await page.clock.runFor(59);
    assert.equal(await visible(frame, "save-loading"), true);
    assert.equal(await visible(frame, "save-done"), false);
    await page.clock.runFor(1);
    assert.equal(await visible(frame, "save-loading"), false);
    assert.equal(await visible(frame, "save-done"), true);
    await frame.getByTestId("reset-btn").click();
    assert.equal(await visible(frame, "save-idle"), true);
    assert.equal(await visible(frame, "save-done"), false);

    // Rapid Reset before delay cancels pending timer so done never overwrites idle.
    await frame.getByTestId("save-btn").click();
    assert.equal(await visible(frame, "save-loading"), true);
    await page.clock.runFor(30);
    await frame.getByTestId("reset-btn").click();
    assert.equal(await visible(frame, "save-idle"), true);
    await page.clock.runFor(500);
    assert.equal(await visible(frame, "save-idle"), true);
    assert.equal(await visible(frame, "save-done"), false);

    // Delay below 50ms is clamped to 50ms.
    await frame.getByTestId("clamp-btn").click();
    assert.equal(await visible(frame, "clamp-go"), true);
    await page.clock.runFor(49);
    assert.equal(await visible(frame, "clamp-go"), true);
    assert.equal(await visible(frame, "clamp-done"), false);
    await page.clock.runFor(1);
    assert.equal(await visible(frame, "clamp-done"), true);

    // Cross-group data-kit-after="<ms>:<otherGroup>:<state>" transitions the target group.
    assert.equal(await visible(frame, "toast-hidden"), true);
    assert.equal(await visible(frame, "toast-shown"), false);
    await frame.getByTestId("cross-btn").click();
    assert.equal(await visible(frame, "cross-go"), true);
    await page.clock.runFor(60);
    assert.equal(await visible(frame, "toast-hidden"), false);
    assert.equal(await visible(frame, "toast-shown"), true);

    // Malformed data-kit-after values do not throw or break state switching.
    for (const id of ["a", "b", "c"]) {
      await frame.getByTestId(`bad-${id}-btn`).click();
      assert.equal(await visible(frame, `bad-${id}`), true);
      await page.clock.runFor(500);
      assert.equal(await visible(frame, `bad-${id}`), true);
      assert.equal(await visible(frame, "bad-done"), false);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("data-kit-after fires with the real browser clock in a sandboxed iframe", async () => {
  const { context, frame, errors } = await openAfter({ fakeClock: false });
  try {
    await frame.getByTestId("save-btn").click();
    assert.equal(await visible(frame, "save-loading"), true);
    await frame.getByTestId("save-done").waitFor({ state: "visible" });
    assert.equal(await visible(frame, "save-loading"), false);
    await frame.getByTestId("reset-btn").click();
    assert.equal(await visible(frame, "save-idle"), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
