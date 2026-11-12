/**
 * Page sources: two apps capture pages into one kit, and each capture
 * rewrites only its own source's frames, rows, stylesheet and gap rows.
 * Drives writePagesKit (the write half of `capture pages`) directly, so no
 * browser or app is started.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import {
  assertPageSources,
  capturePages,
  writePagesKit,
} from "../src/capture-pages.mjs";
import { main } from "../src/cli.mjs";
import { ConfigError, resolveConfig } from "../src/config.mjs";
import { compose, loadKit } from "../src/kit.mjs";
import { kitHtmlFile, kitRouteId, routeCssFile } from "../src/pages.mjs";

const scratch = mkdtempSync(join(tmpdir(), "design-kit-sources-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const freshKit = () => {
  const dir = join(scratch, `kit-${(counter += 1)}`);
  mkdirSync(join(dir, "html"), { recursive: true });
  // The stories' half, which no page capture may touch.
  writeFileSync(join(dir, "html", "story--button@1280.html"), "<button>");
  writeFileSync(
    join(dir, "gaps.json"),
    JSON.stringify([{ id: "story:broken@1280", reason: "story failed" }]),
  );
  return dir;
};

const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

/** One capture: `captured` page names get frames, `failed` get gap rows. */
function capture(out, { source, captured, failed = [], css, pageNames }) {
  const rows = [];
  const files = new Map();
  for (const name of captured) {
    for (const { width, height } of WIDTHS) {
      const id = kitRouteId(name, width);
      const file = kitHtmlFile(id);
      files.set(file, `<main data-kit-slot="main">${name} ${width}</main>`);
      rows.push({
        id,
        kind: "route",
        title: name,
        file,
        width,
        height,
        slots: ["main"],
        ...(source ? { source, css: routeCssFile(source) } : {}),
      });
    }
  }
  const gaps = failed.map((name) => ({
    id: kitRouteId(name, 1280),
    route: name,
    ...(source ? { source } : {}),
    reason: "ready selector never appeared",
  }));
  const pages = [...captured, ...failed].map((name) => ({ name }));
  writePagesKit(out, {
    rows,
    files,
    css: css ?? `/* ${source ?? "pages"} */\n`,
    gaps,
    needles: [],
    pages,
    widths: WIDTHS,
    fonts: new Map(),
    theme: undefined,
    configDir: scratch,
    source,
    ...(pageNames ? { pageNames } : {}),
  });
}

const readJson = (dir, file) =>
  JSON.parse(readFileSync(join(dir, file), "utf8"));
const routeIds = (dir) => readJson(dir, "routes.json").map((row) => row.id);
const gapIds = (dir) => readJson(dir, "gaps.json").map((row) => row.id);

test("capturing source terminal leaves web's frames, rows, stylesheet and gap rows, and the reverse", () => {
  const kit = freshKit();
  capture(kit, {
    source: "web",
    captured: ["dashboard", "apps"],
    failed: ["settings"],
  });
  capture(kit, {
    source: "terminal",
    captured: ["terminal-workspace"],
    failed: ["terminal-settings"],
  });

  assert.deepEqual(routeIds(kit), [
    "route:apps@1280",
    "route:apps@390",
    "route:dashboard@1280",
    "route:dashboard@390",
    "route:terminal-workspace@1280",
    "route:terminal-workspace@390",
  ]);
  assert.deepEqual(gapIds(kit), [
    "story:broken@1280",
    "route:settings@1280",
    "route:terminal-settings@1280",
  ]);
  for (const id of ["route:dashboard@390", "route:terminal-workspace@1280"])
    assert.ok(existsSync(join(kit, kitHtmlFile(id))), id);
  assert.ok(existsSync(join(kit, "html", "story--button@1280.html")));
  assert.equal(
    readFileSync(join(kit, "css", "routes--web.css"), "utf8"),
    "/* web */\n",
  );
  assert.equal(
    readFileSync(join(kit, "css", "routes--terminal.css"), "utf8"),
    "/* terminal */\n",
  );

  // The reverse: web recaptured with dashboard gone and settings now
  // passing. Terminal's frame, row, sheet and gap row stay as they were.
  capture(kit, {
    source: "web",
    captured: ["apps", "settings"],
    css: "/* web 2 */\n",
  });
  assert.deepEqual(routeIds(kit), [
    "route:apps@1280",
    "route:apps@390",
    "route:settings@1280",
    "route:settings@390",
    "route:terminal-workspace@1280",
    "route:terminal-workspace@390",
  ]);
  assert.deepEqual(gapIds(kit), [
    "story:broken@1280",
    "route:terminal-settings@1280",
  ]);
  assert.equal(
    existsSync(join(kit, kitHtmlFile("route:dashboard@1280"))),
    false,
  );
  assert.ok(existsSync(join(kit, kitHtmlFile("route:terminal-workspace@390"))));
  assert.equal(
    readFileSync(join(kit, "css", "routes--terminal.css"), "utf8"),
    "/* terminal */\n",
  );

  const manifest = readJson(kit, "manifest.json");
  assert.equal(manifest.kit_version, 1);
  // The kit's totals, with each source's own numbers beside them.
  assert.equal(manifest.counts.routes, 6);
  assert.equal(manifest.sources.routes.captured, 6);
  assert.equal(manifest.sources.routes.failed, 1);
  assert.deepEqual(manifest.sources.routes.pages, [
    "apps",
    "settings",
    "terminal-settings",
    "terminal-workspace",
  ]);
  assert.deepEqual(manifest.sources.routes.page_sources.terminal, {
    captured: 2,
    failed: 1,
    pages: ["terminal-workspace", "terminal-settings"],
    widths: [1280, 390],
  });
  assert.equal(manifest.sources.routes.page_sources.web.captured, 4);
});

