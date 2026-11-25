/**
 * Frames captured once per theme (`pages.themes`, Terminal's windows):
 * `compose --theme` picks the capture in that theme and never toggles a theme
 * class on such a frame, so a page is never half light and half dark. Frames
 * of a source that captures one theme keep the class toggle.
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

import {
  rowFiles,
  themedGaps,
  themedHtmlFile,
  themedRows,
  writePagesKit,
} from "../src/capture-pages.mjs";
import { run } from "../src/kit.mjs";
import { mergeManifest } from "../src/pages.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "design-kit-themes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const LIGHT_ATTRS = {
  class: "light-mode",
  style: "--terminal-theme-bg: #ffffff; --theme-bg-window: #f5f5f5;",
  "data-codepress-surface": "light",
};
const DARK_ATTRS = {
  style: "--terminal-theme-bg: #000000; --theme-bg-window: #171717;",
  "data-codepress-surface": "dark",
};

/** One Terminal-like row: a light capture, and a dark one when `dark`. */
function terminalRow(name, { dark }) {
  const id = `route:${name}@1280`;
  return {
    id,
    kind: "route",
    title: `${name} (1280)`,
    file: themedHtmlFile(id, "light", true),
    width: 1280,
    height: 800,
    bytes: 1,
    slots: ["main"],
    source: "terminal",
    css: "css/routes--terminal.css",
    path: "/",
    body_class: "",
    html_attrs: LIGHT_ATTRS,
    body_attrs: {},
    theme: "light",
    theme_switch: "capture",
    ...(dark
      ? {
          variants: {
            dark: {
              file: themedHtmlFile(id, "dark", true),
              bytes: 1,
              slots: ["main"],
              body_class: "",
              html_attrs: DARK_ATTRS,
              body_attrs: {},
            },
          },
        }
      : {}),
  };
}

/** The fixture kit plus two Terminal frames: one with a dark capture, one without. */
function terminalKit(name) {
  const dir = join(scratch, name);
  cpSync(FIXTURE, dir, { recursive: true });
  const routes = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));
  routes.push(
    terminalRow("terminal-orchestrator", { dark: true }),
    terminalRow("terminal-settings", { dark: false }),
  );
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  const page = (theme) =>
    `<div data-kit-slot="main"><p class="window">${theme} window</p></div>`;
  writeFileSync(
    join(dir, "html/route--terminal-orchestrator@1280.html"),
    page("light"),
  );
  writeFileSync(
    join(dir, "html/route--terminal-orchestrator@1280.dark.html"),
    page("dark"),
  );
  writeFileSync(
    join(dir, "html/route--terminal-settings@1280.html"),
    page("light"),
  );
  writeFileSync(
    join(dir, "css/routes--terminal.css"),
    ".window{color:var(--theme-text-primary)}\n.dark .window{color:red}\n",
  );
  return dir;
}

let counter = 0;
function compose(dir, args) {
  const target = join(scratch, `${(counter += 1)}-page.html`);
  const out = [];
  const err = [];
  const code = run(["--kit", dir, "compose", ...args, "--out", target], {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return {
    code,
    err: err.join("\n"),
    page: code === 0 ? readFileSync(target, "utf8") : "",
  };
}

const tag = (page, name) => new RegExp(`<${name}[^>]*>`).exec(page)?.[0] ?? "";

test("--theme dark on a frame captured in both themes uses the dark capture and adds no theme class", () => {
  const dir = terminalKit("dark");
  const { code, err, page } = compose(dir, [
    "--frame",
    "route:terminal-orchestrator@1280",
    "--theme",
    "dark",
  ]);
  assert.equal(code, 0, err);
  assert.equal(err, "");
  const html = tag(page, "html");
  assert.match(html, /--terminal-theme-bg: #000000/);
  assert.match(html, /data-codepress-surface="dark"/);
  assert.doesNotMatch(html, /light-mode|#ffffff/);
  assert.doesNotMatch(html, /class="[^"]*\bdark\b/);
  assert.doesNotMatch(tag(page, "body"), /class="[^"]*\bdark\b/);
  assert.match(page, /dark window/);
  assert.doesNotMatch(page, /light window/);
});

test("--theme light and no --theme compose the light capture, the same page as a frame without theme captures", () => {
  const dir = terminalKit("light");
  const frame = ["--frame", "route:terminal-orchestrator@1280"];
  const light = compose(dir, [...frame, "--theme", "light"]);
  const none = compose(dir, frame);
  assert.equal(light.code, 0, light.err);
  assert.equal(none.code, 0, none.err);
  assert.match(tag(light.page, "html"), /class="light-mode"/);
  assert.match(tag(light.page, "html"), /#ffffff/);
  assert.doesNotMatch(light.page, /dark window/);
  assert.doesNotMatch(tag(light.page, "html"), /\bdark\b/);
  assert.equal(none.page, light.page);

  // The same capture as a kit wrote it before theme captures existed: no
  // `theme`, `theme_switch` or `variants`. Without --theme the page is
  // byte-for-byte what it was.
  const before = join(scratch, "before");
  cpSync(dir, before, { recursive: true });
  const routes = JSON.parse(readFileSync(join(before, "routes.json"), "utf8"));
  for (const row of routes) {
    delete row.theme;
    delete row.theme_switch;
    delete row.variants;
  }
  writeFileSync(join(before, "routes.json"), JSON.stringify(routes));
  const old = compose(before, frame);
  assert.equal(old.code, 0, old.err);
  assert.equal(none.page, old.page);
});

test("a frame with no dark capture and --theme dark stays as captured, warns once on stderr and exits 0", () => {
  const dir = terminalKit("missing");
  const { code, err, page } = compose(dir, [
    "--frame",
    "route:terminal-settings@1280",
    "--theme",
    "dark",
  ]);
  assert.equal(code, 0);
  const warnings = err.split("\n").filter(Boolean);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^kit: warning: route:terminal-settings@1280 has no dark capture/,
  );
  const html = tag(page, "html");
  assert.match(html, /class="light-mode"/);
  assert.match(html, /#ffffff/);
  assert.doesNotMatch(html, /class="[^"]*\bdark\b/);
  assert.doesNotMatch(tag(page, "body"), /class="[^"]*\bdark\b/);
  assert.match(page, /light window/);
});

test("a web frame's --theme dark is unchanged: the class toggle on html and body", () => {
  const plain = compose(FIXTURE, [
    "--frame",
    "route:orchestrator@1280",
    "--theme",
    "dark",
  ]);
  const alongside = compose(terminalKit("web"), [
    "--frame",
    "route:orchestrator@1280",
    "--theme",
    "dark",
  ]);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(plain.err, "");
  assert.match(tag(plain.page, "html"), /class="geist dark"/);
  assert.match(tag(plain.page, "body"), /class="[^"]*\bdark\b/);
  // Terminal rows in the same kit change nothing about a web frame.
  assert.equal(alongside.page, plain.page);
});

