/**
 * Playwright browser tests for the annotator's "Open run" link and its
 * undo/redo history:
 * 1. Open run: a relative run URL renders as an absolute link on the host
 *    origin; `javascript:` renders no link; an absolute URL is kept; with
 *    `onOpenRun` the click goes to the host handler; popped out to a real
 *    Document Picture-in-Picture window it opens from the host page, never
 *    in the `about:blank` pop-out.
 * 2. Undo/redo: delete pin #2 of 3 and bring it back with Cmd/Ctrl+Z, the
 *    buttons and redo shortcuts; note edits; focus guards (note textarea,
 *    app input, xterm, Monaco); history cleared by Send to Fix, absent after
 *    a reload, capped at 100 steps; shortcut inside the pop-out window.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { chromium } from "@playwright/test";

import { getAnnotatorRuntimeScript } from "../../src/annotate/index.mjs";

const RUNTIME_SCRIPT = getAnnotatorRuntimeScript();

const PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; padding: 24px; font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    .targets { display: flex; gap: 40px; margin-top: 80px; }
    .targets button { width: 120px; height: 48px; }
    .fields { display: flex; gap: 16px; margin-top: 40px; }
  </style>
</head>
<body>
  <h1>Orders</h1>
  <div class="targets">
    <button id="t1">One</button>
    <button id="t2">Two</button>
    <button id="t3">Three</button>
  </div>
  <div class="fields">
    <input id="app-input" value="app text" />
    <div class="xterm"><textarea class="xterm-helper-textarea" id="xterm-input"></textarea></div>
    <div class="monaco-editor"><textarea id="monaco-input"></textarea></div>
  </div>
  <script src="/annotator.js"></script>
  <script>
    window.__keyLog = [];
    window.addEventListener("keydown", (e) => {
      window.__keyLog.push({ key: e.key, prevented: e.defaultPrevented });
    });
  </script>
</body>
</html>`;

let browser;
let server;
let baseUrl;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/annotator.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
      });
      res.end(RUNTIME_SCRIPT);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function openPage(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));
  await page.goto(`${baseUrl}/app/orders`);
  return { context, page, pageErrors };
}

/** Mount with an onSubmit that returns `runUrl`, optionally with onOpenRun. */
async function mount(
  page,
  { runUrl, withHandler = false, storageKey = false },
) {
  await page.evaluate(
    ({ runUrl, withHandler, storageKey }) => {
      window.__opened = [];
      window.__ctrl = window.__designKitAnnotate.mountAnnotator({
        initialMode: "annotate",
        storageKey,
        onSubmit: async () => ({ message: "Fixing in background", runUrl }),
        ...(withHandler
          ? { onOpenRun: (url) => window.__opened.push(url) }
          : {}),
      });
    },
    { runUrl, withHandler, storageKey },
  );
}

async function addPin(page, selector) {
  const before = await page.evaluate(() => window.__ctrl.getItems().length);
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(
    (n) => window.__ctrl.getItems().length === n,
    before + 1,
  );
}

async function clickControl(page, name) {
  const rect = await page.evaluate(
    (n) => window.__ctrl.getControlRect(n),
    name,
  );
  assert.ok(rect, `control ${name} is visible`);
  await page.mouse.click(rect.centerX, rect.centerY);
}

const itemIds = (page) =>
  page.evaluate(() => window.__ctrl.getItems().map((i) => i.id));
const itemIndexes = (page) =>
  page.evaluate(() => window.__ctrl.getItems().map((i) => i.index));

