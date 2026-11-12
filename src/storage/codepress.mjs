/**
 * `codepress` storage: CodePress keeps the newest kit of each branch.
 *
 * - Upload (GitHub Actions only): the workflow's OIDC token, requested with
 *   the CodePress address as its audience, signs in; the repository holds
 *   no secret. `POST /v1/design-kits/uploads` with the zip's size and a
 *   summary of the kit answers a presigned PUT, the zip goes straight to
 *   storage with exactly the headers it names (its `Content-Length` must be
 *   the declared size), and `POST /v1/design-kits/uploads/{id}/complete`
 *   makes it the branch's kit.
 * - Reads: `GET /v1/design-kits/repos/{owner}/{repo}/latest?branch=` with a
 *   CodePress API key (CODEPRESS_API_KEY, or a file named by --token-file),
 *   which answers the kit's commit and a short-lived download URL.
 *
 * A refusal keeps the backend's name for it (`forbidden`, `no_kit`,
 * `repo_not_connected`, …); a store that cannot be reached is
 * `kit_storage_unavailable`.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";

import { ConfigError } from "../config.mjs";
import {
  StorageError,
  checkSha,
  installKit,
  isKit,
  kitCacheDir,
} from "./common.mjs";
import { zipDirectory } from "./zip.mjs";

export const DEFAULT_URL = "https://codepress.dev";
export const DEFAULT_API_URL = "https://api.codepress.dev/v1";
const UNAVAILABLE = "kit_storage_unavailable";
/** How long one request may take before the store counts as unreachable. */
const REQUEST_TIMEOUT_MS = Number(
  process.env.DESIGN_KIT_REQUEST_TIMEOUT_MS || 120_000,
);
const MANIFEST_BYTES = 4096;

/**
 * The API base for a storage config: `apiUrl` when set; the CodePress API
 * for the default address; else `<url>/v1`.
 */
export function apiBase(storage = {}) {
  if (storage.apiUrl) return storage.apiUrl.replace(/\/+$/, "");
  const url = (storage.url ?? DEFAULT_URL).replace(/\/+$/, "");
  return url === DEFAULT_URL ? DEFAULT_API_URL : `${url}/v1`;
}

/**
 * One HTTP request: `{status, headers, body}` (body a Buffer). Headers are
 * sent exactly as given, so a presigned PUT carries its signed
 * Content-Length. A failure to connect, or no answer within the timeout, is
 * `kit_storage_unavailable`.
 */
export function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new StorageError(UNAVAILABLE, `not a URL: ${url}`));
      return;
    }
    const client = parsed.protocol === "http:" ? http : https;
    const req = client.request(
      parsed,
      { method, headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", (error) =>
          reject(new StorageError(UNAVAILABLE, error.message)),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`no answer from ${parsed.host} in time`)),
    );
    req.on("error", (error) =>
      reject(
        new StorageError(
          UNAVAILABLE,
          `could not reach ${parsed.host} (${error.code ?? error.message})`,
        ),
      ),
    );
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** The backend's named error for a non-2xx answer. */
function refusal(response, what) {
  let payload = null;
  try {
    payload = JSON.parse(response.body.toString("utf8"));
  } catch {
    // Not JSON: a proxy or gateway answered.
  }
  const reason = payload?.reason ?? payload?.code;
  if (typeof reason === "string" && reason)
    return new StorageError(
      reason,
      `${what} was refused (${response.status}): ${payload.detail ?? reason}`,
    );
  if (response.status >= 500 || response.status === 0)
    return new StorageError(
      UNAVAILABLE,
      `${what} failed: CodePress answered ${response.status}`,
    );
  const named = { 401: "unauthorized", 403: "forbidden", 404: "not_found" };
  const detail =
    typeof payload?.detail === "string" ? `: ${payload.detail}` : "";
  return new StorageError(
    named[response.status] ?? `http_${response.status}`,
    `${what} was refused (${response.status})${detail}`,
  );
}

async function json(url, options, what) {
  const response = await request(url, options);
  if (response.status < 200 || response.status >= 300)
    throw refusal(response, what);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new StorageError(UNAVAILABLE, `${what}: the answer is not JSON`);
  }
}

/**
 * The read credential: CODEPRESS_API_KEY, or the token in `tokenFile`. The
 * file may hold the token alone, or `KEY=value` lines (an env file, as
 * CodePress Terminal's `create_backend_access_token_file` writes): then
 * CODEPRESS_API_KEY's line, or the only line.
 */
