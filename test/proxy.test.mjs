import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.mjs";
import { request } from "../src/storage/codepress.mjs";
import { bypassesProxy, proxyFor } from "../src/storage/proxy.mjs";
import { zipDirectory } from "../src/storage/zip.mjs";

const KIT = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const KIT_SHA = JSON.parse(
  readFileSync(join(KIT, "manifest.json"), "utf8"),
).sha;
const ZIP = zipDirectory(KIT);
const BIN = fileURLToPath(new URL("../bin/design-kit.mjs", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "design-kit-proxy-test-"));
let counter = 0;
// A self-signed certificate for kit.test, localhost and 127.0.0.1, made once
// per run and trusted only by the child process that names it in
// NODE_EXTRA_CA_CERTS.
const CERT = join(scratch, "cert.pem");
const KEY = join(scratch, "key.pem");
// prettier-ignore
execFileSync("openssl", [
  "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
  "-nodes", "-keyout", KEY, "-out", CERT, "-days", "2", "-subj", "/CN=kit.test",
  "-addext", "subjectAltName=DNS:kit.test,DNS:localhost,IP:127.0.0.1",
  "-addext", "basicConstraints=critical,CA:TRUE",
], { stdio: "ignore" });
const freshTmp = () => {
  const dir = join(scratch, `tmp-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const listen = (server) =>
  new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done(server.address().port)),
  );
const close = (server) => new Promise((done) => server.close(done));

/** Answers `/kit.zip` with the kit and anything else 404. */
const kitHandler = (req, res) => {
  if (new URL(req.url, "http://x").pathname === "/kit.zip") {
    res.writeHead(200, { "Content-Type": "application/zip" });
    res.end(ZIP);
    return;
  }
  res.writeHead(404);
  res.end();
};

/**
 * A forwarding proxy that records what it saw. `CONNECT` to any host opens a
 * tunnel to the local TLS server (so `kit.test` never needs DNS); an
 * absolute-URL request is forwarded to the URL. With `refuse`, every CONNECT
 * is answered 403.
 */
function makeProxy({ refuse = false } = {}) {
  const seen = [];
  // Tunnelled sockets leave the server's own tracking, so `close()` would
  // wait on them forever; `after` destroys them.
  const tunnels = new Set();
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers["proxy-authorization"],
    });
    const upstream = http.request(
      req.url,
      { method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("connect", (req, socket, head) => {
    tunnels.add(socket);
    seen.push({
      method: "CONNECT",
      url: req.url,
      auth: req.headers["proxy-authorization"],
    });
    if (refuse) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect(tlsPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    tunnels.add(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return { server, seen, tunnels, port: 0 };
}

let tlsServer;
let tlsPort;
let plainServer;
let plainBase;
const open = makeProxy();
const refusing = makeProxy({ refuse: true });

before(async () => {
  tlsServer = https.createServer(
    {
      key: readFileSync(KEY),
      cert: readFileSync(CERT),
    },
    kitHandler,
  );
  tlsPort = await listen(tlsServer);
  plainServer = http.createServer(kitHandler);
  plainBase = `http://127.0.0.1:${await listen(plainServer)}`;
  open.port = await listen(open.server);
  refusing.port = await listen(refusing.server);
});

after(async () => {
  rmSync(scratch, { recursive: true, force: true });
  for (const socket of [...open.tunnels, ...refusing.tunnels]) socket.destroy();
  const servers = [tlsServer, plainServer, open.server, refusing.server];
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map(close));
});

async function cli(args, env) {
  const lines = [];
  const spies = [
    mock.method(console, "log", (text) => lines.push(String(text))),
    mock.method(console, "error", (text) => lines.push(String(text))),
  ];
  try {
    return { code: await main(args, env), output: lines.join("\n") };
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
}

/** Runs the real bin in a child, so NODE_EXTRA_CA_CERTS takes effect. */
function runBin(args, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code, output: output.trim() }));
  });
}

test("proxyFor picks the scheme's variable, lowercase first, and honours NO_PROXY", () => {
  const env = {
    HTTPS_PROXY: "http://upper:3128",
    https_proxy: "http://lower:3128",
    HTTP_PROXY: "plain:8080",
  };
  assert.equal(proxyFor("https://r2.example/kit.zip", env).host, "lower:3128");
  assert.equal(
    proxyFor("https://r2.example/kit.zip", { HTTPS_PROXY: "http://upper:1" })
      .host,
    "upper:1",
  );
  // A proxy written without a scheme is http://.
  assert.equal(proxyFor("http://r2.example/", env).href, "http://plain:8080/");
  assert.equal(
    proxyFor("https://r2.example/", { HTTP_PROXY: "http://p:1" }),
    null,
  );
  assert.equal(proxyFor("https://r2.example/", {}), null);
  assert.equal(
    proxyFor("https://r2.example/", { ...env, NO_PROXY: "r2.example" }),
    null,
  );
  assert.equal(
    proxyFor("https://r2.example/", {
      ...env,
      no_proxy: "other",
      NO_PROXY: "r2.example",
    }).host,
    "lower:3128",
    "no_proxy wins over NO_PROXY",
  );
  assert.throws(
    () => proxyFor("https://a/", { HTTPS_PROXY: "socks5://user:pw@p:1" }),
    (error) =>
      error.code === "invalid_proxy" &&
      !/user|pw/.test(error.message) &&
      /HTTPS_PROXY/.test(error.message),
  );
});

