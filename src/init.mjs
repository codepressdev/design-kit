/**
 * `design-kit init`: sets a design kit up in a repository. It looks at the
 * project (Storybook, framework, package manager, dev script, Playwright,
 * theme) and writes design-kit.config.json, a daily GitHub Actions workflow
 * that rebuilds the kit when the watched UI files change and uploads it, a
 * design-kit skill for the repository's agents and one line in AGENTS.md or
 * CLAUDE.md. It never overwrites a file without --force and never writes a
 * secret. `--workflow-only` rewrites just the workflow.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { DEFAULT_MAX_AGE_DAYS } from "./ci.mjs";
import { CONFIG_NAME } from "./config.mjs";

const PACKAGE = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const SKILL_TEMPLATE = new URL(
  "./templates/design-kit-skill.md",
  import.meta.url,
);

export const WORKFLOW_PATH = ".github/workflows/design-kit.yml";
export const SKILL_DIR = ".claude/skills/design-kit";
export const AGENTS_SKILL_DIR = ".agents/skills/design-kit";
const TODO = "TODO";
// The one line a finished (not dry-run) init ends with. Printed only; init
// makes no network call.
export const CALL_TO_ACTION =
  "Want every screen on one canvas, shareable with your team, and agents that build it? → https://codepress.dev";
/** How long a kit artifact is kept: the most a public repository allows. */
export const RETENTION_DAYS = 90;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".turbo",
  ".cache",
  "coverage",
  "storybook-static",
  "design-kit",
  "vendor",
]);
const SCAN_LIMIT = 4000;
const SCAN_BYTES = 256 * 1024;

/** A problem `init` refuses to work past (exit 1). */
export class InitError extends Error {}

// ── reading the project ─────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function deps(pkg) {
  return {
    ...pkg?.peerDependencies,
    ...pkg?.optionalDependencies,
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
  };
}

/** The folder holding `.git` at or above `from`, else `from` itself. */
export function findRepoRoot(from) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/** `dir`, then each folder above it up to and including `top`. */
function upTo(dir, top) {
  const dirs = [];
  let current = resolve(dir);
  for (;;) {
    dirs.push(current);
    if (current === top) break;
    const parent = dirname(current);
    if (parent === current || !`${current}${sep}`.startsWith(`${top}${sep}`))
      break;
    current = parent;
  }
  return dirs;
}

/** Workspace package folders declared by pnpm-workspace.yaml or package.json. */
function workspacePackages(dir) {
  const patterns = [];
  const pnpm = readText(join(dir, "pnpm-workspace.yaml"));
  if (pnpm) {
    let inPackages = false;
    for (const line of pnpm.split("\n")) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const match = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
        if (match) patterns.push(match[1].trim());
      }
    }
  }
  const pkg = readJson(join(dir, "package.json"));
  const declared = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : (pkg?.workspaces?.packages ?? []);
  patterns.push(...declared);

  const found = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const parts = pattern.replace(/\/+$/, "").split("/");
    let dirs = [dir];
    for (const part of parts) {
      const next = [];
      for (const base of dirs) {
        if (part === "*" || part === "**") {
          for (const entry of safeReaddir(base))
            if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name))
              next.push(join(base, entry.name));
        } else if (isDir(join(base, part))) next.push(join(base, part));
      }
      dirs = next;
    }
    for (const candidate of dirs)
      if (
        existsSync(join(candidate, "package.json")) &&
        !found.includes(candidate)
      )
        found.push(candidate);
  }
  return found.sort();
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function installedVersion(name, from, top) {
  for (const dir of upTo(from, top)) {
    const pkg = readJson(join(dir, "node_modules", name, "package.json"));
    if (pkg?.version) return pkg.version;
  }
  return null;
}

