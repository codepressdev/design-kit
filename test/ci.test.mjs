import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, mock, test } from "node:test";

import {
  ciCheck,
  ciCheckCommand,
  decide,
  deleteOlderKits,
  findNewestKit,
  watchedIds,
} from "../src/ci.mjs";
import { main } from "../src/cli.mjs";
import { buildSkill, detectProject } from "../src/init.mjs";

const scratch = mkdtempSync(join(tmpdir(), "design-kit-ci-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-11T12:00:00Z");
const DAY = 86_400_000;
const fresh = new Date(NOW - 3 * DAY).toISOString();
const WATCH = ["src", "package.json", "gone", "design-kit.config.json"];

/**
 * One template history, built once and only read by the tests:
 *   A  the kit's commit
 *   B  docs only (outside `watch`)
 *   C  a change under src/
 *   D  gone/ deleted (HEAD)
 *   E  on top of D, off main: only src/other.js added
 * origin/main points at D, for the skill's staleness command. `origin.git`
 * is a bare copy that serves shallow, blobless fetches, and `shallow` a
 * depth-1, blobless clone of it: the check job's checkout.
 */
const originDir = join(scratch, "origin.git");
const shallowDir = join(scratch, "shallow");
/*
 */
const repoDir = join(scratch, "repo");
const sha = {};
before(() => {
  const g = (...args) =>
    execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repoDir, path)), { recursive: true });
      writeFileSync(join(repoDir, path), text);
    }
  };
  mkdirSync(repoDir, { recursive: true });
  g("init", "-q", "-b", "main");
  write({
    "design-kit.config.json": JSON.stringify({
      version: 1,
      watch: WATCH,
      pages: {
        baseUrl: "http://localhost:3000/",
        pages: [
          { name: "home", path: "/", ready: "main", slots: { main: ["main"] } },
        ],
      },
    }),
    "package.json": "{}",
    "src/Button.jsx": "export const Button = () => null;",
    "gone/old.css": ".old {}",
    "docs/README.md": "# Docs",
  });
  g("add", "-A");
  g("commit", "-qm", "A");
  sha.A = g("rev-parse", "HEAD");
  write({ "docs/README.md": "# Docs, edited" });
  g("commit", "-qam", "B");
  sha.B = g("rev-parse", "HEAD");
  write({ "src/Button.jsx": "export const Button = () => 'new';" });
  g("commit", "-qam", "C");
  sha.C = g("rev-parse", "HEAD");
  g("rm", "-rq", "gone");
  g("commit", "-qm", "D");
  sha.D = g("rev-parse", "HEAD");
  write({ "src/other.js": "export const other = 1;" });
  g("add", "-A");
  g("commit", "-qm", "E");
  sha.E = g("rev-parse", "HEAD");
  g("reset", "-q", "--hard", sha.D);
  g("update-ref", "refs/remotes/origin/main", sha.D);
  g("clone", "-q", "--bare", repoDir, originDir);
  g("--git-dir", originDir, "config", "uploadpack.allowFilter", "true");
  g("--git-dir", originDir, "config", "uploadpack.allowAnySHA1InWant", "true");
  g(
    "clone",
    "-q",
    "--depth=1",
    "--filter=blob:none",
    "--no-checkout",
    `file://${originDir}`,
    shallowDir,
  );
});

const check = (kitSha, head, extra = {}) =>
  ciCheck({
    repoDir,
    watch: WATCH,
    kit: { sha: kitSha, createdAt: fresh },
    head,
    now: NOW,
    ...extra,
  });

test("commits outside watch since the newest kit: build=false, watched files unchanged", () => {
  const result = check(sha.A, sha.B);
  assert.equal(result.build, false);
  assert.equal(
    result.reason,
    `watched files unchanged since ${sha.A.slice(0, 7)}`,
  );
});

test("a change under a watched path builds and names it", () => {
  const result = check(sha.B, sha.C);
  assert.equal(result.build, true);
  assert.equal(result.reason, "changed: src");
});