test("a frame composes with its own source's stylesheet", () => {
  const kit = freshKit();
  capture(kit, { source: "web", captured: ["apps"], css: ".web{}\n" });
  capture(kit, {
    source: "terminal",
    captured: ["terminal-workspace"],
    css: ".terminal{}\n",
  });
  const page = compose(loadKit(kit), {
    frame: "route:terminal-workspace@1280",
    slots: {},
  });
  assert.match(page, /\.terminal\{\}/);
  assert.doesNotMatch(page, /\.web\{\}/);
});

test("without a source a capture still replaces every page, and a sourced one claims only its own unsourced rows", () => {
  const kit = freshKit();
  capture(kit, { source: null, captured: ["apps", "legacy"] });
  assert.ok(existsSync(join(kit, "css", "routes.css")));
  // A kit from before sources: web claims the unsourced "apps" rows it
  // declares, and leaves "legacy", which it does not.
  capture(kit, { source: "web", captured: ["apps"], failed: [] });
  const rows = readJson(kit, "routes.json");
  assert.deepEqual(
    rows.map((row) => [row.id, row.source ?? null]),
    [
      ["route:apps@1280", "web"],
      ["route:apps@390", "web"],
      ["route:legacy@1280", null],
      ["route:legacy@390", null],
    ],
  );
  capture(kit, { source: "terminal", captured: ["terminal-workspace"] });
  // An unsourced capture is today's behaviour: every page row is its own.
  capture(kit, { source: null, captured: ["home"] });
  assert.deepEqual(routeIds(kit), ["route:home@1280", "route:home@390"]);
  assert.equal(existsSync(join(kit, "css", "routes--terminal.css")), false);
  assert.equal(
    existsSync(join(kit, kitHtmlFile("route:terminal-workspace@1280"))),
    false,
  );
  assert.ok(existsSync(join(kit, "html", "story--button@1280.html")));
});

