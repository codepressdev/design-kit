/**
 * The `design-kit` command line: capture a design kit from a Storybook build
 * and a running app, and compose mockups from it. Run `design-kit --help`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ConfigError, loadConfig } from "./config.mjs";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** The `design-kit-setup` skill, printed by `design-kit setup-guide`. */
const SETUP_GUIDE = new URL(
  "../skills/design-kit-setup/SKILL.md",
  import.meta.url,
);

/** The `storybook-setup` skill, printed by `design-kit storybook-guide`. */
const STORYBOOK_GUIDE = new URL(
  "../skills/storybook-setup/SKILL.md",
  import.meta.url,
);

const USAGE = `usage: design-kit <command> [options]

  init              set a kit up in this repository: the config, a daily
                    GitHub Actions build, and a skill for its agents
      [--root <dir>] [--dry-run] [--force] [--workflow-only]
                    --workflow-only --force rewrites just the workflow
  capture stories   capture every story of a Storybook 7-9 static build
      [--config <file>] [--out <dir>] [--storybook-dir <dir>]
      [--only <id,...> | --only-file <file>] [--base <previous kit>]
  capture pages     capture the configured pages of a running app
      [--config <file>] [--out <dir>] [--base-url <url>] [--only <name,...>]
      [--ready <name>=<selector>] [--screenshots <dir>] [--timeout <ms>]
  kit <info|find|show|compose> ...
                    look up and compose from a kit (\`design-kit kit --help\`)
      [--kit <dir>]   default: DESIGN_KIT_DIR, the config's "out", ./design-kit
  validate          check design-kit.config.json against the v1 schema
      [--config <file>]
  ci-check          in CI: print build=true|false and the reason. Builds
                    when a "watch" path changed since the newest kit, there
                    is no kit, it is DESIGN_KIT_MAX_AGE_DAYS (75) old, or
                    --force or --package is given
      [--config <file>] [--since <sha> --kit-created <iso> | --no-kit]
      [--force] [--package <spec>] [--max-age-days <n>]
      [--repo <owner/name>] [--branch <name>]
  ci-cleanup        in CI: delete the branch's kits older than --keep
      --keep <artifact id> [--repo <owner/name>] [--branch <name>]
  setup-guide       print the guide for setting a kit up in a repository as
                    one reviewable pull request (an agent skill)
  storybook-guide   print the guide for adding Storybook, with stories for
                    every existing component, as one reviewable pull request
                    (an agent skill)

The config is the nearest design-kit.config.json at or above the working
directory unless --config names one. Exit codes: 0 done, 1 a capture could
not run (or init found the repository already set up), 2 a config or usage
error.`;

function parse(argv, spec) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    const name = arg.replace(/^--/, "");
    if (!arg.startsWith("--") || !(name in spec)) {
      throw new ConfigError(`unknown option ${arg}\n\n${USAGE}`);
    }
    if (spec[name] === "flag") {
      options[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new ConfigError(`${arg} needs a value`);
    i += 1;
    if (spec[name] === "list") (options[name] ??= []).push(value);
    else options[name] = value;
  }
  return options;
}

async function captureStories(argv) {
  const options = parse(argv, {
    config: "value",
    out: "value",
    "storybook-dir": "value",
    only: "value",
    "only-file": "value",
    base: "value",
  });
  const config = loadConfig(options.config);
  const { captureStories: run, parseOnly } =
    await import("./capture-stories.mjs");
  const only =
    options.only !== undefined
      ? parseOnly(options.only)
      : options["only-file"] !== undefined
        ? parseOnly(readFileSync(options["only-file"], "utf8"))
        : undefined;
  await run(config, {
    out: options.out,
    storybookDir: options["storybook-dir"],
    only,
    base: options.base ? resolve(options.base) : undefined,
  });
  return 0;
}

