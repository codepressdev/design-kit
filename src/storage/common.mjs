/**
 * What every kit store shares: the error a store raises, where a fetched kit
 * is cached, and how the repository and its default branch are found.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { unzipTo } from "./zip.mjs";

/**
 * A store refused or could not be reached. `code` is the store's own name
 * for it (the backend's `reason`, such as `forbidden` or `no_kit`), or
 * `kit_storage_unavailable` when the store could not be reached at all.
 * Exits 1.
 */
export class StorageError extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code);
    this.code = code;
  }
}

/** The first line of what a failed command said. */
export function errorText(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : "";
  return (stderr || error?.message || String(error)).split("\n")[0];
}

/**
 * `sha` when it is a commit id (7 to 64 hex digits), else a StorageError. A
 * store's answer names the commit, and it becomes a folder and file name,
 * so nothing else (a `/`, a `..`) may reach a path.
 */
export function checkSha(sha, from) {
  if (typeof sha === "string" && /^[0-9a-f]{7,64}$/i.test(sha)) return sha;
  throw new StorageError(
    "invalid_kit_sha",
    `${from} names the kit's commit as ${JSON.stringify(sha)}, which is not a commit id`,
  );
}

/** Where a fetched kit is kept: `$TMPDIR/design-kit-<sha>`. */
export function kitCacheDir(sha, env = process.env) {
  return join(
    env.TMPDIR || tmpdir(),
    `design-kit-${checkSha(sha, "the store")}`,
  );
}

/**
 * Unzips `zip` into `out` through a sibling scratch folder and a rename,
 * so `out` never holds half a kit.
 */
export function installKit(zip, out) {
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  const scratch = mkdtempSync(`${target}.partial-`);
  try {
    unzipTo(zip, scratch);
    if (!existsSync(join(scratch, "manifest.json")))
      throw new Error("the stored kit has no manifest.json");
    rmSync(target, { recursive: true, force: true });
    renameSync(scratch, target);
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  return target;
}

/** A cached kit is a folder with its manifest.json. */
export function isKit(dir) {
  return existsSync(join(dir, "manifest.json"));
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** `owner/name` from a github.com remote URL, or null. */
export function repoFromRemote(url) {
  const match = String(url).match(
    /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The repository as `owner/name`: `--repo`, then GITHUB_REPOSITORY, then
 * the `origin` remote of the checkout holding `cwd`. Null when none says.
 */
export function findRepo({ repo, env = process.env, cwd = process.cwd() }) {
  if (repo) return repo;
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  try {
    return repoFromRemote(git(cwd, ["remote", "get-url", "origin"]));
  } catch {
    return null;
  }
}

/** The default branch `origin/HEAD` names in the checkout, or null. */
export function originDefaultBranch(cwd = process.cwd()) {
  try {
    return (
      git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(
        /^origin\//,
        "",
      ) || null
    );
  } catch {
    return null;
  }
}
