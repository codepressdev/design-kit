import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.mjs";
import { fetchFromUrl, redactUrl } from "../src/storage/url.mjs";
import { zipDirectory } from "../src/storage/zip.mjs";

const KIT = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const KIT_SHA = JSON.parse(
  readFileSync(join(KIT, "manifest.json"), "utf8"),
).sha;
const ZIP = zipDirectory(KIT);

const scratch = mkdtempSync(join(tmpdir(), "design-kit-fetch-url-test-"));
let counter = 0;
const freshTmp = () => {
  const dir = join(scratch, `tmp-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * A fake presigned-URL host. `/kit.zip?sig=…` answers the kit,
 * `/expired.zip` 403 with S3's XML, `/truncated.zip` half the zip, and
 * `/pair.zip` holds each answer until two requests have arrived, so two
 * concurrent fetches both download.
 */
const host = { server: null, base: "", hits: {}, held: [] };

before(async () => {
  host.server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    host.hits[path] = (host.hits[path] ?? 0) + 1;
    const zip = (body = ZIP) => {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(body);
    };
    if (path === "/kit.zip") return zip();
    if (path === "/expired.zip") {
      res.writeHead(403, { "Content-Type": "application/xml" });
      return res.end(
        "<?xml version='1.0'?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
      );
    }
    if (path === "/truncated.zip") return zip(ZIP.subarray(0, ZIP.length >> 1));
    if (path === "/pair.zip") {
      host.held.push(() => zip());
      if (host.held.length === 2)
        for (const send of host.held.splice(0)) send();
      return undefined;
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((done) => host.server.listen(0, "127.0.0.1", done));
  host.base = `http://127.0.0.1:${host.server.address().port}`;
});

after(async () => {
  await new Promise((done) => host.server.close(done));
  rmSync(scratch, { recursive: true, force: true });
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

/** The entries `TMPDIR` holds: nothing but finished kits may be left. */
const leftovers = (dir) => readdirSync(dir).sort();

test("fetch --url installs the kit with no key or config, prints path, sha, branch and the summary; a second run downloads nothing", async () => {
  const TMPDIR = freshTmp();
  const url = `${host.base}/kit.zip?X-Amz-Signature=secret`;
  const before = host.hits["/kit.zip"] ?? 0;
  const args = ["fetch", "--url", url, "--sha", KIT_SHA, "--branch", "main"];
  const first = await cli(args, { TMPDIR });
  assert.equal(first.code, 0, first.output);
  const path = join(TMPDIR, `design-kit-${KIT_SHA}`);
  assert.equal(
    first.output,
    [
      `path=${path}`,
      `sha=${KIT_SHA}`,
      "branch=main",
      "0123456 built 2026-11-03T00:00:00.000Z · stories 38 · routes 1 · failed 0",
    ].join("\n"),
  );
  assert.ok(existsSync(join(path, "html")));
  assert.deepEqual(leftovers(TMPDIR), [`design-kit-${KIT_SHA}`]);

  const second = await cli(args, { TMPDIR });
  assert.equal(second.code, 0, second.output);
  assert.equal(second.output, first.output);
  assert.equal(
    host.hits["/kit.zip"] - before,
    1,
    "the second run downloads nothing",
  );
});

test("fetch --url without --sha is a usage error", async () => {
  const result = await cli(["fetch", "--url", `${host.base}/kit.zip`], {
    TMPDIR: freshTmp(),
  });
  assert.equal(result.code, 2);
  assert.match(result.output, /needs --sha/);
});

for (const [name, path, sha, reason] of [
  [
    "an expired (403) URL",
    "/expired.zip",
    KIT_SHA,
    /^design-kit: forbidden: .*refused \(403\).*expired/,
  ],
  ["a truncated zip", "/truncated.zip", KIT_SHA, /^design-kit: bad_archive: /],
  [
    "a sha mismatch",
    "/kit.zip",
    "f".repeat(40),
    /^design-kit: sha_mismatch: the downloaded kit is of 0123456789ab, not ffffffffffff$/,
  ],
]) {
  test(`fetch --url with ${name} exits 1 with a one-line reason and leaves no partial folder`, async () => {
    const TMPDIR = freshTmp();
    const result = await cli(
      [
        "fetch",
        "--url",
        `${host.base}${path}?X-Amz-Signature=secret`,
        "--sha",
        sha,
      ],
      { TMPDIR },
    );
    assert.equal(result.code, 1, result.output);
    assert.equal(result.output.split("\n").length, 1, result.output);
    assert.match(result.output, reason);
    assert.doesNotMatch(result.output, /secret/, "the signature never prints");
    assert.deepEqual(leftovers(TMPDIR), []);
  });
}

test("fetch --url refuses a short manifest sha and an --out folder that holds files but no kit, and leaves both untouched", async () => {
  const TMPDIR = freshTmp();
  // --sha longer than the manifest's sha: the manifest must start with --sha.
  const longer = await cli(
    ["fetch", "--url", `${host.base}/kit.zip`, "--sha", `${KIT_SHA}0`],
    { TMPDIR },
  );
  assert.equal(longer.code, 1, longer.output);
  assert.match(longer.output, /^design-kit: sha_mismatch: /);
  // A short --sha naming the manifest's sha is fine.
  const short = await cli(
    [
      "fetch",
      "--url",
      `${host.base}/kit.zip`,
      "--sha",
      KIT_SHA.slice(0, 7),
      "--out",
      join(TMPDIR, "short"),
    ],
    { TMPDIR },
  );
  assert.equal(short.code, 0, short.output);

  const out = join(TMPDIR, "busy");
  mkdirSync(out);
  writeFileSync(join(out, "notes.txt"), "mine");
  const busy = await cli(
    ["fetch", "--url", `${host.base}/kit.zip`, "--sha", KIT_SHA, "--out", out],
    { TMPDIR },
  );
  assert.equal(busy.code, 1, busy.output);
  assert.equal(
    busy.output,
    `design-kit: out_not_empty: ${out} exists and is not a kit; choose another --out`,
  );
  assert.deepEqual(readdirSync(out), ["notes.txt"]);
  assert.deepEqual(leftovers(TMPDIR), ["busy", "short"]);
});

test("two concurrent fetches of one sha both end with the same complete folder", async () => {
  const TMPDIR = freshTmp();
  const url = `${host.base}/pair.zip`;
  const [a, b] = await Promise.all([
    fetchFromUrl({ url, sha: KIT_SHA, env: { TMPDIR } }),
    fetchFromUrl({ url, sha: KIT_SHA, env: { TMPDIR } }),
  ]);
  assert.equal(host.hits["/pair.zip"], 2, "both downloaded");
  assert.equal(a.path, b.path);
  assert.deepEqual(
    [a.cached, b.cached].sort(),
    [false, true],
    "one installed, the other kept the winner's folder",
  );
  assert.ok(existsSync(join(a.path, "manifest.json")));
  assert.deepEqual(leftovers(TMPDIR), [`design-kit-${KIT_SHA}`]);
});

test("redactUrl drops the query string", () => {
  assert.equal(
    redactUrl(
      "https://r2.example/kits/a.zip?X-Amz-Signature=abc&X-Amz-Expires=900",
    ),
    "https://r2.example/kits/a.zip?…",
  );
});
