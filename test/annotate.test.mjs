import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeBoxOverlap,
  computePairwiseOverlaps,
  createPostMessageBridge,
  DEFAULT_SOURCEMAP_TIMEOUT_MS,
  dispatchRedlinePacket,
  DK_ANNOTATE_MSG,
  escapeCdata,
  escapeXmlText,
  extractSourceHints,
  formatRedlineMarkdown,
  formatRedlineXml,
  getAnnotatorRuntimeScript,
  MAX_SNAPSHOT_BYTES,
  resolveSourceMapPosition,
  sanitizeRedlinePacket,
  sanitizeRoute,
  sanitizeRunUrl,
} from "../src/annotate/index.mjs";

test("sanitizeRoute strips /v<n>/<capability> prefixes, credential query params, and hashes", () => {
  assert.equal(
    sanitizeRoute("/v1/cap123.456/orders?token=sec&view=all"),
    "/orders?view=all",
  );
  assert.equal(
    sanitizeRoute(
      "https://app.example.test/v2/cap_abc.999/settings/billing?access_token=a&api_key=b&tab=plan&client_secret=c#jwt=xyz",
    ),
    "/settings/billing?tab=plan",
  );
  assert.equal(sanitizeRoute("/v1/cap123.456?token=only"), "/");
  assert.equal(sanitizeRoute(""), "/");
});

test("escapeXmlText and escapeCdata neutralize XML/CDATA breakouts", () => {
  const payload = "]]><script>alert(1)</script>&\"'";
  const escapedXml = escapeXmlText(payload);
  assert.ok(!escapedXml.includes("<script>"));
  assert.ok(escapedXml.includes("&lt;script&gt;"));

  const escapedCdata = escapeCdata(payload);
  assert.ok(!escapedCdata.includes("]]><script>"));
  assert.equal(escapedCdata, "]]]]><![CDATA[><script>alert(1)</script>&\"'");

  const xml = formatRedlineXml({
    route: "/v1/cap123.456/orders?token=sec&view=all",
    viewport: { width: 320, height: 844, dpr: 2 },
    theme: "dark",
    items: [
      {
        id: "i1",
        kind: "pin",
        route: "/v1/cap123.456/orders?token=sec&view=all",
        note: payload,
        selector: 'button[data-testid="x"]',
        outerHtml: `<div>${payload}</div>`,
      },
    ],
  });

  assert.ok(xml.includes('route="/orders?view=all"'));
  assert.ok(!xml.includes("token=sec"));
  assert.ok(!xml.includes("cap123.456"));
  assert.ok(!xml.includes("]]><script>"));
  assert.ok(xml.includes("]]]]><![CDATA[>"));
});

test("sanitizeRedlinePacket enforces snapshot size cap, owners cap, and valid PNG prefix", () => {
  const validPng = `data:image/png;base64,${Buffer.alloc(32, 1).toString("base64")}`;
  const hugePng = `data:image/png;base64,${Buffer.alloc(MAX_SNAPSHOT_BYTES + 1024, 1).toString("base64")}`;

  const packet = sanitizeRedlinePacket({
    route: "/v1/cap1/home?token=abc&page=2",
    items: [
      {
        id: "ok",
        kind: "pin",
        route: "/v1/cap1/home?token=abc&page=2",
        owners: ["A", "B", "C", "D", "E", "F", "G", "H"],
        snapshot: { dataUrl: validPng, width: 100, height: 100 },
      },
      {
        id: "too-big",
        kind: "box",
        snapshot: { dataUrl: hugePng, width: 1000, height: 1000 },
      },
      {
        id: "bad-mime",
        kind: "pin",
        snapshot: {
          dataUrl: "data:text/html;base64,PHNjcmlwdD4=",
          width: 10,
          height: 10,
        },
      },
    ],
  });

  assert.equal(packet.route, "/home?page=2");
  assert.equal(packet.items[0].owners.length, 6);
  assert.ok(packet.items[0].snapshot);
  assert.equal(packet.items[1].snapshot, undefined);
  assert.equal(packet.items[2].snapshot, undefined);

  const md = formatRedlineMarkdown(packet);
  assert.ok(md.includes("# Screen Annotations (3)"));
  assert.ok(md.includes("/home?page=2"));
});

