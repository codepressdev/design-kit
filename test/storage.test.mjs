import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.mjs";
import { resolveConfig } from "../src/config.mjs";
import { readZip, unzipTo, zipDirectory } from "../src/storage/zip.mjs";

const KIT = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "design-kit-storage-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const fresh = (name) => {
  const dir = join(scratch, `${name}-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Every file under `root` with its bytes, as base64. */
function files(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(root);
  return out;
}

/** Runs the CLI in-process; returns its exit code and what it printed. */
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

/** A design-kit.config.json with `storage`, in its own folder. */
function configWith(storage) {
  const dir = fresh("config");
  const file = join(dir, "design-kit.config.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      storage,
      pages: {
        baseUrl: "http://localhost:3000",
        pages: [
          { name: "home", path: "/", ready: "main", slots: { main: ["main"] } },
        ],
      },
    }),
  );
  return file;
}

// ── zip ─────────────────────────────────────────────────────────────────────

test("a kit zips and unzips to the same files, deterministically", () => {
  const zip = zipDirectory(KIT);
  assert.deepEqual(zipDirectory(KIT), zip);
  const out = fresh("unzipped");
  unzipTo(zip, out);
  assert.deepEqual(files(out), files(KIT));
});

test("unzip refuses an entry that climbs out of the kit, and writes nothing", () => {
  const dir = fresh("evil");
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "a", "x.txt"), "x");
  const zip = zipDirectory(dir);
  // Rename "a/x.txt" to "../x.txt" in both headers (same length).
  const evil = Buffer.from(
    zip.toString("latin1").replaceAll("a/x.txt", "../x.tx"),
    "latin1",
  );
  assert.equal(readZip(zip)[0].path, "a/x.txt");
  const out = join(fresh("out"), "kit");
  assert.throws(() => unzipTo(evil, out), /outside the kit/);
  assert.throws(() => readdirSync(out), /ENOENT/);
});

// ── codepress: a fake backend answering the #22399 contract ────────────────

const backend = {
  server: null,
  base: "",
  oidcAudiences: [],
  puts: [],
  completes: [],
  downloads: 0,
  readAuth: [],
  acceptOidcReads: false,
  stored: null,
  latest: null,
};

before(async () => {
  backend.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, backend.base);
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/oidc") {
        if (req.headers.authorization !== "bearer request-token")
          return send(401, {});
        backend.oidcAudiences.push(url.searchParams.get("audience"));
        return send(200, { value: "oidc-jwt" });
      }
      if (req.method === "POST" && url.pathname === "/v1/design-kits/uploads") {
        if (req.headers.authorization !== "Bearer oidc-jwt")
          return send(401, { detail: "no", reason: "invalid_token" });
        const start = JSON.parse(body.toString("utf8"));
        backend.start = start;
        return send(200, {
          upload_id: "u-1",
          branch: "main",
          commit_sha: "c".repeat(40),
          upload: {
            method: "PUT",
            url: `${backend.base}/r2/u-1?X-Amz-Signature=sig`,
            headers: {
              "Content-Length": String(start.size_bytes),
              "Content-Type": "application/zip",
            },
            expires_in: 900,
          },
        });
      }
      if (req.method === "PUT" && url.pathname === "/r2/u-1") {
        backend.puts.push({
          contentLength: req.headers["content-length"],
          contentType: req.headers["content-type"],
          bytes: body.length,
        });
        // R2 refuses a body of any other length than the signed one.
        if (Number(req.headers["content-length"]) !== backend.start.size_bytes)
          return send(403, {});
        backend.stored = body;
        res.writeHead(200);
        return res.end();
      }
      if (
        req.method === "POST" &&
        url.pathname === "/v1/design-kits/uploads/u-1/complete"
      ) {
        backend.completes.push(req.headers.authorization);
        if (!backend.stored)
          return send(409, { detail: "missing", reason: "object_missing" });
        backend.latest = {
          commit_sha: "c".repeat(40),
          branch: "main",
          created_at: "2026-11-12T00:00:00Z",
          size_bytes: backend.stored.length,
          manifest: backend.start.manifest,
          download_url: `${backend.base}/r2/u-1?download`,
        };
        return send(200, {
          upload_id: "u-1",
          branch: "main",
          commit_sha: "c".repeat(40),
          size_bytes: backend.stored.length,
          ready_at: "2026-11-12T00:00:00Z",
        });
      }
      if (req.method === "GET" && url.pathname === "/r2/u-1") {
        backend.downloads += 1;
        res.writeHead(200, { "Content-Type": "application/zip" });
        return res.end(backend.stored);
      }
      if (
        req.method === "GET" &&
        url.pathname === "/v1/design-kits/repos/acme/shop/latest"
      ) {
        backend.readAuth.push(req.headers.authorization);
        // The repository's own OIDC token reads once #22530 is deployed.
        const oidcRead =
          backend.acceptOidcReads &&
          req.headers.authorization === "Bearer oidc-jwt";
        if (req.headers.authorization === "Bearer cpk_other")
          return send(403, {
            detail: "None of your organizations connected acme/shop.",
            reason: "forbidden",
          });
        if (req.headers.authorization !== "Bearer cpk_good" && !oidcRead)
          return send(401, { detail: "Unauthorized" });
        if (!backend.latest || url.searchParams.get("branch") === "empty")
          return send(404, { detail: "No kit.", reason: "no_kit" });
        return send(200, backend.latest);
      }
      return send(404, { detail: "Not Found" });
    });
  });
  await new Promise((resolve) =>
    backend.server.listen(0, "127.0.0.1", resolve),
  );
  backend.base = `http://127.0.0.1:${backend.server.address().port}`;
});
after(() => backend.server?.close());

