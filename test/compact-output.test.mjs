// kit find, show and info print less for the same information (#23280).
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  findMatches,
  findMatchLines,
  loadKit,
  outline,
  run,
} from "../src/kit.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "design-kit-compact-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** A copy of the fixture kit that `edit` may change. */
function fixtureCopy(edit = () => {}) {
  const dir = join(scratch, `kit-${(counter += 1)}`);
  cpSync(FIXTURE, dir, { recursive: true });
  edit(dir);
  return dir;
}

function kit(args, dir = FIXTURE) {
  const out = [];
  const err = [];
  const code = run(["--kit", dir, ...args], {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const readJson = (dir, name) =>
  JSON.parse(readFileSync(join(dir, name), "utf8"));
const writeJson = (dir, name, value) =>
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));

/**
 * The fixture with every story also captured at 390 (the same markup) and
 * `variant-03` only at 390, as a two-width kit has them.
 */
function twoWidthKit(edit = () => {}) {
  return fixtureCopy((dir) => {
    const stories = readJson(dir, "index.json");
    const narrow = stories.map((row) => ({
      ...row,
      id: row.id.replace(/@1280$/, "@390"),
      width: 390,
      bytes: (row.bytes ?? 0) + 4096,
    }));
    writeJson(
      dir,
      "index.json",
      [...stories, ...narrow].filter(
        (row) => row.id !== "story:shell-iconrail--variant-03@1280",
      ),
    );
    edit(dir);
  });
}

/** Ids a find printed, width groups expanded, and the rows its tail counts. */
function printed(lines) {
  const ids = [];
  let counted = 0;
  for (const line of lines) {
    const tail = [...line.matchAll(/(\d+) more/g)];
    if (tail.length) {
      counted += tail.reduce((sum, [, n]) => sum + Number(n), 0);
      continue;
    }
    const [id] = line.split("  ");
    const group = /^(.*)@\{([\d,]+)\}$/.exec(id);
    if (group)
      for (const width of group[2].split(",")) ids.push(`${group[1]}@${width}`);
    else ids.push(id);
  }
  return { ids, counted };
}

/** The ids v0.10.0's find listed: one row per line, 29 when it overflowed. */
function listedBefore(matches) {
  if (matches.length <= 30) return matches.map(({ row }) => row.id);
  const byText = matches.filter((match) => match.excerpt !== undefined);
  if (!byText.length) return matches.slice(0, 29).map(({ row }) => row.id);
  const byName = matches.filter((match) => match.excerpt === undefined);
  const textRoom = Math.min(byText.length, Math.max(5, 29 - byName.length));
  const names = byName.slice(0, 29 - textRoom);
  const texts = byText.slice(0, 29 - names.length);
  return [...names, ...texts].map(({ row }) => row.id);
}

test("find lists or counts every id v0.10.0 listed, and every match exactly once", () => {
  const dir = twoWidthKit((d) => {
    // Some rows found only by on-screen text, for the two-tier tail.
    const text = {};
    for (const row of readJson(d, "index.json"))
      if (/variant-1\d/.test(row.id)) text[row.id] = "Danger zone Rail grip";
    writeJson(d, "text.json", text);
  });
  const loaded = loadKit(dir);
  for (const query of ["rail", "iconrail", "orchestrator", "dialog", "grip"]) {
    const matches = findMatches(loaded, query);
    const result = kit(["find", query], dir);
    assert.equal(result.code, 0, `${query}: ${result.err}`);
    const lines = result.out.split("\n");
    assert.ok(lines.length <= 30, `${query}: ${lines.length} lines`);
    const { ids, counted } = printed(lines);
    assert.equal(new Set(ids).size, ids.length, `${query}: an id twice`);
    const all = new Set(matches.map(({ row }) => row.id));
    for (const id of ids) assert.ok(all.has(id), `${query}: ${id} unmatched`);
    assert.equal(ids.length + counted, matches.length, query);
    for (const id of listedBefore(matches))
      assert.ok(ids.includes(id), `${query}: ${id} no longer listed`);
  }
  // The overflowing query really grouped and really overflowed.
  const rail = kit(["find", "rail"], dir).out;
  assert.match(rail, /story:shell-iconrail--default@\{1280,390\}/);
  assert.match(rail, /more/);
});

test("a frame captured at one width prints one ungrouped id", () => {
  const out = kit(["find", "iconrail variant-03"], twoWidthKit()).out;
  assert.equal(out.split("\n").length, 1);
  assert.match(out, /^story:shell-iconrail--variant-03@390 {2}/);
  assert.doesNotMatch(out, /[{}]/);
  // In a kit of one width, nothing groups.
  for (const line of kit(["find", "rail"]).out.split("\n").slice(0, -1))
    assert.match(line, /^story:[^ ]+@1280 {2}/);
});

test("width groups drop titles that restate the id and keep titles that differ", () => {
  const dir = twoWidthKit((d) => {
    const stories = readJson(d, "index.json").map((row) =>
      row.id === "story:primitives-dialog--open@390"
        ? { ...row, title: "Primitives/Dialog/Open on a phone" }
        : row,
    );
    writeJson(d, "index.json", stories);
    writeJson(d, "routes.json", [
      ...readJson(d, "routes.json"),
      ...readJson(d, "routes.json").map((row) => ({
        ...row,
        id: "route:orchestrator@390",
        width: 390,
        title: `${row.title} (390)`,
      })),
    ]);
  });
  const lines = (query) => kit(["find", query], dir).out.split("\n");
  // Primitives/Dialog/Open restates story:primitives-dialog--open; the
  // phone title does not, and only it is printed.
  assert.deepEqual(lines("dialog"), [
    "story:primitives-dialog--open@{1280,390}  681 B/4.7 KB  Primitives/Dialog/Open on a phone",
  ]);
  const titled = twoWidthKit((d) => {
    writeJson(
      d,
      "index.json",
      readJson(d, "index.json").map((row) =>
        row.id.startsWith("story:primitives-dialog--open@")
          ? { ...row, title: `Dialog ${row.width === 390 ? "narrow" : "wide"}` }
          : row,
      ),
    );
  });
  assert.equal(
    kit(["find", "dialog"], titled).out,
    "story:primitives-dialog--open@{1280,390}  681 B/4.7 KB  Dialog wide | Dialog narrow",
  );
  // A route's " (1280)" is stripped before comparing.
  const route = kit(["find", "route:"], dir).out;
  assert.equal(route, "route:orchestrator@{1280,390}  194 B");
});

test("findMatchLines is find's formatter, sizes printed once when equal", () => {
  const rows = [
    { id: "route:a@1280", title: "Alpha (1280)", bytes: 134_400 },
    { id: "route:a@390", title: "Alpha (390)", bytes: 139_700 },
    { id: "story:b--c@1280", title: "B/C", bytes: 5000 },
    { id: "story:b--c@390", title: "B/C", bytes: 5000 },
  ];
  assert.deepEqual(findMatchLines(rows.map((row) => ({ row }))), [
    "route:a@{1280,390}  131/136 KB  Alpha",
    "story:b--c@{1280,390}  4.9 KB",
  ]);
  // Rows of one frame found by different words keep their own excerpts.
  assert.deepEqual(
    findMatchLines([
      { row: rows[0], excerpt: "one" },
      { row: rows[1], excerpt: "two" },
    ]),
    ['route:a@1280  131 KB  Alpha  "one"', 'route:a@390  136 KB  Alpha  "two"'],
  );
});

test("info prints one line; info --json prints the manifest as v0.10.0's info did", () => {
  const manifest = readJson(FIXTURE, "manifest.json");
  assert.equal(
    kit(["info"]).out,
    "0123456 built 2026-11-03T00:00:00.000Z · stories 38 · routes 1 · failed 0",
  );
  // v0.10.0 printed JSON.stringify(manifest, null, 2), then a rows line.
  assert.equal(kit(["info", "--json"]).out, JSON.stringify(manifest, null, 2));

  const failing = (ids) =>
    fixtureCopy((d) => {
      writeJson(d, "manifest.json", {
        ...manifest,
        counts: { ...manifest.counts, failed: ids.length },
      });
      writeJson(d, "gaps.json", [
        { component: "src/Nothing.tsx", reason: "no story" },
        ...ids.map((id) => ({ id, reason: "timeout" })),
      ]);
    });
  const few = ["story:a--b@1280", "route:c@390"];
  assert.match(
    kit(["info"], failing(few)).out,
    / · failed 2 \(story:a--b@1280, route:c@390\)$/,
  );
  const many = Array.from({ length: 6 }, (_, i) => `story:x--${i}@1280`);
  assert.match(kit(["info"], failing(many)).out, / · failed 6$/);

  const bare = fixtureCopy((d) => rmSync(join(d, "manifest.json")));
  assert.equal(
    kit(["info"], bare).out,
    "no manifest.json · stories 38 · routes 1 · failed 0",
  );
  assert.equal(
    kit(["info", "--json"], bare).out,
    JSON.stringify({ missing: "manifest.json" }, null, 2),
  );
});

test("show collapses identical sibling runs and leaves generated ids out", () => {
  const html = [
    `<nav id="radix-_k3_" aria-label="Primary">`,
    `<button id="_r_1u_">Go</button>`,
    `<ul>`,
    `<li><a>Row</a></li>`.repeat(4),
    `<li><a>Last</a></li>`,
    `</ul>`,
    `<a></a><a></a><a></a>`,
    `</nav>`,
    `<section id="feed"></section>`,
  ].join("");
  assert.deepEqual(outline(html).lines, [
    "<nav[aria-label=Primary]>",
    '  <button> "Go"',
    "  <ul>",
    "    <li> ×4",
    '      <a> "Row"',
    "    <li>",
    '      <a> "Last"',
    "  <a> ×3",
    "<section[id=feed]>",
  ]);
  // --full still prints the markup as captured.
  const dir = fixtureCopy();
  const shown = kit(
    ["show", "story:primitives-dialog--open@1280", "--full"],
    dir,
  );
  assert.equal(
    shown.out,
    readFileSync(
      join(dir, "html/story--primitives-dialog--open@1280.html"),
      "utf8",
    ),
  );
});