test("computeBoxOverlap and computePairwiseOverlaps calculate overlap px accurately", () => {
  const ov = computeBoxOverlap(
    { x: 10, y: 10, width: 100, height: 30 },
    { x: 96, y: 15, width: 80, height: 30 },
  );
  assert.equal(ov.overlapX, 14);
  assert.equal(ov.overlapY, 25);
  assert.equal(ov.overlapPx, 14);

  const pw = computePairwiseOverlaps([
    { selector: ".pill-a", rect: { x: 10, y: 10, width: 100, height: 30 } },
    { selector: ".pill-b", rect: { x: 96, y: 15, width: 80, height: 30 } },
    { selector: ".pill-c", rect: { x: 300, y: 300, width: 40, height: 20 } },
  ]);
  assert.equal(pw.maxOverlapPx, 14);
  assert.equal(pw.pairs.length, 1);
  assert.equal(pw.pairs[0].a, ".pill-a");
  assert.equal(pw.pairs[0].b, ".pill-b");
});

test("extractSourceHints resolves React 18 _debugSource, Vue __file, Svelte __svelte_meta, and codepress-data-fp", async () => {
  // React 18 fiber with 8 owners (should cap to 6) + _debugSource + data-fp
  const makeFiber = (name, ret, debugSource) => ({
    type: Object.assign(function Component() {}, { displayName: name }),
    return: ret,
    _debugSource: debugSource,
  });
  const f7 = makeFiber("RootApp", null);
  const f6 = makeFiber("Shell", f7);
  const f5 = makeFiber("OrdersLayout", f6);
  const f4 = makeFiber("OrdersPage", f5);
  const f3 = makeFiber("OrdersToolbar", f4);
  const f2 = makeFiber("ExportMenu", f3);
  const f1 = makeFiber("ExportButton", f2, {
    fileName: "src/components/ExportButton.tsx",
    lineNumber: 24,
    columnNumber: 6,
  });

  const reactEl = {
    tagName: "BUTTON",
    id: "export-btn",
    outerHTML: '<button id="export-btn">Export</button>',
    getAttribute(name) {
      return name === "codepress-data-fp" ? "src/pages/Orders.tsx:10" : null;
    },
    __reactFiber$abc123: f1,
  };

  const reactRes = await extractSourceHints(reactEl);
  assert.equal(reactRes.owners.length, 6);
  assert.deepEqual(reactRes.owners, [
    "ExportButton",
    "ExportMenu",
    "OrdersToolbar",
    "OrdersPage",
    "OrdersLayout",
    "Shell",
  ]);
  assert.equal(reactRes.sourceHints[0].framework, "react");
  assert.equal(reactRes.sourceHints[0].file, "src/components/ExportButton.tsx");
  assert.equal(reactRes.sourceHints[0].line, 24);
  assert.ok(
    reactRes.sourceHints.some(
      (h) =>
        h.framework === "data-fp" &&
        h.file === "src/pages/Orders.tsx" &&
        h.line === 10,
    ),
  );
  assert.equal(reactRes.selector, "#export-btn");

  // Vue 3 __file
  const vueEl = {
    tagName: "DIV",
    outerHTML: "<div>Vue</div>",
    __vueParentComponent: {
      type: { name: "OrderCard", __file: "src/views/OrderCard.vue" },
      parent: {
        type: { __name: "OrdersGrid", __file: "src/views/OrdersGrid.vue" },
      },
    },
  };
  const vueRes = await extractSourceHints(vueEl);
  assert.deepEqual(vueRes.owners, ["OrderCard", "OrdersGrid"]);
  assert.equal(vueRes.sourceHints[0].framework, "vue");
  assert.equal(vueRes.sourceHints[0].file, "src/views/OrderCard.vue");

  // Svelte __svelte_meta
  const svelteEl = {
    tagName: "SECTION",
    outerHTML: "<section>Svelte</section>",
    __svelte_meta: {
      loc: { file: "src/lib/FilterBar.svelte", line: 60, char: 4 },
    },
  };
  const svelteRes = await extractSourceHints(svelteEl);
  assert.equal(svelteRes.sourceHints[0].framework, "svelte");
  assert.equal(svelteRes.sourceHints[0].file, "src/lib/FilterBar.svelte");
  assert.equal(svelteRes.sourceHints[0].line, 61);
  assert.deepEqual(svelteRes.owners, ["FilterBar"]);
});

