/**
 * Playwright browser tests for `@codepress/design-kit/annotate`:
 * 1. Multi-state Browse <-> Annotate workflow (Pin #1 on /orders -> Browse
 *    click opens modal & navigates to /orders/42 -> sessionStorage reload
 *    persistence -> Region Box #2 with overlap px + Move Arrow #3 -> Send to
 *    Fix with non-blocking "Open run ↗" toast).
 * 2. Negative, security & 320px corner check: pin at (316, 840) in 320x844
 *    with `]]><script>alert(1)</script>`, `/v1/cap123.456/orders?token=sec&view=all`,
 *    and a cross-origin <img> -> 0px spill within [0, 320], sanitized route,
 *    escaped XML/CDATA, valid PNG without SecurityError.
 * 3. Real iframe postMessage isolation: wrong channelId / wrong source ignored.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { chromium } from "@playwright/test";

import {
  formatRedlineXml,
  getAnnotatorRuntimeScript,
  MAX_SNAPSHOT_BYTES,
} from "../../src/annotate/index.mjs";

const RUNTIME_SCRIPT = getAnnotatorRuntimeScript();

// 1x1 transparent PNG bytes for cross-origin <img> fixture
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
      });
    });
  });
}

let browser;
let appServer;
let crossOriginServer;

before(async () => {
  crossOriginServer = await startServer((req, res) => {
    if (req.url === "/ext.png") {
      // Intentionally NO Access-Control-Allow-Origin header to simulate tainted cross-origin image
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(TINY_PNG);
      return;
    }
    if (req.url?.startsWith("/parent?child=")) {
      const childUrl = new URL(req.url, "http://127.0.0.1").searchParams.get(
        "child",
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<body>
  <iframe id="child" src="${childUrl}" style="width:800px;height:500px;border:0"></iframe>
</body>
</html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  appServer = await startServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/annotator.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
      });
      res.end(RUNTIME_SCRIPT);
      return;
    }
    if (url.pathname === "/corner") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #111827; color: #f9fafb; height: 844px; position: relative; }
    #corner-target { position: fixed; right: 0; bottom: 0; width: 48px; height: 48px; background: #2563eb; color: #fff; font-size: 10px; }
    #ext-img { position: fixed; left: 12px; top: 12px; width: 120px; height: 80px; }
  </style>
</head>
<body>
  <img id="ext-img" alt="Partner Logo" src="${crossOriginServer.url}/ext.png" />
  <button id="corner-target" data-testid="corner-btn" codepress-data-fp="src/Corner.tsx:9">]]&gt;&lt;script&gt;alert(1)&lt;/script&gt;</button>
  <script src="/annotator.js"></script>
</body>
</html>`);
      return;
    }

    // Default multi-route SPA app (/orders and /orders/42)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; padding: 24px; font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    .header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
    #export-btn { padding: 10px 16px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
    #open-order-btn { padding: 10px 16px; background: #10b981; color: #052e16; border: 0; border-radius: 6px; cursor: pointer; font-weight: 600; }
    #modal { position: fixed; left: 60px; top: 120px; width: 520px; height: 300px; background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 20px; }
    #modal[hidden] { display: none; }
    .overlap-stage { position: relative; height: 80px; margin-top: 16px; }
    #pill-a { position: absolute; left: 10px; top: 10px; width: 120px; height: 32px; background: #334155; display: flex; align-items: center; justify-content: center; border-radius: 6px; }
    #pill-b { position: absolute; left: 112px; top: 14px; width: 120px; height: 32px; background: #475569; display: flex; align-items: center; justify-content: center; border-radius: 6px; }
    .move-row { display: flex; justify-content: space-between; align-items: center; margin-top: 32px; }
    #live-badge { padding: 4px 10px; background: #ef4444; border-radius: 999px; font-size: 12px; }
    #order-title { padding: 6px 12px; background: #0f172a; border: 1px dashed #64748b; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="header">
    <h1 id="page-heading">Orders</h1>
    <button id="export-btn" data-testid="export-btn" codepress-data-fp="src/components/ExportButton.tsx:24">Export</button>
    <button id="open-order-btn" data-testid="open-order-btn">Open Order #42</button>
  </div>

  <div id="modal" role="dialog" hidden>
    <div class="move-row">
      <div id="order-title" data-testid="order-title" codepress-data-fp="src/pages/OrderDetail.tsx:18">Order #42 Detail</div>
      <span id="live-badge" data-testid="live-badge" codepress-data-fp="src/components/LiveBadge.tsx:7">LIVE</span>
    </div>
    <div class="overlap-stage">
      <button id="pill-a" data-testid="pill-a" type="button">Last 7 days</button>
      <button id="pill-b" data-testid="pill-b" type="button">Custom range</button>
    </div>
  </div>

  <script src="/annotator.js"></script>
  <script>
    // Attach simulated React 18 fiber with _debugSource on ExportButton
    document.getElementById("export-btn").__reactFiber$test = {
      type: Object.assign(function ExportButton() {}, { displayName: "ExportButton" }),
      _debugSource: { fileName: "src/components/ExportButton.tsx", lineNumber: 24, columnNumber: 4 },
      return: { type: Object.assign(function OrdersPage() {}, { displayName: "OrdersPage" }), return: null }
    };

    const modal = document.getElementById("modal");
    function syncModal() {
      modal.hidden = !window.location.pathname.startsWith("/orders/42");
    }
    document.getElementById("open-order-btn").addEventListener("click", () => {
      window.history.pushState({}, "", "/orders/42");
      syncModal();
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    syncModal();
  </script>
</body>
</html>`);
  });

  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  appServer?.server.close();
  crossOriginServer?.server.close();
});

test("Multi-state Browse <-> Annotate & Send to Fix in a live app", async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  try {
    await page.goto(`${appServer.url}/orders`);

    // Mount annotator in Annotate mode with custom onSubmit capturing the packet
    await page.evaluate(() => {
      window.__dispatchedPackets = [];
      window.__annotator = window.__designKitAnnotate.mountAnnotator({
        initialMode: "annotate",
        initialTool: "pin",
        onSubmit: async (packet) => {
          window.__dispatchedPackets.push(packet);
          return {
            message: "Fix started",
            runUrl: "https://codepress.dev/runs/fix-42",
          };
        },
      });
    });

    // Verify Shadow Root is genuinely closed
    const isClosed = await page.evaluate(
      () => document.querySelector("design-kit-annotator")?.shadowRoot === null,
    );
    assert.equal(isClosed, true);

    // 1. Drop Pin #1 on /orders over #export-btn
    const exportBox = await page.locator("#export-btn").boundingBox();
    await page.mouse.click(
      exportBox.x + exportBox.width / 2,
      exportBox.y + exportBox.height / 2,
    );
    await page.waitForFunction(
      () => window.__annotator.getItems().length === 1,
    );

    // Type note and save
    const noteSaveRect = await page.evaluate(() =>
      window.__annotator.getControlRect("note-save"),
    );
    await page.keyboard.type("Rename to Export CSV");
    await page.mouse.click(noteSaveRect.centerX, noteSaveRect.centerY);

    // 2. Switch to Browse mode by clicking the Browse button in the Shadow-DOM bar
    const browseBtn = await page.evaluate(() =>
      window.__annotator.getControlRect("mode-browse"),
    );
    await page.mouse.click(browseBtn.centerX, browseBtn.centerY);
    assert.equal(
      await page.evaluate(() => window.__annotator.getMode()),
      "browse",
    );

    // Click app button natively in Browse mode -> opens modal & navigates to /orders/42
    await page.locator("#open-order-btn").click();
    assert.equal(await page.locator("#modal").isVisible(), true);
    assert.equal(
      await page.evaluate(() => window.location.pathname),
      "/orders/42",
    );

    // Verify queued Pin #1 survives a same-origin reload via sessionStorage
    await page.reload();
    await page.evaluate(() => {
      window.__dispatchedPackets = [];
      window.__annotator = window.__designKitAnnotate.mountAnnotator({
        initialMode: "browse",
        onSubmit: async (packet) => {
          window.__dispatchedPackets.push(packet);
          return {
            message: "Fix started",
            runUrl: "https://codepress.dev/runs/fix-42",
          };
        },
      });
    });
    assert.equal(
      await page.evaluate(() => window.__annotator.getItems().length),
      1,
    );
    assert.equal(await page.locator("#modal").isVisible(), true);

    // 3. Switch back to Annotate mode, select Region Box, drag over overlapping pills (#2)
    const annotateBtn = await page.evaluate(() =>
      window.__annotator.getControlRect("mode-annotate"),
    );
    await page.mouse.click(annotateBtn.centerX, annotateBtn.centerY);
    const boxTool = await page.evaluate(() =>
      window.__annotator.getControlRect("tool-box"),
    );
    await page.mouse.click(boxTool.centerX, boxTool.centerY);

    const pillA = await page.locator("#pill-a").boundingBox();
    const pillB = await page.locator("#pill-b").boundingBox();
    await page.mouse.move(pillA.x - 4, pillA.y - 4);
    await page.mouse.down();
    await page.mouse.move(
      pillB.x + pillB.width + 4,
      pillB.y + pillB.height + 4,
      { steps: 6 },
    );
    await page.mouse.up();
    await page.waitForFunction(
      () => window.__annotator.getItems().length === 2,
    );

    const noteSave2 = await page.evaluate(() =>
      window.__annotator.getControlRect("note-save"),
    );
    await page.keyboard.type("Pills overlap");
    await page.mouse.click(noteSave2.centerX, noteSave2.centerY);

    // 4. Select Move Arrow, drag from #live-badge to #order-title (#3)
    const arrowTool = await page.evaluate(() =>
      window.__annotator.getControlRect("tool-arrow"),
    );
    await page.mouse.click(arrowTool.centerX, arrowTool.centerY);

    const badge = await page.locator("#live-badge").boundingBox();
    const title = await page.locator("#order-title").boundingBox();
    await page.mouse.move(
      badge.x + badge.width / 2,
      badge.y + badge.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      title.x + title.width / 2,
      title.y + title.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();
    await page.waitForFunction(
      () => window.__annotator.getItems().length === 3,
    );

    const noteSave3 = await page.evaluate(() =>
      window.__annotator.getControlRect("note-save"),
    );
    await page.keyboard.type("Move badge beside title");
    await page.mouse.click(noteSave3.centerX, noteSave3.centerY);

    // 5. Click Send to Fix
    const sendBtn = await page.evaluate(() =>
      window.__annotator.getControlRect("send-fix"),
    );
    await page.mouse.click(sendBtn.centerX, sendBtn.centerY);
    await page.waitForFunction(() => window.__dispatchedPackets.length === 1);

    const packet = await page.evaluate(() => window.__dispatchedPackets[0]);
    assert.deepEqual(packet.routes, ["/orders", "/orders/42"]);
    assert.equal(packet.items.length, 3);

    // Pin #1 metadata
    assert.equal(packet.items[0].kind, "pin");
    assert.equal(packet.items[0].route, "/orders");
    assert.equal(packet.items[0].note, "Rename to Export CSV");
    assert.equal(
      packet.items[0].sourceHints[0].file,
      "src/components/ExportButton.tsx",
    );
    assert.equal(packet.items[0].sourceHints[0].line, 24);
    assert.deepEqual(packet.items[0].owners, ["ExportButton", "OrdersPage"]);
    assert.ok(packet.items[0].computedStyle);

    // Region Box #2 overlap px
    assert.equal(packet.items[1].kind, "box");
    assert.equal(packet.items[1].route, "/orders/42");
    assert.ok(
      packet.items[1].overlapPx > 0,
      `expected overlapPx > 0, got ${packet.items[1].overlapPx}`,
    );
    assert.ok(packet.items[1].overlaps.length >= 1);

    // Move Arrow #3 from -> to
    assert.equal(packet.items[2].kind, "arrow");
    assert.equal(packet.items[2].route, "/orders/42");
    assert.equal(packet.items[2].from.selector, "#live-badge");
    assert.equal(packet.items[2].to.selector, "#order-title");

    // Per-item PNG snapshots <= 1 MiB
    for (const item of packet.items) {
      assert.ok(item.snapshot?.dataUrl.startsWith("data:image/png;base64,"));
      assert.ok(
        item.snapshot.byteLength > 0 &&
          item.snapshot.byteLength <= MAX_SNAPSHOT_BYTES,
      );
    }

    // Inline non-blocking toast shows "Open run ↗" and queue cleared
    const toastText = await page.evaluate(() =>
      window.__annotator.getToastText(),
    );
    const toastHref = await page.evaluate(() =>
      window.__annotator.getToastHref(),
    );
    assert.ok(toastText.includes("Fix started"), `toast text: ${toastText}`);
    assert.ok(toastText.includes("Open run ↗"), `toast text: ${toastText}`);
    assert.equal(toastHref, "https://codepress.dev/runs/fix-42");
    assert.equal(
      await page.evaluate(() => window.__annotator.getItems().length),
      0,
    );
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Negative, security & 320px corner check: 0px spill, sanitized route, escaped XML/CDATA, cross-origin PNG safety", async () => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 844 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  try {
    await page.goto(`${appServer.url}/corner`);
    // Wait for cross-origin image to finish loading
    await page.waitForFunction(() => {
      const img = document.getElementById("ext-img");
      return img && img.complete && img.naturalWidth > 0;
    });

    // Set URL to capability-prefixed route with credential query param
    await page.evaluate(() => {
      window.history.replaceState(
        {},
        "",
        "/v1/cap123.456/orders?token=sec&view=all",
      );
      window.__annotator = window.__designKitAnnotate.mountAnnotator({
        initialMode: "annotate",
        initialTool: "pin",
        storageKey: false,
      });
    });

    // Drop Pin at (316, 840) — extreme bottom-right corner of 320x844
    await page.mouse.click(316, 840);
    await page.waitForFunction(
      () => window.__annotator.getItems().length === 1,
    );

    // Every visible Shadow-DOM UI panel & marker must stay strictly within [0, 320] x [0, 844]
    const bounds = await page.evaluate(() => window.__annotator.getUiBounds());
    assert.ok(
      bounds.length >= 2,
      "expected visible UI bounds (bar, marker, popover)",
    );
    for (const b of bounds) {
      assert.ok(
        b.left >= 0 && b.right <= 320,
        `horizontal spill on ${b.name}: [${b.left}, ${b.right}] outside [0, 320]`,
      );
      assert.ok(
        b.top >= 0 && b.bottom <= 844,
        `vertical spill on ${b.name}: [${b.top}, ${b.bottom}] outside [0, 844]`,
      );
    }

    const packet = await page.evaluate(() => window.__annotator.getPacket());
    assert.equal(packet.route, "/orders?view=all");
    assert.equal(packet.items[0].route, "/orders?view=all");

    // Cross-origin <img> must be replaced with labelled placeholder box (no SecurityError)
    assert.ok(
      packet.items[0].snapshot?.dataUrl.startsWith("data:image/png;base64,"),
    );
    assert.ok(packet.items[0].snapshot.byteLength <= MAX_SNAPSHOT_BYTES);
    assert.ok(
      packet.items[0].snapshot.crossOriginPlaceholders >= 1,
      `expected crossOriginPlaceholders >= 1, got ${packet.items[0].snapshot.crossOriginPlaceholders}`,
    );

    // XML/CDATA escaping on untrusted DOM content
    const xml = formatRedlineXml(packet);
    assert.ok(xml.includes('route="/orders?view=all"'));
    assert.ok(!xml.includes("token=sec"));
    assert.ok(!xml.includes("]]><script>"));

    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("Iframe postMessage transport pins source, origin, and channelId in real browser frames", async () => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 700 },
  });
  const page = await context.newPage();

  try {
    await page.goto(
      `${crossOriginServer.url}/parent?child=${encodeURIComponent(`${appServer.url}/orders`)}`,
    );
    const frame = page.frameLocator("#child");
    await frame.locator("#export-btn").waitFor({ state: "visible" });

    const childFrame = page
      .frames()
      .find((f) => f.url().startsWith(appServer.url));
    assert.ok(childFrame);

    // Install parent listener that first sends a wrong-channelId message, then the real reply
    await page.evaluate((childOrigin) => {
      window.__parentReceived = [];
      window.addEventListener("message", (ev) => {
        if (ev.origin !== childOrigin) return;
        if (ev.data?.type === "DK_ANNOTATE_SUBMIT") {
          window.__parentReceived.push(ev.data);
          // 1. Wrong channelId (must be ignored by child)
          ev.source.postMessage(
            {
              type: "DK_ANNOTATE_ERROR",
              channelId: "wrong-chan",
              requestId: ev.data.requestId,
              error: "should-be-ignored",
            },
            ev.origin,
          );
          // 2. Valid reply
          ev.source.postMessage(
            {
              type: "DK_ANNOTATE_RESULT",
              channelId: ev.data.channelId,
              requestId: ev.data.requestId,
              message: "Fix started via parent",
              runUrl: "https://codepress.dev/runs/parent-1",
            },
            ev.origin,
          );
        }
      });
    }, appServer.url);

    // Mount in child iframe using postMessage transport pinned to exact cross-origin parent
    const parentOrigin = crossOriginServer.url;
    const result = await childFrame.evaluate(async (pOrigin) => {
      const ctrl = window.__designKitAnnotate.mountAnnotator({
        initialMode: "annotate",
        storageKey: false,
        transport: {
          type: "postMessage",
          targetOrigin: pOrigin,
          channelId: "iframe-chan-1",
          timeoutMs: 3000,
        },
      });
      const btn = document.getElementById("export-btn");
      const r = btn.getBoundingClientRect();
      window.__childCtrl = ctrl;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, parentOrigin);

    // Click inside iframe at #export-btn
    const iframeBox = await page.locator("#child").boundingBox();
    await page.mouse.click(iframeBox.x + result.x, iframeBox.y + result.y);
    await childFrame.waitForFunction(
      () => window.__childCtrl.getItems().length === 1,
    );

    const submitRes = await childFrame.evaluate(() =>
      window.__childCtrl.submitFix(),
    );
    assert.equal(submitRes.ok, true);
    assert.equal(submitRes.mode, "postMessage");
    assert.equal(submitRes.runUrl, "https://codepress.dev/runs/parent-1");
    assert.equal(await page.evaluate(() => window.__parentReceived.length), 1);
  } finally {
    await context.close();
  }
});

test("Freehand strokes stay visible on screen and capture both composited PNG screenshots and HTML metadata", async () => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 700 },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${appServer.url}/orders`);
    await page.locator("#export-btn").waitFor({ state: "visible" });

    const btnBox = await page.locator("#export-btn").boundingBox();
    assert.ok(btnBox);

    await page.evaluate(() => {
      window.__fhCtrl = window.__designKitAnnotate.mountAnnotator({
        initialMode: "annotate",
        initialTool: "freehand",
        storageKey: false,
      });
    });

    // Draw a freehand circle starting slightly outside #export-btn (on body/whitespace)
    // and looping around #export-btn so centroid hits #export-btn.
    const left = Math.max(2, btnBox.x - 10);
    const top = Math.max(2, btnBox.y - 10);
    const right = btnBox.x + btnBox.width + 10;
    const bottom = btnBox.y + btnBox.height + 10;

    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, top, { steps: 4 });
    await page.mouse.move(right, bottom, { steps: 4 });
    await page.mouse.move(left, bottom, { steps: 4 });
    await page.mouse.move(left, top, { steps: 4 });
    await page.mouse.up();

    await page.waitForFunction(() => window.__fhCtrl.getItems().length === 1);

    // 1. Committed freehand stroke must remain rendered on screen after pointerup
    const shapesAfterFirst = await page.evaluate(() =>
      window.__fhCtrl.getCommittedShapeCount(),
    );
    assert.equal(
      shapesAfterFirst,
      1,
      "freehand polyline must stay visible on screen after pointerup",
    );

    // 2. Switching to Browse mode keeps the stroke visible while overlay is open
    await page.evaluate(() => window.__fhCtrl.setMode("browse"));
    assert.equal(
      await page.evaluate(() => window.__fhCtrl.getCommittedShapeCount()),
      1,
      "freehand stroke must stay visible in Browse mode while overlay is open",
    );

    // 3. Draw a second freehand stroke -> both stay visible on screen
    await page.evaluate(() => window.__fhCtrl.setMode("annotate"));
    await page.mouse.move(320, 200);
    await page.mouse.down();
    await page.mouse.move(420, 240, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__fhCtrl.getItems().length === 2);

    assert.equal(
      await page.evaluate(() => window.__fhCtrl.getCommittedShapeCount()),
      2,
      "both committed freehand strokes must remain visible on screen",
    );

    // 4. First freehand item captured BOTH PNG screenshot AND HTML data (#export-btn)
    const items = await page.evaluate(() => window.__fhCtrl.getItems());
    const first = items[0];
    assert.equal(first.kind, "freehand");
    assert.ok(first.points && first.points.length >= 4);
    assert.ok(
      first.snapshot?.dataUrl?.startsWith("data:image/png;base64,"),
      "freehand item must include a PNG screenshot",
    );
    assert.ok(
      first.snapshot.byteLength > 0 &&
        first.snapshot.byteLength <= MAX_SNAPSHOT_BYTES,
    );
    assert.match(
      first.outerHtml || "",
      /export-btn/i,
      "freehand circle around button should capture button HTML even when started on whitespace",
    );

    // 5. Collapsing hides shapes; reopening restores them; removing removes the shape
    await page.evaluate(() => window.__fhCtrl.setOpen(false));
    assert.equal(
      await page.evaluate(() => window.__fhCtrl.getCommittedShapeCount()),
      0,
    );
    await page.evaluate(() => window.__fhCtrl.setOpen(true));
    assert.equal(
      await page.evaluate(() => window.__fhCtrl.getCommittedShapeCount()),
      2,
    );
    await page.evaluate((id) => window.__fhCtrl.removeItem(id), items[0].id);
    assert.equal(
      await page.evaluate(() => window.__fhCtrl.getCommittedShapeCount()),
      1,
    );
  } finally {
    await context.close();
  }
});

test("Annotate toolbar box drags freely anywhere in viewport and triggers onPopOut when dragged outside window", async () => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 700 },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${appServer.url}/orders`);
    await page.locator("#export-btn").waitFor({ state: "visible" });

    await page.evaluate(() => {
      window.__popOutCalls = [];
      window.__dragCtrl = window.__designKitAnnotate.mountAnnotator({
        initialMode: "annotate",
        storageKey: false,
        onPopOut(coords) {
          window.__popOutCalls.push(coords);
        },
      });
    });

    const beforeRect = await page.evaluate(() =>
      window.__dragCtrl.getDockRect(),
    );
    const handleRect = await page.evaluate(() =>
      window.__dragCtrl.getControlRect("drag-handle"),
    );
    assert.ok(beforeRect && handleRect);

    // Drag the toolbar from bottom-right up-left by (-160, -250), staying inside viewport
    await page.mouse.move(handleRect.centerX, handleRect.centerY);
    await page.mouse.down();
    await page.mouse.move(handleRect.centerX - 160, handleRect.centerY - 250, {
      steps: 6,
    });
    await page.mouse.up();

    const afterRect = await page.evaluate(() =>
      window.__dragCtrl.getDockRect(),
    );
    assert.ok(
      afterRect.x < beforeRect.x - 100 && afterRect.y < beforeRect.y - 150,
      `expected dock to move up-left (before=${JSON.stringify(beforeRect)}, after=${JSON.stringify(afterRect)})`,
    );
    assert.equal(
      await page.evaluate(() => window.__popOutCalls.length),
      0,
      "in-viewport drag must not invoke onPopOut",
    );

    // Dragging past the edge of the viewport triggers onPopOut
    const handleAfter = await page.evaluate(() =>
      window.__dragCtrl.getControlRect("drag-handle"),
    );
    await page.mouse.move(handleAfter.centerX, handleAfter.centerY);
    await page.mouse.down();
    await page.mouse.move(-40, handleAfter.centerY, { steps: 4 });
    await page.mouse.up();

    const popOutCount = await page.evaluate(() => window.__popOutCalls.length);
    assert.equal(
      popOutCount,
      1,
      "dragging past viewport edge must invoke onPopOut",
    );

    // setDockHidden(true) hides the docked bar; setDockHidden(false) restores it
    await page.evaluate(() => window.__dragCtrl.setDockHidden(true));
    assert.equal(
      await page.evaluate(() => window.__dragCtrl.getDockRect().width),
      0,
    );
    await page.evaluate(() => window.__dragCtrl.setDockHidden(false));
    assert.ok(
      (await page.evaluate(() => window.__dragCtrl.getDockRect().width)) > 0,
    );
  } finally {
    await context.close();
  }
});
