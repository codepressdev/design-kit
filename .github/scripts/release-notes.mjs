#!/usr/bin/env node
/**
 * The GitHub Release for one version tag of @codepress/design-kit, used by
 * .github/workflows/release.yml. This file is synced from CodePress's
 * monorepo; change it there.
 *
 *   node .github/scripts/release-notes.mjs <tag> <notes-file>
 *
 * Writes the release notes for <tag> (such as v0.2.1) to <notes-file>: that
 * version's section of CHANGELOG.md as it is at <tag>, then a link to the
 * version on npm. It
 * prints `latest=true` when <tag> is the highest release version among the
 * repository's v* tags (`latest=false` otherwise) and `prerelease=true|false`,
 * in the form $GITHUB_OUTPUT takes.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@codepress/design-kit";
const VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** The parts of a semver string, or null when it is not one. */
export function parseVersion(version) {
  const match = VERSION.exec(version);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++)
    if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.prerelease.length || !y.prerelease.length)
    return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const [p, q] = [x.prerelease[i], y.prerelease[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * True when `version` is a release (not a prerelease) at least as high as
 * every other release among `tags` (names such as v0.2.0; others are ignored).
 */
export function isLatest(version, tags) {
  if (parseVersion(version)?.prerelease.length !== 0) return false;
  return tags
    .map((tag) => tag.replace(/^v/, ""))
    .filter((other) => parseVersion(other)?.prerelease.length === 0)
    .every((other) => compareVersions(version, other) >= 0);
}

/**
 * The body of `version`'s `## <version>` section in a Changesets
 * CHANGELOG.md, or null when it has none. A bullet's leading commit hash
 * ("- 03dea05: ") is dropped: it names a commit in CodePress's monorepo,
 * which is not in this repository.
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .map((line) => line.replace(/^(\s*[-*] )[0-9a-f]{7,40}: /, "$1"))
    .join("\n")
    .trim();
  return body || null;
}

/** The npm page of one version of the package. */
export const npmUrl = (version) =>
  `https://www.npmjs.com/package/${PACKAGE}/v/${version}`;

/** The release notes: the CHANGELOG section, then the npm link. */
export function releaseNotes(changelog, version) {
  const section = changelogSection(changelog, version);
  return `${section ? `${section}\n\n` : ""}On npm: [${PACKAGE}@${version}](${npmUrl(version)})\n`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [tag, notesFile] = process.argv.slice(2);
  const version = tag?.replace(/^v/, "");
  if (!tag?.startsWith("v") || !parseVersion(version) || !notesFile) {
    console.error("usage: release-notes.mjs <tag such as v0.2.1> <notes-file>");
    process.exit(1);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  const changelog = git("show", `refs/tags/${tag}:CHANGELOG.md`);
  writeFileSync(notesFile, releaseNotes(changelog, version));
  console.log(`latest=${isLatest(version, tags)}`);
  console.log(`prerelease=${parseVersion(version).prerelease.length > 0}`);
}
