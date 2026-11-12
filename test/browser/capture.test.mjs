/**
 * The captures against real inputs, in Chromium: a Storybook 8 static build
 * of a small React + Vite project (../fixtures/storybook-react, built into
 * ../fixtures/storybook-react/build), and a small signed-in app
 * (../fixtures/static-app). Run with `pnpm test:browser`; it needs
 * Playwright's Chromium (`pnpm exec playwright install chromium`).
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../../src/cli.mjs";
import { run } from "../../src/kit.mjs";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const scratch = mkdtempSync(
  join(process.env.TMPDIR || tmpdir(), "design-kit-browser-"),
);
after(() => rmSync(scratch, { recursive: true, force: true }));

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function writeConfig(name, value) {
  const file = join(scratch, `${name}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

/** Runs the CLI in-process and keeps its console output out of the test log. */
async function cli(args) {
  const lines = [];
  const quiet = (text) => lines.push(String(text));
  const spies = [
    mock.method(console, "log", quiet),
    mock.method(console, "error", quiet),
    mock.method(process.stderr, "write", (text) => (quiet(text), true)),
  ];
  try {
    return { code: await main(args), output: lines.join("\n") };
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
}

test("a Storybook built from a plain React + Vite project captures, and compose sets data-theme", async () => {
  const out = join(scratch, "stories-kit");
  const config = writeConfig("stories", {
    version: 1,
    theme: {
      attribute: "data-theme",
      dark: "dark",
      light: "light",
      targets: ["html"],
    },
    stories: {
      root: fixture("storybook-react"),
      storybookDir: join(fixture("storybook-react"), "build"),
      widths: [{ titles: "^Pages/", width: 390, height: 844 }],
      gaps: { componentGlob: "src/**/[A-Z]*.jsx" },
    },
  });
  const result = await cli([
    "capture",
    "stories",
    "--config",
    config,
    "--out",
    out,
    // The Hostile/ stories have their own test below, with a short budget.
    "--only",
    [
      "controls-button--long-label",
      "controls-button--primary",
      "pages-card--default",
      "pages-card--phone-only",
      "pages-card--phone-only-broken",
    ].join(","),
  ]);
  assert.equal(result.code, 0, result.output);

  const rows = readJson(join(out, "index.json"));
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      "story:controls-button--long-label@1280",
      "story:controls-button--primary@1280",
      "story:pages-card--default@1280",
      "story:pages-card--default@390",
      // A phone-only story listing its own widths: 390 and never 1280.
      "story:pages-card--phone-only@390",
    ],
  );
  const button = rows.find(
    (row) => row.id === "story:controls-button--primary@1280",
  );
  assert.equal(button.component, "Button");
  assert.match(
    button.source_file,
    /storybook-react\/src\/Button\.stories\.jsx$/,
  );
  assert.match(readFileSync(join(out, button.file), "utf8"), /Save changes/);

  // No configured fonts: the preview's own face travels in the kit.
  const css = readFileSync(join(out, "css/stories.css"), "utf8");
  assert.match(css, /url\("\.\.\/fonts\/fixture-sans\.woff2"\)/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.doesNotMatch(css, /127\.0\.0\.1/);
  assert.ok(existsSync(join(out, "fonts/fixture-sans.woff2")));

  const gaps = readJson(join(out, "gaps.json"));
  assert.ok(
    gaps.some(
      (row) =>
        row.reason === "no story" && row.component.endsWith("src/Badge.jsx"),
    ),
    JSON.stringify(gaps),
  );
  // Leaving 1280 out of its widths is not a gap; failing at a width it lists is.
  assert.deepEqual(
    gaps.filter((row) => row.id).map((row) => [row.id, row.reason, row.detail]),
    [
      [
        "story:pages-card--phone-only-broken@390",
        "threw",
        "play: broken at every width",
      ],
    ],
    JSON.stringify(gaps),
  );
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.theme.attribute, "data-theme");
  assert.equal(manifest.sources.stories.captured, 5);

  const page = join(scratch, "dark.html");
  const io = { out: () => {}, err: (text) => assert.fail(text) };
  assert.equal(
    run(
      [
        "--kit",
        out,
        "compose",
        "--frame",
        button.id,
        "--theme",
        "dark",
        "--out",
        page,
      ],
      io,
    ),
    0,
  );
  const html = readFileSync(page, "utf8");
  assert.match(html, /<html [^>]*data-theme="dark"/);
  assert.match(html, /Save changes/);
  assert.match(html, /url\("data:font\/woff2;base64,/);

  // text.json holds every row's on-screen words, and an incremental build
  // that recaptures one story keeps text for the rows it copies from the base.
  assert.equal(
    readJson(join(out, "text.json"))["story:controls-button--primary@1280"],
    "Save changes",
  );
  const next = join(scratch, "stories-kit-incremental");
  const incremental = await cli([
    "capture",
    "stories",
    "--config",
    config,
    "--out",
    next,
    "--base",
    out,
    "--only",
    "controls-button--primary",
  ]);
  assert.equal(incremental.code, 0, incremental.output);
  const text = readJson(join(next, "text.json"));
  assert.deepEqual(
    Object.keys(text),
    rows.map((row) => row.id),
  );
  assert.match(
    text["story:controls-button--long-label@1280"],
    /close the editor/,
  );
  const lines = [];
  assert.equal(
    run(["--kit", next, "find", "close the editor"], {
      out: (line) => lines.push(line),
      err: (line) => assert.fail(line),
    }),
    0,
  );
  assert.match(
    lines.join("\n"),
    /^story:controls-button--long-label@1280 .*"Save every change made in this session and close the editor"$/,
  );
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A storageState file with the static app's session cookie. */
function signedInState() {
  const state = join(scratch, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      cookies: [
        {
          name: "session",
          value: "ok",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
  );
  return state;
}

/** A pages config for the static app, with its token as a forbidden string. */
function pagesConfig(name, port, pages, extra = {}) {
  return writeConfig(name, {
    version: 1,
    pages: {
      ...extra,
      startCommand: `"${process.execPath}" "${join(fixture("static-app"), "server.mjs")}" ${port}`,
      waitUrl: `http://127.0.0.1:${port}/login`,
      auth: { storageState: signedInState() },
      shellReady: '[data-testid="shell"]',
      widths: [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ],
      timeoutMs: 10000,
      forbidStrings: [
        "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmVkLWJ5LW5vYm9keQ",
      ],
      pages: pages.map((page) => ({
        ready: "main h1",
        slots: { main: ["main"] },
        ...page,
      })),
    },
  });
}

test("a story with an unusable width list, or one holding the main thread before or after it renders, still becomes a gap, and one held at a width it does not list is captured at its own", async () => {
  const out = join(scratch, "hostile-kit");
  const config = writeConfig("hostile", {
    version: 1,
    stories: {
      root: fixture("storybook-react"),
      storybookDir: join(fixture("storybook-react"), "build"),
    },
  });
  const previous = process.env.DESIGN_KIT_STORY_TIMEOUT_MS;
  process.env.DESIGN_KIT_STORY_TIMEOUT_MS = "2000";
  let result;
  try {
    result = await cli([
      "capture",
      "stories",
      "--config",
      config,
      "--out",
      out,
      "--only",
      "hostile-card--zero-widths,hostile-card--busy,hostile-card--busy-after-render,hostile-card--phone-only-held-desktop",
    ]);
  } finally {
    if (previous === undefined) delete process.env.DESIGN_KIT_STORY_TIMEOUT_MS;
    else process.env.DESIGN_KIT_STORY_TIMEOUT_MS = previous;
  }
  assert.equal(result.code, 0, result.output);
  // Held at 1280, which it does not list: its widths still arrive, so 1280
  // is neither a row nor a gap and 390 is captured.
  assert.deepEqual(
    readJson(join(out, "index.json")).map((row) => row.id),
    ["story:hostile-card--phone-only-held-desktop@390"],
  );
  assert.deepEqual(
    readJson(join(out, "gaps.json"))
      .filter((row) => row.id)
      .map((row) => [row.id, row.reason]),
    [
      ["story:hostile-card--busy-after-render@1280", "timeout"],
      ["story:hostile-card--busy@1280", "timeout"],
      ["story:hostile-card--zero-widths@1280", "threw"],
    ],
  );
  // Held after it rendered: the bound on the settle, not the render wait.
  assert.match(
    readJson(join(out, "gaps.json")).find(
      (row) => row.id === "story:hostile-card--busy-after-render@1280",
    ).detail,
    /after storyRendered/,
  );
});

test("capture pages signs in from storageState and marks the main slot", async () => {
  const out = join(scratch, "pages-kit");
  const config = pagesConfig("pages", await freePort(), [
    { name: "home", path: "/" },
  ]);
  const result = await cli([
    "capture",
    "pages",
    "--config",
    config,
    "--out",
    out,
  ]);
  assert.equal(result.code, 0, result.output);

  const rows = readJson(join(out, "routes.json"));
  assert.deepEqual(
    rows.map((row) => [row.id, row.slots]),
    [
      ["route:home@1280", ["main"]],
      ["route:home@390", ["main"]],
    ],
  );
  const html = readFileSync(join(out, rows[0].file), "utf8");
  assert.match(html, /<main data-kit-slot="main">/);
  assert.match(html, /src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /<script|127\.0\.0\.1/);
  assert.deepEqual(rows[0].html_attrs, { "data-theme": "light", lang: "en" });
  assert.deepEqual(readJson(join(out, "gaps.json")), []);

  const css = readFileSync(join(out, "css/routes.css"), "utf8");
  assert.match(css, /url\("\.\.\/fonts\/app-sans\.woff2"\)/);
  assert.match(css, /url\("data:image\/svg\+xml;base64,/);
  assert.equal(
    readFileSync(join(out, "fonts/app-sans.woff2"), "utf8"),
    "wOF2-app-sans-bytes",
  );
  // A pages-only kit carries its own tool.
  assert.ok(existsSync(join(out, "kit.mjs")));
});

test("a path's query is not a redirect, and a page that redirects is a gap", async () => {
  const out = join(scratch, "redirect-kit");
  const config = pagesConfig("redirect", await freePort(), [
    { name: "tabbed", path: "/?tab=settings" },
    { name: "moved", path: "/moved" },
  ]);
  const result = await cli([
    "capture",
    "pages",
    "--config",
    config,
    "--out",
    out,
  ]);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    readJson(join(out, "routes.json")).map((row) => [row.id, row.path]),
    [
      ["route:tabbed@1280", "/?tab=settings"],
      ["route:tabbed@390", "/?tab=settings"],
    ],
  );
  const gaps = readJson(join(out, "gaps.json"));
  assert.equal(gaps.length, 2, JSON.stringify(gaps));
  for (const gap of gaps)
    assert.match(JSON.stringify(gap), /redirected from \/moved to \//);
});

test("a page whose markup carries a forbidStrings value fails the capture and writes nothing", async () => {
  const out = join(scratch, "leaky-kit");
  const config = pagesConfig("leaky", await freePort(), [
    { name: "home", path: "/" },
    { name: "leaky", path: "/leaky" },
  ]);
  const result = await cli([
    "capture",
    "pages",
    "--config",
    config,
    "--out",
    out,
  ]);
  assert.equal(result.code, 1, result.output);
  assert.match(
    result.output,
    /route:leaky@1280, route:leaky@390 carried a forbidStrings value; nothing was written/,
  );
  // The clean page is not written either: the run leaves no kit to upload.
  assert.ok(!existsSync(out));
});

test("two sourced captures into one kit each rewrite only their own source's frames", async () => {
  const out = join(scratch, "sources-kit");
  const capture = async (source, pages) => {
    const config = pagesConfig(`source-${source}`, await freePort(), pages, {
      source,
    });
    const result = await cli([
      "capture",
      "pages",
      "--config",
      config,
      "--out",
      out,
    ]);
    assert.equal(result.code, 0, result.output);
  };
  const ids = () =>
    readJson(join(out, "routes.json")).map((row) => [
      row.id,
      row.source,
      row.css,
    ]);

  await capture("web", [{ name: "home", path: "/" }]);
  // A page that redirects is a gap row, and it carries its source too.
  await capture("terminal", [
    { name: "terminal-home", path: "/?tab=settings" },
    { name: "terminal-moved", path: "/moved" },
  ]);
  const terminalGaps = () =>
    readJson(join(out, "gaps.json")).map((gap) => [gap.id, gap.source]);
  const gaps = [
    ["route:terminal-moved@1280", "terminal"],
    ["route:terminal-moved@390", "terminal"],
  ];
  assert.deepEqual(terminalGaps(), gaps);
  const both = [
    ["route:home@1280", "web", "css/routes--web.css"],
    ["route:home@390", "web", "css/routes--web.css"],
    ["route:terminal-home@1280", "terminal", "css/routes--terminal.css"],
    ["route:terminal-home@390", "terminal", "css/routes--terminal.css"],
  ];
  assert.deepEqual(ids(), both);
  // And the reverse: web again leaves terminal's frames and sheet in place.
  await capture("web", [{ name: "home", path: "/" }]);
  assert.deepEqual(ids(), both);
  assert.deepEqual(terminalGaps(), gaps);
  for (const file of [
    "html/route--terminal-home@1280.html",
    "css/routes--terminal.css",
    "css/routes--web.css",
  ])
    assert.ok(existsSync(join(out, file)), file);
  assert.deepEqual(
    Object.keys(
      readJson(join(out, "manifest.json")).sources.routes.page_sources,
    ).sort(),
    ["terminal", "web"],
  );
});
