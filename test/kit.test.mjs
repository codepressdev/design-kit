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
  fontCss,
  kitFile,
  mergeGaps,
  mergeManifest,
  mergeSheetOrder,
  plannedViewports,
  playwrightVersion,
  timingBreakdown,
} from "../src/capture-stories.mjs";
import {
  compose,
  isMain,
  loadKit,
  run,
  sanitizeCss,
  sanitizeMarkup,
} from "../src/kit.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "design-kit-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function scratchFile(name, content) {
  const file = join(scratch, `${(counter += 1)}-${name}`);
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

/** Runs kit.mjs in-process against a kit; returns its code and output. */
function kit(args, dir = FIXTURE) {
  const out = [];
  const err = [];
  const code = run(["--kit", dir, ...args], {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function composeToString(args, dir) {
  const target = scratchFile("page.html");
  const result = kit(["compose", ...args, "--out", target], dir);
  assert.equal(result.code, 0, result.err);
  return readFileSync(target, "utf8");
}

/** Every URL a page could fetch: src/href-like attributes and CSS url(). */
function remoteReferences(page) {
  const attrs = [
    ...page.matchAll(
      /\s(?:src|href|xlink:href|srcset|poster|action|data|background)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]*)/gi,
    ),
  ].map((m) => m[1]);
  const urls = [
    ...page.matchAll(/url\(\s*(?:&quot;|["'])?\s*((?:https?:)?\/\/[^"')&]*)/gi),
  ].map((m) => m[1]);
  const imports = [...page.matchAll(/@import/gi)].map((m) => m[0]);
  return [...attrs, ...urls, ...imports];
}

test("compose fills a route slot, expands snippets from both sources and stays self-contained", () => {
  const slot = scratchFile(
    "main.html",
    `<section data-kit-new class="new-panel">New panel</section>
<kit-snippet id="story:primitives-dialog--open@1280"></kit-snippet>`,
  );
  const page = composeToString([
    "--frame",
    "route:orchestrator@1280",
    "--slot",
    `main=${slot}`,
  ]);

  assert.match(page, /New panel/);
  assert.doesNotMatch(page, /old content/);
  // The rail placeholder in the frame and the dialog placeholder in the slot
  // both expand; a story snippet loses its #storybook-root wrapper but keeps
  // its portal.
  assert.match(page, /aria-label="Settings"/);
  assert.match(page, /Dialog body/);
  assert.doesNotMatch(page, /<kit-snippet/);
  assert.doesNotMatch(page, /id="storybook-root"/);
  // A route frame carries routes.css; story snippets pull in stories.css.
  assert.match(page, /\.route-only\s*\{\s*color:\s*red/);
  assert.match(page, /\.story-only\s*\{\s*color:\s*blue/);
  // Fonts become data URIs from the kit's fonts folder, by their file names.
  const sans = Buffer.from("wOF2-fixture-sans").toString("base64");
  const mono = Buffer.from("wOF2-fixture-mono").toString("base64");
  assert.ok(page.includes(`data:font/woff2;base64,${sans}`));
  assert.ok(page.includes(`data:font/woff2;base64,${mono}`));
  assert.doesNotMatch(page, /\.\.\/fonts\//);
  // Provenance on <html>, with the captured html attributes kept.
  assert.match(
    page,
    /<html class="geist" style="color-scheme: light" lang="en" data-kit-sha="0123456789abcdef0123456789abcdef01234567" data-kit-id="route:orchestrator@1280">/,
  );
  assert.match(page, /<body class="bg-background font-sans antialiased"/);

  // Self-contained: nothing remote, nothing executable.
  assert.deepEqual(remoteReferences(page), []);
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /\son[a-z]+=/i);
  assert.doesNotMatch(page, /srcdoc=/i);
  assert.doesNotMatch(page, /<link/i);
  // An inline SVG's namespace is not a fetch and survives.
  assert.match(page, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // Without --show-new, new content carries no outline.
  assert.doesNotMatch(page, /\[data-kit-new\]\{outline/);
});

test("--show-new outlines new content and --theme dark sets dark on html and body", () => {
  const page = composeToString([
    "--frame",
    "route:orchestrator@1280",
    "--theme",
    "dark",
    "--show-new",
  ]);
  assert.match(page, /\[data-kit-new\]\{outline/);
  assert.match(page, /<html class="geist dark"/);
  assert.match(page, /<body class="bg-background font-sans antialiased dark"/);
});

test("a story frame keeps its root and Storybook layout class, with stories.css only", () => {
  const page = composeToString([
    "--frame",
    "story:primitives-dialog--open@1280",
  ]);
  assert.match(page, /<body class="sb-main-centered sb-show-main">/);
  assert.match(page, /<div id="storybook-root">/);
  assert.match(page, /Dialog body/);
  assert.match(page, /\.story-only/);
  assert.doesNotMatch(page, /\.route-only/);
  assert.deepEqual(remoteReferences(page), []);
  assert.doesNotMatch(page, /<script/i);
});

test("the sanitizer reads URLs as the browser does: entities, CSS escapes and every srcset candidate", () => {
  const markup = sanitizeMarkup(
    [
      `<img src="&#104;ttps://x.test/a.png">`,
      `<img src="&#x68;&#x74;tps&colon;//x.test/b.png">`,
      `<img srcset="a.png 1x, https://x.test/b.png 2x">`,
      // A bare comma separates candidates too, and the 2x one is fetched on
      // a 2x display.
      `<img srcset="x.png 1x,https://x.test/a58.png 2x">`,
      `<img srcset="x.png 1x,&#104;ttps://x.test/a59.png 2x">`,
      `<source srcset="x.png 1x ,//x.test/a60.png 3x">`,
      `<img srcset="x.png,https://x.test/a61.png">`,
      `<img srcset="data:image/png;base64,AAAA 1x, local.png 2x" alt="kept2">`,
      // Named references the browser decodes: &comma; splits candidates and
      // &lpar; makes a url( function.
      `<img srcset="x.png 1x&comma;https://x.test/s11.png 2x">`,
      `<svg><rect fill="url&lpar;https://x.test/p1.svg#g&rpar;"></rect></svg>`,
      // An unknown terminated reference fails closed.
      `<a href="&bogusname;https://x.test/b">b</a>`,
      `<span title="&copy; 2026 &mdash; ok">kept</span>`,
      `<img src=" \t//x.test/c.png">`,
      `<a href="jav&#x61;script:alert(1)">j</a>`,
      `<a href="java\tscript:alert(1)">t</a>`,
      `<a href="\\\\x.test/share">unc</a>`,
      `<div style="background:url(&quot;\\68ttps://x.test/d.png&quot;)"></div>`,
      `<div style="background:u\\72l(https://x.test/e.png)"></div>`,
      // SVG presentation attributes take url() and fetch it.
      `<svg><rect fill="url(https://x.test/q1.svg#g)"></rect><g mask="url(&quot;https://x.test/q4.svg#m&quot;)" clip-path="url(//x.test/q5.svg#c)" marker-end="u\\72l(https://x.test/q6.svg#e)"></g>`,
      `<rect fill="url(#local-gradient)" stroke="red"></rect>`,
      // SMIL can set an href to a remote URL after load.
      `<image><set attributeName="href" to="https://x.test/s.png"></set><animate attributeName="href" values="https://x.test/v.png"></animate></image></svg>`,
      `<img src="data:image/png;base64,AAAA" alt="kept">`,
      `<img srcset="small.png 1x, large.png 2x" alt="kept">`,
      `<a href="/settings">kept</a><a href="#top">kept</a>`,
    ].join(""),
  );
  assert.doesNotMatch(markup, /x\.test/);
  assert.doesNotMatch(markup, /script:/i);
  assert.equal((markup.match(/href="#"/g) ?? []).length, 4);
  assert.match(markup, /title="&copy; 2026 &mdash; ok"/);
  assert.match(markup, /src="data:image\/png;base64,AAAA"/);
  assert.match(markup, /srcset="small\.png 1x, large\.png 2x"/);
  assert.match(
    markup,
    /srcset="data:image\/png;base64,AAAA 1x, local\.png 2x"/,
  );
  assert.match(markup, /href="\/settings"/);
  assert.match(markup, /href="#top"/);
  assert.match(markup, /fill="url\(#local-gradient\)" stroke="red"/);
  assert.doesNotMatch(markup, /<set|<animate/);

  const css = sanitizeCss(
    [
      `.a{background:url(\\68ttps://x.test/a.png)}`,
      `.b{background-image:image-set("https://x.test/b.png" 1x)}`,
      // An escaped function name or at-keyword still works in the browser.
      `.e{background:u\\72l(https://x.test/e.png)}`,
      `.f{background:\\75 RL(https://x.test/f.png)}`,
      `@\\69mport "https://x.test/g.css";`,
      `.keep3\\:hover{color:red}`,
      `.c{background:url('//x.test/c.png')}`,
      `@import "https://x.test/d.css";`,
      `.keep{background:url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"></svg>")}`,
      `.keep2{background:url(../img/local.png)}`,
    ].join("\n"),
  );
  assert.doesNotMatch(css, /x\.test/);
  assert.doesNotMatch(css, /@import/);
  assert.ok(
    css.includes(
      `url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"></svg>")`,
    ),
    css,
  );
  assert.match(css, /url\(\.\.\/img\/local\.png\)/);
  assert.ok(css.includes(".keep3\\:hover{color:red}"), css);
});

test("compose names an unknown snippet, frame or slot with near matches and exits non-zero", () => {
  const typo = scratchFile(
    "typo.html",
    `<kit-snippet id="story:primitives-dialog--opne@1280"></kit-snippet>`,
  );
  const cases = [
    {
      args: ["--frame", "route:orchestrator@1280", "--slot", `main=${typo}`],
      named: "story:primitives-dialog--opne@1280",
      near: "story:primitives-dialog--open@1280",
    },
    {
      args: ["--frame", "route:orchestrater@1280"],
      named: "route:orchestrater@1280",
      near: "route:orchestrator@1280",
    },
    {
      args: ["--frame", "route:orchestrator@1280", "--slot", `mian=${typo}`],
      named: "mian",
      near: "main",
    },
  ];
  for (const { args, named, near } of cases) {
    const target = scratchFile("never.html");
    const result = kit(["compose", ...args, "--out", target]);
    assert.notEqual(result.code, 0, args.join(" "));
    assert.ok(result.err.includes(`"${named}"`), result.err);
    assert.match(result.err, /Did you mean/);
    assert.ok(result.err.includes(near), result.err);
  }
});

test("find prints at most 30 lines and show stays under 2 KB unless --full", () => {
  const found = kit(["find", "rail"]);
  assert.equal(found.code, 0, found.err);
  const lines = found.out.split("\n");
  assert.equal(lines.length, 30);
  assert.match(lines.at(-1), /more; add a word/);
  assert.match(found.out, /story:shell-iconrail--default@1280/);

  const id = "story:orchestrator-feed--long@1280";
  const markup = readFileSync(
    join(FIXTURE, "html/story--orchestrator-feed--long@1280.html"),
    "utf8",
  );
  assert.ok(Buffer.byteLength(markup) > 8 * 1024, "the fixture must be large");
  const shown = kit(["show", id]);
  assert.equal(shown.code, 0, shown.err);
  assert.ok(
    Buffer.byteLength(shown.out) <= 2048,
    `${Buffer.byteLength(shown.out)} bytes`,
  );
  assert.match(shown.out, /--full/);
  assert.match(shown.out, /<section\.feed>/);
  // The header names the kit's path, so the budget must hold wherever the
  // kit lives: the same kit under roots of every length in a 64-byte cycle.
  for (let pad = 0; pad < 64; pad += 1) {
    const dir = join(scratch, `kit-${"x".repeat(pad)}`);
    cpSync(FIXTURE, dir, { recursive: true });
    const moved = kit(["show", id], dir);
    assert.ok(
      Buffer.byteLength(moved.out) <= 2048,
      `${Buffer.byteLength(moved.out)} bytes at ${dir}`,
    );
  }
  assert.equal(kit(["show", id, "--full"]).out, markup);

  // Files are found through the row's `file`, never from the id: every
  // variant row points at the default story's markup.
  const variant = kit(["show", "story:shell-iconrail--variant-07@1280"]);
  assert.equal(variant.code, 0, variant.err);
  assert.match(variant.out, /html\/story--shell-iconrail--default@1280\.html/);

  const missing = kit(["show", "story:orchestrator-feed--lnog@1280"]);
  assert.notEqual(missing.code, 0);
  assert.ok(missing.err.includes(id), missing.err);
});

test("a kit with no route data still finds and composes stories", () => {
  const dir = join(scratch, "stories-only");
  cpSync(FIXTURE, dir, { recursive: true });
  rmSync(join(dir, "routes.json"));
  rmSync(join(dir, "css/routes.css"));
  rmSync(join(dir, "html/route--orchestrator@1280.html"));

  const info = kit(["info"], dir);
  assert.match(info.out, /rows: 38 \(stories 38, routes 0\)/);
  assert.notEqual(kit(["find", "route:"], dir).code, 0);
  const page = composeToString(
    ["--frame", "story:shell-iconrail--default@1280"],
    dir,
  );
  assert.match(page, /icon-rail/);
});

test("capture merges keep the other writer's rows and a cascade-respecting sheet order", () => {
  const gaps = mergeGaps(
    [
      { id: "route:media@390", reason: "empty main" },
      { route: "/apps", reason: "timeout" },
      { id: "story:old--gone@1280", reason: "timeout" },
    ],
    [{ id: "story:a--b@1280", reason: "threw" }],
  );
  assert.deepEqual(
    gaps.map((row) => row.id ?? row.route),
    ["/apps", "route:media@390", "story:a--b@1280"],
  );

  const manifest = mergeManifest(
    {
      counts: { routes: 12 },
      sources: { routes: { captured: 12, failed: 2 } },
    },
    { sha: "abc", builtAt: "t", stories: { captured: 100, failed: 3 } },
  );
  assert.deepEqual(manifest.counts, { stories: 100, routes: 12, failed: 5 });
  assert.equal(manifest.sources.routes.captured, 12);

  const order = [];
  mergeSheetOrder(order, ["inline:sb", "/main.css"]);
  mergeSheetOrder(order, ["inline:sb", "/chunk.css", "/main.css"]);
  mergeSheetOrder(order, ["/main.css", "inline:radix"]);
  assert.deepEqual(order, [
    "inline:sb",
    "/chunk.css",
    "/main.css",
    "inline:radix",
  ]);

  // Ids keep their ':'; file names never carry one (Actions artifacts reject it).
  assert.equal(
    kitFile("story:shell-appshell--desktop@1280"),
    "html/story--shell-appshell--desktop@1280.html",
  );

  const planning = {
    viewport: { width: 1280, height: 800 },
    widths: [{ titles: /^(Shell|Orchestrator)\//, width: 390, height: 844 }],
  };
  assert.deepEqual(
    plannedViewports("Shell/AppShell", null, planning).map((v) => v.width),
    [1280, 390],
  );
  assert.deepEqual(
    plannedViewports(
      "Orchestrator/Land",
      { width: 390, height: 844 },
      planning,
    ).map((v) => v.width),
    [390],
  );
  assert.deepEqual(
    plannedViewports("Chat/Bubble", { width: 320, height: 568 }, planning).map(
      (v) => v.width,
    ),
    [320],
  );
  assert.deepEqual(
    plannedViewports("Chat/Bubble", null).map((v) => v.width),
    [1280],
  );
});

test("timingBreakdown sums each phase and the time failures burned", () => {
  const t = (boot, render) => ({
    boot,
    render,
    settle: 1,
    serialize: 0,
    close: 0,
  });
  const result = timingBreakdown([
    { timing: t(10, 20), result: {} },
    { timing: t(5, 15000), failure: { reason: "timeout" } },
    { timing: t(5, 7), failure: { reason: "threw" } },
  ]);
  assert.deepEqual(result, {
    captures: 3,
    ok: 1,
    phases_ms: { boot: 20, render: 15027, settle: 3, serialize: 0, close: 0 },
    failed: { timeout: { count: 1, ms: 15006 }, threw: { count: 1, ms: 13 } },
  });
});

test("playwrightVersion reads the project's Playwright", () => {
  assert.match(playwrightVersion(), /^\d+\.\d+\.\d+/);
});

test("configured faces give the capture CSS byte for byte, variables included", () => {
  const fonts = {
    dir: "unused",
    faces: [
      {
        family: "Geist",
        file: "geist-latin.*.woff2",
        weight: "100 900",
        variable: "--font-geist-sans",
        fallback: "ui-sans-serif,system-ui,sans-serif",
      },
      {
        family: "Geist Mono",
        file: "geist-mono-latin.*.woff2",
        weight: "100 900",
        variable: "--font-geist-mono",
        fallback: "ui-monospace,monospace",
      },
    ],
  };
  assert.equal(
    fontCss("../fonts/", fonts, ["sans.woff2", "mono.woff2"]),
    `@font-face{font-family:"Geist";font-weight:100 900;font-display:block;src:url("../fonts/sans.woff2") format("woff2")}
@font-face{font-family:"Geist Mono";font-weight:100 900;font-display:block;src:url("../fonts/mono.woff2") format("woff2")}
:root{--font-geist-sans:"Geist",ui-sans-serif,system-ui,sans-serif !important;--font-geist-mono:"Geist Mono",ui-monospace,monospace !important}
*,*::before,*::after{caret-color:transparent !important;animation:none !important;transition:none !important}`,
  );
  // No fonts: only the rule that stops motion.
  assert.equal(
    fontCss("../fonts/", null, []),
    "*,*::before,*::after{caret-color:transparent !important;animation:none !important;transition:none !important}",
  );
});

/** A copy of the fixture kit with `manifest.theme` set. */
function themedKit(name, theme) {
  const dir = join(scratch, name);
  cpSync(FIXTURE, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ ...manifest, theme }),
  );
  return dir;
}

test("the manifest's theme decides what --theme dark sets", () => {
  const dir = themedKit("data-theme", {
    attribute: "data-theme",
    dark: "dark",
    light: "light",
    targets: ["html"],
  });
  const dark = composeToString(
    ["--frame", "route:orchestrator@1280", "--theme", "dark"],
    dir,
  );
  assert.match(dark, /<html [^>]*data-theme="dark"/);
  assert.doesNotMatch(dark, /<html class="[^"]*\bdark\b/);
  assert.doesNotMatch(dark, /<body [^>]*data-theme=/);
  const light = composeToString(["--frame", "route:orchestrator@1280"], dir);
  assert.match(light, /<html [^>]*data-theme="light"/);
});

test("a Storybook 6 #root is unwrapped like #storybook-root", () => {
  const dir = join(scratch, "sb6");
  cpSync(FIXTURE, dir, { recursive: true });
  const file = join(dir, "html/story--shell-iconrail--default@1280.html");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace('id="storybook-root"', 'id="root"'),
  );
  const slot = scratchFile(
    "slot.html",
    '<kit-snippet id="story:shell-iconrail--default@1280"></kit-snippet>',
  );
  const page = composeToString(
    ["--frame", "route:orchestrator@1280", "--slot", `main=${slot}`],
    dir,
  );
  assert.match(page, /icon-rail/);
  assert.doesNotMatch(page, /<div id="root">/);
});

test("any relative url() that names a file in the kit is inlined, anything else is dropped", () => {
  const dir = join(scratch, "assets");
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, "fonts/brand.woff"), "WOFF");
  writeFileSync(
    join(dir, "css/stories.css"),
    `${readFileSync(join(dir, "css/stories.css"), "utf8")}
@font-face{font-family:B;src:url('../fonts/brand.woff')}
.gone{background:url(../assets/missing.png)}
.frag{filter:url(#f)}`,
  );
  const page = composeToString(
    ["--frame", "story:shell-iconrail--default@1280"],
    dir,
  );
  assert.match(page, /url\("data:font\/woff;base64,V09GRg=="\)/);
  assert.match(page, /\.gone\{background:none\}/);
  assert.match(page, /filter:url\(#f\)/);
});

test("kit.mjs runs its command line only when it is the script node started", () => {
  const self = new URL("../src/kit.mjs", import.meta.url);
  assert.equal(isMain(self.href, fileURLToPath(self)), true);
  // Bundled into another program, import.meta.url is that program's, and so
  // is argv[1]: the kit must not run its CLI on the program's arguments.
  const bundle = scratchFile("agent-runner.js", "");
  assert.equal(isMain(new URL(`file://${bundle}`).href, bundle), false);
  assert.equal(isMain(self.href, undefined), false);
  assert.equal(isMain(undefined, bundle), false);
  assert.equal(isMain("data:text/javascript,", bundle), false);
});

test("compose refuses a page that snippets grow past its byte budget", () => {
  const kit = loadKit(FIXTURE);
  const many =
    '<kit-snippet id="story:shell-iconrail--default@1280"></kit-snippet>'.repeat(
      50,
    );
  const slots = [{ name: "main", content: many }];
  // Within the default budget it composes.
  assert.match(
    compose(kit, { frame: "route:orchestrator@1280", slots }),
    /data-kit-sha/,
  );
  assert.throws(
    () =>
      compose(kit, { frame: "route:orchestrator@1280", slots, maxBytes: 4096 }),
    /^Error: too large: the page grows past 4096 bytes/,
  );
});
