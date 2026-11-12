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
 * The newest kit comes from the configured store's `latest` (see
 * src/storage/); cleanup is for `github` storage only, since CodePress and
 * a bucket keep one pointer per branch.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { posix } from "node:path";

import { CONFIG_NAME, ConfigError, loadConfig } from "./config.mjs";
import { errorText } from "./storage/common.mjs";
import {
  ARTIFACT,
  deleteOlderKits,
  findNewestKit,
  runGh,
} from "./storage/github.mjs";
import { storageFor } from "./storage/index.mjs";

export { ARTIFACT, deleteOlderKits, findNewestKit, runGh };
/** Rebuild a kit this old even with no UI change, so it never expires. */
export const DEFAULT_MAX_AGE_DAYS = 75;
/** What `watch` means when a config has none: the whole repository. */
export const DEFAULT_WATCH = ["."];
const DAY_MS = 86_400_000;

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
 * for "no kit", with `lookupError` when the lookup failed) skips the store
 * lookup; otherwise `findKit()` is called. `head` is the commit being built
 * (default HEAD). Returns `{build, reason, kit}`.
 */
export function ciCheck({
  repoDir,
  head = "HEAD",
  watch = DEFAULT_WATCH,
  force = false,
  packageSpec = "",
  kit,
  lookupError,
  findKit,
  now = Date.now(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
}) {
  const inputs = { force, packageSpec, now, maxAgeDays };
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

function repoAndBranch(options, env, storage = { type: "github" }) {
  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  const branch = options.branch ?? env.GITHUB_REF_NAME;
  // A bucket is not keyed by repository; GitHub and CodePress are.
  const needsRepo = storage.type === "github" || storage.type === "codepress";
  if ((needsRepo && !repo) || !branch)
    throw new ConfigError(
      needsRepo
        ? "--repo <owner/name> and --branch <name> are needed outside GitHub Actions"
        : "--branch <name> is needed outside GitHub Actions",
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
 * writes them to $GITHUB_OUTPUT and the step summary when set). The newest
 * kit comes from the configured store's `latest`. With `github` storage
 * (or when no lookup is needed) it runs synchronously and returns 0; the
 * other stores answer over the network, so it returns a promise of 0.
 */
export function ciCheckCommand(
  options,
  { env = process.env, gh, aws, now } = {},
) {
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
  const storage = config.storage ?? { type: "github" };
  const check = {
    repoDir,
    watch,
    force: Boolean(options.force),
    packageSpec: options.package ?? "",
    now: now ?? Date.now(),
    maxAgeDays: maxAgeFrom(options["max-age-days"], env),
  };
  const store = () => {
    const { repo, branch } = repoAndBranch(options, env, storage);
    return {
      branch,
      store: storageFor(storage, {
        repo,
        env,
        gh: gh ?? ((args) => runGh(args, { env })),
        aws,
      }),
    };
  };
  const finish = (result) => {
    report(result, env);
    return 0;
  };
  if (kit !== undefined || check.force || check.packageSpec)
    return finish(ciCheck({ ...check, kit }));
  if (storage.type === "github")
    return finish(
      ciCheck({
        ...check,
        findKit: () => {
          const { store: github, branch } = store();
          return github.latest({ branch });
        },
      }),
    );
  return (async () => {
    let found = null;
    let lookupError;
    try {
      const { store: other, branch } = store();
      found = await other.latest({ branch });
    } catch (error) {
      lookupError = errorText(error);
    }
    return finish(ciCheck({ ...check, kit: found, lookupError }));
  })();
}

function report(result, env) {
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