test("a deleted watched path counts as changed", () => {
  const ids = watchedIds(repoDir, sha.D, ["gone", "src"]);
  assert.equal(ids.gone, "missing");
  assert.match(ids.src, /^[0-9a-f]{40}$/);
  const result = check(sha.C, sha.D);
  assert.equal(result.build, true);
  assert.equal(result.reason, "changed: gone");
});

test('the repository root (".") is watched as its whole tree', () => {
  const root = watchedIds(repoDir, sha.A, ["."]);
  assert.match(root["."], /^[0-9a-f]{40}$/);
  assert.equal(check(sha.A, sha.B, { watch: ["."] }).reason, "changed: .");
});

test("a kit at the max age rebuilds to refresh it before it expires", () => {
  const result = ciCheck({
    repoDir,
    watch: WATCH,
    kit: { sha: sha.A, createdAt: new Date(NOW - 75 * DAY).toISOString() },
    head: sha.B,
    now: NOW,
    maxAgeDays: 75,
  });
  assert.equal(result.build, true);
  assert.match(result.reason, /^refresh before expiry: .* 75 days old/);
  // One day younger and nothing changed: skipped.
  assert.equal(
    ciCheck({
      repoDir,
      watch: WATCH,
      kit: { sha: sha.A, createdAt: new Date(NOW - 74 * DAY).toISOString() },
      head: sha.B,
      now: NOW,
      maxAgeDays: 75,
    }).build,
    false,
  );
});

test("no kit, force and an explicit package each build", () => {
  assert.deepEqual(decide({ kit: null, now: NOW }), {
    build: true,
    reason: "no kit yet on this branch",
  });
  assert.equal(check(sha.A, sha.B, { force: true }).build, true);
  assert.match(check(sha.A, sha.B, { force: true }).reason, /^forced/);
  const pinned = check(sha.A, sha.B, {
    packageSpec: "@codepress/design-kit@0.2.0",
  });
  assert.equal(pinned.build, true);
  assert.match(
    pinned.reason,
    /explicit package was given \(@codepress\/design-kit@0\.2\.0\)/,
  );
  // A store that cannot be read builds rather than skipping.
  const unreadable = ciCheck({
    repoDir,
    findKit: () => {
      throw new Error("HTTP 502");
    },
    now: NOW,
  });
  assert.equal(unreadable.build, true);
  assert.match(
    unreadable.reason,
    /could not look up the newest kit \(HTTP 502\)/,
  );
});

