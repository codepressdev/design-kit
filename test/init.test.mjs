import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, mock, test } from "node:test";

import { parse as parseYaml } from "yaml";

import { main } from "../src/cli.mjs";
import { resolveConfig } from "../src/config.mjs";
import { CALL_TO_ACTION } from "../src/init.mjs";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const scratch = mkdtempSync(join(tmpdir(), "design-kit-init-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** A repository folder (with a .git folder) holding `files`. */
function repo(files) {
  const root = join(scratch, `repo-${(counter += 1)}`);
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

/** Every file under `root` (but .git) with its content; links as "-> target". */
function snapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        files[relative(root, path)] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

/** Runs the CLI in-process; returns its exit code and what it printed. */
async function cli(args) {
  const lines = [];
  const spies = [
    mock.method(console, "log", (text) => lines.push(String(text))),
    mock.method(console, "error", (text) => lines.push(String(text))),
  ];
  try {
    return { code: await main(args), output: lines.join("\n") };
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The workflow's jobs, by name, as text. */
function jobsOf(workflow) {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const jobs = {};
  for (const part of body.split(/\n(?= {2}[a-z-]+:\n)/)) {
    const name = part.match(/^ {2}([a-z-]+):/)?.[1];
    if (name) jobs[name] = part;
  }
  return jobs;
}

const storybookRepo = () =>
  repo({
    "package.json": {
      name: "shop",
      scripts: { dev: "vite", storybook: "storybook dev -p 6006" },
      devDependencies: {
        storybook: "^8.6.0",
        "@storybook/react-vite": "^8.6.0",
        vite: "^6.0.0",
        "@playwright/test": "^1.50.0",
      },
    },
    "package-lock.json": "{}",
    ".nvmrc": "22\n",
    ".storybook/main.js": "export default {};",
    "src/Button.jsx": "export const Button = () => null;",
    "src/theme.css": ".dark { --bg: black; }",
    "playwright.config.ts":
      'export default { use: { baseURL: "http://localhost:4173" } };',
  });

test("init in a repository with Storybook writes the config, workflow, skill and AGENTS.md line", async () => {
  const root = storybookRepo();
  const result = await cli(["init", "--root", root]);
  assert.equal(result.code, 0, result.output);
  // It ends with the one call-to-action line.
  assert.equal(
    CALL_TO_ACTION,
    "Want every screen on one canvas, shareable with your team, and agents that build it? → https://codepress.dev",
  );
  assert.ok(result.output.endsWith(`\n\n${CALL_TO_ACTION}`), result.output);

  const config = readJson(join(root, "design-kit.config.json"));
  // It is a valid v1 config as written.
  resolveConfig(structuredClone(config), join(root, "design-kit.config.json"));
  assert.deepEqual(config.theme, { attribute: "class", dark: "dark" });
  assert.deepEqual(config.stories, {
    root: ".",
    buildCommand: "npx storybook build --quiet -o storybook-static",
    staticDir: "storybook-static",
    gaps: { componentGlob: "src/**/[A-Z]*.{tsx,jsx,vue,svelte}" },
  });
  assert.equal(config.pages.startCommand, "npm run dev");
  assert.equal(config.pages.waitUrl, "http://localhost:4173/");
  assert.match(config.pages.pages[0].ready, /^TODO/);
  assert.match(config.pages.pages[0].slots.main[0], /^TODO/);

  const workflow = readFileSync(
    join(root, ".github/workflows/design-kit.yml"),
    "utf8",
  );
  assert.match(workflow, /cron: "23 5 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /node-version-file: \.nvmrc/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /design-kit capture stories --config "\$CONFIG"/);
  assert.match(workflow, /design-kit capture pages --config "\$CONFIG"/);
  assert.deepEqual(config.watch, [
    ".storybook",
    "package.json",
    "src",
    "design-kit.config.json",
    "package-lock.json",
    ".github/workflows/design-kit.yml",
  ]);
  const jobs = jobsOf(workflow);
  assert.deepEqual(Object.keys(jobs), ["check", "build", "cleanup"]);
  assert.match(
    jobs.build,
    /name: design-kit\n\s+path: design-kit\n(\s+#.*\n)*\s+retention-days: 90\n/,
  );
  assert.match(jobs.build, /# .*private repository may\n.*raise it to 400/);
  // Deleting artifacts is allowed in the cleanup job only.
  assert.match(jobs.cleanup, /permissions:\n\s+actions: write\n/);
  assert.match(jobs.cleanup, /needs: build\n/);
  assert.match(jobs.cleanup, /continue-on-error: true/);
  assert.match(jobs.cleanup, /design-kit ci-cleanup --keep "\$KEEP"/);
  assert.match(
    jobs.check,
    /permissions:\n\s+contents: read\n\s+actions: read\n/,
  );
  assert.match(jobs.check, /design-kit ci-check --config "\$CONFIG"/);
  assert.match(jobs.check, /sparse-checkout: design-kit\.config\.json\n/);
  assert.doesNotMatch(workflow.replace(jobs.cleanup, ""), /actions: write/);
  assert.match(workflow, /DESIGN_KIT_MAX_AGE_DAYS: "75"/);
  assert.match(
    workflow,
    /DESIGN_KIT_PACKAGE: "@codepress\/design-kit@\d+\.\d+\.\d+"/,
  );

  const skill = readFileSync(
    join(root, ".claude/skills/design-kit/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: design-kit\n/);
  assert.doesNotMatch(skill, /\{\{[A-Z_]+\}\}/);
  assert.match(skill, /npx playwright install chromium/);
  assert.equal(
    readlinkSync(join(root, ".agents/skills/design-kit")),
    "../../.claude/skills/design-kit",
  );
  assert.match(
    readFileSync(join(root, "AGENTS.md"), "utf8"),
    /^# Agent instructions\n\n- \*\*Mockups and UI designs:\*\* use the `design-kit` skill/,
  );
  assert.match(result.output, /Storybook\s+\^8\.6\.0 in \. \(\.storybook\)/);
  assert.match(
    result.output,
    /Still to decide\n {2}- Pages: replace the TODO selectors/,
  );
});

test("init without Storybook writes a pages-only config with TODO selectors and says so", async () => {
  const root = repo({
    "package.json": {
      name: "site",
      packageManager: "pnpm@9.15.0",
      scripts: { dev: "next dev" },
      dependencies: { next: "15.0.0", "next-themes": "0.4.0" },
    },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "app/layout.tsx":
      '<ThemeProvider attribute="data-theme">{children}</ThemeProvider>',
    "app/globals.css": '[data-theme="dark"] { --bg: black; }',
  });
  const result = await cli(["init", "--root", root]);
  assert.equal(result.code, 0, result.output);
  // It ends with the one call-to-action line.
  assert.equal(
    CALL_TO_ACTION,
    "Want every screen on one canvas, shareable with your team, and agents that build it? → https://codepress.dev",
  );
  assert.ok(result.output.endsWith(`\n\n${CALL_TO_ACTION}`), result.output);

  const config = readJson(join(root, "design-kit.config.json"));
  assert.equal(config.stories, undefined);
  // Pages only: the app's folders and config, plus the lockfile and workflow.
  assert.deepEqual(config.watch, [
    "app",
    "package.json",
    "design-kit.config.json",
    "pnpm-lock.yaml",
    ".github/workflows/design-kit.yml",
  ]);
  assert.deepEqual(config.theme, { attribute: "data-theme", dark: "dark" });
  assert.equal(config.pages.startCommand, "pnpm run dev");
  assert.equal(config.pages.waitUrl, "http://localhost:3000/");
  assert.match(config.pages.pages[0].ready, /^TODO/);

  const workflow = readFileSync(
    join(root, ".github/workflows/design-kit.yml"),
    "utf8",
  );
  assert.doesNotMatch(workflow, /capture stories/);
  // With nothing captured yet (no stories, pages still TODO), the run warns
  // and skips the upload instead of failing at it.
  const steps = workflow.split(/\n(?= {6}- )/);
  const nothing = steps.find((step) =>
    step.includes("name: Nothing to capture yet"),
  );
  assert.ok(nothing, "a step explains an empty run");
  assert.match(nothing, /if: hashFiles\('design-kit\/manifest\.json'\) == ''/);
  assert.match(
    nothing,
    /::warning title=Design kit::Nothing to capture yet, so no kit was uploaded/,
  );
  const upload = steps.find((step) =>
    step.includes("uses: actions/upload-artifact@v5"),
  );
  assert.match(upload, /if: hashFiles\('design-kit\/manifest\.json'\) != ''/);
  assert.ok(steps.indexOf(nothing) < steps.indexOf(upload));
  assert.match(workflow, /uses: pnpm\/action-setup@v6\n/);
  assert.match(workflow, /cache: pnpm/);
  assert.match(workflow, /run: pnpm install --frozen-lockfile/);
  assert.match(
    result.output,
    /No Storybook: the config captures pages only\. Decide whether to add Storybook/,
  );
  assert.match(result.output, /Framework\s+Next\.js in \./);
});

test("init where design-kit.config.json exists exits 1, already set up, and writes nothing", async () => {
  const root = storybookRepo();
  writeFileSync(join(root, "design-kit.config.json"), '{"version":1}');
  const before = snapshot(root);
  const result = await cli(["init", "--root", root]);
  assert.equal(result.code, 1);
  assert.match(result.output, /already set up/);
  assert.ok(!result.output.includes(CALL_TO_ACTION), result.output);
  assert.deepEqual(snapshot(root), before);
});

test("init refuses to replace any other file it would write, unless --force", async () => {
  const root = storybookRepo();
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/design-kit.yml"), "mine");
  const before = snapshot(root);
  const refused = await cli(["init", "--root", root]);
  assert.equal(refused.code, 1);
  assert.match(
    refused.output,
    /\.github\/workflows\/design-kit\.yml already exists/,
  );
  assert.deepEqual(snapshot(root), before);

  const forced = await cli(["init", "--root", root, "--force"]);
  assert.equal(forced.code, 0, forced.output);
  assert.notEqual(
    readFileSync(join(root, ".github/workflows/design-kit.yml"), "utf8"),
    "mine",
  );
  // A second forced run replaces the files but adds no second line.
  assert.equal((await cli(["init", "--root", root, "--force"])).code, 0);
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.equal(agents.match(/design-kit` skill/g).length, 1);
});

test("--dry-run prints the plan and writes nothing", async () => {
  const root = storybookRepo();
  const before = snapshot(root);
  const result = await cli(["init", "--root", root, "--dry-run"]);
  assert.equal(result.code, 0, result.output);
  assert.match(
    result.output,
    /Would write\n {2}design-kit\.config\.json\n {2}\.github\/workflows\/design-kit\.yml/,
  );
  assert.ok(!result.output.includes(CALL_TO_ACTION), result.output);
  assert.deepEqual(snapshot(root), before);
});

test("--root puts the config in the subpackage and the workflow, skill and line at the repository root", async () => {
  const root = repo({
    "package.json": { name: "mono", private: true, workspaces: ["apps/*"] },
    "yarn.lock": "",
    "CLAUDE.md": "# Rules\n",
    ".agents/skills/other/SKILL.md": "---\nname: other\n---\n",
    "apps/web/package.json": {
      name: "@mono/web",
      scripts: { start: "react-scripts start" },
      dependencies: { "react-scripts": "5.0.1" },
    },
  });
  const result = await cli(["init", "--root", join(root, "apps/web")]);
  assert.equal(result.code, 0, result.output);
  assert.ok(existsSync(join(root, "apps/web/design-kit.config.json")));
  assert.ok(!existsSync(join(root, "design-kit.config.json")));
  // The config sits in apps/web, which is watched whole.
  assert.deepEqual(
    readJson(join(root, "apps/web/design-kit.config.json")).watch,
    ["apps/web", "yarn.lock", ".github/workflows/design-kit.yml"],
  );

  const workflow = readFileSync(
    join(root, ".github/workflows/design-kit.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /CONFIG: \$\{\{ github\.workspace \}\}\/apps\/web\/design-kit\.config\.json/,
  );
  assert.match(workflow, /path: apps\/web\/design-kit\n/);
  // The empty-run guard looks where the subpackage writes its kit.
  assert.match(
    workflow,
    /hashFiles\('apps\/web\/design-kit\/manifest\.json'\) != ''/,
  );
  assert.match(workflow, /run: yarn install --frozen-lockfile/);
  // The repository keeps real folders in .agents/skills, so the skill is copied.
  assert.ok(lstatSync(join(root, ".agents/skills/design-kit")).isDirectory());
  assert.equal(
    readFileSync(join(root, ".agents/skills/design-kit/SKILL.md"), "utf8"),
    readFileSync(join(root, ".claude/skills/design-kit/SKILL.md"), "utf8"),
  );
  // CLAUDE.md exists and AGENTS.md does not: the line goes into CLAUDE.md.
  assert.match(
    readFileSync(join(root, "CLAUDE.md"), "utf8"),
    /^# Rules\n\n- \*\*Mockups and UI designs:\*\*/,
  );
  assert.ok(!existsSync(join(root, "AGENTS.md")));
  assert.equal(
    readJson(join(root, "apps/web/design-kit.config.json")).pages.startCommand,
    "yarn run start",
  );
});

test("nothing init writes names the vendor's internals or carries a secret", async () => {
  const root = storybookRepo();
  assert.equal((await cli(["init", "--root", root])).code, 0);
  const before = snapshot(storybookRepo());
  const written = Object.entries(snapshot(root)).filter(
    ([path]) => !(path in before),
  );
  assert.ok(written.length >= 4);
  for (const [path, text] of written) {
    assert.doesNotMatch(
      text,
      /quantfive|verification-fixture|CodePress|Orchestrator/,
      path,
    );
    assert.doesNotMatch(
      text,
      /(?:password|token|secret)\s*[:=]\s*["'][^"']+/i,
      path,
    );
  }
});

test("in a workspace monorepo, watch holds the app and the shared UI package it uses, not unrelated packages", async () => {
  const root = repo({
    "package.json": {
      name: "mono",
      private: true,
      packageManager: "pnpm@9.15.0",
    },
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tailwind.config.ts": "export default {};",
    "styles/tokens.css": ":root { --brand: red; }",
    "apps/web/package.json": {
      name: "@mono/web",
      scripts: { dev: "next dev" },
      dependencies: { next: "15.0.0", "@mono/ui": "workspace:*" },
    },
    "packages/ui/package.json": {
      name: "@mono/ui",
      dependencies: { "@mono/tokens": "workspace:*" },
    },
    "packages/tokens/package.json": { name: "@mono/tokens" },
    "packages/api/package.json": { name: "@mono/api" },
  });
  const result = await cli(["init", "--root", root]);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(readJson(join(root, "design-kit.config.json")).watch, [
    "apps/web",
    "packages/ui",
    "packages/tokens",
    "styles",
    "tailwind.config.ts",
    "design-kit.config.json",
    "pnpm-lock.yaml",
    ".github/workflows/design-kit.yml",
  ]);
  assert.match(
    result.output,
    /Rebuilds on\s+apps\/web, packages\/ui, packages\/tokens/,
  );
});

test("init --workflow-only --force rewrites just the workflow and suggests a watch list", async () => {
  const root = storybookRepo();
  assert.equal((await cli(["init", "--root", root])).code, 0);
  const config = join(root, "design-kit.config.json");
  // An older setup: no watch list, an older workflow.
  const old = readJson(config);
  delete old.watch;
  writeFileSync(config, JSON.stringify(old));
  const workflow = join(root, ".github/workflows/design-kit.yml");
  writeFileSync(workflow, "old workflow");
  const before = snapshot(root);

  const refused = await cli(["init", "--root", root, "--workflow-only"]);
  assert.equal(refused.code, 1);
  assert.match(refused.output, /pass --force with --workflow-only/);
  assert.deepEqual(snapshot(root), before);

  const result = await cli([
    "init",
    "--root",
    root,
    "--workflow-only",
    "--force",
  ]);
  assert.equal(result.code, 0, result.output);
  const after = snapshot(root);
  for (const path of Object.keys(before))
    if (path !== ".github/workflows/design-kit.yml")
      assert.equal(after[path], before[path], path);
  assert.match(readFileSync(workflow, "utf8"), /design-kit ci-check/);
  assert.match(
    result.output,
    /Wrote\n {2}\.github\/workflows\/design-kit\.yml\n\n/,
  );
  assert.match(
    result.output,
    /has no "watch" list[\s\S]*"watch": \[".storybook","package.json","src"/,
  );
});

test("init --workflow-only without a config says to run init", async () => {
  const root = storybookRepo();
  const result = await cli(["init", "--root", root, "--workflow-only"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /Run init without --workflow-only/);
});

/** The workflow init wrote in `root`, parsed (a YAML error throws). */
const workflowOf = (root) =>
  parseYaml(
    readFileSync(join(root, ".github/workflows/design-kit.yml"), "utf8"),
  );
const stepsUsing = (workflow, pattern) =>
  Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => pattern.test(step.uses ?? step.run ?? "")),
  );

test("the default (github) workflow parses as YAML and uploads an artifact", async () => {
  const root = storybookRepo();
  assert.equal((await cli(["init", "--root", root])).code, 0);
  const workflow = workflowOf(root);
  assert.deepEqual(Object.keys(workflow.jobs), ["check", "build", "cleanup"]);
  assert.equal(stepsUsing(workflow, /^actions\/upload-artifact@/).length, 1);
  assert.equal(stepsUsing(workflow, /design-kit upload/).length, 0);
  assert.equal(
    "storage" in readJson(join(root, "design-kit.config.json")),
    false,
  );
});

test("init --storage codepress: id-token: write only on the build job, design-kit upload and no artifact step", async () => {
  const root = storybookRepo();
  const result = await cli(["init", "--root", root, "--storage", "codepress"]);
  assert.equal(result.code, 0, result.output);
  const config = readJson(join(root, "design-kit.config.json"));
  assert.deepEqual(config.storage, { type: "codepress" });
  // The key and the version that knows it are written together.
  assert.match(config.$schema, new RegExp(`@${VERSION}/schema/`));
  resolveConfig(structuredClone(config), join(root, "design-kit.config.json"));

  const workflow = workflowOf(root);
  assert.equal(
    workflow.env.DESIGN_KIT_PACKAGE,
    `@codepress/design-kit@${VERSION}`,
  );
  assert.deepEqual(Object.keys(workflow.jobs), ["check", "build"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.build.permissions, {
    contents: "read",
    "id-token": "write",
  });
  // The check reads the newest kit with its own OIDC token when there is
  // no API key secret, so it is the one other job with id-token: write.
  assert.deepEqual(workflow.jobs.check.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(stepsUsing(workflow, /upload-artifact/).length, 0);
  const [upload] = stepsUsing(workflow, /design-kit upload/);
  assert.equal(upload.if, "hashFiles('design-kit/manifest.json') != ''");
  assert.match(upload.run, /--dir "\$GITHUB_WORKSPACE\/design-kit"/);
  const check = workflow.jobs.check.steps.find((step) => step.id === "check");
  assert.equal(check.env.CODEPRESS_API_KEY, "${{ secrets.CODEPRESS_API_KEY }}");
  assert.equal(check.env.GH_TOKEN, undefined);
  assert.match(result.output, /Connect this repository in CodePress/);
});

test("init --storage r2 maps the R2 token's secrets to the AWS variables, and asks for the account id and bucket", async () => {
  const root = storybookRepo();
  const result = await cli(["init", "--root", root, "--storage", "r2"]);
  assert.equal(result.code, 0, result.output);
  const workflow = workflowOf(root);
  const [upload] = stepsUsing(workflow, /design-kit upload/);
  const check = workflow.jobs.check.steps.find((step) => step.id === "check");
  for (const env of [upload.env, check.env])
    assert.deepEqual(
      [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY],
      [
        "${{ secrets.R2_ACCESS_KEY_ID }}",
        "${{ secrets.R2_SECRET_ACCESS_KEY }}",
      ],
    );
  assert.equal(workflow.jobs.build.permissions, undefined);
  assert.equal(stepsUsing(workflow, /upload-artifact/).length, 0);
  const config = readJson(join(root, "design-kit.config.json"));
  assert.equal(config.storage.type, "r2");
  // The TODOs stop the config validating until they are filled in.
  assert.throws(
    () => resolveConfig(config, join(root, "design-kit.config.json")),
    /storage\.accountId: still TODO/,
  );
  assert.match(result.output, /R2 API token with Object Read & Write/);

  const s3 = storybookRepo();
  assert.equal((await cli(["init", "--root", s3, "--storage", "s3"])).code, 0);
  const [s3Upload] = stepsUsing(workflowOf(s3), /design-kit upload/);
  assert.equal(
    s3Upload.env.AWS_ACCESS_KEY_ID,
    "${{ secrets.AWS_ACCESS_KEY_ID }}",
  );
});

test("init --workflow-only --force --storage sets the key in an existing config and rewrites the workflow; plain init points there", async () => {
  const root = storybookRepo();
  assert.equal((await cli(["init", "--root", root])).code, 0);
  const configFile = join(root, "design-kit.config.json");
  const old = readJson(configFile);
  old.$schema = old.$schema.replace(/@[^/]+\/schema/, "@0.4.0/schema");
  old.out = "kit-out";
  writeFileSync(configFile, JSON.stringify(old));

  const refused = await cli(["init", "--root", root, "--storage", "codepress"]);
  assert.equal(refused.code, 1);
  assert.match(
    refused.output,
    /init --workflow-only --force --storage codepress/,
  );

  const result = await cli([
    "init",
    "--root",
    root,
    "--workflow-only",
    "--force",
    "--storage",
    "codepress",
  ]);
  assert.equal(result.code, 0, result.output);
  const updated = readJson(configFile);
  assert.deepEqual(Object.keys(updated), [
    "$schema",
    "version",
    "out",
    "storage",
    ...Object.keys(old).slice(3),
  ]);
  assert.deepEqual(updated.storage, { type: "codepress" });
  assert.match(updated.$schema, new RegExp(`@${VERSION}/schema/`));
  for (const key of Object.keys(old))
    if (key !== "$schema") assert.deepEqual(updated[key], old[key], key);
  assert.ok(workflowOf(root).jobs.build.permissions["id-token"]);

  // Rewriting the workflow again keeps the config's storage.
  assert.equal(
    (await cli(["init", "--root", root, "--workflow-only", "--force"])).code,
    0,
  );
  assert.equal(stepsUsing(workflowOf(root), /design-kit upload/).length, 1);

  const bad = await cli(["init", "--root", root, "--storage", "gcs"]);
  assert.equal(bad.code, 2);
  assert.match(bad.output, /--storage takes github, codepress, s3, r2/);
});
