import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CssCollector,
  cssUrls,
  findForbidden,
  forbiddenNeedles,
  isRouteHtmlFile,
  kitHtmlFile,
  kitRouteId,
  mergeGaps,
  mergeManifest,
  normalizeReactIds,
  rewriteCssUrls,
  selectPages,
} from "../src/pages.mjs";

const APP = "http://localhost:3100";
const PAGES = [
  { name: "home", path: "/", ready: "h1", slots: { main: ["main"] } },
  { name: "apps", path: "/apps", ready: "h1", slots: { main: ["main"] } },
  { name: "media", path: "/media", ready: "h1", slots: { main: ["main"] } },
];

test("selectPages keeps the config order, applies a ready override and names an unknown page", () => {
  const picked = selectPages(PAGES, {
    only: ["media", "apps"],
    ready: { apps: "#nope" },
  });
  assert.deepEqual(
    picked.map((page) => page.name),
    ["apps", "media"],
  );
  assert.equal(picked[0].ready, "#nope");
  assert.throws(
    () => selectPages(PAGES, { only: ["nope"] }),
    /unknown page "nope"/,
  );
  assert.equal(kitRouteId("apps", 390), "route:apps@390");
  // No ':' in a path: Actions artifacts reject it.
  assert.equal(kitHtmlFile("route:apps@390"), "html/route--apps@390.html");
  assert.equal(isRouteHtmlFile("route--apps@1280.html"), true);
  assert.equal(isRouteHtmlFile("story--x--y@1280.html"), false);
});

test("rewriteCssUrls points app fonts at the kit, inlines known assets and drops other app URLs", () => {
  const base = `${APP}/assets/root-abc.css`;
  const fonts = new Map();
  assert.equal(
    rewriteCssUrls(
      `src: url("/fonts/geist-latin.9b6f5ff4.woff2")`,
      base,
      APP,
      new Map(),
      {
        fontsPath: "/fonts/",
        fonts,
      },
    ),
    `src: url("../fonts/geist-latin.9b6f5ff4.woff2")`,
  );
  assert.deepEqual([...fonts.values()], ["geist-latin.9b6f5ff4.woff2"]);
  // Without a fontsPath, any font file on the app origin is a font.
  assert.equal(
    rewriteCssUrls(`src: url(/static/media/inter.abc.woff2)`, base, APP),
    `src: url("../fonts/inter.abc.woff2")`,
  );
  const inlined = new Map([
    [`${APP}/assets/dot.svg`, "data:image/svg+xml;base64,AA"],
  ]);
  assert.equal(
    rewriteCssUrls(`a{b:url(dot.svg)}`, base, APP, inlined),
    `a{b:url("data:image/svg+xml;base64,AA")}`,
  );
  assert.equal(rewriteCssUrls(`a{b:url('/big.png')}`, base, APP), "a{b:none}");
  const rule = `a{b:url("data:image/png;base64,AA");c:url(#f)}`;
  assert.equal(rewriteCssUrls(rule, base, APP), rule);
  assert.deepEqual(cssUrls(rule, base), []);
});

test("CssCollector adds a shared sheet once and orders inline styles by content", () => {
  const same = (rule) => rule;
  const root = {
    href: `${APP}/assets/root.css`,
    media: "",
    rules: ["a{x:1}", "b{x:2}"],
  };
  const chunk = {
    href: `${APP}/assets/apps.css`,
    media: "",
    rules: ["c{x:3}"],
  };
  const collector = new CssCollector();
  collector.add([root], same);
  collector.add([root, chunk], same);
  assert.equal(collector.toString(), "a{x:1}\nb{x:2}\nc{x:3}\n");

  const shimmer = { href: null, media: "", rules: ["@keyframes s{to{x:1}}"] };
  const radix = { href: null, media: "", rules: ["b{x:2}", "a{x:1}"] };
  const first = new CssCollector();
  first.add([shimmer, root, radix], same);
  const second = new CssCollector();
  second.add([root, radix], same);
  second.add([shimmer], same);
  assert.equal(first.toString(), second.toString());
  assert.equal(first.toString(), "a{x:1}\nb{x:2}\n@keyframes s{to{x:1}}\n");

  const media = new CssCollector();
  media.add([{ href: null, media: "print", rules: ["a{x:1}"] }], same);
  media.add([{ href: null, media: "print", rules: ["a{x:1}"] }], same);
  assert.equal(media.toString(), "@media print {\na{x:1}\n}\n");
});

