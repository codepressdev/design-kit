/**
 * `github` storage (the default): each kit is a `design-kit` GitHub Actions
 * artifact, uploaded by the workflow's `actions/upload-artifact` step and
 * read through the `gh` CLI. Artifacts last at most 90 days on a public
 * repository (400 on a private one), so the workflow rebuilds before then.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { ConfigError } from "../config.mjs";
import {
  StorageError,
  checkSha,
  errorText,
  isKit,
  kitCacheDir,
} from "./common.mjs";

export const ARTIFACT = "design-kit";
const PAGES = 5;

/** Runs `gh` and returns its stdout. */
export function runGh(args, { env = process.env } = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Every `design-kit` artifact of the repository, newest first. */
function listKits({ repo, gh }) {
  const artifacts = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const body = JSON.parse(
      gh([
        "api",
        `repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=100&page=${page}`,
      ]),
    );
    const batch = body?.artifacts ?? [];
    artifacts.push(...batch);
    if (batch.length < 100) break;
  }
  return artifacts
    .filter((artifact) => artifact.name === ARTIFACT)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * The newest unexpired kit on `branch`: `{id, sha, createdAt, runId}`, or
 * null when there is none. Throws when the store cannot be read.
 */
export function findNewestKit({ repo, branch, gh = runGh }) {
  const kit = listKits({ repo, gh }).find(
    (artifact) =>
      !artifact.expired && artifact.workflow_run?.head_branch === branch,
  );
  if (!kit?.workflow_run?.head_sha) return null;
  return {
    id: String(kit.id),
    sha: kit.workflow_run.head_sha,
    createdAt: kit.created_at,
    runId: kit.workflow_run.id ? String(kit.workflow_run.id) : null,
  };
}

/**
 * Deletes the kits on `branch` older than the one `keep` names (an artifact
 * id). Returns `{deleted: [ids], failed: [{id, error}], keptFound}`; never
 * throws for a single failed delete. When the kept kit is not in the listing
 * (not listed yet, or on another branch), nothing is deleted: "older" has
 * nothing to be measured against.
 */
export function deleteOlderKits({ repo, branch, keep, gh = runGh }) {
  const kits = listKits({ repo, gh }).filter(
    (artifact) => artifact.workflow_run?.head_branch === branch,
  );
  const kept = kits.find((artifact) => String(artifact.id) === String(keep));
  const deleted = [];
  const failed = [];
  if (!kept) return { deleted, failed, keptFound: false };
  for (const artifact of kits) {
    if (String(artifact.id) === String(keep)) continue;
    // Only kits uploaded before the one just kept: a newer one, or one
    // uploaded in the same instant, is never removed.
    if (!(Date.parse(artifact.created_at) < Date.parse(kept.created_at)))
      continue;
    try {
      gh([
        "api",
        "--method",
        "DELETE",
        `repos/${repo}/actions/artifacts/${artifact.id}`,
      ]);
      deleted.push(String(artifact.id));
    } catch (error) {
      failed.push({ id: String(artifact.id), error: errorText(error) });
    }
  }
  return { deleted, failed, keptFound: Boolean(kept) };
}

/**
 * The `github` store. `repo` is `owner/name`; `gh` runs the GitHub CLI
 * (tests pass their own).
 */
export function githubStorage({ repo, env = process.env, gh } = {}) {
  const run = gh ?? ((args) => runGh(args, { env }));
  const needRepo = () => {
    if (!repo)
      throw new ConfigError(
        "--repo <owner/name> is needed: no GITHUB_REPOSITORY and no github.com origin remote",
      );
    return repo;
  };
  const defaultBranch = () =>
    JSON.parse(run(["api", `repos/${needRepo()}`])).default_branch;
  return {
    type: "github",
    latest({ branch }) {
      return findNewestKit({
        repo: needRepo(),
        branch: branch ?? defaultBranch(),
        gh: run,
      });
    },
    upload() {
      throw new ConfigError(
        'github storage uploads the kit with the workflow\'s actions/upload-artifact step, so there is nothing for design-kit upload to do. Set "storage" in the config to codepress, s3 or r2 to upload with this command.',
      );
    },
    fetch({ branch, out }) {
      const name = branch ?? defaultBranch();
      const kit = findNewestKit({ repo: needRepo(), branch: name, gh: run });
      if (!kit?.runId)
        throw new StorageError(
          "no_kit",
          `no unexpired design-kit artifact on ${name} in ${repo}`,
        );
      checkSha(kit.sha, "The artifact's workflow run");
      const path = resolve(out ?? kitCacheDir(kit.sha, env));
      if (isKit(path))
        return { path, sha: kit.sha, branch: name, cached: true };
      mkdirSync(dirname(path), { recursive: true });
      const scratch = mkdtempSync(`${path}.partial-`);
      try {
        run([
          "run",
          "download",
          kit.runId,
          "--repo",
          repo,
          "-n",
          ARTIFACT,
          "-D",
          scratch,
        ]);
        if (!isKit(scratch))
          throw new StorageError(
            "no_kit",
            `the artifact of run ${kit.runId} has no manifest.json`,
          );
        rmSync(path, { recursive: true, force: true });
        renameSync(scratch, path);
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true });
        throw error;
      }
      return { path, sha: kit.sha, branch: name, cached: false };
    },
  };
}