test("Open run: absolute href on the host origin, unsafe URLs rejected, host handler and new-tab fallback", async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    // No handler + relative URL: absolute link on the host origin, opened in a new tab.
    await mount(page, { runUrl: "/dashboard/q5/orchestrator/p1" });
    await addPin(page, "#t1");
    await page.evaluate(() => window.__ctrl.submitFix());
    assert.equal(
      await page.evaluate(() => window.__ctrl.getToastHref()),
      `${baseUrl}/dashboard/q5/orchestrator/p1`,
    );
    assert.equal(
      await page.evaluate(() => window.__ctrl.getState().toastUrl),
      `${baseUrl}/dashboard/q5/orchestrator/p1`,
    );
    const popupPromise = context.waitForEvent("page");
    await clickControl(page, "toast-link");
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), `${baseUrl}/dashboard/q5/orchestrator/p1`);
    assert.equal(page.url(), `${baseUrl}/app/orders`);
    await popup.close();
    await page.evaluate(() => window.__ctrl.destroy());

    // javascript: URL renders no link at all.
    await mount(page, { runUrl: "javascript:alert(1)" });
    await addPin(page, "#t1");
    await page.evaluate(() => window.__ctrl.submitFix());
    assert.equal(await page.evaluate(() => window.__ctrl.getToastHref()), "");
    assert.equal(
      await page.evaluate(() => window.__ctrl.getControlRect("toast-link")),
      null,
    );
    assert.equal(await page.evaluate(() => window.__ctrl.openRun()), false);
    await page.evaluate(() => window.__ctrl.destroy());

    // An absolute URL is used as-is; with onOpenRun the click goes to the host.
    await mount(page, {
      runUrl: "https://codepress.dev/dashboard/q5/chat/abc",
      withHandler: true,
    });
    await addPin(page, "#t1");
    await page.evaluate(() => window.__ctrl.submitFix());
    let popups = 0;
    const onPage = () => {
      popups += 1;
    };
    context.on("page", onPage);
    await clickControl(page, "toast-link");
    assert.deepEqual(await page.evaluate(() => window.__opened), [
      "https://codepress.dev/dashboard/q5/chat/abc",
    ]);
    // A relative URL reaches the handler absolute.
    await page.evaluate(() => window.__ctrl.destroy());
    await mount(page, { runUrl: "/dashboard/q5/chat/xyz", withHandler: true });
    await addPin(page, "#t1");
    await page.evaluate(() => window.__ctrl.submitFix());
    await clickControl(page, "toast-link");
    assert.deepEqual(await page.evaluate(() => window.__opened), [
      `${baseUrl}/dashboard/q5/chat/xyz`,
    ]);
    context.off("page", onPage);
    assert.equal(popups, 0, "onOpenRun replaces the new-tab navigation");
    assert.equal(page.url(), `${baseUrl}/app/orders`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Open run and the undo shortcut work from a Document Picture-in-Picture pop-out", async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    assert.equal(
      await page.evaluate(() => typeof window.documentPictureInPicture),
      "object",
      "Chromium exposes Document Picture-in-Picture",
    );

    for (const withHandler of [true, false]) {
      await mount(page, {
        runUrl: "/dashboard/q5/orchestrator/p9",
        withHandler,
      });
      await addPin(page, "#t1");
      await addPin(page, "#t2");
      await page.keyboard.press("Escape"); // close the note popover

      const pipPromise = context.waitForEvent("page");
      await clickControl(page, "pop-out");
      const pip = await pipPromise;
      assert.equal(pip.url(), "about:blank");

      // Undo shortcut pressed inside the pop-out window.
      await pip.bringToFront();
      await pip.locator("body").click({ position: { x: 2, y: 2 } });
      await pip.keyboard.press("ControlOrMeta+z");
      assert.equal(
        await page.evaluate(() => window.__ctrl.getItems().length),
        1,
      );
      await pip.keyboard.press("ControlOrMeta+Shift+z");
      assert.equal(
        await page.evaluate(() => window.__ctrl.getItems().length),
        2,
      );

      await page.evaluate(() => window.__ctrl.submitFix());
      const popupPromise = withHandler
        ? null
        : context.waitForEvent("page", (p) => p !== pip);
      await pip.getByText("Open run ↗").click();
      if (withHandler) {
        assert.deepEqual(await page.evaluate(() => window.__opened), [
          `${baseUrl}/dashboard/q5/orchestrator/p9`,
        ]);
      } else {
        const popup = await popupPromise;
        await popup.waitForLoadState();
        assert.equal(popup.url(), `${baseUrl}/dashboard/q5/orchestrator/p9`);
        await popup.close();
      }
      assert.equal(pip.url(), "about:blank", "pop-out never navigates");
      assert.equal(page.url(), `${baseUrl}/app/orders`);
      await page.evaluate(() => window.__ctrl.destroy());
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Undo/redo: shortcuts and buttons restore a deleted pin at its position and disable at stack ends", async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    await mount(page, { runUrl: "/dashboard/q5/orchestrator/p1" });
    assert.equal(await page.evaluate(() => window.__ctrl.canUndo()), false);
    await addPin(page, "#t1");
    await addPin(page, "#t2");
    await addPin(page, "#t3");
    await page.keyboard.press("Escape");
    const original = await itemIds(page);
    assert.equal(original.length, 3);

    await page.evaluate((id) => window.__ctrl.removeItem(id), original[1]);
    assert.deepEqual(await itemIds(page), [original[0], original[2]]);

    await page.keyboard.press("ControlOrMeta+z");
    assert.deepEqual(await itemIds(page), original);
    assert.deepEqual(await itemIndexes(page), [1, 2, 3]);
    assert.notEqual(
      (await page.evaluate(() => window.__keyLog)).at(-1).key.toLowerCase(),
      "z",
      "a handled undo is consumed before the app's own listeners",
    );

    await page.keyboard.press("ControlOrMeta+Shift+z");
    assert.deepEqual(await itemIds(page), [original[0], original[2]]);
    await page.keyboard.press("ControlOrMeta+z");
    assert.deepEqual(await itemIds(page), original);
    await page.keyboard.press("Control+y");
    assert.deepEqual(await itemIds(page), [original[0], original[2]]);
    assert.equal(await page.evaluate(() => window.__ctrl.canRedo()), false);

    // Buttons do the same.
    await clickControl(page, "undo");
    assert.deepEqual(await itemIds(page), original);
    assert.equal(await page.evaluate(() => window.__ctrl.canRedo()), true);
    await clickControl(page, "redo");
    assert.deepEqual(await itemIds(page), [original[0], original[2]]);
    // Redo at the end of its stack: disabled, a click changes nothing.
    await clickControl(page, "redo");
    assert.deepEqual(await itemIds(page), [original[0], original[2]]);

    // Undo everything: remove, then the three adds; then Undo is disabled.
    for (let i = 0; i < 4; i += 1) await clickControl(page, "undo");
    assert.deepEqual(await itemIds(page), []);
    assert.equal(await page.evaluate(() => window.__ctrl.canUndo()), false);
    assert.equal(
      await page.evaluate(() => window.__ctrl.getState().canUndo),
      false,
    );
    await clickControl(page, "undo");
    assert.deepEqual(await itemIds(page), []);
    // An unhandled shortcut is left alone.
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal(
      (await page.evaluate(() => window.__keyLog)).at(-1).prevented,
      false,
    );

    // Any new change clears the redo stack.
    await clickControl(page, "redo");
    assert.equal((await itemIds(page)).length, 1);
    await addPin(page, "#t3");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => window.__ctrl.canRedo()), false);

    // The shortcut also works in Browse mode.
    await clickControl(page, "mode-browse");
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal((await itemIds(page)).length, 1);

    // Closed overlay: no listener, shortcut untouched.
    await page.evaluate(() => window.__ctrl.setOpen(false));
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal((await itemIds(page)).length, 1);
    assert.equal(
      (await page.evaluate(() => window.__keyLog)).at(-1).prevented,
      false,
    );
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Undo/redo: note edits, focus guards, Send to Fix, reload and the 100-step cap", async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    await mount(page, { runUrl: "/dashboard/q5/orchestrator/p1" });
    await addPin(page, "#t1");
    await page.keyboard.type("old note");
    await clickControl(page, "note-save");

    // Reopen the pin's note via its marker (centred on the pin's point).
    const pinRect = await page.evaluate(
      () => window.__ctrl.getItems()[0].point,
    );
    await page.mouse.click(pinRect.x, pinRect.y);
    assert.equal(
      (await itemIds(page)).length,
      1,
      "marker click opens the note",
    );
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("new note");
    await clickControl(page, "note-save");
    assert.equal(
      await page.evaluate(() => window.__ctrl.getItems()[0].note),
      "new note",
    );
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal(
      await page.evaluate(() => window.__ctrl.getItems()[0].note),
      "old note",
    );
    await page.keyboard.press("ControlOrMeta+Shift+z");
    assert.equal(
      await page.evaluate(() => window.__ctrl.getItems()[0].note),
      "new note",
    );

    // Focus guards: the note textarea, an app input, an xterm and a Monaco editor.
    await page.mouse.click(pinRect.x, pinRect.y);
    const undoBefore = await page.evaluate(() => window.__ctrl.canUndo());
    assert.equal(undoBefore, true);
    for (const focus of [null, "#app-input", "#xterm-input", "#monaco-input"]) {
      if (focus) await page.locator(focus).focus();
      const before = await page.evaluate(() =>
        JSON.stringify(window.__ctrl.getItems().map((i) => [i.id, i.note])),
      );
      await page.keyboard.press("ControlOrMeta+z");
      const afterItems = await page.evaluate(() =>
        JSON.stringify(window.__ctrl.getItems().map((i) => [i.id, i.note])),
      );
      assert.equal(
        afterItems,
        before,
        `queue unchanged with focus in ${focus ?? "note textarea"}`,
      );
      assert.equal(
        (await page.evaluate(() => window.__keyLog)).at(-1).prevented,
        false,
        `shortcut not preventDefaulted with focus in ${focus ?? "note textarea"}`,
      );
    }
    await page.locator("#app-input").evaluate((el) => el.blur());

    // After a successful Send to Fix, Undo is disabled and re-queues nothing.
    await page.evaluate(() => window.__ctrl.submitFix());
    assert.equal(await page.evaluate(() => window.__ctrl.canUndo()), false);
    assert.equal(await page.evaluate(() => window.__ctrl.canRedo()), false);
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal((await itemIds(page)).length, 0);
    await page.evaluate(() => window.__ctrl.destroy());

    // Reload with a persisted queue: history is in memory, so Undo is disabled.
    await page.evaluate(() => {
      const items = Array.from({ length: 120 }, (_, i) => ({
        id: `seed-${i}`,
        index: i + 1,
        kind: "pin",
        note: "",
        route: "/app/orders",
        point: { x: 10, y: 10 },
      }));
      window.sessionStorage.setItem("dk-history-test", JSON.stringify(items));
    });
    await page.reload();
    await mount(page, { runUrl: "/x", storageKey: "dk-history-test" });
    assert.equal(
      await page.evaluate(() => window.__ctrl.getItems().length),
      120,
    );
    assert.equal(await page.evaluate(() => window.__ctrl.canUndo()), false);

    // 110 changes keep only the newest 100 undo steps.
    await page.evaluate(() => {
      for (let i = 0; i < 110; i += 1) {
        window.__ctrl.removeItem(window.__ctrl.getItems()[0].id);
      }
    });
    assert.equal(
      await page.evaluate(() => window.__ctrl.getItems().length),
      10,
    );
    // Try more undos than were made; only the newest 100 succeed.
    const undone = await page.evaluate(
      () =>
        Array.from({ length: 110 }, () => window.__ctrl.undo()).filter(Boolean)
          .length,
    );
    assert.equal(undone, 100);
    assert.equal(
      await page.evaluate(() => window.__ctrl.getItems().length),
      110,
    );
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Undo shortcut works right after Escape closes the note, at 390px wide", async () => {
  const { context, page, pageErrors } = await openPage({
    width: 390,
    height: 844,
  });
  try {
    await mount(page, { runUrl: "/x" });
    await addPin(page, "#t1");
    await addPin(page, "#t2");
    // Escape hides the note popover; its textarea must not keep focus and
    // swallow the shortcut.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal(await page.evaluate(() => window.__ctrl.getItems().length), 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