const codepressConfig = () =>
  configWith({
    type: "codepress",
    url: "https://codepress.dev",
    apiUrl: `${backend.base}/v1`,
  });

const actionsEnv = () => ({
  ACTIONS_ID_TOKEN_REQUEST_URL: `${backend.base}/oidc?api-version=2.0`,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  GITHUB_REPOSITORY: "acme/shop",
  GITHUB_REF_NAME: "main",
  GITHUB_SHA: "c".repeat(40),
});

test("codepress: upload signs in with the OIDC token for the CodePress audience, PUTs the exact size, then completes; fetch caches by SHA", async () => {
  const config = codepressConfig();
  const upload = await cli(
    ["upload", "--config", config, "--dir", KIT],
    actionsEnv(),
  );
  assert.equal(upload.code, 0, upload.output);
  assert.deepEqual(backend.oidcAudiences, ["https://codepress.dev"]);
  // Branch and commit come from the token: the body has neither.
  assert.deepEqual(Object.keys(backend.start).sort(), [
    "manifest",
    "size_bytes",
  ]);
  assert.deepEqual(backend.start.manifest.counts, {
    stories: 38,
    routes: 1,
    failed: 0,
  });
  assert.equal(backend.puts.length, 1);
  assert.equal(backend.puts[0].contentLength, String(backend.start.size_bytes));
  assert.equal(backend.puts[0].bytes, backend.start.size_bytes);
  assert.equal(backend.puts[0].contentType, "application/zip");
  assert.deepEqual(backend.completes, ["Bearer oidc-jwt"]);
  assert.match(upload.output, /^sha=c{40}$/m);

  const env = {
    CODEPRESS_API_KEY: "cpk_good",
    GITHUB_REPOSITORY: "acme/shop",
    TMPDIR: fresh("tmp"),
  };
  const first = await cli(["fetch", "--config", config], env);
  assert.equal(first.code, 0, first.output);
  const path = first.output.match(/^path=(.*)$/m)[1];
  assert.equal(path, join(env.TMPDIR, `design-kit-${"c".repeat(40)}`));
  assert.match(first.output, /^sha=c{40}$/m);
  assert.match(first.output, /^branch=main$/m);
  assert.deepEqual(files(path), files(KIT));
  assert.equal(backend.downloads, 1);

  const second = await cli(["fetch", "--config", config], env);
  assert.equal(second.code, 0, second.output);
  assert.equal(second.output.match(/^path=(.*)$/m)[1], path);
  assert.equal(backend.downloads, 1, "the cached kit is not downloaded again");

  const latest = await cli(["latest", "--config", config], env);
  assert.equal(latest.code, 0, latest.output);
  assert.equal(
    latest.output,
    `sha=${"c".repeat(40)}\ncreated=2026-11-12T00:00:00Z`,
  );
  // --token-file: an env file, as a CodePress Terminal token file is written.
  const tokenFile = join(fresh("token"), "codepress.env");
  writeFileSync(tokenFile, "# kit reads\nCODEPRESS_API_KEY=cpk_good\n");
  const viaFile = await cli(
    ["latest", "--config", config, "--token-file", tokenFile],
    { GITHUB_REPOSITORY: "acme/shop" },
  );
  assert.equal(viaFile.code, 0, viaFile.output);
  const empty = await cli(
    ["latest", "--config", config, "--branch", "empty"],
    env,
  );
  assert.equal(empty.code, 1);
  assert.match(empty.output, /no_kit/);
});

