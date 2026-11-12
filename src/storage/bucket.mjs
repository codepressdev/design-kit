/**
 * `s3` and `r2` storage: your own AWS S3 or Cloudflare R2 bucket, through
 * the `aws` CLI (`aws s3 cp`). Credentials come from the environment the
 * CLI reads (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).
 *
 * Layout, under the optional prefix:
 *
 *     <prefix>/<branch>/<sha>.zip     each kit
 *     <prefix>/<branch>/latest.json   {sha, created_at, size_bytes, key, manifest}
 *
 * An upload writes the zip, then latest.json, so latest.json never names a
 * zip that is not there yet. `r2` is `s3` with the endpoint
 * `https://<accountId>.r2.cloudflarestorage.com` and the region `auto`.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigError } from "../config.mjs";
import {
  StorageError,
  checkSha,
  installKit,
  isKit,
  kitCacheDir,
} from "./common.mjs";
import { kitSummary } from "./codepress.mjs";
import { zipDirectory } from "./zip.mjs";

/** The endpoint of a Cloudflare R2 account. */
export function r2Endpoint(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** Runs `aws` with `args`; resolves its stdout, rejects with its stderr. */
export function runAws(args, { env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "aws",
      args,
      { env, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr?.toString("utf8") ?? "";
          reject(error);
        } else resolvePromise(stdout);
      },
    );
  });
}

const NOT_FOUND = /\(404\)|NoSuchKey|Not Found|does not exist/i;

/**
 * The `s3` or `r2` store. `storage` is the config's `storage` object;
 * `aws` runs the CLI (tests pass their own, or put a stub on PATH).
 */
export function bucketStorage(
  storage,
  { env = process.env, aws = runAws, now = () => new Date() } = {},
) {
  const r2 = storage.type === "r2";
  const endpoint = r2 ? r2Endpoint(storage.accountId) : storage.endpoint;
  const region = r2 ? "auto" : storage.region;
  const common = [
    ...(endpoint ? ["--endpoint-url", endpoint] : []),
    ...(region ? ["--region", region] : []),
  ];
  const prefix = String(storage.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const key = (branch, name) =>
    [prefix, branch, name].filter(Boolean).join("/");
  const url = (path) => `s3://${storage.bucket}/${path}`;
  const label = r2 ? "R2" : "S3";

  const call = async (args) => {
    try {
      return await aws([...args, ...common], { env });
    } catch (error) {
      if (error?.code === "ENOENT")
        throw new StorageError(
          "aws_cli_missing",
          `${storage.type} storage uses the aws CLI, and there is no aws on PATH. Install it (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html); GitHub's ubuntu runners have it already.`,
        );
      throw error;
    }
  };
  const needBranch = (branch) => {
    if (!branch)
      throw new ConfigError(
        "--branch <name> is needed: GITHUB_REF_NAME is not set and the checkout's origin/HEAD names no default branch",
      );
    return branch;
  };
  const failed = (what, error) =>
    new StorageError(
      "kit_storage_unavailable",
      `${what} in ${label} bucket ${storage.bucket} failed: ${String(
        error?.stderr || error?.message || error,
      )
        .trim()
        .split("\n")
        .pop()}`,
    );

  const readLatest = async (branch) => {
    let out;
    try {
      out = await call(["s3", "cp", url(key(branch, "latest.json")), "-"]);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (NOT_FOUND.test(String(error?.stderr ?? ""))) return null;
      throw failed(`Reading ${key(branch, "latest.json")}`, error);
    }
    try {
      const latest = JSON.parse(out.toString("utf8"));
      if (!latest?.sha) throw new Error("no sha");
      return latest;
    } catch {
      throw new StorageError(
        "kit_storage_unavailable",
        `${key(branch, "latest.json")} is not a kit pointer`,
      );
    }
  };

  return {
    type: storage.type,
    async latest({ branch } = {}) {
      const latest = await readLatest(needBranch(branch));
      return latest
        ? { sha: latest.sha, createdAt: latest.created_at, branch }
        : null;
    },
    async fetch({ branch, out } = {}) {
      const name = needBranch(branch);
      const latest = await readLatest(name);
      if (!latest)
        throw new StorageError(
          "no_kit",
          `no kit on ${name} in ${label} bucket ${storage.bucket}`,
        );
      checkSha(latest.sha, `${key(name, "latest.json")}`);
      const path = resolve(out ?? kitCacheDir(latest.sha, env));
      const result = { path, sha: latest.sha, branch: name };
      if (isKit(path)) return { ...result, cached: true };
      const scratch = mkdtempSync(
        join(env.TMPDIR || tmpdir(), "design-kit-zip-"),
      );
      try {
        const zipFile = join(scratch, "kit.zip");
        try {
          await call([
            "s3",
            "cp",
            url(latest.key ?? key(name, `${latest.sha}.zip`)),
            zipFile,
          ]);
        } catch (error) {
          if (error instanceof StorageError) throw error;
          throw failed(`Downloading ${latest.sha}.zip`, error);
        }
        installKit(readFileSync(zipFile), path);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      return { ...result, cached: false };
    },
    async upload({ dir, branch, sha } = {}) {
      const name = needBranch(branch);
      const manifest = kitSummary(dir);
      const kitSha = sha ?? manifest.sha;
      if (!kitSha)
        throw new ConfigError(
          "--sha <commit> is needed: GITHUB_SHA is not set and the kit's manifest names no commit",
        );
      checkSha(kitSha, sha ? "--sha (or GITHUB_SHA)" : "the kit's manifest");
      const scratch = mkdtempSync(
        join(env.TMPDIR || tmpdir(), "design-kit-zip-"),
      );
      try {
        const zip = zipDirectory(dir);
        const zipFile = join(scratch, `${kitSha}.zip`);
        writeFileSync(zipFile, zip);
        const zipKey = key(name, `${kitSha}.zip`);
        try {
          await call([
            "s3",
            "cp",
            zipFile,
            url(zipKey),
            "--content-type",
            "application/zip",
            "--only-show-errors",
          ]);
        } catch (error) {
          if (error instanceof StorageError) throw error;
          throw failed(`Uploading ${zipKey}`, error);
        }
        const pointer = join(scratch, "latest.json");
        writeFileSync(
          pointer,
          `${JSON.stringify({
            sha: kitSha,
            branch: name,
            created_at: now().toISOString(),
            size_bytes: zip.length,
            key: zipKey,
            manifest,
          })}\n`,
        );
        try {
          await call([
            "s3",
            "cp",
            pointer,
            url(key(name, "latest.json")),
            "--content-type",
            "application/json",
            "--only-show-errors",
          ]);
        } catch (error) {
          if (error instanceof StorageError) throw error;
          throw failed(`Writing ${key(name, "latest.json")}`, error);
        }
        return {
          sha: kitSha,
          branch: name,
          sizeBytes: zip.length,
          key: zipKey,
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
