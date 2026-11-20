/**
 * Unit and integration tests for:
 * - `@codepress/design-kit/vite` (dev-only injection, zero bytes in prod build,
 *   `/__design-kit/fix` security guards, `.design-kit/redlines/` writing,
 *   `.gitignore` idempotency, safe argv local agent spawning)
 * - `@codepress/design-kit/next` (`createNextFixHandler`, `getNextAnnotatorScript`)
 * - `design-kit annotate` CLI argument parsing and reverse proxy
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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  injectAnnotatorScriptTag,
  parseAnnotateArgs,
  startAnnotateProxy,
} from "../src/annotate-cli.mjs";
import {
  createFixMiddleware,
  ensureGitignoreEntry,
  generateCapabilityToken,
  hasPathTraversal,
  isLoopbackAddress,
  isOriginAllowed,
  resolveAgentInvocation,
  tokensEqual,
  writeRedlinePacket,
} from "../src/annotate/fix-receiver.mjs";
import { createNextFixHandler, getNextAnnotatorScript } from "../src/next.mjs";
import { designKitAnnotate, getAnnotatorScriptHtml } from "../src/vite.mjs";

const BIN_PATH = fileURLToPath(
  new URL("../bin/design-kit.mjs", import.meta.url),
);

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeTempDir(prefix = "dk-vite-cli-") {
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
}

function makePacket(overrides = {}) {
  return {
    version: 1,
    capturedAt: "2026-11-20T12:00:00.000Z",
    route: "/orders",
    routes: ["/orders", "/orders/42"],
    viewport: { width: 1280, height: 800, dpr: 1 },
    theme: "dark",
    items: [
      {
        id: "item-1",
        index: 1,
        kind: "pin",
        note: "Button clips $(touch pwned) `id`; echo danger",
        route: "/orders",
        createdAt: "2026-11-20T12:00:01.000Z",
        viewport: { width: 1280, height: 800, dpr: 1 },
        theme: "dark",
        selector: "#export-btn",
        sourceHints: [
          {
            framework: "react",
            file: "src/Orders.tsx",
            line: 42,
            confidence: "high",
          },
        ],
        owners: ["OrdersPage"],
        snapshot: {
          dataUrl: TINY_PNG_DATA_URL,
          width: 1,
          height: 1,
          byteLength: 68,
          crossOriginPlaceholders: 0,
        },
      },
      {
        id: "item-2",
        index: 2,
        kind: "box",
        note: "Modal header wraps on narrow screen",
        route: "/orders/42",
        createdAt: "2026-11-20T12:00:05.000Z",
        viewport: { width: 390, height: 844, dpr: 2 },
        theme: "dark",
        selector: "#modal h2",
        sourceHints: [],
        owners: [],
        snapshot: {
          dataUrl: TINY_PNG_DATA_URL,
          width: 1,
          height: 1,
          byteLength: 68,
          crossOriginPlaceholders: 0,
        },
      },
    ],
    ...overrides,
  };
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

function waitForFile(filePath, timeoutMs = 4000) {
  const tryRead = () => {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf8");
    return content.trim().length > 0 ? content : null;
  };
  const immediate = tryRead();
  if (immediate !== null) return Promise.resolve(immediate);

  return new Promise((resolveFile, rejectFile) => {
    const watcher = watch(dirname(filePath), () => {
      const content = tryRead();
      if (content !== null) {
        clearTimeout(timer);
        watcher.close();
        resolveFile(content);
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      const content = tryRead();
      if (content !== null) resolveFile(content);
      else rejectFile(new Error(`Timed out waiting for ${filePath}`));
    }, timeoutMs);
  });
}

test("token comparison, origin allowlist, and path traversal detectors", () => {
  const tok = generateCapabilityToken();
  assert.equal(tok.length, 48);
  assert.equal(tokensEqual(tok, tok), true);
  assert.equal(tokensEqual("wrong", tok), false);
  assert.equal(tokensEqual("", tok), false);
  assert.equal(tokensEqual(undefined, tok), false);

  assert.equal(
    isOriginAllowed("http://127.0.0.1:5173", "127.0.0.1:5173"),
    true,
  );
  assert.equal(
    isOriginAllowed("http://localhost:3000", "localhost:3000"),
    true,
  );
  assert.equal(
    isOriginAllowed("https://evil.example", "127.0.0.1:5173"),
    false,
  );
  assert.equal(
    isOriginAllowed("http://127.0.0.1:9999", "127.0.0.1:5173"),
    false,
  );
  assert.equal(isOriginAllowed(undefined, "127.0.0.1:5173"), false);
  assert.equal(isOriginAllowed("null", "127.0.0.1:5173"), false);

  assert.equal(hasPathTraversal("../etc/passwd"), true);
  assert.equal(hasPathTraversal("foo\\bar"), true);
  assert.equal(hasPathTraversal("/__design-kit/fix/%2e%2e/secret"), true);
  assert.equal(hasPathTraversal("/orders/42"), false);

  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.42"), false);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
});

test("createFixMiddleware rejects non-loopback remoteAddress with 403 by default", async () => {
  const dir = makeTempDir();
  const token = generateCapabilityToken();
  const middleware = createFixMiddleware({ root: dir, token });
  let statusCode = 0;
  let body = "";
  const fakeReq = {
    method: "POST",
    url: "/__design-kit/fix",
    headers: {
      origin: "http://localhost:5173",
      host: "localhost:5173",
      "x-design-kit-token": token,
    },
    socket: { remoteAddress: "192.168.1.50" },
  };
  const fakeRes = {
    setHeader() {},
    end(payload) {
      body = payload;
    },
    set statusCode(code) {
      statusCode = code;
    },
  };
  try {
    await middleware(fakeReq, fakeRes);
    assert.equal(statusCode, 403);
    assert.match(body, /loopback/i);
    assert.equal(existsSync(join(dir, ".design-kit")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security & negative cases on POST /__design-kit/fix return 403/413/400 and write/spawn nothing", async () => {
  const dir = makeTempDir();
  let spawnCalls = 0;
  const token = generateCapabilityToken();
  const middleware = createFixMiddleware({
    root: dir,
    token,
    agent: [process.execPath, "-e", "process.exit(0)"],
    spawnImpl: () => {
      spawnCalls += 1;
      return { pid: 123, on() {}, unref() {} };
    },
  });

  const srv = await startHttpServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });

  try {
    const validBody = JSON.stringify(makePacket());

    // 1. Missing X-Design-Kit-Token -> 403
    const noToken = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: srv.url,
      },
      body: validBody,
    });
    assert.equal(noToken.status, 403);

    // 2. Wrong X-Design-Kit-Token -> 403
    const badToken = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: srv.url,
        "X-Design-Kit-Token": "wrong-token",
      },
      body: validBody,
    });
    assert.equal(badToken.status, 403);

    // 3. Mismatched Origin -> 403
    const badOrigin = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "X-Design-Kit-Token": token,
      },
      body: validBody,
    });
    assert.equal(badOrigin.status, 403);

    // 4. Missing Origin -> 403
    const noOrigin = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Design-Kit-Token": token,
      },
      body: validBody,
    });
    assert.equal(noOrigin.status, 403);

    // 5. Oversized body (> 8 MB) -> 413
    const bigPayload = JSON.stringify({
      ...makePacket(),
      pad: "x".repeat(8 * 1024 * 1024 + 4096),
    });
    const tooBig = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: srv.url,
        "X-Design-Kit-Token": token,
      },
      body: bigPayload,
    });
    assert.equal(tooBig.status, 413);

    // 6. Path traversal in item.id (`..`) -> 400
    const traversalId = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: srv.url,
        "X-Design-Kit-Token": token,
      },
      body: JSON.stringify(
        makePacket({
          items: [{ ...makePacket().items[0], id: "../../etc/passwd" }],
        }),
      ),
    });
    assert.equal(traversalId.status, 400);

    // 7. Path traversal with backslash (`\`) in route -> 400
    const traversalBackslash = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: srv.url,
        "X-Design-Kit-Token": token,
      },
      body: JSON.stringify(makePacket({ route: "\\windows\\system32" })),
    });
    assert.equal(traversalBackslash.status, 400);

    // 8. Path traversal in extra runId field -> 400
    const traversalRunId = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: srv.url,
        "X-Design-Kit-Token": token,
      },
      body: JSON.stringify(makePacket({ runId: "../escape" })),
    });
    assert.equal(traversalRunId.status, 400);

    // 9. Path traversal in URL query/path -> 400
    const traversalUrl = await fetch(
      `${srv.url}/__design-kit/fix?dir=..%2Fetc`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: srv.url,
          "X-Design-Kit-Token": token,
        },
        body: validBody,
      },
    );
    assert.equal(traversalUrl.status, 400);

    // 10. Non-POST method -> 405
    const wrongMethod = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "GET",
      headers: { Origin: srv.url, "X-Design-Kit-Token": token },
    });
    assert.equal(wrongMethod.status, 405);

    // Nothing was written or spawned by any rejected request
    assert.equal(spawnCalls, 0);
    assert.equal(existsSync(join(dir, ".design-kit")), false);
    assert.equal(existsSync(join(dir, ".gitignore")), false);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRedlinePacket writes packet.md, packet.json, step-*.png, latest.md, and updates .gitignore once", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");

    const first = writeRedlinePacket(makePacket(), { root: dir });
    assert.equal(existsSync(first.packetMd), true);
    assert.equal(existsSync(first.packetJson), true);
    assert.equal(existsSync(first.latestMd), true);
    assert.equal(first.images.length, 2);
    assert.equal(existsSync(join(first.dir, "step-1.png")), true);
    assert.equal(existsSync(join(first.dir, "step-2.png")), true);
    assert.equal(first.gitignoreUpdated, true);

    const latest = readFileSync(first.latestMd, "utf8");
    assert.match(latest, /step-1\.png/);
    assert.match(latest, /step-2\.png/);
    assert.match(latest, /#export-btn/);

    const parsedJson = JSON.parse(readFileSync(first.packetJson, "utf8"));
    assert.equal(parsedJson.runId, first.runId);
    assert.equal(parsedJson.items[0].snapshotFile, "step-1.png");
    assert.equal(parsedJson.items[0].snapshot.dataUrl, undefined);

    const gi1 = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(gi1, "node_modules/\n/.design-kit/redlines/\n");

    // Second write must not duplicate .gitignore entry
    const second = writeRedlinePacket(makePacket(), { root: dir });
    assert.equal(second.gitignoreUpdated, false);
    assert.notEqual(second.runId, first.runId);
    const gi2 = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(gi2, gi1);

    // Direct idempotency check
    const gi3 = ensureGitignoreEntry(dir);
    assert.equal(gi3.updated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAgentInvocation supports claude, codex, agy, and custom argv arrays without shell interpolation", () => {
  const ctx = {
    runId: "2026-11-20T12-00-00-000Z",
    dir: "/repo/.design-kit/redlines/2026-11-20T12-00-00-000Z",
    relativeDir: ".design-kit/redlines/2026-11-20T12-00-00-000Z",
    packetMd: "/repo/.design-kit/redlines/2026-11-20T12-00-00-000Z/packet.md",
    relativePacketMd: ".design-kit/redlines/2026-11-20T12-00-00-000Z/packet.md",
    latestMd: "/repo/.design-kit/redlines/latest.md",
    relativeLatestMd: ".design-kit/redlines/latest.md",
    packetJson:
      "/repo/.design-kit/redlines/2026-11-20T12-00-00-000Z/packet.json",
    itemCount: 2,
  };

  const claude = resolveAgentInvocation("claude", ctx);
  assert.equal(claude.command, "claude");
  assert.equal(claude.args[0], "-p");
  assert.match(claude.args[1], /packet\.md/);

  const codex = resolveAgentInvocation("codex", ctx);
  assert.equal(codex.command, "codex");
  assert.equal(codex.args[0], "exec");

  const agy = resolveAgentInvocation("agy", ctx);
  assert.equal(agy.command, "agy");
  assert.equal(agy.args[0], "-p");

  const custom = resolveAgentInvocation(
    ["my-agent", "--file", "{packet}"],
    ctx,
  );
  assert.equal(custom.command, "my-agent");
  assert.deepEqual(custom.args, ["--file", ctx.packetMd]);
});

test("designKitAnnotate injects zero bytes in vite build unless enabled + remote endpoint are both set", () => {
  const html =
    "<!doctype html><html><body><div id='app'>Hi</div></body></html>";

  // 1. Default in `build` mode -> zero bytes added
  const prodDefault = designKitAnnotate({ agent: "claude" });
  prodDefault.configResolved({ command: "build", root: process.cwd() });
  assert.equal(prodDefault.transformIndexHtml(html), html);

  // 2. `enabled: true` WITHOUT remote `endpoint` in `build` mode -> still zero bytes!
  const prodEnabledNoEndpoint = designKitAnnotate({
    enabled: true,
    agent: "claude",
  });
  prodEnabledNoEndpoint.configResolved({
    command: "build",
    root: process.cwd(),
  });
  assert.equal(prodEnabledNoEndpoint.transformIndexHtml(html), html);

  // 3. `enabled: true` WITH remote `endpoint` in `build` mode -> injects inline script
  const prodWithEndpoint = designKitAnnotate({
    enabled: true,
    endpoint: "https://hooks.example.com/redlines",
  });
  prodWithEndpoint.configResolved({ command: "build", root: process.cwd() });
  const transformedBuild = prodWithEndpoint.transformIndexHtml(html);
  assert.equal(typeof transformedBuild, "object");
  assert.equal(transformedBuild.tags.length, 1);
  assert.match(
    transformedBuild.tags[0].children,
    /https:\/\/hooks\.example\.com\/redlines/,
  );

  // 4. Default in `serve` mode -> injects defer script tag
  const devPlugin = designKitAnnotate({ agent: "claude" });
  devPlugin.configResolved({ command: "serve", root: process.cwd() });
  const transformedDev = devPlugin.transformIndexHtml(html);
  assert.equal(typeof transformedDev, "object");
  assert.equal(transformedDev.tags[0].attrs.src, "/__design-kit/annotator.js");
  assert.equal(transformedDev.tags[0].attrs.defer, true);
});

test("designKitAnnotate dev middleware writes redlines and spawns real stub agent via safe argv array", async () => {
  const dir = makeTempDir();
  const stubScript = join(dir, "stub-agent.mjs");
  const recordFile = join(dir, "agent-invocation.json");
  const pwnFile = join(dir, "pwned");

  writeFileSync(
    stubScript,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  runId: process.env.DESIGN_KIT_REDLINE_RUN_ID,
  md: process.env.DESIGN_KIT_REDLINE_MD,
  latest: process.env.DESIGN_KIT_REDLINE_LATEST,
}, null, 2));
`,
    "utf8",
  );

  const token = generateCapabilityToken();
  const plugin = designKitAnnotate({
    root: dir,
    token,
    agent: [process.execPath, stubScript, "--from-vite"],
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
      if (fn) fn(req, res, next);
      else {
        res.statusCode = 404;
        res.end("not found");
      }
    };
    next();
  });

  try {
    // Runtime script is served
    const jsRes = await fetch(`${srv.url}/__design-kit/annotator.js`);
    assert.equal(jsRes.status, 200);
    const jsText = await jsRes.text();
    assert.match(jsText, /__designKitAnnotate/);
    assert.match(jsText, new RegExp(token));

    // POST /__design-kit/fix succeeds and invokes stub agent
    const fixRes = await fetch(`${srv.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: srv.url,
        "X-Design-Kit-Token": token,
      },
      body: JSON.stringify(makePacket()),
    });
    assert.equal(fixRes.status, 200);
    const body = await fixRes.json();
    assert.equal(body.ok, true);
    assert.ok(body.runId);
    assert.match(body.message, /Saved 2 redlines & started/);

    const recorded = JSON.parse(await waitForFile(recordFile));
    assert.equal(recorded.argv[0], "--from-vite");
    assert.match(recorded.argv[1], /packet\.md/);
    assert.equal(recorded.runId, body.runId);
    assert.equal(existsSync(recorded.md), true);
    assert.equal(existsSync(recorded.latest), true);
    // Ensure shell metacharacters in DOM note never executed
    assert.equal(existsSync(pwnFile), false);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Next.js helpers (createNextFixHandler, getNextAnnotatorScript, getAnnotatorScriptHtml)", async () => {
  const dir = makeTempDir();
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const handler = createNextFixHandler({ root: dir });
    assert.ok(handler.token);

    // Rejected without token
    const reqBad = new Request("http://localhost:3000/api/design-kit/fix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        Host: "localhost:3000",
      },
      body: JSON.stringify(makePacket()),
    });
    const resBad = await handler(reqBad);
    assert.equal(resBad.status, 403);

    // Accepted with token + loopback origin
    const reqOk = new Request("http://localhost:3000/api/design-kit/fix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        Host: "localhost:3000",
        "X-Design-Kit-Token": handler.token,
      },
      body: JSON.stringify(makePacket()),
    });
    const resOk = await handler(reqOk);
    assert.equal(resOk.status, 200);
    const json = await resOk.json();
    assert.equal(json.ok, true);
    assert.equal(existsSync(join(dir, ".design-kit/redlines/latest.md")), true);

    assert.match(
      getNextAnnotatorScript({ token: handler.token }),
      /__designKitAnnotate/,
    );
    const prevTok = process.env.DESIGN_KIT_ANNOTATE_TOKEN;
    try {
      process.env.DESIGN_KIT_ANNOTATE_TOKEN = "shared-next-token-123";
      assert.match(getNextAnnotatorScript(), /shared-next-token-123/);
    } finally {
      if (prevTok === undefined) delete process.env.DESIGN_KIT_ANNOTATE_TOKEN;
      else process.env.DESIGN_KIT_ANNOTATE_TOKEN = prevTok;
    }
    assert.match(
      getAnnotatorScriptHtml({ token: handler.token }),
      /<script data-design-kit-annotator="true">/,
    );

    // In production, handler refuses with 404 and script helpers return empty strings
    process.env.NODE_ENV = "production";
    const resProd = await handler(reqOk);
    assert.equal(resProd.status, 404);
    assert.equal(getNextAnnotatorScript({ token: handler.token }), "");
    assert.equal(getAnnotatorScriptHtml({ token: handler.token }), "");
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseAnnotateArgs and injectAnnotatorScriptTag", () => {
  const parsed = parseAnnotateArgs([
    "http://localhost:4000",
    "--agent",
    "claude",
    "--port",
    "4180",
    "--no-open",
  ]);
  assert.equal(parsed.targetUrl, "http://localhost:4000/");
  assert.equal(parsed.agent, "claude");
  assert.equal(parsed.port, 4180);
  assert.equal(parsed.noOpen, true);

  const custom = parseAnnotateArgs([
    "http://127.0.0.1:5173",
    "--agent",
    "node",
    "--agent-arg",
    "fix.mjs",
  ]);
  assert.deepEqual(custom.agent, ["node", "fix.mjs"]);

  assert.throws(() => parseAnnotateArgs(["ftp://example.com"]), /http:|https:/);
  assert.throws(() => parseAnnotateArgs(["--port", "99999"]), /integer/);

  assert.equal(
    injectAnnotatorScriptTag("<html><body><h1>Hi</h1></body></html>"),
    '<html><body><h1>Hi</h1><script src="/__design-kit/annotator.js" defer></script></body></html>',
  );
  assert.equal(
    injectAnnotatorScriptTag("<h1>No body</h1>"),
    '<h1>No body</h1><script src="/__design-kit/annotator.js" defer></script>',
  );
});

test("startAnnotateProxy injects script into HTML, preserves non-HTML assets, and handles /__design-kit/fix", async () => {
  const dir = makeTempDir();
  const upstream = await startHttpServer((req, res) => {
    if (req.url === "/style.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end("body { color: red; }");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><main>App</main></body></html>");
  });

  const proxy = await startAnnotateProxy({
    targetUrl: upstream.url,
    root: dir,
  });

  try {
    const htmlRes = await fetch(`${proxy.url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /<main>App<\/main>/);
    assert.match(
      html,
      /<script src="\/__design-kit\/annotator\.js" defer><\/script>/,
    );

    const cssRes = await fetch(`${proxy.url}/style.css`);
    assert.equal(cssRes.status, 200);
    assert.equal(await cssRes.text(), "body { color: red; }");

    // Token + origin guarded fix endpoint
    const badRes = await fetch(`${proxy.url}/__design-kit/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: proxy.url },
      body: JSON.stringify(makePacket()),
    });
    assert.equal(badRes.status, 403);

    const okRes = await fetch(`${proxy.url}/__design-kit/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: proxy.url,
        "X-Design-Kit-Token": proxy.token,
      },
      body: JSON.stringify(makePacket()),
    });
    assert.equal(okRes.status, 200);
    assert.equal(existsSync(join(dir, ".design-kit/redlines/latest.md")), true);
  } finally {
    await proxy.close();
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI `design-kit annotate <url> --no-open` starts proxy and exits cleanly on SIGTERM", async () => {
  const dir = makeTempDir();
  const upstream = await startHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><p>CLI Proxy Target</p></body></html>");
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
      child.once("exit", (code) => {
        clearTimeout(timer);
        rejectUrl(new Error(`CLI exited early (${code}): ${stderr}`));
      });
    });

    const resp = await fetch(proxyUrl);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /CLI Proxy Target/);
    assert.match(body, /\/__design-kit\/annotator\.js/);

    const exitCode = await new Promise((resolveExit) => {
      child.once("exit", (code) => resolveExit(code));
      child.kill("SIGTERM");
    });
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