test("NO_PROXY matches *, exact names, leading-dot and plain domain suffixes, and an optional port", () => {
  const cases = [
    ["*", "anything.example", 443, true],
    ["kit.test", "kit.test", 443, true],
    ["kit.test", "a.kit.test", 443, true],
    ["kit.test", "notkit.test", 443, false],
    [".example.com", "cdn.example.com", 443, true],
    [".example.com", "example.com", 443, true],
    ["*.example.com", "deep.cdn.example.com", 443, true],
    ["example.com:8443", "example.com", 8443, true],
    ["example.com:8443", "example.com", 443, false],
    ["localhost, 127.0.0.1", "127.0.0.1", 80, true],
    ["[::1]:80", "[::1]", 80, true],
    ["other.test", "kit.test", 443, false],
    ["", "kit.test", 443, false],
  ];
  for (const [list, host, port, expected] of cases)
    assert.equal(
      bypassesProxy(host, port, { NO_PROXY: list }),
      expected,
      `NO_PROXY=${JSON.stringify(list)} for ${host}:${port}`,
    );
});

test("fetch --url through an HTTPS_PROXY CONNECT tunnel installs the kit with exactly one CONNECT and Basic proxy auth", async () => {
  const TMPDIR = freshTmp();
  const before = open.seen.length;
  const result = await runBin(
    [
      "fetch",
      "--url",
      "https://kit.test/kit.zip?X-Amz-Signature=secret",
      "--sha",
      KIT_SHA,
    ],
    {
      TMPDIR,
      HTTPS_PROXY: `http://agent:p%40ss@127.0.0.1:${open.port}`,
      NODE_EXTRA_CA_CERTS: CERT,
    },
  );
  assert.equal(result.code, 0, result.output);
  const path = join(TMPDIR, `design-kit-${KIT_SHA}`);
  assert.match(result.output, new RegExp(`^path=${path}$`, "m"));
  assert.ok(existsSync(join(path, "manifest.json")));
  assert.deepEqual(readdirSync(TMPDIR), [`design-kit-${KIT_SHA}`]);
  const seen = open.seen.slice(before);
  assert.deepEqual(
    seen.map(({ method, url }) => `${method} ${url}`),
    ["CONNECT kit.test:443"],
  );
  assert.equal(
    seen[0].auth,
    `Basic ${Buffer.from("agent:p@ss").toString("base64")}`,
  );
});

test("a proxy refusing CONNECT with 403 exits 1 with one line that names no credential or query, and leaves no partial folder", async () => {
  const TMPDIR = freshTmp();
  const before = refusing.seen.length;
  const result = await cli(
    [
      "fetch",
      "--url",
      "https://kit.test/kit.zip?X-Amz-Signature=secret",
      "--sha",
      KIT_SHA,
    ],
    { TMPDIR, HTTPS_PROXY: `http://agent:s3cret@127.0.0.1:${refusing.port}` },
  );
  assert.equal(result.code, 1, result.output);
  assert.equal(
    result.output,
    "design-kit: kit_storage_unavailable: could not reach kit.test through the proxy (403)",
  );
  assert.doesNotMatch(result.output, /s3cret|agent|Signature|secret/);
  assert.equal(refusing.seen.length - before, 1);
  assert.deepEqual(readdirSync(TMPDIR), []);
});

test("NO_PROXY naming the host goes direct and the proxy sees nothing; without it a plain http URL goes to the proxy as an absolute URL", async () => {
  const url = `${plainBase}/kit.zip?X-Amz-Signature=secret`;
  const before = open.seen.length;
  const direct = await cli(["fetch", "--url", url, "--sha", KIT_SHA], {
    TMPDIR: freshTmp(),
    HTTP_PROXY: `http://127.0.0.1:${open.port}`,
    NO_PROXY: "localhost,127.0.0.1",
  });
  assert.equal(direct.code, 0, direct.output);
  assert.equal(open.seen.length, before, "the proxy saw nothing");

  const proxied = await cli(["fetch", "--url", url, "--sha", KIT_SHA], {
    TMPDIR: freshTmp(),
    HTTP_PROXY: `http://127.0.0.1:${open.port}`,
  });
  assert.equal(proxied.code, 0, proxied.output);
  assert.deepEqual(
    open.seen.slice(before).map(({ method, url: seen }) => `${method} ${seen}`),
    [`GET ${url}`],
  );
});

test("the codepress store's requests follow the proxy too", async () => {
  const before = open.seen.length;
  const response = await request(`${plainBase}/kit.zip`, {
    env: { http_proxy: `http://127.0.0.1:${open.port}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.length, ZIP.length);
  assert.deepEqual(
    open.seen.slice(before).map(({ url }) => url),
    [`${plainBase}/kit.zip`],
  );
  await assert.rejects(
    request("https://kit.test/latest?token=secret", {
      env: { HTTPS_PROXY: `http://user:pw@127.0.0.1:${refusing.port}` },
    }),
    (error) =>
      error.code === "kit_storage_unavailable" &&
      error.message.endsWith(
        "could not reach kit.test through the proxy (403)",
      ) &&
      !/user|pw|secret/.test(error.message),
  );
});
