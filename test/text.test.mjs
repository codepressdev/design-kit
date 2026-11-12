/**
 * text.json: each row's on-screen words, written when the kit is, and the
 * `find` that searches them. Kits are built from small template rows through
 * the package's own writers (writePagesKit, writeKitText); no browser runs.
 */
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { writePagesKit } from "../src/capture-pages.mjs";
import {
  find,
  findMatches,
  loadKit,
  run,
  visibleText,
  writeKitText,
} from "../src/kit.mjs";
import { forbiddenNeedles, kitHtmlFile, kitRouteId } from "../src/pages.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "design-kit-text-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const scratchDir = (name) => join(scratch, `${(counter += 1)}-${name}`);

/** Runs kit.mjs in-process; returns its code and output. */
function kit(args, dir) {
  const out = [];
  const err = [];
  const code = run(["--kit", dir, ...args], {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const readJson = (dir, file) =>
  JSON.parse(readFileSync(join(dir, file), "utf8"));

/** The App Settings page: its words are on screen, never in its id or title. */
const SETTINGS_PAGE = `<main data-kit-slot="main" data-label="hiddenattr" title="tooltipword">
  <script>window.scriptword = "x";</script>
  <style>.styleword { color: red }</style>
  <svg viewBox="0 0 1 1"><title>svgword</title><text>svgtext</text></svg>
  <template><p>templateword</p></template>
  <h1>Environment&nbsp;variables</h1>
  <section><h2>Danger zone</h2><button aria-label="ariaword">Transfer app</button><button>Delete&hellip;</button></section>
  <p>No <b>secrets</b> yet &amp; nothing   to
    show</p>
</main>`;

const STORY = `<div id="storybook-root"><button class="btn">Save changes</button><span>Cancel</span></div>`;

/**
 * A kit the package writes: a story half (index.json and its markup, as a
 * stories capture leaves it) and one page capture through writePagesKit.
 */
function buildKit({
  pages = { "app-settings": SETTINGS_PAGE },
  needles = [],
} = {}) {
  const out = scratchDir("kit");
  mkdirSync(join(out, "html"), { recursive: true });
  writeFileSync(
    join(out, "html/story--controls-button--primary@1280.html"),
    STORY,
  );
  writeFileSync(
    join(out, "index.json"),
    JSON.stringify([
      {
        id: "story:controls-button--primary@1280",
        kind: "story",
        title: "Controls/Button/Primary",
        component: "Button",
        file: "html/story--controls-button--primary@1280.html",
        width: 1280,
        height: 800,
        bytes: STORY.length,
        source_file: "src/Button.stories.jsx",
      },
    ]),
  );
  const rows = [];
  const files = new Map();
  for (const [name, html] of Object.entries(pages)) {
    const id = kitRouteId(name, 1280);
    const file = kitHtmlFile(id);
    files.set(file, html);
    rows.push({
      id,
      kind: "route",
      title: name,
      file,
      width: 1280,
      height: 800,
      bytes: html.length,
      slots: ["main"],
    });
  }
  writePagesKit(out, {
    rows,
    files,
    css: "/* pages */\n",
    gaps: [],
    needles,
    pages: Object.keys(pages).map((name) => ({ name })),
    widths: [{ width: 1280, height: 800 }],
    fonts: new Map(),
    theme: undefined,
    configDir: scratch,
  });
  return out;
}

test("a kit the package writes holds each row's visible text, with no script, style, SVG, template or attribute content", () => {
  const out = buildKit();
  assert.deepEqual(readJson(out, "text.json"), {
    "route:app-settings@1280":
      "Environment variables Danger zone Transfer app Delete… No secrets yet & nothing to show",
    "story:controls-button--primary@1280": "Save changes Cancel",
  });
  const text = readFileSync(join(out, "text.json"), "utf8");
  for (const hidden of [
    "scriptword",
    "styleword",
    "svgword",
    "svgtext",
    "templateword",
    "hiddenattr",
    "tooltipword",
    "ariaword",
    "data-kit-slot",
  ])
    assert.doesNotMatch(text, new RegExp(hidden), hidden);
});

test("visibleText keeps the first 600 characters and keeps words apart across block tags", () => {
  assert.equal(
    visibleText("<td>Name</td><td>Owner</td><p>Tr<em>an</em>sfer</p>"),
    "Name Owner Transfer",
  );
  const long = visibleText(`<p>${"word ".repeat(500)}</p>`);
  assert.equal(long.length, 600);
  assert.ok(long.startsWith("word word"));
  assert.equal(visibleText("<head><title>T</title></head><body></body>"), "");
});

test("a page's slot text comes ahead of the navigation it repeats on every page", () => {
  const nav = `<nav>${"Apps Automations Media ".repeat(40)}</nav>`;
  const page = `<body>${nav}<main data-kit-slot="main"><h1>Settings</h1><button>Transfer app</button></main><footer>Help</footer></body>`;
  const text = visibleText(page);
  assert.ok(text.startsWith("Settings Transfer app Apps Automations"), text);
  assert.equal(text.length, 600);
});

test("among rows that tie, the one whose text holds the whole query comes first, and its excerpt shows it", () => {
  const out = buildKit({
    pages: {
      // Both pages hold every word; only "b-vault" holds the phrase.
      "a-vault": `<main><p>No members yet. Your secrets stay here.</p></main>`,
      "b-vault": `<main><p>Add a secret. No secrets yet.</p></main>`,
    },
  });
  assert.deepEqual(
    findMatches(loadKit(out), "no secrets yet").map(({ row, excerpt }) => [
      row.id,
      excerpt,
    ]),
    [
      ["route:b-vault@1280", "Add a secret. No secrets yet."],
      ["route:a-vault@1280", "No members yet. Your secrets stay here."],
    ],
  );
});

test('find "transfer app" returns the page that shows it, with an excerpt, though no id or title holds the words', () => {
  const out = buildKit();
  const found = kit(["find", "transfer app"], out);
  assert.equal(found.code, 0, found.err);
  assert.equal(
    found.out,
    'route:app-settings@1280  route  1280w  504 B  app-settings  "…t variables Danger zone Transfer app Delete… No secrets yet…"',
  );
  const [match] = findMatches(loadKit(out), "Environment variables");
  assert.equal(match.row.id, "route:app-settings@1280");
  assert.match(match.excerpt, /^Environment variables Danger zone/);
});

test("when names fill the list, its last 5 lines are text hits, and a closing line counts what each tier left out", () => {
  const pages = {};
  // 40 pages with the words in their id, 8 that only show them.
  for (let i = 10; i < 50; i += 1)
    pages[`transfer-app-${i}`] = `<main><p>Step ${i}</p></main>`;
  for (let i = 0; i < 8; i += 1)
    pages[`settings-${i}`] =
      `<main><h2>Danger zone</h2><button>Transfer app</button></main>`;
  const out = buildKit({ pages });
  const lines = kit(["find", "transfer app"], out).out.split("\n");
  assert.equal(lines.length, 30);
  assert.deepEqual(
    lines.slice(0, 24).map((text) => text.split(" ")[0]),
    Array.from({ length: 24 }, (_, i) => `route:transfer-app-${10 + i}@1280`),
  );
  assert.deepEqual(
    lines.slice(24, 29).map((text) => text.split(" ")[0]),
    [0, 1, 2, 3, 4].map((i) => `route:settings-${i}@1280`),
  );
  for (const text of lines.slice(24, 29))
    assert.match(text, /"Danger zone Transfer app"$/);
  assert.equal(
    lines[29],
    "+16 more by name, +3 more by on-screen text; narrow the query",
  );

  // Few names: text hits take the rest of the list, and only their count is left.
  const few = {};
  for (let i = 0; i < 3; i += 1)
    few[`transfer-app-${i}`] = `<main><p>Step</p></main>`;
  for (let i = 10; i < 50; i += 1)
    few[`settings-${i}`] = `<main><button>Transfer app</button></main>`;
  const mostlyText = kit(
    ["find", "transfer app"],
    buildKit({ pages: few }),
  ).out.split("\n");
  assert.equal(mostlyText.length, 30);
  assert.equal(
    mostlyText.filter((text) => text.endsWith('"Transfer app"')).length,
    26,
  );
  assert.equal(mostlyText[29], "+14 more by on-screen text; narrow the query");
});

test("a word in a row's id ranks above the same word only in another row's text", () => {
  const out = buildKit({
    pages: {
      "app-settings": SETTINGS_PAGE,
      // "cancel" is in this page's id; the story only shows it.
      "cancel-plan": `<main data-kit-slot="main"><h1>Plans</h1></main>`,
    },
  });
  const matches = findMatches(loadKit(out), "cancel");
  assert.deepEqual(
    matches.map(({ row, excerpt }) => [row.id, excerpt ?? null]),
    [
      ["route:cancel-plan@1280", null],
      ["story:controls-button--primary@1280", "Save changes Cancel"],
    ],
  );
  // Title (component) ranks above text too: "button" is the story's component.
  const out2 = buildKit({
    pages: { "app-settings": `<main><button>Button</button></main>` },
  });
  assert.deepEqual(
    find(loadKit(out2), "button").map((row) => row.id),
    ["story:controls-button--primary@1280", "route:app-settings@1280"],
  );
});

test("a word only inside a script, a style, an SVG or an attribute value matches nothing", () => {
  const out = buildKit();
  for (const word of [
    "scriptword",
    "styleword",
    "svgword",
    "hiddenattr",
    "tooltipword",
    "ariaword",
  ]) {
    const result = kit(["find", word], out);
    assert.notEqual(result.code, 0, word);
    assert.match(result.err, /nothing matches/, word);
  }
});

test("a kit without text.json finds exactly as before, and loads without text", () => {
  const dir = scratchDir("old-kit");
  cpSync(FIXTURE, dir, { recursive: true });
  assert.equal(existsSync(join(dir, "text.json")), false);
  assert.equal("text" in loadKit(dir), false);
  // The lines the find before text.json printed, byte for byte.
  assert.equal(
    kit(["find", "orchestrator"], dir).out,
    [
      "route:orchestrator@1280  route  1280w  194 B  Orchestrator",
      "story:orchestrator-feed--long@1280  story  1280w  24.2 KB  Orchestrator/Feed/Long",
    ].join("\n"),
  );
  assert.equal(
    kit(["find", "dialog"], dir).out,
    "story:primitives-dialog--open@1280  story  1280w  681 B  Primitives/Dialog/Open",
  );
  const missing = kit(["find", "transfer"], dir);
  assert.equal(missing.code, 2);
  assert.equal(missing.out, "");
  // A broken text.json is ignored the same way.
  writeFileSync(join(dir, "text.json"), "{not json");
  assert.equal("text" in loadKit(dir), false);
  assert.equal(
    kit(["find", "dialog"], dir).out,
    "story:primitives-dialog--open@1280  story  1280w  681 B  Primitives/Dialog/Open",
  );
});

test("rows a build copies from the base kit get text too", () => {
  // An incremental stories build leaves the kept rows' markup and index rows
  // in place and writes text.json from every row in the kit.
  const dir = scratchDir("incremental");
  cpSync(FIXTURE, dir, { recursive: true });
  writeKitText(dir);
  const text = readJson(dir, "text.json");
  const rows = loadKit(dir).rows;
  assert.equal(Object.keys(text).length, rows.length);
  assert.ok(text["route:orchestrator@1280"]);
  assert.ok(text["story:shell-iconrail--variant-07@1280"]);
});

test("a forbidden value in a page's text fails the capture as it does in the html, and nothing is written", () => {
  const needles = forbiddenNeedles(["hunter2"]);
  // Written with character references, the markup check alone misses it;
  // the text decodes it.
  const encoded = `<main data-kit-slot="main"><p>Password: hunter&#50;</p></main>`;
  assert.throws(
    () => buildKit({ pages: { "app-settings": encoded }, needles }),
    /text\.json carries a forbidStrings value/,
  );
  // A story's text counts the same: the whole kit's text.json is checked.
  assert.throws(
    () =>
      buildKit({
        pages: {
          "app-settings": SETTINGS_PAGE,
        },
        needles: forbiddenNeedles(["Save changes"]),
      }),
    /text\.json carries a forbidStrings value/,
  );
});

test("a refused text.json leaves the kit's files as they were", () => {
  const out = buildKit();
  const before = [
    "routes.json",
    "text.json",
    "html/route--app-settings@1280.html",
  ].map((file) => readFileSync(join(out, file), "utf8"));
  const id = kitRouteId("app-settings", 1280);
  const file = kitHtmlFile(id);
  assert.throws(
    () =>
      writePagesKit(out, {
        rows: [
          { id, kind: "route", title: "x", file, width: 1280, height: 800 },
        ],
        files: new Map([[file, "<main>hunter&#50;</main>"]]),
        css: "",
        gaps: [],
        needles: forbiddenNeedles(["hunter2"]),
        pages: [{ name: "app-settings" }],
        widths: [{ width: 1280, height: 800 }],
        fonts: new Map(),
        theme: undefined,
        configDir: scratch,
      }),
    /text\.json carries a forbidStrings value/,
  );
  assert.deepEqual(
    ["routes.json", "text.json", "html/route--app-settings@1280.html"].map(
      (name) => readFileSync(join(out, name), "utf8"),
    ),
    before,
  );
});