test("forbidden strings are found as written, as token segments and escaped", () => {
  const token =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl";
  const user = JSON.stringify({ id: "user-1", name: "Pat Example" });
  const needles = forbiddenNeedles([token, user]);
  assert.equal(findForbidden(`<a data-t="${token}">`, needles), token);
  const payload = token.split(".")[1];
  assert.equal(findForbidden(`x${payload}x`, needles), payload);
  const inAttribute = `<div data-user="${user.replace(/"/g, "&quot;")}"></div>`;
  for (const text of [
    inAttribute,
    JSON.stringify({ a: user }),
    JSON.stringify({ a: inAttribute }),
  ])
    assert.notEqual(findForbidden(text, needles), null, text);
  assert.equal(findForbidden("<span>Pat Example</span>", needles), null);
  // A value that is not token-shaped is never split.
  assert.deepEqual(forbiddenNeedles(["a.b c"]).includes("a"), false);
});

test("mergeGaps replaces this half's rows and keeps the stories'", () => {
  assert.deepEqual(
    mergeGaps(
      [
        { id: "story:a--b@1280", reason: "threw" },
        { id: "route:apps@390", route: "apps", reason: "old" },
        { id: "route:media@390", reason: "old, no route key" },
        { component: "Thing", reason: "no story" },
      ],
      [{ id: "route:home@1280", route: "home", reason: "new" }],
    ),
    [
      { id: "story:a--b@1280", reason: "threw" },
      { component: "Thing", reason: "no story" },
      { id: "route:home@1280", route: "home", reason: "new" },
    ],
  );
  assert.deepEqual(mergeGaps(undefined, []), []);
  assert.deepEqual(mergeGaps({ not: "rows" }, []), []);
});

test("normalizeReactIds renumbers ids in document order and keeps references matching", () => {
  const a = `<button id="radix-_r_1u_" aria-controls="radix-_r_1v_"></button><div id="radix-_r_1v_"></div>`;
  const b = `<button id="radix-_r_2f_" aria-controls="radix-_r_2g_"></button><div id="radix-_r_2g_"></div>`;
  assert.equal(normalizeReactIds(a), normalizeReactIds(b));
  assert.equal(
    normalizeReactIds(a),
    `<button id="radix-_k0_" aria-controls="radix-_k1_"></button><div id="radix-_k1_"></div>`,
  );
  assert.equal(normalizeReactIds(`<label for=":r3:">`), `<label for="_k0_">`);
});

test("mergeManifest keeps the stories half, sums failures and records the theme", () => {
  const run = {
    sha: "abc",
    builtAt: "2026-11-03T00:00:00.000Z",
    captured: 14,
    failed: 2,
    pages: ["apps"],
    widths: [1280, 390],
  };
  assert.deepEqual(
    mergeManifest(
      {
        kit_version: 1,
        sha: "old",
        counts: { stories: 1200, failed: 30 },
        sources: { stories: { captured: 1200, failed: 30 } },
      },
      run,
    ),
    {
      kit_version: 1,
      sha: "abc",
      built_at: run.builtAt,
      counts: { stories: 1200, routes: 14, failed: 32 },
      sources: {
        stories: { captured: 1200, failed: 30 },
        routes: {
          captured: 14,
          failed: 2,
          pages: ["apps"],
          widths: [1280, 390],
        },
      },
    },
  );
  assert.deepEqual(mergeManifest(undefined, run).counts, {
    routes: 14,
    failed: 2,
  });
  const theme = { attribute: "data-theme", dark: "dark", targets: ["html"] };
  assert.deepEqual(mergeManifest(undefined, { ...run, theme }).theme, theme);
});
