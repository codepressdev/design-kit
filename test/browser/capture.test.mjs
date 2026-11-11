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
  assert.equal(gaps.filter((row) => row.id).length, 0, JSON.stringify(gaps));
  const manifest = readJson(join(out, "manifest.json"));
  assert.equal(manifest.theme.attribute, "data-theme");
  assert.equal(manifest.sources.stories.captured, 4);

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
function pagesConfig(name, port, pages) {
  return writeConfig(name, {
    version: 1,
    pages: {
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