test("codepress: fetch without CODEPRESS_API_KEY or --token-file exits 1 naming both", async () => {
  const result = await cli(["fetch", "--config", codepressConfig()], {
    GITHUB_REPOSITORY: "acme/shop",
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /CODEPRESS_API_KEY/);
  assert.match(result.output, /--token-file/);
});

test("codepress: a forbidden answer exits 1 and shows forbidden", async () => {
  const result = await cli(["fetch", "--config", codepressConfig()], {
    CODEPRESS_API_KEY: "cpk_other",
    GITHUB_REPOSITORY: "acme/shop",
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /^design-kit: forbidden: /);
});

test("codepress: a backend that cannot be reached is kit_storage_unavailable", async () => {
  // Accepts the connection and drops it: no answer ever comes.
  const dead = http.createServer();
  dead.on("connection", (socket) => socket.destroy());
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  try {
    const config = configWith({
      type: "codepress",
      apiUrl: `http://127.0.0.1:${dead.address().port}/v1`,
    });
    const result = await cli(["latest", "--config", config], {
      CODEPRESS_API_KEY: "cpk_good",
      GITHUB_REPOSITORY: "acme/shop",
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /^design-kit: kit_storage_unavailable: /);
  } finally {
    dead.close();
  }
});

test("codepress: upload outside GitHub Actions says it needs the Actions OIDC token", async () => {
  const result = await cli(
    ["upload", "--config", codepressConfig(), "--dir", KIT],
    { GITHUB_REF_NAME: "main" },
  );
  assert.equal(result.code, 1);
  assert.match(result.output, /ACTIONS_ID_TOKEN_REQUEST_URL is not set/);
  assert.match(result.output, /id-token: write/);
});

test("github: design-kit upload says the workflow uploads the artifact and exits 2", async () => {
  const result = await cli(
    ["upload", "--config", configWith({ type: "github" }), "--dir", KIT],
    {},
  );
  assert.equal(result.code, 2);
  assert.match(result.output, /actions\/upload-artifact/);
});

// ── s3 and r2: a stub aws on PATH ──────────────────────────────────────────

/**
 * A folder with an `aws` stub: it logs each call to `$AWS_LOG` and serves
 * `s3 cp` from a fake bucket folder (`$AWS_BUCKET_DIR/<bucket>/<key>`).
 */
function stubAws() {
  const bin = fresh("bin");
  const stub = join(bin, "aws");
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$*" >> "$AWS_LOG"
[ "$1 $2" = "s3 cp" ] || { echo "unexpected: $*" >&2; exit 2; }
from=$3; to=$4
case "$from" in
  s3://*)
    src="$AWS_BUCKET_DIR/\${from#s3://}"
    [ -f "$src" ] || { echo "fatal error: An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 1; }
    if [ "$to" = "-" ]; then cat "$src"; else cp "$src" "$to"; fi ;;
  *)
    dest="$AWS_BUCKET_DIR/\${to#s3://}"
    mkdir -p "$(dirname "$dest")" && cp "$from" "$dest" ;;
esac
`,
  );
  chmodSync(stub, 0o755);
  return bin;
}

const awsEnv = (bin) => ({
  PATH: `${bin}:/usr/bin:/bin`,
  AWS_LOG: join(fresh("log"), "aws.log"),
  AWS_BUCKET_DIR: fresh("bucket"),
  TMPDIR: fresh("tmp"),
  GITHUB_REF_NAME: "main",
  GITHUB_SHA: "d".repeat(40),
});
const calls = (env) => readFileSync(env.AWS_LOG, "utf8").trim().split("\n");

test("s3: upload writes the zip, then latest.json; fetch reads latest.json, then the zip", async () => {
  const bin = stubAws();
  const env = awsEnv(bin);
  const config = configWith({
    type: "s3",
    bucket: "kits",
    prefix: "design-kits/",
    region: "eu-west-1",
  });
  const upload = await cli(["upload", "--config", config, "--dir", KIT], env);
  assert.equal(upload.code, 0, upload.output);
  const sha = "d".repeat(40);
  const writes = calls(env).map((line) => line.split(" ")[3]);
  assert.deepEqual(writes, [
    `s3://kits/design-kits/main/${sha}.zip`,
    "s3://kits/design-kits/main/latest.json",
  ]);
  for (const line of calls(env)) assert.match(line, / --region eu-west-1$/);
  const pointer = JSON.parse(
    readFileSync(
      join(env.AWS_BUCKET_DIR, "kits/design-kits/main/latest.json"),
      "utf8",
    ),
  );
  assert.equal(pointer.sha, sha);
  assert.equal(pointer.key, `design-kits/main/${sha}.zip`);

  writeFileSync(env.AWS_LOG, "");
  const fetched = await cli(
    ["fetch", "--config", config, "--branch", "main"],
    env,
  );
  assert.equal(fetched.code, 0, fetched.output);
  assert.deepEqual(
    calls(env).map((line) => line.split(" ")[2]),
    [
      "s3://kits/design-kits/main/latest.json",
      `s3://kits/design-kits/main/${sha}.zip`,
    ],
  );
  const path = fetched.output.match(/^path=(.*)$/m)[1];
  assert.deepEqual(files(path), files(KIT));

  const latest = await cli(
    ["latest", "--config", config, "--branch", "nothing-here"],
    env,
  );
  assert.equal(latest.code, 1);
  assert.match(latest.output, /no_kit/);
});