test("a kit commit that cannot be fetched builds", () => {
  const result = check("0123456789abcdef0123456789abcdef01234567", sha.B);
  assert.equal(result.build, true);
  assert.match(result.reason, /^could not read the kit's commit 0123456/);
});

test("ci-check reads watch from the config and writes the outputs and summary", () => {
  const output = join(scratch, "github-output");
  const stepSummary = join(scratch, "step-summary");
  writeFileSync(output, "");
  writeFileSync(stepSummary, "");
  const lines = [];
  const spy = mock.method(console, "log", (text) => lines.push(String(text)));
  try {
    const env = { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: stepSummary };
    const config = join(repoDir, "design-kit.config.json");
    // HEAD is D: since C, gone/ was deleted.
    ciCheckCommand(
      { config, since: sha.C, "kit-created": fresh },
      { env, now: NOW },
    );
    // The newest kit comes from the store when --since is not given.
    const gh = (args) => {
      assert.deepEqual(args.slice(0, 1), ["api"]);
      return JSON.stringify({
        artifacts: [
          artifact(3, sha.D, "other-branch", "2026-11-10T00:00:00Z"),
          artifact(2, sha.D, "main", "2026-11-09T00:00:00Z"),
          artifact(1, sha.A, "main", "2026-11-01T00:00:00Z"),
        ],
      });
    };
    ciCheckCommand(
      { config, repo: "o/r", branch: "main" },
      { env, gh, now: NOW },
    );
  } finally {
    spy.mock.restore();
  }
  assert.equal(
    readFileSync(output, "utf8"),
    `build=true\nreason=changed: gone\nkit-sha=${sha.C}\n` +
      `build=false\nreason=watched files unchanged since ${sha.D.slice(0, 7)}\nkit-sha=${sha.D}\n`,
  );
  assert.match(
    readFileSync(stepSummary, "utf8"),
    /Design kit: building, changed: gone\./,
  );
  assert.match(
    readFileSync(stepSummary, "utf8"),
    /Design kit: nothing to build, watched files unchanged since/,
  );
  // gone/ was deleted, so the run also says it can never trigger a rebuild.
  assert.match(
    lines[0],
    /^::warning title=Design kit::These watch paths do not exist at this commit.*: gone\./,
  );
  assert.equal(lines[1], "build=true");
});

function artifact(id, headSha, branch, createdAt, extra = {}) {
  return {
    id,
    name: "design-kit",
    expired: false,
    created_at: createdAt,
    workflow_run: { id: id * 10, head_sha: headSha, head_branch: branch },
    ...extra,
  };
}

test("findNewestKit picks the newest unexpired kit on the branch", () => {
  const gh = () =>
    JSON.stringify({
      artifacts: [
        artifact(4, "e".repeat(40), "main", "2026-11-11T00:00:00Z", {
          expired: true,
        }),
        artifact(3, "d".repeat(40), "feature", "2026-11-10T00:00:00Z"),
        artifact(2, "c".repeat(40), "main", "2026-11-09T00:00:00Z"),
        artifact(1, "b".repeat(40), "main", "2026-11-08T00:00:00Z"),
      ],
    });
  assert.deepEqual(findNewestKit({ repo: "o/r", branch: "main", gh }), {
    id: "2",
    sha: "c".repeat(40),
    createdAt: "2026-11-09T00:00:00Z",
    runId: "20",
  });
  assert.equal(findNewestKit({ repo: "o/r", branch: "none", gh }), null);
});

test("deleteOlderKits deletes only the branch's older kits and reports a failed delete", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(" "));
    if (args.includes("DELETE")) {
      if (args.at(-1).endsWith("/12"))
        throw Object.assign(new Error("x"), {
          stderr: "HTTP 403: forbidden\n",
        });
      return "";
    }
    return JSON.stringify({
      artifacts: [
        artifact(14, "f".repeat(40), "main", "2026-11-12T00:00:00Z"),
        artifact(13, "e".repeat(40), "main", "2026-11-11T00:00:00Z"),
        artifact(12, "d".repeat(40), "main", "2026-11-10T00:00:00Z"),
        artifact(11, "c".repeat(40), "feature", "2026-11-09T00:00:00Z"),
        artifact(10, "b".repeat(40), "main", "2026-11-01T00:00:00Z", {
          expired: true,
        }),
      ],
    });
  };
  const result = deleteOlderKits({
    repo: "o/r",
    branch: "main",
    keep: "13",
    gh,
  });
  assert.deepEqual(result.deleted, ["10"]);
  assert.deepEqual(result.failed, [{ id: "12", error: "HTTP 403: forbidden" }]);
  // Never the kept kit, a newer one, or another branch's.
  assert.deepEqual(
    calls.filter((call) => call.includes("DELETE")),
    [
      "api --method DELETE repos/o/r/actions/artifacts/12",
      "api --method DELETE repos/o/r/actions/artifacts/10",
    ],
  );
});

