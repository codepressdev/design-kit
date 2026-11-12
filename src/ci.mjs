/**
 * The CI side of the workflow `design-kit init` writes:
 *
 * - `design-kit ci-check` decides whether a run builds the kit. It builds
 *   only when a path in the config's `watch` list has changed since the
 *   newest kit's commit (git tree and blob ids, so no file is read), when
 *   there is no kit, when the newest kit is close to expiring, or when the
 *   run asked for it (`--force`, `--package`).
 * - `design-kit ci-cleanup` deletes the older kits on the branch once a new
 *   one is uploaded. A failed delete is a warning, never a failure.
 *
 * Where kits are stored is behind two functions, `findNewestKit` and
 * `deleteOlderKits` (GitHub Actions artifacts, through `gh`), so another
 * store changes only those and the workflow's upload step.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { posix } from "node:path";

import { CONFIG_NAME, ConfigError, loadConfig } from "./config.mjs";

export const ARTIFACT = "design-kit";
/** Rebuild a kit this old even with no UI change, so it never expires. */
export const DEFAULT_MAX_AGE_DAYS = 75;
/** What `watch` means when a config has none: the whole repository. */
export const DEFAULT_WATCH = ["."];
const DAY_MS = 86_400_000;
const PAGES = 5;

// ── storage: GitHub Actions artifacts ───────────────────────────────────────

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

function errorText(error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : "";
  return (stderr || error?.message || String(error)).split("\n")[0];
}

// ── git: ids of the watched paths ───────────────────────────────────────────

function git(cwd, args, env = process.env) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * A `watch` entry as git names it: forward slashes, `.`/`..` segments and
 * repeated or trailing slashes resolved, "" for the repository root.
 */
export function normalizeWatchPath(path) {
  const normalized = posix.normalize(String(path).replace(/\\/g, "/"));
  return normalized.replace(/^\.\/?$/, "").replace(/\/+$/, "");
}

/**
 * `{path: id}` for each watched path at `rev`: the git tree id of a folder,
 * the blob id of a file, or "missing" when the path does not exist there.
 * Each path is listed on its own (`git ls-tree <rev> -- <path>`), so
 * overlapping entries such as `src` and `src/theme.css` cannot hide each
 * other. A path that is absent lists nothing; a tree git cannot read throws,
 * so the run builds instead of mistaking it for an absent path. Only trees
 * are read, so it works in a blobless (`--filter=blob:none`) clone.
 */
export function watchedIds(repoDir, rev, paths) {
  const ids = {};
  for (const path of paths) {
    const key = normalizeWatchPath(path);
    if (key === "") {
      ids[path] = git(repoDir, [
        "rev-parse",
        "--verify",
        `${rev}^{tree}`,
      ]).trim();
      continue;
    }
    const out = git(repoDir, ["ls-tree", "-z", "--full-tree", rev, "--", key]);
    let id = "missing";
    for (const entry of out.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      if (entry.slice(tab + 1) === key) id = entry.slice(0, tab).split(" ")[2];
    }
    ids[path] = id;
  }
  return ids;
}