test("extractSourceHints resolves React 19 _debugStack via same-origin .map and fails closed within timeout on slow/broken/cross-origin maps", async () => {
  assert.equal(DEFAULT_SOURCEMAP_TIMEOUT_MS, 250);

  // VLQ mapping: line 1 col 0 -> source 0, origLine 11 (1-based 12), origCol 2 (1-based 3)
  // VLQ(0)=A, VLQ(0)=A, VLQ(11)=W, VLQ(2)=E -> "AAWE"
  const fakeMap = {
    version: 3,
    sources: ["src/components/KpiHeader.tsx"],
    mappings: "AAWE",
  };
  assert.deepEqual(resolveSourceMapPosition(fakeMap, 1, 1), {
    file: "src/components/KpiHeader.tsx",
    line: 12,
    column: 3,
  });

  const react19El = {
    tagName: "SPAN",
    outerHTML: "<span>Live</span>",
    __reactFiber$r19: {
      type: Object.assign(function KpiHeader() {}, {
        displayName: "KpiHeader",
      }),
      _debugStack: {
        stack:
          "Error: react-stack-top-frame\n    at KpiHeader (https://app.example.test/assets/app.js:1:1)",
      },
    },
  };

  let fetchedUrl = null;
  const mappedRes = await extractSourceHints(react19El, {
    origin: "https://app.example.test",
    fetchImpl: async (url) => {
      fetchedUrl = url;
      return { ok: true, json: async () => fakeMap };
    },
  });
  assert.equal(fetchedUrl, "https://app.example.test/assets/app.js.map");
  assert.equal(mappedRes.sourceHints[0].framework, "react");
  assert.equal(mappedRes.sourceHints[0].file, "src/components/KpiHeader.tsx");
  assert.equal(mappedRes.sourceHints[0].line, 12);
  assert.equal(mappedRes.sourceHints[0].confidence, "high");

  // Cross-origin script URL must NEVER trigger a .map fetch
  let crossOriginFetched = false;
  const crossOriginEl = {
    tagName: "SPAN",
    outerHTML: "<span>Ext</span>",
    __reactFiber$r19: {
      type: Object.assign(function ExtWidget() {}, {
        displayName: "ExtWidget",
      }),
      _debugStack:
        "Error\n    at ExtWidget (https://cdn.other.test/widget.js:5:2)",
    },
  };
  await extractSourceHints(crossOriginEl, {
    origin: "https://app.example.test",
    fetchImpl: async () => {
      crossOriginFetched = true;
      return { ok: true, json: async () => fakeMap };
    },
  });
  assert.equal(crossOriginFetched, false);

  // Hung .map fetch fails closed within timeoutMs (uses AbortController)
  let aborted = false;
  const slowRes = await extractSourceHints(react19El, {
    origin: "https://app.example.test",
    timeoutMs: 30,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
  });
  assert.equal(aborted, true);
  assert.equal(slowRes.sourceHints[0].file, "/assets/app.js");
  assert.equal(slowRes.sourceHints[0].confidence, "medium");

  // Broken JSON .map fails closed without throwing
  const brokenRes = await extractSourceHints(react19El, {
    origin: "https://app.example.test",
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }),
  });
  assert.equal(brokenRes.sourceHints[0].file, "/assets/app.js");
});