test("r2: every aws call carries the account's endpoint and region auto", async () => {
  const env = awsEnv(stubAws());
  const config = configWith({
    type: "r2",
    accountId: "abc123",
    bucket: "kits",
  });
  assert.equal(
    (await cli(["upload", "--config", config, "--dir", KIT], env)).code,
    0,
  );
  assert.equal(
    (await cli(["latest", "--config", config, "--branch", "main"], env)).code,
    0,
  );
  const lines = calls(env);
  assert.equal(lines.length, 3);
  for (const line of lines)
    assert.match(
      line,
      / --endpoint-url https:\/\/abc123\.r2\.cloudflarestorage\.com --region auto$/,
    );
  assert.match(lines[0], /^s3 cp \S+ s3:\/\/kits\/main\/d{40}\.zip /);
});

test("s3: no aws on PATH is a clear error", async () => {
  const env = { ...awsEnv(fresh("empty-bin")), PATH: fresh("empty-bin") };
  const config = configWith({ type: "s3", bucket: "kits" });
  const result = await cli(
    ["latest", "--config", config, "--branch", "main"],
    env,
  );
  assert.equal(result.code, 1);
  assert.match(result.output, /aws_cli_missing: .*no aws on PATH/);
});

const PAGES = {
  baseUrl: "http://localhost:3000",
  pages: [{ name: "a", path: "/", ready: "main", slots: { main: ["main"] } }],
};

test("storage config: r2 needs accountId, and each type takes only its own keys", () => {
  const check = (storage) => () =>
    resolveConfig(
      { version: 1, storage, pages: PAGES },
      "/x/design-kit.config.json",
    );
  assert.throws(
    check({ type: "r2", bucket: "kits" }),
    /storage\.accountId: is required for r2 storage/,
  );
  assert.throws(
    check({ type: "r2", accountId: "a", bucket: "k", endpoint: "https://x" }),
    /storage\.endpoint: not used by r2 storage/,
  );
  assert.throws(check({ type: "s3" }), /storage\.bucket: is required/);
  assert.throws(check({ type: "gcs" }), /storage\.type: must be/);
  assert.throws(
    check({ type: "s3", bucket: "TODO: your S3 bucket's name" }),
    /storage\.bucket: still TODO/,
  );
  assert.equal(check({ type: "codepress" })().storage.type, "codepress");
  assert.deepEqual(
    resolveConfig({ version: 1, pages: PAGES }, "/x/design-kit.config.json")
      .storage,
    { type: "github" },
  );
});

// ── ci-check through codepress latest ───────────────────────────────────────