async function capturePagesCommand(argv) {
  const options = parse(argv, {
    config: "value",
    out: "value",
    "base-url": "value",
    only: "value",
    ready: "list",
    screenshots: "value",
    timeout: "value",
  });
  const config = loadConfig(options.config);
  const ready = {};
  for (const raw of options.ready ?? []) {
    const at = raw.indexOf("=");
    if (at < 1)
      throw new ConfigError(`--ready takes <page>=<selector>, got ${raw}`);
    ready[raw.slice(0, at)] = raw.slice(at + 1);
  }
  const timeoutMs =
    options.timeout === undefined ? undefined : Number(options.timeout);
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0))
    throw new ConfigError("--timeout takes a positive number of milliseconds");
  const { capturePages } = await import("./capture-pages.mjs");
  const session = { interrupted: false, browser: null };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      session.interrupted = true;
    });
  }
  return capturePages(config, {
    out: options.out,
    baseUrl: options["base-url"],
    only: options.only?.split(",").filter(Boolean),
    ready,
    screenshots: options.screenshots ? resolve(options.screenshots) : undefined,
    timeoutMs,
    session,
  });
}

async function kitCommand(argv, env) {
  const { run } = await import("./kit.mjs");
  let defaultDir = resolve("design-kit");
  if (!argv.includes("--kit") && !env.DESIGN_KIT_DIR) {
    try {
      const config = loadConfig();
      if (config.out) defaultDir = config.out;
    } catch {
      // No usable config: the kit folder comes from --kit or ./design-kit.
    }
    if (!existsSync(defaultDir)) defaultDir = process.cwd();
  }
  return run(argv, undefined, env, defaultDir);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, sub, ...rest] = argv;
  try {
    if (!command) {
      console.log(USAGE);
      return 2;
    }
    // `kit --help` is the kit tool's own usage; anywhere else, this one.
    if (
      command !== "kit" &&
      argv.some((arg) => arg === "--help" || arg === "-h")
    ) {
      console.log(USAGE);
      return 0;
    }
    if (command === "--version") {
      console.log(VERSION);
      return 0;
    }
    if (command === "kit") return await kitCommand(argv.slice(1), env);
    if (command === "init") {
      const options = parse(argv.slice(1), {
        root: "value",
        "dry-run": "flag",
        force: "flag",
        "workflow-only": "flag",
      });
      const { init } = await import("./init.mjs");
      return init({
        root: options.root ?? ".",
        dryRun: Boolean(options["dry-run"]),
        force: Boolean(options.force),
        workflowOnly: Boolean(options["workflow-only"]),
      });
    }
    if (command === "ci-check") {
      const options = parse(argv.slice(1), {
        config: "value",
        since: "value",
        "kit-created": "value",
        "no-kit": "flag",
        force: "flag",
        package: "value",
        "max-age-days": "value",
        repo: "value",
        branch: "value",
      });
      const { ciCheckCommand } = await import("./ci.mjs");
      return ciCheckCommand(options, { env });
    }
    if (command === "ci-cleanup") {
      const options = parse(argv.slice(1), {
        keep: "value",
        repo: "value",
        branch: "value",
      });
      const { ciCleanupCommand } = await import("./ci.mjs");
      return ciCleanupCommand(options, { env });
    }
    if (command === "setup-guide") {
      parse(argv.slice(1), {});
      process.stdout.write(readFileSync(SETUP_GUIDE, "utf8"));
      return 0;
    }
    if (command === "storybook-guide") {
      parse(argv.slice(1), {});
      process.stdout.write(readFileSync(STORYBOOK_GUIDE, "utf8"));
      return 0;
    }
    if (command === "validate") {
      const options = parse(argv.slice(1), { config: "value" });
      const config = loadConfig(options.config);
      console.log(`${config.file}: valid (version 1)`);
      return 0;
    }
    if (command === "capture" && sub === "stories")
      return await captureStories(rest);
    if (command === "capture" && sub === "pages")
      return await capturePagesCommand(rest);
    throw new ConfigError(`unknown command "${argv.join(" ")}"\n\n${USAGE}`);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`design-kit: ${error.message}`);
      return 2;
    }
    console.error(`design-kit: ${error?.message ?? error}`);
    return 1;
  }
}
