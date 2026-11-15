/**
 * `design-kit fetch --url <download_url> --sha <commit>`: installs a kit
 * from a download URL someone else already looked up (the `download_url` of
 * `GET /design-kits/repos/{owner}/{repo}/latest`, read through the Platform
 * MCP), with no credential and no config.
 *
 * The kit lands where the key path puts it, `$TMPDIR/design-kit-<sha>`, and a
 * complete folder there is reused without downloading. Otherwise the zip is
 * streamed to a scratch folder beside the target, unzipped there with the
 * package's own reader, checked (its manifest.json must name `sha`), and
 * renamed into place in one step. A fetch that loses a race to another for
 * the same commit keeps the winner's folder. A failure leaves nothing behind.
 */
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { StorageError, checkSha, isKit, kitCacheDir } from "./common.mjs";
import { unzipTo } from "./zip.mjs";

/** How long the download may stall before it counts as failed. */
const DOWNLOAD_TIMEOUT_MS = Number(
  process.env.DESIGN_KIT_REQUEST_TIMEOUT_MS || 120_000,
);

/** What an S3- or R2-style refusal is called, by status. */
const REFUSED = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  410: "expired",
};

/** The query string of a URL replaced by `?…`, so a signature never prints. */
export function redactUrl(url) {
  return String(url).replace(/\?.*$/s, "?…");
}

/** Streams `url` into `file`. A non-2xx answer or a broken stream throws. */
function download(url, file) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new StorageError("invalid_url", "--url is not a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new StorageError(
      "invalid_url",
      "--url must be an https: download URL",
    );
  const client = parsed.protocol === "http:" ? http : https;
  return new Promise((resolvePromise, reject) => {
    const req = client.get(parsed, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        const code =
          REFUSED[status] ??
          (status >= 500 ? "kit_storage_unavailable" : `http_${status}`);
        const hint =
          status === 403 || status === 400 || status === 410
            ? "; the download URL may have expired, so ask for a fresh one"
            : "";
        reject(
          new StorageError(
            code,
            `downloading ${redactUrl(url)} was refused (${status})${hint}`,
          ),
        );
        return;
      }
      pipeline(res, createWriteStream(file)).then(resolvePromise, (error) =>
        reject(
          new StorageError(
            "download_failed",
            `downloading ${redactUrl(url)} broke off (${error.code ?? error.message})`,
          ),
        ),
      );
    });
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", (error) =>
      reject(
        new StorageError(
          "kit_storage_unavailable",
          `could not reach ${parsed.host} (${error.code ?? error.message})`,
        ),
      ),
    );
  });
}

/** Nothing when manifest.json's `sha` starts with `sha`, else a StorageError. */
function checkManifestSha(dir, sha) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    throw new StorageError(
      "not_a_kit",
      "the download has no readable manifest.json",
    );
  }
  const named =
    typeof manifest?.sha === "string" ? manifest.sha.toLowerCase() : "";
  const wanted = sha.toLowerCase();
  // A short --sha may name the manifest's full sha, never the other way round.
  if (!named || !named.startsWith(wanted))
    throw new StorageError(
      "sha_mismatch",
      `the downloaded kit is of ${named.slice(0, 12) || "no commit"}, not ${wanted.slice(0, 12)}`,
    );
}

/**
 * Installs the kit of commit `sha` from `url` into `out` (default
 * `$TMPDIR/design-kit-<sha>`): `{path, sha, branch, cached}`.
 */
export async function fetchFromUrl({
  url,
  sha,
  branch,
  out,
  env = process.env,
}) {
  if (!url)
    throw new StorageError("invalid_url", "--url needs the kit's download URL");
  checkSha(sha, "--sha");
  const path = resolve(out ?? kitCacheDir(sha, env));
  const result = { path, sha, branch };
  if (isKit(path)) return { ...result, cached: true };
  mkdirSync(dirname(path), { recursive: true });
  const scratch = mkdtempSync(`${path}.partial-`);
  try {
    const zipFile = join(scratch, "kit.zip");
    const unpacked = join(scratch, "kit");
    await download(url, zipFile);
    try {
      unzipTo(readFileSync(zipFile), unpacked);
    } catch (error) {
      throw new StorageError(
        "bad_archive",
        `the download is not a whole kit zip (${error.message})`,
      );
    }
    checkManifestSha(unpacked, sha);
    try {
      renameSync(unpacked, path);
    } catch (error) {
      // Another fetch of the same commit got there first: keep its folder.
      if (isKit(path)) return { ...result, cached: true };
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST")
        throw new StorageError(
          "out_not_empty",
          `${path} exists and is not a kit; choose another --out`,
        );
      throw error;
    }
    return { ...result, cached: false };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