/** True when `sha` is a commit in this clone. */
function hasCommit(repoDir, sha) {
  try {
    // No lazy fetch from a partial clone's remote: one shallow fetch below
    // brings the commit and its trees together.
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`], {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
    });
    return true;
  } catch {
    return false;
  }
}

/** Makes `sha` available: already here, or a shallow, blobless fetch. */
export function ensureCommit(repoDir, sha) {
  if (hasCommit(repoDir, sha)) return;
  git(repoDir, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "--filter=blob:none",
    "origin",
    sha,
  ]);
  if (!hasCommit(repoDir, sha)) throw new Error(`${sha} is not a commit`);
}

// ── the decision ────────────────────────────────────────────────────────────

const short = (sha) => String(sha).slice(0, 7);

/**
 * The reasons to build that need no git: `force`, an explicit package, no
 * kit, or a kit close to expiring. Null when none applies.
 */
function buildWithoutComparing({
  force,
  packageSpec,
  kit,
  lookupError,
  now,
  maxAgeDays,
}) {
  if (force) return { build: true, reason: "forced (the force input is set)" };
  if (packageSpec)
    return {
      build: true,
      reason: `an explicit package was given (${packageSpec})`,
    };
  if (!kit)
    return {
      build: true,
      reason: lookupError
        ? `could not look up the newest kit (${lookupError}), so building`
        : "no kit yet on this branch",
    };
  const ageDays = (now - Date.parse(kit.createdAt)) / DAY_MS;
  if (!(ageDays < maxAgeDays))
    return {
      build: true,
      reason: Number.isFinite(ageDays)
        ? `refresh before expiry: the newest kit (${short(kit.sha)}) is ${Math.floor(ageDays)} days old, and the limit is ${maxAgeDays}`
        : `refresh before expiry: the newest kit (${short(kit.sha)}) has no usable date`,
    };
  return null;
}

/**
 * Whether to build, and why. Pure: every input is already looked up.
 * `kit` is `{sha, createdAt}` or null; `before` and `after` are
 * `watchedIds` at the kit's commit and at HEAD, unless `fetchError` says
 * why they could not be read.
 */
export function decide({
  force = false,
  packageSpec = "",
  kit = null,
  lookupError,
  now = Date.now(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  fetchError,
  before = {},
  after = {},
}) {
  const early = buildWithoutComparing({
    force,
    packageSpec,
    kit,
    lookupError,
    now,
    maxAgeDays,
  });
  if (early) return early;
  if (fetchError)
    return {
      build: true,
      reason: `could not read the kit's commit ${short(kit.sha)} (${fetchError}), so building`,
    };
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = paths.filter((path) => before[path] !== after[path]);
  if (changed.length)
    return { build: true, reason: `changed: ${changed.join(", ")}` };
  return {
    build: false,
    reason: `watched files unchanged since ${short(kit.sha)}`,
  };
}

/**
 * Looks everything up and decides. `kit` given (`{sha, createdAt}`, or null
 * for "no kit") skips the store lookup; otherwise `findKit()` is called.
 * `head` is the commit being built (default HEAD). Returns
 * `{build, reason, kit}`.
 */
export function ciCheck({
  repoDir,
  head = "HEAD",
  watch = DEFAULT_WATCH,
  force = false,
  packageSpec = "",
  kit,
  findKit,
  now = Date.now(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
}) {
  const inputs = { force, packageSpec, now, maxAgeDays };
  let lookupError;
  if (kit === undefined && !force && !packageSpec) {
    try {
      kit = findKit();
    } catch (error) {
      kit = null;
      lookupError = errorText(error);
    }
  }
  kit ??= null;
  const early = buildWithoutComparing({ ...inputs, kit, lookupError });
  if (early) return { ...early, kit };
  let fetchError;
  let before;
  let after;
  try {
    ensureCommit(repoDir, kit.sha);
    before = watchedIds(repoDir, kit.sha, watch);
    after = watchedIds(repoDir, head, watch);
  } catch (error) {
    fetchError = errorText(error);
  }
  const missing = after
    ? Object.keys(after).filter((path) => after[path] === "missing")
    : [];
  return {
    ...decide({ ...inputs, kit, before, after, fetchError }),
    kit,
    missing,
  };
}

// ── the commands ────────────────────────────────────────────────────────────

function maxAgeFrom(value, env) {
  const raw = value ?? env.DESIGN_KIT_MAX_AGE_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_AGE_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0)
    throw new ConfigError(
      `--max-age-days (or DESIGN_KIT_MAX_AGE_DAYS) takes a number of days, got ${raw}`,
    );
  return days;
}

