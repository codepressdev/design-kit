/**
 * Playwright browser end-to-end tests for PR 2:
 * 1. Vite dev plugin (`designKitAnnotate({ agent: ... })`) mounted against a
 *    two-state test app at 1280x800 -> annotate across two live states ->
 *    click Send to Fix -> verifies `.design-kit/redlines/latest.md`,
 *    `step-1.png` + `step-2.png`, `.gitignore` updated once, stub agent binary
 *    invoked via safe argv array, confirmation toast, and 0px horizontal overflow.
 * 2. Zero-code CLI (`design-kit annotate <url> --no-open --agent ...`) at both
 *    Desktop (1280x800) and Mobile (390x844) -> annotate across two live states
 *    -> click Send to Fix -> verifies files, stub agent, toast, and 0px overflow.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { designKitAnnotate } from "../../src/vite.mjs";

const BIN_PATH = fileURLToPath(
  new URL("../../bin/design-kit.mjs", import.meta.url),
);

function makeTempDir(prefix = "dk-browser-vite-cli-") {
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
}

function makeStubAgent(dir) {
  const stubPath = join(dir, "stub-agent.mjs");
  const recordPath = join(dir, "stub-invocations.jsonl");
  writeFileSync(
    stubPath,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  runId: process.env.DESIGN_KIT_REDLINE_RUN_ID,
  md: process.env.DESIGN_KIT_REDLINE_MD,
  latest: process.env.DESIGN_KIT_REDLINE_LATEST,
  dir: process.env.DESIGN_KIT_REDLINE_DIR,
}) + "\\n");
`,
    "utf8",
  );
  return { stubPath, recordPath };
}

function waitForRecordLines(filePath, expectedCount, timeoutMs = 5000) {
  const tryRead = () => {
    if (!existsSync(filePath)) return null;
    const lines = readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    if (lines.length < expectedCount) return null;
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      return null;
    }
  };
  const immediate = tryRead();
  if (immediate !== null) return Promise.resolve(immediate);

  return new Promise((resolveRecords, rejectRecords) => {
    const watcher = watch(dirname(filePath), () => {
      const parsed = tryRead();
      if (parsed !== null) {
        clearTimeout(timer);
        watcher.close();
        resolveRecords(parsed);
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      const parsed = tryRead();
      if (parsed !== null) resolveRecords(parsed);
      else
        rejectRecords(
          new Error(
            `Timed out waiting for ${expectedCount} record(s) in ${filePath}`,
          ),
        );
    }, timeoutMs);
  });
}

function renderTwoStateAppHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Test App</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    .bar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
    button { padding: 10px 14px; border: 0; border-radius: 6px; cursor: pointer; font-weight: 600; }
    #export-btn { background: #2563eb; color: #fff; }
    #open-order-btn { background: #10b981; color: #052e16; }
    #modal { margin-top: 16px; padding: 16px; max-width: 100%; background: #1e293b; border: 1px solid #475569; border-radius: 10px; }
    #modal[hidden] { display: none; }
    #save-modal-btn { background: #f59e0b; color: #111827; margin-top: 10px; }
  </style>
</head>
<body>
  <header class="bar">
    <button id="export-btn" data-testid="export-btn" codepress-data-fp="src/Orders.tsx:18">Export CSV</button>
    <button id="open-order-btn" data-testid="open-order-btn">Open Order #42</button>
  </header>
  <section id="modal" hidden>
    <h2 id="modal-title">Order #42 Details</h2>
    <p>Shipping status: pending review.</p>
    <button id="save-modal-btn" codepress-data-fp="src/OrderModal.tsx:44">Approve Shipment</button>
  </section>
  <script>
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
</html>`;
}

function startHttpServer(handler) {
  return new Promise((resolveServer) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveServer({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        close() {
          return new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

async function annotateTwoStatesAndSend(page, { expectAgentToast }) {
  // Wait for auto-mounted annotator instance
  await page.waitForFunction(() =>
    Boolean(window.__designKitAnnotatorInstance),
  );

  // Verify 0px horizontal overflow before annotating
  const overflowBefore = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(
    overflowBefore <= 0,
    `Expected 0px horizontal overflow before annotating, got ${overflowBefore}px`,
  );

  // Open annotator toolbar via launcher (or ensure open + annotate mode)
  await page.evaluate(() => {
    window.__designKitAnnotatorInstance.setOpen(true);
    window.__designKitAnnotatorInstance.setMode("annotate");
    window.__designKitAnnotatorInstance.setTool("pin");
  });

  // State 1 (/orders): click #export-btn to drop Pin #1
  const exportBox = await page.locator("#export-btn").boundingBox();
  await page.mouse.click(
    exportBox.x + exportBox.width / 2,
    exportBox.y + exportBox.height / 2,
  );
  await page.waitForFunction(
    () => window.__designKitAnnotatorInstance.getItems().length === 1,
  );
  const saveRect1 = await page.evaluate(() =>
    window.__designKitAnnotatorInstance.getControlRect("note-save"),
  );
  await page.keyboard.type("State 1: align export button");
  await page.mouse.click(saveRect1.centerX, saveRect1.centerY);

  // Switch to Browse mode and click #open-order-btn -> navigates to /orders/42 and opens modal
  const browseBtn = await page.evaluate(() =>
    window.__designKitAnnotatorInstance.getControlRect("mode-browse"),
  );
  await page.mouse.click(browseBtn.centerX, browseBtn.centerY);
  await page.locator("#open-order-btn").click();
  await page.locator("#modal").waitFor({ state: "visible" });

  // Switch back to Annotate mode and drop Pin #2 on #save-modal-btn
  const annotateBtn = await page.evaluate(() =>
    window.__designKitAnnotatorInstance.getControlRect("mode-annotate"),
  );
  await page.mouse.click(annotateBtn.centerX, annotateBtn.centerY);
  const modalBtnBox = await page.locator("#save-modal-btn").boundingBox();
  await page.mouse.click(
    modalBtnBox.x + modalBtnBox.width / 2,
    modalBtnBox.y + modalBtnBox.height / 2,
  );
  await page.waitForFunction(
    () => window.__designKitAnnotatorInstance.getItems().length === 2,
  );
  const saveRect2 = await page.evaluate(() =>
    window.__designKitAnnotatorInstance.getControlRect("note-save"),
  );
  await page.keyboard.type("State 2: increase contrast on Approve button");
  await page.mouse.click(saveRect2.centerX, saveRect2.centerY);

  // Verify 0px horizontal overflow while annotator UI is open
  const overflowDuring = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(
    overflowDuring <= 0,
    `Expected 0px horizontal overflow while annotating, got ${overflowDuring}px`,
  );

  // Click Send to Fix
  const sendBtn = await page.evaluate(() =>
    window.__designKitAnnotatorInstance.getControlRect("send-fix"),
  );
  assert.ok(sendBtn, "Send to Fix button must be present");
  await page.mouse.click(sendBtn.centerX, sendBtn.centerY);

  // Wait for confirmation toast (past transient "Sending…" state)
  await page.waitForFunction(() => {
    const t = window.__designKitAnnotatorInstance.getToastText();
    return t.length > 0 && !t.includes("Sending");
  });
  const toast = await page.evaluate(() =>
    window.__designKitAnnotatorInstance.getToastText(),
  );
  assert.match(toast, expectAgentToast);
}

let browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

test("Vite dev plugin end-to-end: two live states -> Send to Fix writes redlines, updates .gitignore once, invokes stub agent, shows toast", async () => {
  const dir = makeTempDir("dk-vite-e2e-");
  const { stubPath, recordPath } = makeStubAgent(dir);

  const plugin = designKitAnnotate({
    root: dir,
    agent: [process.execPath, stubPath, "--vite-mode"],
  });
  plugin.configResolved({ command: "serve", root: dir });

  const middlewares = [];
  plugin.configureServer({
    middlewares: {
      use(fn) {
        middlewares.push(fn);
      },
    },
  });

  const srv = await startHttpServer((req, res) => {
    let idx = 0;
    const next = () => {
      const fn = middlewares[idx++];
      if (fn) {
        fn(req, res, next);
        return;
      }
      const rawHtml = renderTwoStateAppHtml();
      const transformed = plugin.transformIndexHtml(rawHtml);
      let html =
        typeof transformed === "string" ? transformed : transformed.html;
      if (typeof transformed === "object" && Array.isArray(transformed.tags)) {
        const tagHtml = transformed.tags
          .map((t) => `<script src="${t.attrs.src}" defer></script>`)
          .join("");
        html = html.replace("</body>", `${tagHtml}</body>`);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    };
    next();
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${srv.url}/orders`);
    await annotateTwoStatesAndSend(page, {
      expectAgentToast: /Saved 2 redlines & started/,
    });

    const records = await waitForRecordLines(recordPath, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].argv[0], "--vite-mode");
    assert.match(records[0].argv[1], /packet\.md/);
    assert.equal(existsSync(records[0].md), true);
    assert.equal(existsSync(records[0].latest), true);
    assert.equal(existsSync(join(records[0].dir, "step-1.png")), true);
    assert.equal(existsSync(join(records[0].dir, "step-2.png")), true);

    const latestMd = readFileSync(
      join(dir, ".design-kit/redlines/latest.md"),
      "utf8",
    );
    assert.match(latestMd, /State 1: align export button/);
    assert.match(latestMd, /State 2: increase contrast on Approve button/);

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(
      gitignore.split("\n").filter((l) => l.trim() === "/.design-kit/redlines/")
        .length,
      1,
    );
  } finally {
    await context.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI `design-kit annotate <url> --no-open` end-to-end at Desktop (1280x800) and Mobile (390x844)", async () => {
  const dir = makeTempDir("dk-cli-e2e-");
  const { stubPath, recordPath } = makeStubAgent(dir);

  const upstream = await startHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderTwoStateAppHtml());
  });

  const child = spawn(
    process.execPath,
    [
      BIN_PATH,
      "annotate",
      upstream.url,
      "--no-open",
      "--port",
      "0",
      "--root",
      dir,
      "--agent",
      process.execPath,
      "--agent-arg",
      stubPath,
      "--agent-arg",
      "--cli-mode",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const proxyUrl = await new Promise((resolveUrl, rejectUrl) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        rejectUrl(
          new Error(`CLI timed out. stdout=${stdout} stderr=${stderr}`),
        );
      }, 5000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolveUrl(match[0]);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
    });

    // Desktop 1280x800
    const desktopCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const desktopPage = await desktopCtx.newPage();
    try {
      await desktopPage.goto(`${proxyUrl}/orders`);
      await annotateTwoStatesAndSend(desktopPage, {
        expectAgentToast: /Saved 2 redlines & started/,
      });
    } finally {
      await desktopCtx.close();
    }

    // Mobile 390x844
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const mobilePage = await mobileCtx.newPage();
    try {
      await mobilePage.goto(`${proxyUrl}/orders`);
      await annotateTwoStatesAndSend(mobilePage, {
        expectAgentToast: /Saved 2 redlines & started/,
      });
    } finally {
      await mobileCtx.close();
    }

    const records = await waitForRecordLines(recordPath, 2);
    assert.equal(records.length, 2);
    assert.equal(records[0].argv[0], "--cli-mode");
    assert.equal(records[1].argv[0], "--cli-mode");
    assert.equal(existsSync(join(records[1].dir, "step-1.png")), true);
    assert.equal(existsSync(join(records[1].dir, "step-2.png")), true);

    // .gitignore must still have /.design-kit/redlines/ only once after 2 submissions
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(
      gitignore.split("\n").filter((l) => l.trim() === "/.design-kit/redlines/")
        .length,
      1,
    );
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", () => r()));
    }
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