test("ci-cleanup through the CLI calls gh, warns on a failed delete and exits 0", async () => {
  // A stand-in `gh` on PATH: lists from a file, logs every call, refuses one delete.
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(scratch, "gh.log");
  const list = join(scratch, "artifacts.json");
  writeFileSync(log, "");
  writeFileSync(
    list,
    JSON.stringify({
      artifacts: [
        artifact(22, "c".repeat(40), "main", "2026-11-11T00:00:00Z"),
        artifact(21, "b".repeat(40), "main", "2026-11-10T00:00:00Z"),
        artifact(20, "a".repeat(40), "main", "2026-11-09T00:00:00Z"),
      ],
    }),
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *DELETE*/20) echo "HTTP 403: Resource not accessible by integration" >&2; exit 1 ;;
  *DELETE*) exit 0 ;;
  *) cat "${list}" ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const lines = [];
  const spy = mock.method(console, "log", (text) => lines.push(String(text)));
  let code;
  try {
    code = await main(["ci-cleanup", "--keep", "22"], {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF_NAME: "main",
    });
  } finally {
    spy.mock.restore();
  }
  assert.equal(code, 0);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "api repos/o/r/actions/artifacts?name=design-kit&per_page=100&page=1",
    "api --method DELETE repos/o/r/actions/artifacts/21",
    "api --method DELETE repos/o/r/actions/artifacts/20",
  ]);
  assert.match(
    lines.join("\n"),
    /::warning title=Design kit::Could not delete the older kit 20: HTTP 403/,
  );
  assert.match(
    lines.join("\n"),
    /deleted 1 older kit on main; 1 could not be deleted/,
  );
});

