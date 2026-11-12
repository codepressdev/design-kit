/**
 * Where a kit is stored, chosen by the config's `storage` key, behind one
 * interface:
 *
 *     latest({branch})          → {sha, createdAt} | null
 *     upload({dir, branch, sha}) → {sha, branch, sizeBytes}
 *     fetch({branch, out})      → {path, sha, branch, cached}
 *
 * `github` (the default) is a GitHub Actions artifact; `codepress` is
 * CodePress; `s3` and `r2` are the user's own bucket. The commands
 * `design-kit upload`, `fetch` and `latest` are here too.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { ConfigError, loadConfig } from "../config.mjs";
import { bucketStorage } from "./bucket.mjs";
import { codepressStorage } from "./codepress.mjs";
import { findRepo, originDefaultBranch } from "./common.mjs";
import { githubStorage } from "./github.mjs";

export { StorageError } from "./common.mjs";

export const STORAGE_TYPES = ["github", "codepress", "s3", "r2"];

/**
 * The store for a config's `storage` object (`{type: "github"}` when
 * absent). `context`: `repo` (owner/name), `env`, `tokenFile`, and for
 * tests `gh` and `aws`.
 */
export function storageFor(storage, context = {}) {
  const config = storage ?? { type: "github" };
  if (config.type === "github") return githubStorage(context);
  if (config.type === "codepress") return codepressStorage(config, context);
  if (config.type === "s3" || config.type === "r2")
    return bucketStorage(config, context);
  throw new ConfigError(
    `storage.type: must be one of ${STORAGE_TYPES.join(", ")}`,
  );
}

/** The branch a read means when --branch is not given. */
function readBranch(options, storage, configDir) {
  if (options.branch) return options.branch;
  // github asks GitHub and codepress asks CodePress for the default branch;
  // a bucket knows no repository, so the checkout's origin/HEAD says.
  if (storage.type === "s3" || storage.type === "r2")
    return originDefaultBranch(configDir) ?? undefined;
  return undefined;
}

function contextFor(options, config, { env, gh, aws }) {
  return {
    repo: findRepo({ repo: options.repo, env, cwd: config.configDir }),
    env,
    tokenFile: options["token-file"],
    gh,
    aws,
  };
}

function storageOf(config) {
  return config.storage ?? { type: "github" };
}

/**
 * `design-kit upload --dir <kit>`: uploads a built kit to the configured
 * store. `github` storage exits 2: the workflow's upload-artifact step
 * uploads it.
 */
export async function uploadCommand(
  options,
  { env = process.env, gh, aws } = {},
) {
  const config = loadConfig(options.config);
  const storage = storageOf(config);
  const dir = resolve(options.dir ?? config.out ?? "design-kit");
  if (storage.type !== "github" && !existsSync(join(dir, "manifest.json")))
    throw new ConfigError(
      `${dir} is not a kit (no manifest.json); pass --dir <kit folder>`,
    );
  const store = storageFor(
    storage,
    contextFor(options, config, { env, gh, aws }),
  );
  const result = await store.upload({
    dir,
    branch: options.branch ?? env.GITHUB_REF_NAME,
    sha: options.sha ?? env.GITHUB_SHA,
  });
  console.log(
    `Uploaded the kit of ${String(result.sha).slice(0, 7)} on ${result.branch} to ${storage.type} storage (${result.sizeBytes} bytes zipped).`,
  );
  console.log(`sha=${result.sha}`);
  console.log(`branch=${result.branch}`);
  return 0;
}

/**
 * `design-kit fetch [--branch b] [--out dir]`: downloads the newest kit
 * (once per commit: it is cached under $TMPDIR/design-kit-<sha>) and prints
 * `path=`, `sha=` and `branch=`.
 */
export async function fetchCommand(
  options,
  { env = process.env, gh, aws } = {},
) {
  const config = loadConfig(options.config);
  const storage = storageOf(config);
  const store = storageFor(
    storage,
    contextFor(options, config, { env, gh, aws }),
  );
  const kit = await store.fetch({
    branch: readBranch(options, storage, config.configDir),
    out: options.out,
  });
  console.log(`path=${kit.path}`);
  console.log(`sha=${kit.sha}`);
  if (kit.branch) console.log(`branch=${kit.branch}`);
  return 0;
}

/**
 * `design-kit latest [--branch b]`: prints the newest kit's `sha=` and
 * `created=`. No kit exits 1.
 */
export async function latestCommand(
  options,
  { env = process.env, gh, aws } = {},
) {
  const config = loadConfig(options.config);
  const storage = storageOf(config);
  const store = storageFor(
    storage,
    contextFor(options, config, { env, gh, aws }),
  );
  const branch = readBranch(options, storage, config.configDir);
  const kit = await store.latest({ branch });
  if (!kit) {
    console.error(
      `design-kit: no_kit: no kit stored${branch ? ` on ${branch}` : " on the default branch"} in ${storage.type} storage`,
    );
    return 1;
  }
  console.log(`sha=${kit.sha}`);
  console.log(`created=${kit.createdAt ?? ""}`);
  return 0;
}