function repoAndBranch(options, env) {
  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  const branch = options.branch ?? env.GITHUB_REF_NAME;
  if (!repo || !branch)
    throw new ConfigError(
      "--repo <owner/name> and --branch <name> are needed outside GitHub Actions",
    );
  return { repo, branch };
}

function emit(values, env) {
  // One line per value: a newline (from a dispatch input in the reason)
  // must not add a second `build=` line to $GITHUB_OUTPUT.
  const lines = Object.entries(values).map(
    ([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, " ")}`,
  );
  for (const line of lines) console.log(line);
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function summary(text, env) {
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/**
 * `design-kit ci-check`: prints `build=true|false` and `reason=…` (and
 * writes them to $GITHUB_OUTPUT and the step summary when set).
 */
export function ciCheckCommand(options, { env = process.env, gh, now } = {}) {
  const config = loadConfig(options.config);
  const watch = config.raw.watch?.length ? config.raw.watch : DEFAULT_WATCH;
  if ((options.since === undefined) !== (options["kit-created"] === undefined))
    throw new ConfigError("--since and --kit-created go together");
  const kit =
    options.since !== undefined
      ? { sha: options.since, createdAt: options["kit-created"] }
      : options["no-kit"]
        ? null
        : undefined;
  if (kit?.createdAt && Number.isNaN(Date.parse(kit.createdAt)))
    throw new ConfigError(
      `--kit-created takes an ISO 8601 date, got ${kit.createdAt}`,
    );
  const repoDir = git(config.configDir, [
    "rev-parse",
    "--show-toplevel",
  ]).trim();
  const result = ciCheck({
    repoDir,
    watch,
    force: Boolean(options.force),
    packageSpec: options.package ?? "",
    kit,
    findKit: () =>
      findNewestKit({
        ...repoAndBranch(options, env),
        gh: gh ?? ((args) => runGh(args, { env })),
      }),
    now: now ?? Date.now(),
    maxAgeDays: maxAgeFrom(options["max-age-days"], env),
  });
  if (result.missing?.length)
    console.log(
      `::warning title=Design kit::These watch paths do not exist at this commit, so they never trigger a rebuild: ${result.missing.join(", ")}. Fix or remove them in ${CONFIG_NAME}.`,
    );
  emit(
    {
      build: String(result.build),
      reason: result.reason,
      "kit-sha": result.kit?.sha ?? "",
    },
    env,
  );
  summary(
    `Design kit: ${result.build ? "building" : "nothing to build"}, ${result.reason}.`,
    env,
  );
  return 0;
}

/**
 * `design-kit ci-cleanup --keep <artifact id>`: deletes the branch's older
 * kits. Always exits 0; each failed delete is a workflow warning.
 */
export function ciCleanupCommand(options, { env = process.env, gh } = {}) {
  if (!options.keep) throw new ConfigError("--keep <artifact id> is required");
  const { repo, branch } = repoAndBranch(options, env);
  let result;
  try {
    result = deleteOlderKits({
      repo,
      branch,
      keep: options.keep,
      gh: gh ?? ((args) => runGh(args, { env })),
    });
  } catch (error) {
    console.log(
      `::warning title=Design kit::Could not list the older kits, so none were deleted: ${errorText(error)}`,
    );
    return 0;
  }
  if (!result.keptFound) {
    console.log(
      `::warning title=Design kit::The kit just uploaded (${options.keep}) is not listed on ${branch} yet, so no older kit was deleted. The next build deletes them.`,
    );
    return 0;
  }
  for (const { id, error } of result.failed)
    console.log(
      `::warning title=Design kit::Could not delete the older kit ${id}: ${error}`,
    );
  const text = `Design kit: deleted ${result.deleted.length} older kit${result.deleted.length === 1 ? "" : "s"} on ${branch}${result.failed.length ? `; ${result.failed.length} could not be deleted` : ""}.`;
  console.log(text);
  summary(text, env);
  return 0;
}