test("the skill's staleness command reads watch from the config, as ci-check does", () => {
  const skill = buildSkill(detectProject(repoDir));
  assert.doesNotMatch(skill, /\{\{[A-Z_]+\}\}/);
  const block = skill.match(/KIT_SHA=\$\(node[^\n]*\n([\s\S]*?)\n```/)[1];
  // Run it as written, minus the fetch, against the template history.
  const script = block.replace('git fetch -q origin "$BRANCH" &&', "");
  const out = execFileSync("bash", ["-c", script], {
    cwd: join(repoDir, "src"),
    encoding: "utf8",
    env: { ...process.env, KIT_SHA: sha.A, BRANCH: "main" },
  });
  // C (src) and D (gone) touch watched paths; B (docs) does not.
  assert.deepEqual(
    out
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[1]),
    ["D", "C"],
  );
});

test("deleteOlderKits deletes nothing when the kept kit is not listed, and keeps a kit uploaded in the same instant", () => {
  const calls = [];
  const listing = (artifacts) => (args) => {
    calls.push(args.join(" "));
    return args.includes("DELETE") ? "" : JSON.stringify({ artifacts });
  };
  const notListed = deleteOlderKits({
    repo: "o/r",
    branch: "main",
    keep: "99",
    gh: listing([
      artifact(31, "b".repeat(40), "main", "2026-11-10T00:00:00Z"),
      artifact(30, "a".repeat(40), "main", "2026-11-09T00:00:00Z"),
    ]),
  });
  assert.deepEqual(notListed, { deleted: [], failed: [], keptFound: false });
  // The kept id on another branch is not "this branch's kit" either.
  const otherBranch = deleteOlderKits({
    repo: "o/r",
    branch: "main",
    keep: "41",
    gh: listing([
      artifact(41, "c".repeat(40), "feature", "2026-11-11T00:00:00Z"),
      artifact(40, "a".repeat(40), "main", "2026-11-09T00:00:00Z"),
    ]),
  });
  assert.equal(otherBranch.keptFound, false);
  const tie = deleteOlderKits({
    repo: "o/r",
    branch: "main",
    keep: "52",
    gh: listing([
      artifact(52, "c".repeat(40), "main", "2026-11-11T00:00:00Z"),
      artifact(51, "b".repeat(40), "main", "2026-11-11T00:00:00Z"),
      artifact(50, "a".repeat(40), "main", "2026-11-10T00:00:00Z"),
    ]),
  });
  assert.deepEqual(tie.deleted, ["50"]);
  assert.equal(calls.filter((call) => call.includes("DELETE")).length, 1);
});

test("overlapping watch entries cannot hide each other", () => {
  // E adds src/other.js only: src changed, src/Button.jsx did not.
  const result = check(sha.D, sha.E, { watch: ["src", "src/Button.jsx"] });
  assert.equal(result.build, true);
  assert.equal(result.reason, "changed: src");
  const ids = watchedIds(repoDir, sha.E, ["src", "src/Button.jsx"]);
  assert.notEqual(ids.src, "missing");
  assert.notEqual(ids["src/Button.jsx"], "missing");
});

test("watch paths are resolved as git names them (./, //, trailing slash, backslash)", () => {
  const plain = watchedIds(repoDir, sha.E, ["src/other.js"])["src/other.js"];
  assert.match(plain, /^[0-9a-f]{40}$/);
  const ids = watchedIds(repoDir, sha.E, [
    "src/./other.js",
    "src//other.js",
    "./src/other.js",
    "src\\other.js",
  ]);
  for (const [path, id] of Object.entries(ids)) assert.equal(id, plain, path);
  assert.equal(
    check(sha.D, sha.E, { watch: ["src/./other.js"] }).reason,
    "changed: src/./other.js",
  );
});

test("a watch path missing at HEAD is reported, so a typo is visible", () => {
  const result = check(sha.A, sha.B, { watch: ["src", "sorc"] });
  assert.equal(result.build, false);
  assert.deepEqual(result.missing, ["sorc"]);
});

test("a newline in the package input cannot add a second build= output", () => {
  const output = join(scratch, "github-output-newline");
  writeFileSync(output, "");
  const spy = mock.method(console, "log", () => {});
  try {
    ciCheckCommand(
      {
        config: join(repoDir, "design-kit.config.json"),
        since: sha.D,
        "kit-created": fresh,
        package: "x\nbuild=false",
      },
      { env: { GITHUB_OUTPUT: output }, now: NOW },
    );
  } finally {
    spy.mock.restore();
  }
  const lines = readFileSync(output, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("build=")),
    ["build=true"],
  );
  assert.equal(lines.length, 3);
});

test("in a depth-1 blobless clone, the kit's commit is fetched and compared (the check job's checkout)", () => {
  const present = (rev) => {
    try {
      execFileSync(
        "git",
        ["-C", shallowDir, "cat-file", "-e", `${rev}^{commit}`],
        {
          env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          stdio: "ignore",
        },
      );
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(present(sha.C), false);
  assert.equal(present(sha.B), false);
  const run = (kitSha, watch) =>
    ciCheck({
      repoDir: shallowDir,
      watch,
      kit: { sha: kitSha, createdAt: fresh },
      now: NOW,
    });
  // C → D deleted gone/ only: src and package.json are unchanged.
  const unchanged = run(sha.C, ["src", "package.json"]);
  assert.equal(unchanged.build, false, unchanged.reason);
  assert.equal(
    unchanged.reason,
    `watched files unchanged since ${sha.C.slice(0, 7)}`,
  );
  assert.equal(present(sha.C), true);
  // B → D changed src/ and deleted gone/.
  const changed = run(sha.B, WATCH);
  assert.equal(changed.reason, "changed: src, gone");
});

test("a tree git cannot read at the kit's commit builds, never reads as an absent path", () => {
  // A copy of the history whose kit commit A cannot read its gone/ tree.
  const broken = join(scratch, "broken");
  cpSync(repoDir, broken, { recursive: true });
  const tree = execFileSync(
    "git",
    ["-C", broken, "rev-parse", `${sha.A}:gone`],
    {
      encoding: "utf8",
    },
  ).trim();
  rmSync(join(broken, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  // gone/old.css really is absent at D, so equal "missing" ids would skip.
  const result = ciCheck({
    repoDir: broken,
    watch: ["gone/old.css"],
    kit: { sha: sha.A, createdAt: fresh },
    head: sha.D,
    now: NOW,
  });
  assert.equal(result.build, true);
  assert.match(result.reason, /^could not read the kit's commit/);
});