test("postMessage bridge ignores non-parent source, wrong origin, and wrong channelId", async () => {
  const listeners = new Set();
  const fakeWindow = {
    addEventListener(type, fn) {
      if (type === "message") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "message") listeners.delete(fn);
    },
  };
  const posted = [];
  const parentWin = {
    postMessage(data, origin) {
      posted.push({ data, origin });
    },
  };
  const otherWin = {};

  const received = [];
  const bridge = createPostMessageBridge({
    windowObj: fakeWindow,
    targetWindow: parentWin,
    targetOrigin: "https://host.example.test",
    channelId: "chan-42",
    onMessage(data) {
      received.push(data);
    },
  });

  const emit = (ev) => {
    for (const fn of listeners) fn(ev);
  };

  // Ignored: wrong source
  emit({
    source: otherWin,
    origin: "https://host.example.test",
    data: {
      type: DK_ANNOTATE_MSG.SET_MODE,
      channelId: "chan-42",
      mode: "annotate",
    },
  });
  // Ignored: wrong origin
  emit({
    source: parentWin,
    origin: "https://evil.example.test",
    data: {
      type: DK_ANNOTATE_MSG.SET_MODE,
      channelId: "chan-42",
      mode: "annotate",
    },
  });
  // Ignored: wrong channelId
  emit({
    source: parentWin,
    origin: "https://host.example.test",
    data: {
      type: DK_ANNOTATE_MSG.SET_MODE,
      channelId: "chan-other",
      mode: "annotate",
    },
  });
  assert.equal(received.length, 0);

  // Accepted: exact source, origin, and channelId
  emit({
    source: parentWin,
    origin: "https://host.example.test",
    data: {
      type: DK_ANNOTATE_MSG.SET_MODE,
      channelId: "chan-42",
      mode: "annotate",
    },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].mode, "annotate");

  bridge.destroy();

  // Full dispatchRedlinePacket via postMessage transport
  const dispatchPromise = dispatchRedlinePacket(
    { route: "/orders", items: [{ id: "1", kind: "pin", route: "/orders" }] },
    {
      transport: {
        type: "postMessage",
        windowObj: fakeWindow,
        targetWindow: parentWin,
        targetOrigin: "https://host.example.test",
        channelId: "chan-99",
        timeoutMs: 2000,
      },
    },
  );

  assert.equal(posted.length, 1);
  assert.equal(posted[0].origin, "https://host.example.test");
  assert.equal(posted[0].data.type, DK_ANNOTATE_MSG.SUBMIT);
  const reqId = posted[0].data.requestId;

  // Spoofed reply with wrong channelId must be ignored
  emit({
    source: parentWin,
    origin: "https://host.example.test",
    data: {
      type: DK_ANNOTATE_MSG.RESULT,
      channelId: "wrong-channel",
      requestId: reqId,
      message: "spoofed",
    },
  });

  // Legitimate parent reply resolves
  emit({
    source: parentWin,
    origin: "https://host.example.test",
    data: {
      type: DK_ANNOTATE_MSG.RESULT,
      channelId: "chan-99",
      requestId: reqId,
      message: "Fix started",
      runUrl: "https://codepress.dev/runs/123",
    },
  });

  const res = await dispatchPromise;
  assert.equal(res.ok, true);
  assert.equal(res.mode, "postMessage");
  assert.equal(res.runUrl, "https://codepress.dev/runs/123");
});

test("sanitizeRunUrl rejects javascript: URLs and allows https/http/relative paths", () => {
  assert.equal(sanitizeRunUrl("javascript:alert(1)"), undefined);
  assert.equal(sanitizeRunUrl("//evil.test/x"), undefined);
  assert.equal(
    sanitizeRunUrl("https://codepress.dev/runs/1"),
    "https://codepress.dev/runs/1",
  );
  assert.equal(sanitizeRunUrl("/runs/1"), "/runs/1");
});

test("dispatchRedlinePacket supports http transport and copy fallback", async () => {
  let sentReq = null;
  const httpRes = await dispatchRedlinePacket(
    {
      route: "/v1/cap1/orders?token=secret&view=all",
      items: [{ id: "1", kind: "pin" }],
    },
    {
      transport: {
        type: "http",
        url: "http://127.0.0.1:4123/__design-kit/fix",
        headers: { "X-Custom": "1" },
        fetchImpl: async (url, init) => {
          sentReq = { url, init, body: JSON.parse(init.body) };
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: "Fix started", runUrl: "/runs/9" }),
          };
        },
      },
    },
  );
  assert.equal(sentReq.url, "http://127.0.0.1:4123/__design-kit/fix");
  assert.equal(sentReq.init.headers["X-Custom"], "1");
  assert.equal(sentReq.body.route, "/orders?view=all");
  assert.equal(httpRes.runUrl, "/runs/9");

  const copyRes = await dispatchRedlinePacket({
    route: "/orders",
    items: [{ id: "1", kind: "pin", note: "Fix padding" }],
  });
  assert.equal(copyRes.mode, "copy");
  assert.ok(copyRes.markdown.includes("Fix padding"));
});

test("getAnnotatorRuntimeScript compiles cleanly and escapes script-closing sequences in options", () => {
  const script = getAnnotatorRuntimeScript({
    autoMount: {
      initialMode: "browse",
      storageKey: "</script><script>alert(1)",
    },
  });
  assert.ok(script.includes("__designKitAnnotate"));
  assert.ok(!script.includes("</script>"));
  // Verify the generated bundle is syntactically valid JS
  assert.doesNotThrow(() => new Function(script));
});