function majorOf(version) {
  const match = String(version ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function storybookIn(dir, repoRoot) {
  const pkg = readJson(join(dir, "package.json"));
  const all = deps(pkg);
  const names = Object.keys(all).filter(
    (name) => name === "storybook" || name.startsWith("@storybook/"),
  );
  const hasConfig = isDir(join(dir, ".storybook"));
  if (!names.length && !hasConfig) return null;
  const versionName = names.includes("storybook")
    ? "storybook"
    : (names.find((name) =>
        /^@storybook\/(react|vue3|svelte|angular|web-components|html|preact|nextjs|react-vite)/.test(
          name,
        ),
      ) ?? names[0]);
  const version =
    (versionName && installedVersion(versionName, dir, repoRoot)) ??
    (versionName ? all[versionName] : null);
  return {
    dir,
    hasConfig,
    version: version ?? null,
    major: majorOf(version),
  };
}

const FRAMEWORKS = [
  { name: "Next.js", deps: ["next"], port: 3000, configs: ["next.config"] },
  {
    name: "Remix",
    deps: ["@remix-run/dev", "@remix-run/react"],
    port: 3000,
    configs: ["vite.config", "remix.config"],
  },
  { name: "Astro", deps: ["astro"], port: 4321, configs: ["astro.config"] },
  {
    name: "Create React App",
    deps: ["react-scripts"],
    port: 3000,
    configs: [],
  },
  { name: "Vite", deps: ["vite"], port: 5173, configs: ["vite.config"] },
];

function frameworkIn(dir) {
  const all = deps(readJson(join(dir, "package.json")));
  return FRAMEWORKS.find((framework) =>
    framework.deps.some((name) => name in all),
  );
}

function scriptsIn(dir) {
  return readJson(join(dir, "package.json"))?.scripts ?? {};
}

function devScriptName(scripts) {
  return ["dev", "start", "serve", "preview"].find((name) =>
    Boolean(scripts[name]),
  );
}

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function packageManagerOf(project, repoRoot) {
  let lockfile = null;
  for (const dir of upTo(project, repoRoot)) {
    const hit = LOCKFILES.find(([file]) => existsSync(join(dir, file)));
    if (hit) {
      lockfile = { file: hit[0], name: hit[1], dir };
      break;
    }
  }
  let declared = null;
  for (const dir of upTo(project, repoRoot)) {
    const field = readJson(join(dir, "package.json"))?.packageManager;
    if (typeof field === "string") {
      const match = field.match(/^(npm|pnpm|yarn|bun)@([^+\s]+)/);
      if (match) {
        declared = { name: match[1], version: match[2] };
        break;
      }
    }
  }
  const name = declared?.name ?? lockfile?.name ?? "npm";
  const installDir = lockfile?.dir ?? project;
  let version = declared?.name === name ? declared.version : null;
  if (!version && name === "pnpm" && lockfile) {
    const lock = readText(join(lockfile.dir, lockfile.file)) ?? "";
    const lockVersion = majorOf(
      lock.match(/lockfileVersion:\s*'?([\d.]+)/)?.[1],
    );
    version = lockVersion >= 9 ? "10" : lockVersion === 6 ? "8" : null;
  }
  const berry =
    name === "yarn" &&
    (existsSync(join(installDir, ".yarnrc.yml")) || majorOf(version) >= 2);
  return {
    name,
    version,
    declared: Boolean(declared),
    lockfile: lockfile?.file ?? null,
    installDir,
    berry,
  };
}

function playwrightOf(project, repoRoot) {
  for (const dir of upTo(project, repoRoot)) {
    const all = deps(readJson(join(dir, "package.json")));
    for (const name of ["@playwright/test", "playwright"])
      if (all[name])
        return {
          name,
          version: installedVersion(name, dir, repoRoot) ?? all[name],
          dir,
        };
    const config = safeReaddir(dir).find((entry) =>
      /^playwright\.config\.(m?[jt]s|cjs)$/.test(entry.name),
    );
    if (config) return { name: "@playwright/test", version: null, dir };
  }
  return null;
}

/** The app's local URL: a Playwright baseURL, a configured port, or the framework's default. */
function appUrlOf(project, appDir, framework, repoRoot) {
  for (const dir of [...new Set([project, appDir, repoRoot])]) {
    for (const entry of safeReaddir(dir)) {
      if (!/^playwright\.config\.(m?[jt]s|cjs)$/.test(entry.name)) continue;
      const text = readText(join(dir, entry.name)) ?? "";
      const match = text.match(/baseURL:\s*["'`](https?:\/\/[^"'`\s/]+)/);
      if (match)
        return {
          url: `${match[1]}/`,
          source: relative(repoRoot, join(dir, entry.name)),
        };
    }
  }
  for (const name of framework?.configs ?? []) {
    for (const entry of safeReaddir(appDir)) {
      if (!entry.name.startsWith(`${name}.`)) continue;
      const text = readText(join(appDir, entry.name)) ?? "";
      const match = text.match(/\bport:\s*(\d{2,5})\b/);
      if (match)
        return {
          url: `http://localhost:${match[1]}/`,
          source: relative(repoRoot, join(appDir, entry.name)),
        };
    }
  }
  return {
    url: `http://localhost:${framework?.port ?? 3000}/`,
    source: framework ? `${framework.name}'s default port` : "a guess",
  };
}

/** Class or data-theme: whichever the project's styles and scripts use more. */
function themeOf(dirs) {
  const score = { class: 0, attribute: 0 };
  let attributeName = "data-theme";
  let darkValue = null;
  let lightValue = null;
  let scanned = 0;
  const visit = (dir) => {
    for (const entry of safeReaddir(dir)) {
      if (scanned >= SCAN_LIMIT) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith("."))
          visit(path);
        else if (entry.name === ".storybook") visit(path);
        continue;
      }
      if (
        !/\.(css|scss|sass|less|[cm]?[jt]sx?|html|vue|svelte|astro)$/.test(
          entry.name,
        )
      )
        continue;
      scanned += 1;
      let text;
      try {
        if (statSync(path).size > SCAN_BYTES) continue;
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const attr = text.match(
        /\[(data-(?:theme|mode|color-scheme))=["']?(dark)["']?\]|(data-(?:theme|mode|color-scheme))=["'](dark)["']|setAttribute\(\s*["'](data-(?:theme|mode|color-scheme))["']|attribute=["'](data-[a-z-]+)["']/,
      );
      if (attr) {
        score.attribute += 2;
        attributeName =
          attr[1] ?? attr[3] ?? attr[5] ?? attr[6] ?? attributeName;
        if (attr[2] || attr[4]) darkValue = "dark";
        const light = text.match(
          new RegExp(
            `\\[${attributeName}=["']?(light)["']?\\]|${attributeName}=["'](light)["']`,
          ),
        );
        if (light) lightValue = "light";
      }
      if (
        /darkMode:\s*\[?\s*["'](class|selector)["']/.test(text) ||
        /@custom-variant\s+dark\s+\(&:where\(\.dark/.test(text) ||
        /classList\.(add|toggle|remove)\(\s*["']dark["']/.test(text) ||
        /attribute=["']class["']/.test(text) ||
        /(^|[\s,}])\.dark\s*[{,:.\s]/m.test(text)
      )
        score.class += 1;
    }
  };
  for (const dir of dirs) visit(dir);
  if (score.attribute > score.class)
    return {
      attribute: attributeName,
      dark: darkValue ?? "dark",
      ...(lightValue ? { light: lightValue } : {}),
      evidence: `${attributeName} attribute`,
    };
  return {
    attribute: "class",
    dark: "dark",
    evidence: score.class ? "a dark class" : null,
  };
}

/**
 * Everything `init` decides from: the project folder (`root`, where the
 * config goes) and the repository around it.
 */
export function detectProject(root) {
  const project = resolve(root);
  if (!isDir(project)) throw new InitError(`${project}: no such folder`);
  const repoRoot = findRepoRoot(project);
  const workspaces = workspacePackages(project);
  const packages = [project, ...workspaces];

  const storybooks = packages
    .map((dir) => storybookIn(dir, repoRoot))
    .filter(Boolean);
  const storybook = storybooks[0] ?? null;

  // The app: the project itself when it is one, else the first workspace
  // package with a framework and a dev script that is not only a Storybook.
  let app = null;
  for (const dir of packages) {
    const framework = frameworkIn(dir);
    const script = devScriptName(scriptsIn(dir));
    const onlyStorybook =
      storybookIn(dir, repoRoot) &&
      (!script || /storybook/.test(scriptsIn(dir)[script]));
    if (framework && script && !onlyStorybook) {
      app = { dir, framework, script };
      break;
    }
  }
  const framework = app?.framework ?? frameworkIn(project) ?? null;
  const appDir = app?.dir ?? project;

  const pm = packageManagerOf(project, repoRoot);
  const rootScript = devScriptName(scriptsIn(project));
  let dev = null;
  if (rootScript && !/storybook/.test(scriptsIn(project)[rootScript]))
    dev = {
      dir: project,
      script: rootScript,
      command: runScript(pm, rootScript),
    };
  else if (app)
    dev = {
      dir: app.dir,
      script: app.script,
      command: runWorkspaceScript(
        pm,
        readJson(join(app.dir, "package.json"))?.name,
        app.script,
        relative(project, app.dir),
      ),
    };

  return {
    project,
    repoRoot,
    workspaces,
    storybook,
    otherStorybooks: storybooks.slice(1).map((sb) => sb.dir),
    framework: framework ? { name: framework.name, dir: appDir } : null,
    packageManager: pm,
    dev,
    appUrl: appUrlOf(project, appDir, framework, repoRoot),
    playwright: playwrightOf(project, repoRoot),
    theme: themeOf(packages),
    nodeVersion: nodeVersionOf(project, repoRoot),
  };
}

function nodeVersionOf(project, repoRoot) {
  for (const dir of upTo(project, repoRoot)) {
    for (const file of [".nvmrc", ".node-version"])
      if (existsSync(join(dir, file)))
        return { file: relative(repoRoot, join(dir, file)) || file };
  }
  for (const dir of upTo(project, repoRoot)) {
    const engines = readJson(join(dir, "package.json"))?.engines?.node;
    const major = majorOf(engines);
    if (major) return { version: String(Math.max(major, 20)) };
  }
  return { version: "22" };
}

// ── package manager commands ────────────────────────────────────────────────

function runScript(pm, script) {
  return pm.name === "npm" ? `npm run ${script}` : `${pm.name} run ${script}`;
}

function runWorkspaceScript(pm, name, script, dir) {
  if (!name) return `cd ${dir} && ${runScript(pm, script)}`;
  if (pm.name === "pnpm") return `pnpm --filter ${name} run ${script}`;
  if (pm.name === "yarn") return `yarn workspace ${name} run ${script}`;
  if (pm.name === "bun") return `bun run --filter ${name} ${script}`;
  return `npm run ${script} --workspace ${name}`;
}

function execBin(pm) {
  if (pm.name === "pnpm") return "pnpm exec";
  if (pm.name === "yarn") return pm.berry ? "yarn exec" : "npx";
  if (pm.name === "bun") return "bunx";
  return "npx";
}

function installCommand(pm) {
  if (!pm.lockfile)
    return pm.name === "npm" ? "npm install" : `${pm.name} install`;
  if (pm.name === "pnpm") return "pnpm install --frozen-lockfile";
  if (pm.name === "yarn")
    return pm.berry
      ? "yarn install --immutable"
      : "yarn install --frozen-lockfile";
  if (pm.name === "bun") return "bun install --frozen-lockfile";
  return "npm ci";
}

// ── what init writes ────────────────────────────────────────────────────────

/** The Playwright this package is tested with, pinned in what init writes. */
function playwrightPin() {
  return PACKAGE.devDependencies?.["@playwright/test"] ?? "1.58.2";
}

function posix(path) {
  return path.split(sep).join("/");
}

/** Folders at a package root that hold what the UI renders or loads. */
const ROOT_UI_DIRS = new Set([
  ".storybook",
  "app",
  "assets",
  "components",
  "design-tokens",
  "lib",
  "pages",
  "public",
  "src",
  "stories",
  "styles",
  "theme",
  "tokens",
]);
/** Global styles and tokens that can sit at the repository root. */
const ROOT_STYLE_DIRS = new Set(["design-tokens", "styles", "theme", "tokens"]);
const UI_CONFIG_FILE =
  /^(tailwind|postcss|vite|next|astro|remix|svelte|nuxt|uno|panda)\.config\.[cm]?[jt]s$/;

/**
 * What to watch for one package folder: the folder itself, or, when the
 * package is the repository root, its UI folders and config files (watching
 * the whole root would rebuild on every commit).
 */
function packageWatch(dir, repoRoot) {
  if (dir !== repoRoot) return [posix(relative(repoRoot, dir))];
  const paths = [];
  for (const entry of safeReaddir(dir)) {
    if (entry.isDirectory() && ROOT_UI_DIRS.has(entry.name))
      paths.push(entry.name);
    else if (
      entry.isFile() &&
      (UI_CONFIG_FILE.test(entry.name) ||
        entry.name === "package.json" ||
        entry.name === "index.html")
    )
      paths.push(entry.name);
  }
  return paths.sort();
}

/** The workspace packages `dirs` depend on, directly or through each other. */
function workspaceDependencies(dirs, found) {
  const all = [
    ...new Set([...workspacePackages(found.repoRoot), ...found.workspaces]),
  ];
  const byName = new Map();
  for (const dir of all) {
    const name = readJson(join(dir, "package.json"))?.name;
    if (name && !byName.has(name)) byName.set(name, dir);
  }
  const seen = new Set(dirs);
  const queue = [...dirs];
  const dependencies = [];
  while (queue.length) {
    const dir = queue.shift();
    for (const name of Object.keys(deps(readJson(join(dir, "package.json"))))) {
      const dep = byName.get(name);
      if (dep && !seen.has(dep)) {
        seen.add(dep);
        dependencies.push(dep);
        queue.push(dep);
      }
    }
  }
  return dependencies;
}

/**
 * The config's `watch` list: the paths, relative to the repository root,
 * whose change rebuilds the kit. The Storybook and app folders, the
 * workspace packages they depend on (shared UI usually lives there), global
 * styles and tokens at the root, the config, the lockfile and the workflow.
 */
export function watchDefaults(found) {
  const rel = (path) => posix(relative(found.repoRoot, path));
  const roots = [
    ...(found.storybook ? [found.storybook.dir] : []),
    found.framework?.dir ?? found.project,
  ];
  const packages = [...new Set(roots)];
  const paths = [];
  for (const dir of [...packages, ...workspaceDependencies(packages, found)])
    paths.push(...packageWatch(dir, found.repoRoot));
  for (const entry of safeReaddir(found.repoRoot))
    if (
      (entry.isDirectory() && ROOT_STYLE_DIRS.has(entry.name)) ||
      (entry.isFile() && UI_CONFIG_FILE.test(entry.name))
    )
      paths.push(entry.name);
  paths.push(rel(join(found.project, CONFIG_NAME)));
  const pm = found.packageManager;
  if (pm.lockfile) paths.push(rel(join(pm.installDir, pm.lockfile)));
  paths.push(WORKFLOW_PATH);
  const unique = [...new Set(paths.filter(Boolean))];
  // A path inside another watched folder adds nothing.
  return unique.filter(
    (path) =>
      !unique.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}

/** design-kit.config.json, as an object. */
export function buildConfig(found) {
  const config = {
    $schema: `https://unpkg.com/${PACKAGE.name}@${PACKAGE.version}/schema/design-kit.config.schema.json`,
    version: 1,
    out: "design-kit",
    watch: watchDefaults(found),
    theme: {
      attribute: found.theme.attribute,
      dark: found.theme.dark,
      ...(found.theme.light ? { light: found.theme.light } : {}),
    },
  };
  if (found.storybook) {
    const root = posix(relative(found.project, found.storybook.dir)) || ".";
    config.stories = {
      root,
      buildCommand: `${execBin(found.packageManager)} storybook build --quiet -o storybook-static`,
      staticDir: "storybook-static",
      ...(isDir(join(found.storybook.dir, "src"))
        ? { gaps: { componentGlob: "src/**/[A-Z]*.{tsx,jsx,vue,svelte}" } }
        : {}),
    };
  }
  config.pages = {
    startCommand:
      found.dev?.command ?? `${TODO}: the command that starts the app`,
    waitUrl: found.appUrl.url,
    pages: [
      {
        name: "home",
        title: "Home",
        path: "/",
        ready: `${TODO}: a selector that shows once the page has its content, such as "main h1"`,
        slots: {
          main: [
            `${TODO}: the selector of the page's main content region, such as "main"`,
          ],
        },
      },
    ],
  };
  return config;
}

/** .github/workflows/design-kit.yml, as text. */
export function buildWorkflow(found) {
  const pm = found.packageManager;
  const rel = (path) => posix(relative(found.repoRoot, path)) || ".";
  const projectDir = rel(found.project);
  const at = (path) => (projectDir === "." ? path : `${projectDir}/${path}`);
  const installDir = rel(pm.installDir);
  const node = found.nodeVersion.file
    ? `node-version-file: ${found.nodeVersion.file}`
    : `node-version: "${found.nodeVersion.version}"`;
  const cache =
    pm.lockfile && pm.name !== "bun" ? `\n          cache: ${pm.name}` : "";
  const cachePath =
    cache && installDir !== "."
      ? `\n          cache-dependency-path: ${installDir}/${pm.lockfile}`
      : "";

  const setup = [];
  if (pm.name === "pnpm")
    setup.push(
      pm.declared || !pm.version
        ? "      - uses: pnpm/action-setup@v6"
        : `      - uses: pnpm/action-setup@v6\n        with:\n          version: ${pm.version}`,
    );
  if (pm.name === "yarn" && pm.berry)
    setup.push("      - run: corepack enable");
  if (pm.name === "bun") setup.push("      - uses: oven-sh/setup-bun@v2");
  setup.push(
    `      - uses: actions/setup-node@v5\n        with:\n          ${node}${cache}${cachePath}`,
  );

  const storiesStep = found.storybook
    ? `
      - name: Build Storybook and capture stories
        working-directory: \${{ runner.temp }}/design-kit-cli
        run: design-kit capture stories --config "$CONFIG"
`
    : "";

  return `name: Design kit

# Captures this repository's design kit: ${found.storybook ? "every Storybook story and " : ""}the pages
# listed in ${at(CONFIG_NAME)}, as static HTML with the CSS and fonts they
# load. It uploads the result as the \`design-kit\` artifact, which agents
# download to draw mockups from the app's real markup.
#
# It runs daily, but builds only when a path in the config's "watch" list
# changed since the newest kit's commit, when there is no kit yet, or when
# the newest kit is DESIGN_KIT_MAX_AGE_DAYS old, so a kit never expires
# unreplaced. After an upload it deletes the branch's older kits.
#
# Written by \`design-kit init\` (${PACKAGE.name}); \`init --workflow-only
# --force\` rewrites just this file. Edit it freely.

on:
  schedule:
    - cron: "23 5 * * *"
  workflow_dispatch:
    inputs:
      force:
        description: Build even when no watched file changed since the newest kit
        type: boolean
        default: false
      package:
        description: "The ${PACKAGE.name} to build with, as an npm package spec (default: the pinned version below). Always builds."
        type: string
        default: ""

permissions:
  contents: read

concurrency:
  group: design-kit-\${{ github.ref }}
  cancel-in-progress: false

env:
  DESIGN_KIT_PACKAGE: "${PACKAGE.name}@${PACKAGE.version}"
  PLAYWRIGHT_PACKAGE: "@playwright/test@${playwrightPin()}"
  CONFIG: \${{ github.workspace }}/${at(CONFIG_NAME)}
  # Rebuild a kit this many days old even with no UI change. Kits are kept
  # ${RETENTION_DAYS} days (retention-days below), so this refreshes the kit before it
  # expires.
  DESIGN_KIT_MAX_AGE_DAYS: "${DEFAULT_MAX_AGE_DAYS}"

jobs:
  check:
    name: Did the watched files change?
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      actions: read
    outputs:
      build: \${{ steps.check.outputs.build }}
    steps:
      # Only the config is checked out and no file contents are fetched: the
      # check compares the git tree and blob ids of the watched paths at the
      # newest kit's commit and at this one.
      - uses: actions/checkout@v5
        with:
          fetch-depth: 1
          filter: blob:none
          sparse-checkout: ${at(CONFIG_NAME)}
          sparse-checkout-cone-mode: false

      - uses: actions/setup-node@v5
        with:
          node-version: "22"

      - id: check
        env:
          GH_TOKEN: \${{ github.token }}
          FORCE: \${{ inputs.force || 'false' }}
          PACKAGE_INPUT: \${{ inputs.package || '' }}
        run: |
          args=()
          if [ "$FORCE" = "true" ]; then args+=(--force); fi
          if [ -n "$PACKAGE_INPUT" ]; then args+=(--package "$PACKAGE_INPUT"); fi
          npx --yes -p "$DESIGN_KIT_PACKAGE" design-kit ci-check --config "$CONFIG" "\${args[@]}"

  build:
    name: Build the design kit
    needs: check
    if: needs.check.outputs.build == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    outputs:
      artifact-id: \${{ steps.upload.outputs.artifact-id }}
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false

${setup.join("\n\n")}

      - name: Install dependencies${installDir === "." ? "" : `\n        working-directory: ${installDir}`}
        run: ${installCommand(pm)}

      # The capture runs from this folder so it drives the pinned Playwright
      # and the Chromium installed for it, whatever the project depends on.
      - name: Install design-kit and Chromium
        working-directory: \${{ runner.temp }}
        env:
          PACKAGE: \${{ inputs.package || env.DESIGN_KIT_PACKAGE }}
        run: |
          mkdir -p design-kit-cli && cd design-kit-cli
          npm init -y > /dev/null
          npm install --no-audit --no-fund "$PACKAGE" "$PLAYWRIGHT_PACKAGE"
          npx playwright install --with-deps chromium
          echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"
${storiesStep}
      # Signing in: when the pages need a signed-in user, name a sign-in
      # module in pages.auth.setup and have it read these secrets (add them
      # under Settings > Secrets and variables > Actions). Never commit a
      # credential. Until the TODO page settings are filled in, pages are
      # skipped with a warning.
      - name: Capture pages
        working-directory: \${{ runner.temp }}/design-kit-cli
        env:
          DESIGN_KIT_USERNAME: \${{ secrets.DESIGN_KIT_USERNAME }}
          DESIGN_KIT_PASSWORD: \${{ secrets.DESIGN_KIT_PASSWORD }}
        run: |
          if grep -q '"${TODO}' "$CONFIG"; then
            echo "::warning title=Design kit::${at(CONFIG_NAME)} still has ${TODO} page settings, so no pages were captured. Fill them in, or remove the pages section."
          else
            design-kit capture pages --config "$CONFIG"
          fi

      # Nothing captured yet (no stories, and the pages still have ${TODO}s):
      # the run ends here with a warning instead of failing to upload.
      - name: Nothing to capture yet
        if: hashFiles('${at("design-kit")}/manifest.json') == ''
        run: |
          echo "::warning title=Design kit::Nothing to capture yet, so no kit was uploaded: ${at(CONFIG_NAME)} has no stories and its pages still have ${TODO} settings. Fill in the pages (or add Storybook) and run this workflow again."

      - id: upload
        if: hashFiles('${at("design-kit")}/manifest.json') != ''
        uses: actions/upload-artifact@v5
        with:
          name: design-kit
          path: ${at("design-kit")}
          # The most a public repository allows. A private repository may
          # raise it to 400 (and DESIGN_KIT_MAX_AGE_DAYS with it).
          retention-days: ${RETENTION_DAYS}
          if-no-files-found: error

  # Deletes this branch's older kits once the new one is uploaded. The only
  # job that may delete artifacts; a failed delete is a warning.
  cleanup:
    name: Delete older kits
    needs: build
    if: needs.build.outputs.artifact-id != ''
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: write
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: "22"

      - continue-on-error: true
        env:
          GH_TOKEN: \${{ github.token }}
          KEEP: \${{ needs.build.outputs.artifact-id }}
        run: npx --yes -p "$DESIGN_KIT_PACKAGE" design-kit ci-cleanup --keep "$KEEP"
`;
}

/** .claude/skills/design-kit/SKILL.md, as text. */
export function buildSkill(found) {
  const pm = found.packageManager;
  const projectDir = posix(relative(found.repoRoot, found.project)) || ".";
  const cli = `npx --yes -p ${PACKAGE.name}@${PACKAGE.version} -p @playwright/test@${playwrightPin()} design-kit`;
  const values = {
    CLI: cli,
    CONFIG: projectDir === "." ? CONFIG_NAME : `${projectDir}/${CONFIG_NAME}`,
    PROJECT_DIR: projectDir,
    STORIES_LINE: found.storybook
      ? `$DK capture stories --config "$CONFIG" --out "$KIT"   # builds Storybook first`
      : `# (no Storybook: this kit has pages only)`,
    PACKAGE: PACKAGE.name,
    INSTALL: installCommand(pm),
    // The capture drives the project's own Playwright when it has one.
    PLAYWRIGHT_INSTALL: found.playwright
      ? `${execBin(pm)} playwright install chromium`
      : `npx --yes -p @playwright/test@${playwrightPin()} playwright install chromium`,
  };
  const template = readFileSync(SKILL_TEMPLATE, "utf8");
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    key in values ? values[key] : match,
  );
}

const AGENTS_LINE =
  "- **Mockups and UI designs:** use the `design-kit` skill (`.claude/skills/design-kit/SKILL.md`). It composes mockups from this app's real pages and components, which `.github/workflows/design-kit.yml` captures every day.";

function agentsSkillMode(repoRoot) {
  const dir = join(repoRoot, ".agents", "skills");
  const entries = safeReaddir(dir);
  if (entries.some((entry) => entry.isSymbolicLink())) return "symlink";
  if (entries.some((entry) => entry.isDirectory())) return "copy";
  return "symlink";
}

function instructionsFile(repoRoot) {
  for (const name of ["AGENTS.md", "CLAUDE.md"])
    if (existsSync(join(repoRoot, name))) return name;
  return "AGENTS.md";
}

/**
 * The plan: every file init writes, with its content, and the notes for the
 * summary. Nothing is written here.
 */
export function planInit(found) {
  const at = (path) => join(found.repoRoot, path);
  const skill = buildSkill(found);
  const instructions = instructionsFile(found.repoRoot);
  const instructionsText = readText(at(instructions));
  const writes = [
    {
      path: join(found.project, CONFIG_NAME),
      kind: "file",
      content: `${JSON.stringify(buildConfig(found), null, 2)}\n`,
    },
    { path: at(WORKFLOW_PATH), kind: "file", content: buildWorkflow(found) },
    { path: at(`${SKILL_DIR}/SKILL.md`), kind: "file", content: skill },
    agentsSkillMode(found.repoRoot) === "symlink"
      ? {
          path: at(AGENTS_SKILL_DIR),
          kind: "symlink",
          target: posix(relative(dirname(at(AGENTS_SKILL_DIR)), at(SKILL_DIR))),
        }
      : { path: at(AGENTS_SKILL_DIR), kind: "copy", from: at(SKILL_DIR) },
  ];
  if (instructionsText?.includes("skills/design-kit"))
    writes.push({ path: at(instructions), kind: "unchanged" });
  else
    writes.push({
      path: at(instructions),
      kind: instructionsText === null ? "file" : "append",
      content:
        instructionsText === null
          ? `# Agent instructions\n\n${AGENTS_LINE}\n`
          : `${instructionsText.endsWith("\n") ? "" : "\n"}\n${AGENTS_LINE}\n`,
    });
  return { writes };
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function apply(write) {
  mkdirSync(dirname(write.path), { recursive: true });
  if (write.kind === "file") writeFileSync(write.path, write.content);
  else if (write.kind === "append")
    writeFileSync(write.path, write.content, { flag: "a" });
  else if (write.kind === "symlink") {
    rmSync(write.path, { recursive: true, force: true });
    symlinkSync(write.target, write.path, "dir");
  } else if (write.kind === "copy") {
    rmSync(write.path, { recursive: true, force: true });
    cpSync(write.from, write.path, { recursive: true });
  }
}

// ── the summary ─────────────────────────────────────────────────────────────

function describe(found) {
  const rel = (path) => posix(relative(found.repoRoot, path)) || ".";
  const pm = found.packageManager;
  const sb = found.storybook;
  return [
    [
      "Storybook",
      sb
        ? `${sb.version ?? "version unknown"} in ${rel(sb.dir)}${sb.hasConfig ? " (.storybook)" : " (no .storybook folder)"}${found.otherStorybooks.length ? `; also in ${found.otherStorybooks.map(rel).join(", ")}` : ""}`
        : "none",
    ],
    [
      "Framework",
      found.framework
        ? `${found.framework.name} in ${rel(found.framework.dir)}`
        : "not recognized (other)",
    ],
    [
      "Packages",
      `${pm.name}${pm.version ? ` ${pm.version}` : ""}${pm.lockfile ? ` (${rel(join(pm.installDir, pm.lockfile))})` : " (no lockfile)"}`,
    ],
    [
      "Dev script",
      found.dev
        ? `${found.dev.command} -> ${found.appUrl.url} (from ${found.appUrl.source})`
        : "none found",
    ],
    [
      "Playwright",
      found.playwright
        ? `${found.playwright.name}${found.playwright.version ? ` ${found.playwright.version}` : ""}`
        : "none (the workflow installs its own)",
    ],
    ["Rebuilds on", watchDefaults(found).join(", ")],
    [
      "Theme",
      found.theme.evidence
        ? `${found.theme.attribute === "class" ? `class "${found.theme.dark}"` : `${found.theme.attribute}="${found.theme.dark}"`} (from ${found.theme.evidence})`
        : `class "dark" (a guess: no dark theme found)`,
    ],
  ];
}

function todo(found) {
  const items = [];
  const sb = found.storybook;
  if (!sb)
    items.push(
      "No Storybook: the config captures pages only. Decide whether to add Storybook with stories for the components the main screens use (`npx --yes @codepress/design-kit storybook-guide` prints a guide for that), capture real pages, or both.",
    );
  else if (sb.major && (sb.major < 7 || sb.major > 9))
    items.push(
      `Storybook ${sb.version}: captures are supported for Storybook 7, 8 and 9 static builds; check that \`capture stories\` works, or use page capture.`,
    );
  items.push(
    `Pages: replace the ${TODO} selectors in ${CONFIG_NAME} (pages[].ready and slots.main), add the app's main screens, and check startCommand and waitUrl. Until then the workflow skips page capture.`,
  );
  if (!found.dev)
    items.push(
      "No dev or start script found: set pages.startCommand to the command that serves the app.",
    );
  items.push(
    "Sign-in: if the pages need a signed-in user, use a seeded test user or the app's mock mode, and a sign-in module (pages.auth.setup) that reads repository secrets in CI. Never commit a credential.",
  );
  if (!found.theme.evidence)
    items.push(
      "Theme: no dark theme was found; check the theme section, or remove it if the app has no dark mode.",
    );
  items.push(
    "Build the kit once locally (see the design-kit skill) and say in the pull request what it captured and what it missed.",
  );
  return items;
}

function summary(found, plan, { dryRun, workflowOnly, notes }) {
  const rel = (path) => posix(relative(found.repoRoot, path)) || ".";
  const lines = [
    `design-kit init${workflowOnly ? " --workflow-only" : ""}${dryRun ? " --dry-run" : ""}: ${found.project}`,
    "",
    "Found",
  ];
  const rows = describe(found);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows)
    lines.push(`  ${label.padEnd(width)}  ${value}`);
  lines.push("", dryRun ? "Would write" : "Wrote");
  for (const write of plan.writes) {
    const note =
      write.kind === "symlink"
        ? ` -> ${write.target}`
        : write.kind === "copy"
          ? ` (a copy of ${rel(write.from)})`
          : write.kind === "append"
            ? " (one line added)"
            : write.kind === "unchanged"
              ? " (unchanged: it already points at the skill)"
              : "";
    lines.push(`  ${rel(write.path)}${note}`);
  }
  lines.push("", "Still to decide");
  for (const item of notes ?? todo(found)) lines.push(`  - ${item}`);
  return lines.join("\n");
}

// ── the command ─────────────────────────────────────────────────────────────

/**
 * `init --workflow-only`: rewrites .github/workflows/design-kit.yml from
 * this version and nothing else. The config is left alone; when it has no
 * `watch` list, the summary prints the one init would write.
 */
function initWorkflowOnly(found, { dryRun, force, log }) {
  const configFile = join(found.project, CONFIG_NAME);
  if (!exists(configFile))
    throw new InitError(
      `${configFile} does not exist, so there is no kit to build yet. Run init without --workflow-only.`,
    );
  const path = join(found.repoRoot, WORKFLOW_PATH);
  if (!force && exists(path))
    throw new InitError(
      `${WORKFLOW_PATH} already exists. Nothing was written; pass --force with --workflow-only to replace it.`,
    );
  const plan = {
    writes: [{ path, kind: "file", content: buildWorkflow(found) }],
  };
  if (!dryRun) apply(plan.writes[0]);
  const notes = [];
  const raw = readJson(configFile);
  if (!Array.isArray(raw?.watch) || !raw.watch.length)
    notes.push(
      `${CONFIG_NAME} has no "watch" list, so the kit rebuilds after any commit. To rebuild only when the UI changes, add:\n    "watch": ${JSON.stringify(watchDefaults(found))}`,
    );
  else notes.push(`Nothing: ${CONFIG_NAME} already has a "watch" list.`);
  log(summary(found, plan, { dryRun, workflowOnly: true, notes }));
  return 0;
}

/**
 * Runs init. Options: `root` (the project folder, default the working
 * directory), `dryRun`, `force`, `workflowOnly` (write just the workflow, for
 * a repository set up by an older version), `log`. Returns the exit code: 0
 * done, 1 already set up or another file in the way.
 */
export function init({
  root = ".",
  dryRun = false,
  force = false,
  workflowOnly = false,
  log = console.log,
} = {}) {
  const found = detectProject(root);
  if (workflowOnly) return initWorkflowOnly(found, { dryRun, force, log });
  const plan = planInit(found);
  if (!force) {
    const config = join(found.project, CONFIG_NAME);
    if (exists(config))
      throw new InitError(
        `already set up: ${config} exists. Nothing was written; pass --force to replace the files init writes.`,
      );
    const inTheWay = plan.writes
      .filter(
        (write) =>
          write.kind === "file" ||
          write.kind === "symlink" ||
          write.kind === "copy",
      )
      .filter((write) => exists(write.path))
      .map((write) => posix(relative(found.repoRoot, write.path)));
    if (inTheWay.length)
      throw new InitError(
        `${inTheWay.join(", ")} already exist${inTheWay.length === 1 ? "s" : ""}. Nothing was written; pass --force to replace ${inTheWay.length === 1 ? "it" : "them"}.`,
      );
  }
  if (!dryRun) {
    // The skill folder is written before the copy or link that points at it.
    for (const write of plan.writes)
      if (write.kind !== "unchanged") apply(write);
  }
  log(summary(found, plan, { dryRun }));
  if (!dryRun) log(`\n${CALL_TO_ACTION}`);
  return 0;
}