test("show lists a frame's captured themes", () => {
  const out = [];
  const code = run(
    ["--kit", terminalKit("show"), "show", "route:terminal-orchestrator@1280"],
    { out: (text) => out.push(text), err: () => {} },
  );
  assert.equal(code, 0);
  assert.match(out.join("\n"), /^themes: light, dark \(captured/m);
});

test("themedRows keeps the first captured theme as the row and the others as variants", () => {
  const base = (theme) => ({
    id: "route:x@1280",
    kind: "route",
    file: themedHtmlFile("route:x@1280", theme, true),
    bytes: theme === "light" ? 10 : 20,
    slots: ["main"],
    body_class: "",
    html_attrs: theme === "light" ? LIGHT_ATTRS : DARK_ATTRS,
    body_attrs: {},
  });
  const both = themedRows(
    new Map([["route:x@1280", { light: base("light"), dark: base("dark") }]]),
    ["light", "dark"],
  );
  assert.equal(both.length, 1);
  assert.equal(both[0].file, "html/route--x@1280.html");
  assert.equal(both[0].theme, "light");
  assert.equal(both[0].theme_switch, "capture");
  assert.equal(both[0].variants.dark.file, "html/route--x@1280.dark.html");
  assert.deepEqual(both[0].variants.dark.html_attrs, DARK_ATTRS);
  assert.deepEqual(rowFiles(both[0]), [
    "html/route--x@1280.html",
    "html/route--x@1280.dark.html",
  ]);

  // Light failed (a gap row): the dark capture is the row, with no variants.
  const darkOnly = themedRows(
    new Map([["route:x@1280", { dark: base("dark") }]]),
    ["light", "dark"],
  );
  assert.equal(darkOnly[0].theme, "dark");
  assert.equal(darkOnly[0].variants, undefined);
  assert.equal(
    themedHtmlFile("route:x@1280", "dark", false),
    "html/route--x@1280.html",
  );
});

test("a themed capture writes both files, records its themes and removes its old dark files on the next run", () => {
  const out = join(scratch, "write");
  mkdirSync(out, { recursive: true });
  const write = (rows, files) =>
    writePagesKit(out, {
      rows,
      files: new Map(files),
      css: "/* terminal */\n",
      gaps: [],
      needles: [],
      pages: [{ name: "terminal-orchestrator" }],
      widths: [{ width: 1280, height: 800 }],
      fonts: new Map(),
      theme: undefined,
      configDir: scratch,
      source: "terminal",
      themes: ["light", "dark"],
    });
  write(
    [terminalRow("terminal-orchestrator", { dark: true })],
    [
      ["html/route--terminal-orchestrator@1280.html", "<p>light</p>"],
      ["html/route--terminal-orchestrator@1280.dark.html", "<p>dark</p>"],
    ],
  );
  assert.ok(
    existsSync(join(out, "html/route--terminal-orchestrator@1280.dark.html")),
  );
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.sources.routes.page_sources.terminal.themes, [
    "light",
    "dark",
  ]);

  // The next capture has no dark file for the page: the old one goes.
  write(
    [terminalRow("terminal-orchestrator", { dark: false })],
    [["html/route--terminal-orchestrator@1280.html", "<p>light</p>"]],
  );
  assert.ok(
    !existsSync(join(out, "html/route--terminal-orchestrator@1280.dark.html")),
  );
});

test("a one-theme capture's manifest records no themes", () => {
  const manifest = mergeManifest(undefined, {
    sha: "s",
    builtAt: "t",
    captured: 1,
    failed: 0,
    pages: ["a"],
    widths: [1280],
    themes: ["light"],
    source: "web",
  });
  assert.equal("themes" in manifest.sources.routes.page_sources.web, false);
});

test("a frame that failed in both themes is one gap row listing both", () => {
  const gap = (id, theme, reason) => ({
    id,
    route: "x",
    themes: [theme],
    reason,
  });
  assert.deepEqual(
    themedGaps([
      gap("route:x@390", "light", "timed out"),
      gap("route:y@390", "dark", "no main slot"),
      gap("route:x@390", "dark", "timed out again"),
    ]),
    [
      {
        id: "route:x@390",
        route: "x",
        themes: ["light", "dark"],
        reason: "timed out",
      },
      {
        id: "route:y@390",
        route: "x",
        themes: ["dark"],
        reason: "no main slot",
      },
    ],
  );
});