test("ci-check reads the newest kit through codepress latest, and builds when the lookup is refused", async () => {
  const repo = fresh("repo");
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.css"), "a{}");
  cpSync(codepressConfig(), join(repo, "design-kit.config.json"));
  const config = JSON.parse(readFileSync(join(repo, "design-kit.config.json")));
  config.watch = ["src"];
  writeFileSync(join(repo, "design-kit.config.json"), JSON.stringify(config));
  git("add", ".");
  git(
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "one",
  );
  const head = git("rev-parse", "HEAD");
  // A kit made just now, so it is never old enough to need a refresh.
  backend.latest = {
    commit_sha: head,
    branch: "main",
    created_at: new Date().toISOString(),
    size_bytes: 1,
    manifest: {},
    download_url: `${backend.base}/r2/u-1?download`,
  };
  const output = join(fresh("out"), "github-output");
  writeFileSync(output, "");
  const base = {
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_REF_NAME: "main",
    GITHUB_OUTPUT: output,
  };
  const args = ["ci-check", "--config", join(repo, "design-kit.config.json")];
  const unchanged = await cli(args, { ...base, CODEPRESS_API_KEY: "cpk_good" });
  assert.equal(unchanged.code, 0, unchanged.output);
  const refused = await cli(args, { ...base, CODEPRESS_API_KEY: "cpk_other" });
  assert.equal(refused.code, 0, refused.output);
  const lines = readFileSync(output, "utf8").trim().split("\n");
  assert.equal(lines[0], "build=false");
  assert.equal(lines[2], `kit-sha=${head}`);
  assert.equal(lines[3], "build=true");
  assert.match(
    lines[4],
    /^reason=could not look up the newest kit \(forbidden: /,
  );
});

test("ci-check without CODEPRESS_API_KEY reads with the job's OIDC token, and builds when the backend refuses it", async () => {
  const repo = fresh("repo");
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(
    join(repo, "design-kit.config.json"),
    JSON.stringify({
      ...JSON.parse(readFileSync(codepressConfig(), "utf8")),
      watch: ["design-kit.config.json"],
    }),
  );
  git("add", ".");
  git(
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "one",
  );
  const head = git("rev-parse", "HEAD");
  backend.latest = {
    commit_sha: head,
    branch: "main",
    created_at: new Date().toISOString(),
    size_bytes: 1,
    manifest: {},
    download_url: `${backend.base}/r2/u-1?download`,
  };
  const output = join(fresh("out"), "github-output");
  writeFileSync(output, "");
  const env = { ...actionsEnv(), GITHUB_OUTPUT: output };
  const args = ["ci-check", "--config", join(repo, "design-kit.config.json")];
  backend.readAuth = [];
  backend.oidcAudiences = [];
  try {
    // Before #22530: the OIDC read is refused, so the run builds.
    assert.equal((await cli(args, env)).code, 0);
    // After it: the same read succeeds and nothing changed, so it skips.
    backend.acceptOidcReads = true;
    assert.equal((await cli(args, env)).code, 0);
  } finally {
    backend.acceptOidcReads = false;
  }
  assert.deepEqual(backend.readAuth, ["Bearer oidc-jwt", "Bearer oidc-jwt"]);
  assert.deepEqual(backend.oidcAudiences, [
    "https://codepress.dev",
    "https://codepress.dev",
  ]);
  const lines = readFileSync(output, "utf8").trim().split("\n");
  assert.equal(lines[0], "build=true");
  assert.match(
    lines[1],
    /^reason=could not look up the newest kit \(unauthorized: /,
  );
  assert.equal(lines[3], "build=false");
  assert.equal(lines[5], `kit-sha=${head}`);

  // An API key, when set, is sent instead of minting a token.
  backend.readAuth = [];
  await cli(args, { ...env, CODEPRESS_API_KEY: "cpk_good" });
  assert.deepEqual(backend.readAuth, ["Bearer cpk_good"]);
});

test("a commit id that is not hex, from CodePress or a bucket's latest.json, is refused before it reaches a path", async () => {
  const saved = backend.latest;
  const tmp = fresh("tmp");
  backend.latest = {
    commit_sha: "../../escape",
    branch: "main",
    created_at: new Date().toISOString(),
    size_bytes: 1,
    manifest: {},
    download_url: `${backend.base}/r2/u-1?download`,
  };
  const downloads = backend.downloads;
  try {
    const result = await cli(["fetch", "--config", codepressConfig()], {
      CODEPRESS_API_KEY: "cpk_good",
      GITHUB_REPOSITORY: "acme/shop",
      TMPDIR: tmp,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.output,
      /^design-kit: invalid_kit_sha: CodePress names/,
    );
  } finally {
    backend.latest = saved;
  }
  assert.equal(backend.downloads, downloads, "nothing was downloaded");

  const env = awsEnv(stubAws());
  const pointer = join(env.AWS_BUCKET_DIR, "kits/main/latest.json");
  mkdirSync(join(env.AWS_BUCKET_DIR, "kits/main"), { recursive: true });
  writeFileSync(
    pointer,
    JSON.stringify({ sha: "a/../../b", key: "main/x.zip" }),
  );
  const bucket = await cli(
    [
      "fetch",
      "--config",
      configWith({ type: "s3", bucket: "kits" }),
      "--branch",
      "main",
    ],
    env,
  );
  assert.equal(bucket.code, 1);
  assert.match(bucket.output, /invalid_kit_sha: main\/latest\.json names/);
  // Only latest.json was read: the zip was never asked for.
  assert.equal(calls(env).length, 1);
  assert.deepEqual(readdirSync(tmp), []);
});