/** A config for source `source` declaring `names`, written to disk. */
function sourceConfig(source, names) {
  const file = join(scratch, `config-${(counter += 1)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      pages: {
        source,
        baseUrl: "http://127.0.0.1:9",
        pages: names.map((name) => ({
          name,
          path: `/${name}`,
          ready: "main",
          slots: { main: ["main"] },
        })),
      },
    }),
  );
  return file;
}

test("two sources declaring apps: a config error naming both, exit 2, before anything starts", async () => {
  const kit = freshKit();
  capture(kit, { source: "web", captured: ["dashboard", "apps"] });
  const file = sourceConfig("terminal", ["terminal-workspace", "apps"]);
  const config = resolveConfig(JSON.parse(readFileSync(file, "utf8")), file);

  // No browser and no app: the clash is found first.
  const playwright = {
    chromium: {
      launch: () => assert.fail("the browser must not start"),
    },
  };
  await assert.rejects(
    capturePages(config, { out: kit, playwright, log: () => {} }),
    (error) =>
      error instanceof ConfigError &&
      error.exitCode === 2 &&
      /page "apps" is declared by page source "terminal"/.test(error.message) &&
      /source "web" already captured it/.test(error.message),
  );

  const errors = [];
  const restore = mock.method(console, "error", (text) => errors.push(text));
  let code;
  try {
    code = await main(["capture", "pages", "--config", file, "--out", kit]);
  } finally {
    restore.mock.restore();
  }
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /"terminal".*"web"/s);
  // Nothing was written: web's rows are as they were.
  assert.deepEqual(routeIds(kit), [
    "route:apps@1280",
    "route:apps@390",
    "route:dashboard@1280",
    "route:dashboard@390",
  ]);
});

const loadSourceConfig = (source, names) => {
  const file = sourceConfig(source, names);
  return resolveConfig(JSON.parse(readFileSync(file, "utf8")), file);
};
const kitFiles = (dir) =>
  ["routes.json", "gaps.json", "manifest.json"].map((file) =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null,
  );

test("a clash held only in gaps.json is a config error too, and --only still checks every declared page", async () => {
  const kit = freshKit();
  // Web's "apps" failed: it is a gap row of web's, with no routes.json row.
  capture(kit, { source: "web", captured: ["dashboard"], failed: ["apps"] });
  const before = kitFiles(kit);
  const config = loadSourceConfig("terminal", ["terminal-workspace", "apps"]);

  assert.throws(
    () => assertPageSources(config, kit),
    (error) =>
      error instanceof ConfigError &&
      error.exitCode === 2 &&
      /page "apps" is declared by page source "terminal"/.test(error.message) &&
      /source "web" already captured it/.test(error.message),
  );
  // `--only terminal-workspace` selects a page that clashes with nothing; the
  // declared "apps" still does.
  const playwright = {
    chromium: { launch: () => assert.fail("the browser must not start") },
  };
  await assert.rejects(
    capturePages(config, {
      out: kit,
      only: ["terminal-workspace"],
      playwright,
      log: () => {},
    }),
    (error) => error instanceof ConfigError && error.exitCode === 2,
  );
  assert.deepEqual(kitFiles(kit), before);

  // No clash, and no kit yet: nothing to check against.
  assertPageSources(loadSourceConfig("terminal", ["terminal-workspace"]), kit);
  assertPageSources(config, join(scratch, "no-kit-here"));
});

test("a page another source wrote while this capture ran stops the write, and nothing changes", () => {
  const kit = freshKit();
  capture(kit, { source: "terminal", captured: ["terminal-workspace"] });
  // Web checked before starting, then terminal captured "apps" meanwhile.
  capture(kit, {
    source: "terminal",
    captured: ["terminal-workspace", "apps"],
  });
  const before = kitFiles(kit);
  const frame = join(kit, kitHtmlFile("route:apps@1280"));
  const frameBefore = readFileSync(frame, "utf8");
  assert.throws(
    () =>
      capture(kit, {
        source: "web",
        captured: ["apps"],
        css: "/* web */\n",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.exitCode === 2 &&
      /page "apps" was captured into .* by page source "terminal" while source "web" was capturing; nothing was written/.test(
        error.message,
      ),
  );
  assert.deepEqual(kitFiles(kit), before);
  assert.equal(readFileSync(frame, "utf8"), frameBefore);
  assert.equal(existsSync(join(kit, "css", "routes--web.css")), false);

  // Checked before the kit's folders are made: a kit holding only rows gets
  // no html/ or css/ folder from a capture that stops.
  const bare = join(scratch, `kit-${(counter += 1)}`);
  mkdirSync(bare);
  writeFileSync(join(bare, "routes.json"), before[0]);
  assert.throws(
    () => capture(bare, { source: "web", captured: ["apps"] }),
    (error) => error instanceof ConfigError && error.exitCode === 2,
  );
  assert.equal(existsSync(join(bare, "html")), false);
  assert.equal(existsSync(join(bare, "css")), false);
});

test("pages.source must be a lowercase name", () => {
  const file = join(scratch, "bad-source.json");
  assert.throws(
    () =>
      resolveConfig(
        {
          version: 1,
          pages: {
            source: "Web App",
            baseUrl: "http://127.0.0.1:9",
            pages: [
              { name: "a", path: "/", ready: "main", slots: { main: ["m"] } },
            ],
          },
        },
        file,
      ),
    /pages\.source: must match/,
  );
});