export function readToken({ tokenFile, env = process.env } = {}) {
  if (tokenFile) {
    let text;
    try {
      text = readFileSync(tokenFile, "utf8");
    } catch (error) {
      throw new ConfigError(
        `--token-file ${tokenFile}: could not read it (${error.code ?? error.message})`,
      );
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const assignments = lines
      .map((line) =>
        line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/),
      )
      .filter(Boolean);
    const unquote = (value) => value.replace(/^(['"])(.*)\1$/, "$2");
    if (assignments.length) {
      const named = assignments.find(([, key]) => key === "CODEPRESS_API_KEY");
      const chosen =
        named ?? (assignments.length === 1 ? assignments[0] : undefined);
      if (!chosen)
        throw new ConfigError(
          `--token-file ${tokenFile}: it has several KEY=value lines and none is CODEPRESS_API_KEY`,
        );
      return unquote(chosen[2].trim());
    }
    if (lines.length === 1) return lines[0];
    throw new ConfigError(`--token-file ${tokenFile}: it holds no token`);
  }
  if (env.CODEPRESS_API_KEY) return env.CODEPRESS_API_KEY.trim();
  throw new StorageError(
    "no_credentials",
    "codepress storage needs a CodePress API key to read kits. Set CODEPRESS_API_KEY, or pass --token-file <path> (a file holding the key alone, or a KEY=value env file with a CODEPRESS_API_KEY line)",
  );
}

/**
 * The credential a read sends: an API key (CODEPRESS_API_KEY or
 * --token-file) when there is one; otherwise, inside a GitHub Actions job
 * with `id-token: write`, the repository's own OIDC token for `audience`
 * (the backend reads it as that repository, #22530). Neither is
 * `no_credentials`.
 */
export async function readCredential({
  tokenFile,
  env = process.env,
  audience,
}) {
  if (
    !tokenFile &&
    !env.CODEPRESS_API_KEY &&
    env.ACTIONS_ID_TOKEN_REQUEST_URL &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    return oidcToken(audience, env);
  return readToken({ tokenFile, env });
}

/**
 * The workflow's GitHub OIDC token for `audience`. Needs
 * ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN, which
 * GitHub sets only in a job with `permissions: id-token: write`.
 */
export async function oidcToken(audience, env = process.env) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token)
    throw new StorageError(
      "oidc_unavailable",
      "design-kit upload with codepress storage signs in with the GitHub Actions OIDC token, and ACTIONS_ID_TOKEN_REQUEST_URL is not set. Run it in a GitHub Actions job with `permissions: id-token: write` (the workflow design-kit init writes does).",
    );
  const separator = url.includes("?") ? "&" : "?";
  const body = await json(
    `${url}${separator}audience=${encodeURIComponent(audience)}`,
    {
      headers: { Authorization: `bearer ${token}`, Accept: "application/json" },
    },
    "Requesting the GitHub OIDC token",
  );
  if (!body?.value)
    throw new StorageError("oidc_unavailable", "GitHub answered no OIDC token");
  return body.value;
}

/** The kit summary sent with an upload: at most 4 KB. */
export function kitSummary(dir) {
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    throw new ConfigError(
      `${dir} is not a kit: no readable manifest.json (${error.code ?? error.message})`,
    );
  }
  const summary = {};
  for (const key of ["kit_version", "sha", "built_at", "counts"])
    if (manifest[key] !== undefined) summary[key] = manifest[key];
  if (Buffer.byteLength(JSON.stringify(summary)) > MANIFEST_BYTES)
    delete summary.counts;
  return summary;
}

/**
 * The `codepress` store. `storage` is the config's `storage` object; `repo`
 * is `owner/name` (reads only).
 */
export function codepressStorage(
  storage = {},
  { repo, env = process.env, tokenFile } = {},
) {
  const audience = (storage.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const api = apiBase(storage);
  const readLatest = async (branch) => {
    if (!repo)
      throw new ConfigError(
        "--repo <owner/name> is needed: no GITHUB_REPOSITORY and no github.com origin remote",
      );
    const token = await readCredential({ tokenFile, env, audience });
    const [owner, name] = repo.split("/");
    const query = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    const response = await request(
      `${api}/design-kits/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/latest${query}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      const error = refusal(response, `Reading the newest kit of ${repo}`);
      if (error.code === "no_kit") return null;
      throw error;
    }
    try {
      return JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new StorageError(UNAVAILABLE, "the latest kit answer is not JSON");
    }
  };
  return {
    type: "codepress",
    async latest({ branch } = {}) {
      const kit = await readLatest(branch);
      if (!kit) return null;
      return {
        sha: kit.commit_sha,
        createdAt: kit.created_at,
        branch: kit.branch,
        sizeBytes: kit.size_bytes,
      };
    },
    async fetch({ branch, out } = {}) {
      const kit = await readLatest(branch);
      if (!kit)
        throw new StorageError(
          "no_kit",
          `CodePress has no kit for ${repo}${branch ? ` on ${branch}` : " on its default branch"}`,
        );
      checkSha(kit.commit_sha, "CodePress");
      const path = resolve(out ?? kitCacheDir(kit.commit_sha, env));
      const result = { path, sha: kit.commit_sha, branch: kit.branch };
      if (isKit(path)) return { ...result, cached: true };
      const response = await request(kit.download_url);
      if (response.status < 200 || response.status >= 300)
        throw refusal(response, "Downloading the kit");
      installKit(response.body, path);
      return { ...result, cached: false };
    },
    async upload({ dir } = {}) {
      const manifest = kitSummary(dir);
      const token = await oidcToken(audience, env);
      const zip = zipDirectory(dir);
      const auth = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      const started = await json(
        `${api}/design-kits/uploads`,
        {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ size_bytes: zip.length, manifest }),
        },
        "Starting the upload",
      );
      const target = started.upload ?? {};
      const put = await request(target.url, {
        method: target.method ?? "PUT",
        headers: { ...target.headers },
        body: zip,
      });
      if (put.status < 200 || put.status >= 300)
        throw new StorageError(
          "upload_failed",
          `storage refused the zip (${put.status}): ${put.body.toString("utf8").slice(0, 300)}`,
        );
      const done = await json(
        `${api}/design-kits/uploads/${encodeURIComponent(started.upload_id)}/complete`,
        { method: "POST", headers: auth, body: "{}" },
        "Completing the upload",
      );
      return {
        sha: done.commit_sha ?? started.commit_sha,
        branch: done.branch ?? started.branch,
        sizeBytes: zip.length,
        uploadId: started.upload_id,
      };
    },
  };
}
