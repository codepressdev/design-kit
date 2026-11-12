#!/usr/bin/env node
/**
 * Checks what `npm publish` would ship: the CLI, the kit tool, the schema and
 * the README, and none of the tests or fixtures. It packs the package for
 * real and reads the packed package.json, which must keep the `design-kit`
 * bin, and it fails when `npm publish --dry-run` auto-corrects package.json
 * (publish rewrites what it corrects in the manifest it sends to the
 * registry, so the shipped bin could differ from the one checked in).
 *
 * `NPM_SPEC` (such as `^11.5.1`) runs both through `npx npm@<spec>`, the npm
 * the publish job installs; without it, the npm on PATH.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.env.NPM_SPEC
  ? ["npx", ["--yes", `npm@${process.env.NPM_SPEC}`]]
  : ["npm", []];
const run = (args) =>
  spawnSync(npm[0], [...npm[1], ...args], { cwd: root, encoding: "utf8" });

const problems = [];
const out = mkdtempSync(
  join(process.env.TMPDIR || tmpdir(), "design-kit-pack-"),
);
try {
  const packed = run([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    out,
  ]);
  if (packed.status !== 0)
    throw new Error(`npm pack failed:\n${packed.stderr}`);
  const [pack] = JSON.parse(packed.stdout);
  const tarball = join(out, pack.filename);
  const npmVersion = run(["--version"]).stdout.trim();

  const files = pack.files.map((file) => file.path).sort();
  const required = [
    "bin/design-kit.mjs",
    "src/cli.mjs",
    "src/kit.mjs",
    "src/kit.d.ts",
    "src/init.mjs",
    "src/templates/design-kit-skill.md",
    "src/index.mjs",
    "src/index.d.ts",
    "schema/design-kit.config.schema.json",
    "skills/design-kit-setup/SKILL.md",
    "skills/storybook-setup/SKILL.md",
    "README.md",
    "LICENSE",
    "package.json",
  ];
  const missing = required.filter((file) => !files.includes(file));
  if (missing.length) problems.push(`missing: ${missing.join(", ")}`);
  const unexpected = files.filter((file) => /^(test|scripts)\//.test(file));
  if (unexpected.length)
    problems.push(`should not ship: ${unexpected.join(", ")}`);

  // The packed package.json, as npm wrote it into the tarball.
  const manifest = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const bin = manifest.bin?.["design-kit"];
  if (!bin) problems.push("the packed package.json has no bin.design-kit");
  else if (bin !== source.bin?.["design-kit"])
    problems.push(
      `the packed bin.design-kit is ${bin}, package.json says ${source.bin?.["design-kit"]}`,
    );
  else if (!files.includes(bin))
    problems.push(`bin.design-kit names ${bin}, which is not in the tarball`);
  const mode = execFileSync("tar", ["-tvzf", tarball, `package/${bin}`], {
    encoding: "utf8",
  });
  if (!/^-rwx/.test(mode))
    problems.push(`${bin} is not executable in the tarball: ${mode.trim()}`);

  // What publish would correct, it rewrites in the registry manifest.
  const dryRun = run([
    "publish",
    "--dry-run",
    "--ignore-scripts",
    "--access",
    "public",
  ]);
  const corrected = `${dryRun.stdout}\n${dryRun.stderr}`
    .split("\n")
    .filter((line) =>
      /auto-corrected|errors corrected|was invalid|removed invalid|was renamed/.test(
        line,
      ),
    );
  if (corrected.length)
    problems.push(
      `npm publish would auto-correct package.json:\n${corrected.join("\n")}`,
    );

  console.log(
    `${pack.name}@${pack.version} (npm ${npmVersion}): ${files.length} files, ${pack.size} bytes packed, bin.design-kit ${bin ?? "missing"}`,
  );
  for (const file of files) console.log(`  ${file}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}
