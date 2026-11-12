/**
 * `design-kit capture stories`: every story of a Storybook 7, 8 or 9 static build
 * rendered to static HTML, the CSS the preview loaded, the fonts, an index
 * and kit.mjs.
 *
 * DESIGN_KIT_CONCURRENCY caps the browser pages working at once (default 4);
 * DESIGN_KIT_STORY_TIMEOUT_MS bounds each capture (default 15000);
 * DESIGN_KIT_QUIET_MS is how long the DOM must stay unchanged (default 600);
 * DESIGN_KIT_TIMINGS_FILE, when set, receives the per-phase time breakdown.
 * Needs Playwright's Chromium (`npx playwright install chromium`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { globToRegExp, matchFile } from "./glob.mjs";
import { loadPlaywright, playwrightVersion } from "./playwright.mjs";

export { playwrightVersion };

const here = fileURLToPath(new URL(".", import.meta.url));

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const QUIET_FRAMES = 6;
/**
 * DESIGN_KIT_QUIET_MS: how long the DOM must stay unchanged, after fonts,
 * frames, images and requests are done (default 600). Stories on real timers
 * (slow routes, loading states) render a different state under a shorter
 * floor, so it stays at 600.
 */
const quietMs =
  Number.parseInt(process.env.DESIGN_KIT_QUIET_MS ?? "600", 10) || 0;

/** Storybook's built-in viewport names (minimal set plus the iPhones in use). */
const NAMED_VIEWPORTS = {
  mobile1: { width: 320, height: 568 },
  mobile2: { width: 414, height: 896 },
  tablet: { width: 834, height: 1112 },
  iphone12: { width: 390, height: 844 },
  iphone12promax: { width: 428, height: 926 },
  iphonex: { width: 375, height: 812 },
  iphone6: { width: 375, height: 667 },
};

/** The kit ids are Storybook's with a width suffix. */
export const kitId = (storyId, width) => `story:${storyId}@${width}`;
/** File names carry no ':' (Actions artifacts reject it): `story--<id>@<w>`. */
export const kitFile = (id) => `html/${id.replace(/^story:/, "story--")}.html`;
export const storyIdOf = (id) => id.replace(/^story:/, "").replace(/@\d+$/, "");

/**
 * Sheets in a cascade-respecting order: each capture's sheets keep their
 * document order, and a sheet first seen later is placed after the sheet
 * that preceded it in that capture.
 */
export function mergeSheetOrder(order, keys) {
  let last = -1;
  for (const key of keys) {
    let at = order.indexOf(key);
    if (at < 0) {
      order.splice(last + 1, 0, key);
      at = last + 1;
    }
    last = at;
  }
  return order;
}

/** All rules once, first occurrence wins, in sheet order. */
export function buildCss(fontCss, order, sheets) {
  const seen = new Set();
  const out = [fontCss.trim()];
  for (const key of order) {
    for (const rule of sheets[key] ?? []) {
      if (seen.has(rule)) continue;
      seen.add(rule);
      out.push(rule);
    }
  }
  return `${out.join("\n")}\n`;
}

/** Keeps another writer's rows (routes); ours are replaced wholesale. */
export function mergeGaps(existing, ours) {
  const theirs = existing.filter(
    (row) =>
      row.route !== undefined || String(row.id ?? "").startsWith("route:"),
  );
  return [...ours, ...theirs].sort((a, b) => {
    const ka = JSON.stringify([a.id ?? "", a.component ?? "", a.route ?? ""]);
    const kb = JSON.stringify([b.id ?? "", b.component ?? "", b.route ?? ""]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function mergeManifest(existing, { sha, builtAt, stories, theme }) {
  const sources = { ...(existing?.sources ?? {}), stories };
  const failed = Object.values(sources).reduce(
    (sum, source) => sum + (Number(source?.failed) || 0),
    0,
  );
  return {
    kit_version: 1,
    sha,
    built_at: builtAt,
    counts: {
      ...(existing?.counts ?? {}),
      stories: stories.captured,
      routes: existing?.counts?.routes ?? 0,
      failed,
    },
    sources,
    ...(theme ? { theme } : {}),
  };
}

/**
 * Which captures a story gets: its declared viewport or the default, plus
 * each configured width whose `titles` pattern matches the story's title.
 */
export function plannedViewports(
  title,
  declared,
  { viewport = DEFAULT_VIEWPORT, widths = [] } = {},
) {
  const first = declared ?? viewport;
  const list = [first];
  for (const extra of widths) {
    if (
      extra.titles.test(title) &&
      !list.some((planned) => planned.width === extra.width)
    ) {
      list.push({ width: extra.width, height: extra.height });
    }
  }
  return list;
}

/** `--only` / `--only-file` text: comma- or newline-separated story ids. */
export function parseOnly(text) {
  return text
    .split(/[,\n]/)
    .map((id) => storyIdOf(id.trim()))
    .filter(Boolean);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function serve(buildDir, fontsDir) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    const fonts = fontsDir !== null && path.startsWith("/__fonts/");
    const root = fonts ? fontsDir : buildDir;
    const file = resolve(
      root,
      `.${fonts ? path.slice("/__fonts".length) : path}`,
    );
    if (
      !file.startsWith(root + sep) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "content-type",
      TYPES[extname(file)] ?? "application/octet-stream",
    );
    createReadStream(file).pipe(response);
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done(server)),
  );
}

/** No animation or transition runs, and no caret blinks, in a capture. */
const STILL_CSS =
  "*,*::before,*::after{caret-color:transparent !important;animation:none !important;transition:none !important}";

const FONT_FORMATS = {
  ".woff2": "woff2",
  ".woff": "woff",
  ".ttf": "truetype",
  ".otf": "opentype",
};

/**
 * Each configured face's file in `fonts.dir`: the first name, in sorted
 * order, that its `file` glob matches. The kit keeps the file's name.
 */
export function fontFiles(fonts) {
  if (!fonts) return [];
  const names = readdirSync(fonts.dir).sort();
  return fonts.faces.map((face, index) => {
    const pattern = globToRegExp(face.file);
    const name = names.find((candidate) => pattern.test(candidate));
    if (!name) {
      throw new Error(
        `stories.fonts.faces[${index}].file "${face.file}" matches nothing in ${fonts.dir}`,
      );
    }
    return name;
  });
}

/**
 * The CSS every capture is given first: the configured faces from `base`,
 * the CSS variables that name them, and the rule that stops motion.
 */
export function fontCss(base, fonts, files = fontFiles(fonts)) {
  const faces = fonts?.faces ?? [];
  const lines = faces.map((face, index) => {
    const file = files[index];
    const format = FONT_FORMATS[extname(file).toLowerCase()] ?? "woff2";
    return `@font-face{font-family:"${face.family}";${face.weight ? `font-weight:${face.weight};` : ""}${face.style ? `font-style:${face.style};` : ""}font-display:block;src:url("${base}${file}") format("${format}")}`;
  });
  const variables = faces
    .filter((face) => face.variable)
    .map(
      (face) =>
        `${face.variable}:"${face.family}"${face.fallback ? `,${face.fallback}` : ""} !important`,
    );
  if (variables.length) lines.push(`:root{${variables.join(";")}}`);
  lines.push(STILL_CSS);
  return lines.join("\n");
}

/** Runs before any page script: a seeded Math.random, the font CSS, and a channel tap. */
function pageInit({ css, families }) {
  let seed = 0x2f6b9a1d;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  if (globalThis.crypto) {
    let n = 0;
    crypto.randomUUID = () =>
      `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
    crypto.getRandomValues = (array) => {
      for (let i = 0; i < array.length; i += 1) {
        array[i] = Math.floor(Math.random() * 256);
      }
      return array;
    };
  }
  const kit = { outcome: null, detail: "", pending: 0 };
  window.__kit = kit;
  // In-flight requests, so settling can wait for them rather than a timer.
  const track = (promise) => {
    kit.pending += 1;
    return promise.finally(() => {
      kit.pending -= 1;
    });
  };
  if (window.fetch) {
    const fetch = window.fetch;
    window.fetch = function (...args) {
      return track(fetch.apply(this, args));
    };
  }
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    track(
      new Promise((done) =>
        this.addEventListener("loadend", done, { once: true }),
      ),
    );
    return send.apply(this, args);
  };
  const finish = (outcome, detail) => {
    if (!kit.outcome) {
      kit.outcome = outcome;
      kit.detail = String(detail ?? "").slice(0, 500);
    }
  };
  const describe = (value) =>
    value && typeof value === "object"
      ? (value.description ??
        value.message ??
        value.title ??
        JSON.stringify(value))
      : value;
  let channel;
  Object.defineProperty(window, "__STORYBOOK_ADDONS_CHANNEL__", {
    configurable: true,
    get: () => channel,
    set(value) {
      channel = value;
      value.on("storyRendered", () => finish("rendered"));
      value.on("storyErrored", (e) => finish("threw", describe(e)));
      value.on("storyThrewException", (e) => finish("threw", describe(e)));
      value.on("playFunctionThrewException", (e) =>
        finish("threw", `play: ${describe(e)}`),
      );
      value.on("storyMissing", () => finish("missing"));
    },
  });
  window.__kitLoaded = new WeakSet();
  // `load` never propagates through window (DOM spec), so listen on document.
  document.addEventListener(
    "load",
    (event) => {
      if (event.target?.localName === "iframe")
        window.__kitLoaded.add(event.target);
    },
    true,
  );
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.setAttribute("data-kit-inject", "");
    style.textContent = css;
    document.head.append(style);
    for (const family of families) document.fonts.load(`400 16px "${family}"`);
  });
}

/**
 * Waits for fonts, frame and image loads, no pending requests and a quiet
 * DOM, bounded. Answers whether it
 * settled and whether anything changed while it waited.
 */
function settle({ frames, quietMs, timeout }) {
  let mutated = false;
  return Promise.race([
    (async () => {
      await document.fonts.ready;
      // Frames report their size after they load; wait for every one.
      await Promise.all(
        [...document.querySelectorAll("iframe")].map((frame) =>
          window.__kitLoaded?.has(frame)
            ? null
            : new Promise((done) =>
                frame.addEventListener("load", done, { once: true }),
              ),
        ),
      );
      await Promise.all(
        [...document.images].map((image) =>
          image.complete
            ? null
            : new Promise((done) => {
                image.addEventListener("load", done, { once: true });
                image.addEventListener("error", done, { once: true });
              }),
        ),
      );
      // Quiet means no request in flight and no DOM change for `frames`
      // frames AND `quietMs` ms: a loaded machine paints slowly, so frames
      // alone can pass before the async work (timers, postMessage) lands.
      await new Promise((done) => {
        let quiet = 0;
        let since = performance.now();
        const observer = new MutationObserver(() => {
          mutated = true;
          quiet = 0;
          since = performance.now();
        });
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const tick = () => {
          if (window.__kit?.pending > 0) {
            quiet = 0;
            since = performance.now();
          } else quiet += 1;
          if (quiet >= frames && performance.now() - since >= quietMs) {
            observer.disconnect();
            done();
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { settled: true, mutated };
    })(),
    new Promise((done) =>
      setTimeout(() => done({ settled: false, mutated: true }), timeout),
    ),
  ]);
}

/**
 * In the page: the story's parameters, the head's style sheets, and the body
 * serialized with scaffolding and scripts removed and portals kept.
 */
async function extract() {
  const SCAFFOLD =
    ".sb-preparing-story,.sb-preparing-docs,.sb-nopreview,.sb-errordisplay,#storybook-docs,script,noscript,template,link,[data-kit-inject]";
  const story = window.__STORYBOOK_PREVIEW__?.currentRender?.story;
  const parameters = story?.parameters ?? {};
  const viewport = parameters.viewport ?? {};
  let declared = null;
  const name = viewport.defaultViewport;
  if (name && name !== "responsive") {
    const custom = viewport.viewports?.[name]?.styles;
    declared = custom
      ? {
          name,
          width: parseInt(custom.width, 10),
          height: parseInt(custom.height, 10),
        }
      : { name };
  }

  const sheets = [];
  for (const sheet of document.styleSheets) {
    const owner = sheet.ownerNode;
    if (
      owner &&
      (owner.hasAttribute?.("data-kit-inject") || document.body.contains(owner))
    ) {
      continue;
    }
    let rules;
    try {
      rules = [...sheet.cssRules].map((rule) => rule.cssText);
    } catch {
      continue;
    }
    const base = sheet.href ?? location.href;
    const absolute = rules.map((text) =>
      text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, q, url) =>
        url.startsWith("data:") ? whole : `url("${new URL(url, base).href}")`,
      ),
    );
    const key = sheet.href
      ? new URL(sheet.href).pathname
      : `inline:${absolute.join("\n")}`;
    sheets.push({ key, rules: absolute });
  }

  // Storybook 7 and later render into #storybook-root, Storybook 6 into #root.
  const root =
    document.getElementById("storybook-root") ??
    document.getElementById("root");
  const live = [...document.body.querySelectorAll("*")];
  const clone = document.body.cloneNode(true);
  const copies = [...clone.querySelectorAll("*")];
  const toData = async (url) => {
    try {
      const blob = await (await fetch(url)).blob();
      if (blob.size > 512 * 1024) return null;
      return await new Promise((done) => {
        const reader = new FileReader();
        reader.onload = () => done(reader.result);
        reader.onerror = () => done(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };
  for (let i = 0; i < live.length; i += 1) {
    const element = live[i];
    const copy = copies[i];
    const tag = element.localName;
    if (tag === "input") {
      if (element.type === "checkbox" || element.type === "radio") {
        copy.toggleAttribute("checked", element.checked);
      } else if (element.type !== "file" && element.type !== "password") {
        copy.setAttribute("value", element.value);
      }
    } else if (tag === "textarea") {
      copy.textContent = element.value;
    } else if (tag === "option") {
      copy.toggleAttribute("selected", element.selected);
    } else if (tag === "canvas") {
      try {
        const image = document.createElement("img");
        for (const attr of element.attributes)
          image.setAttribute(attr.name, attr.value);
        image.setAttribute("src", element.toDataURL("image/png"));
        image.setAttribute("width", String(element.clientWidth));
        image.setAttribute("height", String(element.clientHeight));
        copy.replaceWith(image);
      } catch {
        // A tainted canvas stays an empty canvas.
      }
    } else if (tag === "iframe") {
      copy.removeAttribute("src");
      copy.removeAttribute("srcdoc");
    } else if (tag === "img" && element.getAttribute("src")) {
      const src = element.currentSrc || element.src;
      if (src && new URL(src).origin === location.origin) {
        const data = await toData(src);
        if (data) copy.setAttribute("src", data);
        else copy.removeAttribute("src");
        copy.removeAttribute("srcset");
      }
    }
    for (const attr of [...(copy.attributes ?? [])]) {
      if (attr.name.startsWith("on")) copy.removeAttribute(attr.name);
    }
  }
  for (const node of clone.querySelectorAll(SCAFFOLD)) node.remove();
  // Attribute order follows the order code set them in, which can race;
  // sort it so the markup depends only on the final state.
  for (const element of clone.querySelectorAll("*")) {
    const attrs = [...element.attributes].map((attr) => [
      attr.name,
      attr.value,
    ]);
    if (attrs.length < 2) continue;
    for (const [name] of attrs) element.removeAttribute(name);
    attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name, value] of attrs) element.setAttribute(name, value);
  }
  const html = clone.innerHTML.trim();

  const rootHasContent =
    !!root &&
    (root.children.length > 0 || (root.textContent ?? "").trim().length > 0);
  const portalHasContent = [...clone.children].some(
    (node) =>
      node.id !== "storybook-root" &&
      node.id !== "root" &&
      (node.textContent ?? "").trim().length > 0,
  );
  const bodyClass = [...document.body.classList]
    .filter((name) => name === "sb-show-main" || name.startsWith("sb-main-"))
    .join(" ");
  return {
    html,
    sheets,
    declared,
    bodyClass,
    empty: !rootHasContent && !portalHasContent,
  };
}

/** Capture phases, timed per capture for the run's breakdown. */
export const PHASES = ["boot", "render", "settle", "serialize", "close"];

/** One capture, with the milliseconds it spent in each phase. */
async function captureOne(args) {
  const timing = Object.fromEntries(PHASES.map((name) => [name, 0]));
  let phase = "boot";
  let last = Date.now();
  const step = (next) => {
    const now = Date.now();
    timing[phase] += now - last;
    last = now;
    phase = next;
  };
  const out = await captureTimed(args, step);
  step("close");
  return { ...out, timing };
}

/**
 * Pages waiting for their next story, per viewport. A page is reused only
 * after a capture that succeeded, and starts each story from about:blank
 * with the origin's storage (session storage included) cleared and
 * window.name reset, so a story sees what a fresh context would show it.
 * At most `parkLimit` pages wait at once (the lane count); the rest close.
 */
const idlePages = new Map();
let parkLimit = 4;
const parkedCount = () =>
  [...idlePages.values()].reduce((sum, list) => sum + list.length, 0);

async function freshPage({
  browser,
  origin,
  viewport,
  css,
  families,
  fixedTime,
}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: "en-US",
  });
  await context.route("**/*", (route) =>
    route.request().url().startsWith(origin) ||
    route.request().url().startsWith("data:")
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  page.on("pageerror", () => {});
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(pageInit, { css, families });
  return { context, page, cdp: await context.newCDPSession(page) };
}

async function captureTimed(
  { browser, origin, story, viewport, timeout, css, families, fixedTime },
  step,
) {
  const key = `${viewport.width}x${viewport.height}`;
  const slot =
    idlePages.get(key)?.pop() ??
    (await freshPage({
      browser,
      origin,
      viewport,
      css,
      families,
      fixedTime,
    }));
  const { context, page, cdp } = slot;
  let reusable = false;
  try {
    await cdp.send("Storage.clearDataForOrigin", {
      origin,
      storageTypes: "all",
    });
    step("render");
    const deadline = Date.now() + timeout;
    // `a11y.manual` keeps @storybook/addon-a11y from running axe after every
    // render (when a preview sets `a11y.test`). Axe reads the DOM without
    // changing it, so the markup is the same; it was a quarter of the CPU.
    await page.goto(
      `${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&globals=a11y.manual:!true`,
      { waitUntil: "domcontentloaded", timeout },
    );
    const outcome = await page
      .waitForFunction(() => window.__kit?.outcome, null, {
        timeout: Math.max(1000, deadline - Date.now()),
        polling: 50,
      })
      .then(() => page.evaluate(() => ({ ...window.__kit })))
      .catch(() => ({
        outcome: "timeout",
        detail: `no storyRendered within ${timeout}ms`,
      }));
    if (outcome.outcome !== "rendered") {
      return {
        failure: {
          reason: outcome.outcome === "missing" ? "missing" : outcome.outcome,
          detail: outcome.detail,
        },
      };
    }
    // Settling has its own budget, so a slow render under load does not eat
    // into it. A story whose DOM is still changing when it runs out has no
    // reproducible snapshot (a live ticker, say), so it is a gap, not a row.
    step("settle");
    const quiet = { frames: QUIET_FRAMES, quietMs, timeout };
    // Sandboxed frames render in their own process, so the host can look
    // quiet while a guest has yet to report its size, and a host may bring in
    // guests one after another. Settle the guests, then the host, until a
    // round brings no new frame and no host change.
    const settleBy = Date.now() + timeout;
    let settled = (await page.evaluate(settle, quiet)).settled;
    let known = new Set();
    while (settled) {
      const guests = page
        .frames()
        .filter((frame) => frame !== page.mainFrame());
      const fresh = guests.some((frame) => !known.has(frame));
      if (!fresh && known.size === 0) break;
      known = new Set(guests);
      const results = await Promise.all(
        // A frame that navigated away or detached has nothing left to wait for.
        guests.map((frame) =>
          frame.evaluate(settle, quiet).catch(() => ({ settled: true })),
        ),
      );
      const host = await page.evaluate(settle, quiet);
      settled =
        results.every((result) => result.settled) &&
        host.settled &&
        Date.now() < settleBy;
      if (!fresh && !host.mutated) break;
    }
    if (!settled) {
      return {
        failure: {
          reason: "timeout",
          detail: `DOM still changing ${timeout}ms after storyRendered`,
        },
      };
    }
    step("serialize");
    const result = await page.evaluate(extract);
    // An inline sheet is keyed by its text, which resolved its url()s against
    // this run's server; the port must not reach the kit.
    for (const sheet of result.sheets)
      sheet.key = sheet.key.split(origin).join("");
    if (result.empty) {
      return {
        failure: {
          reason: "empty root",
          detail: "nothing rendered in the root or a portal",
        },
      };
    }
    reusable = true;
    return { result };
  } catch (error) {
    return {
      failure: {
        reason: /Timeout/i.test(String(error)) ? "timeout" : "threw",
        detail: String(error?.message ?? error)
          .split("\n")[0]
          .slice(0, 500),
      },
    };
  } finally {
    step("close");
    const parked =
      reusable &&
      parkedCount() < parkLimit &&
      (await page
        // Session storage lives with the tab, not the origin's data, so it
        // is cleared on the story's own page before leaving it.
        .evaluate(() => sessionStorage.clear())
        .then(() => page.goto("about:blank"))
        .then(() =>
          page.evaluate(() => {
            window.name = "";
          }),
        )
        .then(() => true)
        .catch(() => false));
    if (parked) {
      const list = idlePages.get(key) ?? [];
      list.push(slot);
      idlePages.set(key, list);
    } else await context.close().catch(() => {});
  }
}

/**
 * Where the lanes' time went: per phase over all captures, and the time
 * failed captures spent before they failed, by reason.
 */
export function timingBreakdown(captures) {
  const phases = Object.fromEntries(PHASES.map((name) => [name, 0]));
  const failed = {};
  let ok = 0;
  for (const { timing, failure } of captures) {
    const total = PHASES.reduce((sum, name) => sum + (timing?.[name] ?? 0), 0);
    for (const name of PHASES) phases[name] += timing?.[name] ?? 0;
    if (failure) {
      const row = (failed[failure.reason] ??= { count: 0, ms: 0 });
      row.count += 1;
      row.ms += total;
    } else ok += 1;
  }
  return { captures: captures.length, ok, phases_ms: phases, failed };
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function pool(items, limit, work) {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

function viewportFor(declared) {
  if (!declared) return null;
  if (declared.width && declared.height) return declared;
  return NAMED_VIEWPORTS[declared.name] ?? null;
}

function storybookStories(buildDir) {
  const index = JSON.parse(readFileSync(join(buildDir, "index.json"), "utf8"));
  return Object.values(index.entries ?? {})
    .filter((entry) => entry.type === "story")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Component files nothing documents: files under `gaps.sourceRoot` whose path
 * from the Storybook project matches `gaps.componentGlob`, minus stories,
 * tests and specs, that no story names as its component or import. Paths in
 * the rows are relative to the config file's folder.
 */
export function componentsWithoutStories(stories, { gaps, root, configDir }) {
  const documented = new Set(
    stories
      .flatMap((s) => [s.componentPath, s.importPath])
      .filter(Boolean)
      .map((path) =>
        path.replace(/^\.\//, "").replace(/\.stories\.([cm]?[jt]sx?)$/, ".$1"),
      ),
  );
  if (!gaps) return [];
  const pattern = globToRegExp(gaps.componentGlob);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        if (name.name !== "node_modules") walk(path);
      } else if (!/\.(stories|test|spec)\.[cm]?[jt]sx?$/.test(name.name)) {
        const rel = relative(root, path).split(sep).join("/");
        if (matchFile(pattern, rel) && !documented.has(rel)) {
          out.push({
            component: relative(configDir, path).split(sep).join("/"),
            reason: "no story",
          });
        }
      }
    }
  };
  if (existsSync(gaps.sourceRoot)) walk(gaps.sourceRoot);
  return out;
}

/** The commit the kit was built from, or "unknown" outside a git checkout. */
function gitSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Font files a captured sheet loads from the capture server, by URL. */
const FONT_URL = /url\("([^"]+\.(?:woff2?|ttf|otf|eot))(?:[?#][^"]*)?"\)/gi;

/**
 * Without configured fonts, the preview's own `@font-face` files travel in
 * the kit: each one the build serves is copied to `fonts/` and the rule
 * points at `../fonts/<name>`.
 */
function collectFonts(rules, { origin, buildDir, out, copied }) {
  return rules.map((rule) =>
    rule.replace(FONT_URL, (whole, url) => {
      if (!url.startsWith(`${origin}/`)) return whole;
      const path = decodeURIComponent(new URL(url).pathname);
      const file = resolve(buildDir, `.${path}`);
      if (!file.startsWith(buildDir + sep) || !existsSync(file)) return whole;
      const name = file.split(sep).pop();
      if (!copied.has(name)) {
        copyFileSync(file, join(out, "fonts", name));
        copied.add(name);
      }
      return `url("../fonts/${name}")`;
    }),
  );
}

/**
 * Captures the stories half of a kit.
 *
 * `config` is a loaded design-kit.config.json (see config.mjs); `options`
 * carries the command line: `out`, `storybookDir`, `only` (story ids) and
 * `base` (a previous kit to copy the other rows from).
 */
export async function captureStories(config, options = {}) {
  const stories_ = config.stories;
  if (!stories_) {
    throw new Error(
      "design-kit.config.json has no stories section; add one to capture stories",
    );
  }
  const log = options.log ?? console.log;
  const started = Date.now();
  const cpuStart = process.cpuUsage();
  const tmp = process.env.TMPDIR ?? tmpdir();
  const out = resolve(options.out ?? config.out ?? join(tmp, "design-kit"));
  const concurrency = Math.max(
    1,
    Number.parseInt(process.env.DESIGN_KIT_CONCURRENCY ?? "4", 10) || 4,
  );
  parkLimit = concurrency;
  const timeout =
    Number.parseInt(process.env.DESIGN_KIT_STORY_TIMEOUT_MS ?? "15000", 10) ||
    15000;

  const root = stories_.root;
  const fonts = stories_.fonts;
  const fixedTime = stories_.fixedTime;
  const families = (fonts?.faces ?? []).map((face) => face.family);
  const planning = { viewport: stories_.viewport, widths: stories_.widths };
  const fontNames = fontFiles(fonts);

  let buildDir = options.storybookDir
    ? resolve(options.storybookDir)
    : stories_.storybookDir;
  let ownedBuild = null;
  let server = null;
  let browser = null;
  let buildSeconds = 0;
  try {
    if (!buildDir && stories_.buildCommand) {
      // The configured build writes `staticDir`; a build with no staticDir
      // goes to a temporary folder, removed afterwards ({out} names it).
      if (stories_.staticDir) buildDir = stories_.staticDir;
      else {
        ownedBuild = mkdtempSync(join(tmp, "design-kit-storybook-"));
        buildDir = ownedBuild;
      }
      const command = stories_.buildCommand.split("{out}").join(buildDir);
      log(`building Storybook: ${command}`);
      const built = spawnSync(command, {
        cwd: root,
        shell: true,
        stdio: "inherit",
        env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1" },
      });
      if (built.status !== 0) {
        throw new Error(`the Storybook build exited ${built.status}`);
      }
      buildSeconds = (Date.now() - started) / 1000;
    }
    if (!buildDir) buildDir = stories_.staticDir;
    if (!buildDir || !existsSync(join(buildDir, "index.json"))) {
      throw new Error(
        `no Storybook static build${buildDir ? ` at ${buildDir} (it has no index.json)` : ""}: pass --storybook-dir, or set stories.buildCommand and stories.staticDir`,
      );
    }

    const stories = storybookStories(buildDir);
    const only = options.only ? new Set(options.only) : null;
    if (only) {
      const known = new Set(stories.map((s) => s.id));
      const missing = [...only].filter((id) => !known.has(id));
      if (missing.length)
        throw new Error(`--only: no such story ${missing.join(", ")}`);
    }
    const targets = only ? stories.filter((s) => only.has(s.id)) : stories;

    server = await serve(buildDir, fonts ? fonts.dir : null);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const css = fontCss(`${origin}/__fonts/`, fonts, fontNames);
    const playwright = loadPlaywright(config.configDir);
    browser = await playwright.chromium.launch();

    // One task per story; it can add a second capture (390) or move to the
    // story's declared viewport once the story's parameters are known.
    const captures = new Map(); // kit id -> {story, viewport, result}
    const failures = [];
    const attempts = []; // every capture's timing, kept or not
    let done = 0;
    await pool(targets, concurrency, async (story) => {
      const first = await captureOne({
        browser,
        origin,
        story,
        viewport: planning.viewport,
        timeout,
        css,
        families,
        fixedTime,
      });
      attempts.push(first);
      let viewports = plannedViewports(story.title, null, planning);
      const results = new Map([[planning.viewport.width, first]]);
      if (first.result) {
        const declared = viewportFor(first.result.declared);
        viewports = plannedViewports(story.title, declared, planning);
        if (declared) {
          results.delete(planning.viewport.width);
          first.discarded = true;
        }
      }
      for (const viewport of viewports) {
        if (!results.has(viewport.width)) {
          const capture = await captureOne({
            browser,
            origin,
            story,
            viewport,
            timeout,
            css,
            families,
            fixedTime,
          });
          attempts.push(capture);
          results.set(viewport.width, capture);
        }
        const capture = results.get(viewport.width);
        const id = kitId(story.id, viewport.width);
        if (capture.failure) {
          failures.push({ id, ...capture.failure });
        } else {
          captures.set(id, { story, viewport, result: capture.result });
        }
      }
      done += 1;
      if (done % 50 === 0 || done === targets.length) {
        log(
          `captured ${done}/${targets.length} stories (${failures.length} failed)`,
        );
      }
    });

    // ── assemble ───────────────────────────────────────────────────────────
    const baseIndex = options.base
      ? readJsonOr(join(options.base, "index.json"), [])
      : [];
    const baseGaps = options.base
      ? readJsonOr(join(options.base, "gaps.json"), [])
      : [];
    const baseSheets = options.base
      ? readJsonOr(join(options.base, "css/stories.sheets.json"), {
          order: [],
          sheets: {},
        })
      : { order: [], sheets: {} };
    const current = new Set(stories.map((s) => s.id));
    const recaptured = new Set(targets.map((s) => s.id));
    const keptFromBase = baseIndex.filter(
      (row) =>
        row.kind === "story" &&
        current.has(storyIdOf(row.id)) &&
        !recaptured.has(storyIdOf(row.id)),
    );

    mkdirSync(join(out, "html"), { recursive: true });
    mkdirSync(join(out, "css"), { recursive: true });
    mkdirSync(join(out, "fonts"), { recursive: true });

    const rows = [];
    const sheetOrder = [...baseSheets.order];
    const sheets = { ...baseSheets.sheets };
    for (const id of [...captures.keys()].sort()) {
      const { story, viewport, result } = captures.get(id);
      const file = kitFile(id);
      const html = `${result.html}\n`;
      writeFileSync(join(out, file), html);
      for (const sheet of result.sheets) sheets[sheet.key] ??= sheet.rules;
      mergeSheetOrder(
        sheetOrder,
        result.sheets.map((sheet) => sheet.key),
      );
      rows.push({
        id,
        kind: "story",
        title: `${story.title}/${story.name}`,
        ...(story.componentPath
          ? {
              component: story.componentPath
                .split("/")
                .pop()
                .replace(/\.[cm]?[jt]sx?$/, ""),
            }
          : {}),
        file,
        width: viewport.width,
        height: viewport.height,
        bytes: Buffer.byteLength(html),
        source_file: relative(config.configDir, join(root, story.importPath))
          .split(sep)
          .join("/"),
        ...(result.bodyClass ? { body_class: result.bodyClass } : {}),
      });
    }
    for (const row of keptFromBase) {
      if (resolve(options.base) !== resolve(out)) {
        copyFileSync(join(options.base, row.file), join(out, row.file));
      }
      rows.push(row);
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : 1));

    const keepIds = new Set(rows.map((row) => row.file.slice("html/".length)));
    for (const name of readdirSync(join(out, "html"))) {
      if (name.startsWith("story--") && !keepIds.has(name)) {
        rmSync(join(out, "html", name));
      }
    }

    // Every sheet that resolved to the local server becomes a kit-relative
    // reference or is dropped; the kit never points at the capture server.
    const absolute = new RegExp(
      `url\\("${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"\\)`,
      "g",
    );
    // Configured fonts replace the preview's own faces; otherwise those
    // faces' files are copied into the kit.
    const copied = new Set();
    for (const key of Object.keys(sheets)) {
      const rules = fonts
        ? sheets[key]
        : collectFonts(sheets[key], { origin, buildDir, out, copied });
      sheets[key] = rules
        .filter(
          (rule) => !(rule.startsWith("@font-face") && rule.includes(origin)),
        )
        .map((rule) => rule.replace(absolute, "none"));
    }
    writeFileSync(
      join(out, "css/stories.css"),
      buildCss(fontCss("../fonts/", fonts, fontNames), sheetOrder, sheets),
    );
    writeFileSync(
      join(out, "css/stories.sheets.json"),
      `${JSON.stringify({ order: sheetOrder, sheets }, null, 1)}\n`,
    );
    for (const name of fontNames) {
      copyFileSync(join(fonts.dir, name), join(out, "fonts", name));
    }
    copyFileSync(join(here, "kit.mjs"), join(out, "kit.mjs"));

    writeFileSync(
      join(out, "index.json"),
      `${JSON.stringify(rows, null, 1)}\n`,
    );

    const storyGaps = [
      ...failures,
      ...baseGaps.filter(
        (row) =>
          row.id?.startsWith("story:") &&
          current.has(storyIdOf(row.id)) &&
          !recaptured.has(storyIdOf(row.id)),
      ),
    ];
    const gaps = mergeGaps(readJsonOr(join(out, "gaps.json"), []), [
      ...storyGaps,
      ...componentsWithoutStories(stories, {
        gaps: stories_.gaps,
        root,
        configDir: config.configDir,
      }),
    ]);
    writeFileSync(join(out, "gaps.json"), `${JSON.stringify(gaps, null, 1)}\n`);

    const sha = gitSha(config.configDir);
    const cpu = process.cpuUsage(cpuStart);
    const wallSeconds = (Date.now() - started) / 1000;
    const manifest = mergeManifest(
      readJsonOr(join(out, "manifest.json"), null),
      {
        sha,
        builtAt: new Date().toISOString(),
        stories: {
          stories: stories.length,
          captured: rows.length,
          failed: storyGaps.length,
          recaptured: targets.length,
          ...(options.base ? { base: options.base } : {}),
          fixed_time: fixedTime,
          playwright: playwright.version,
          wall_seconds: Math.round(wallSeconds),
          build_seconds: Math.round(buildSeconds),
        },
        theme: config.theme,
      },
    );
    writeFileSync(
      join(out, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    log(
      [
        `design kit: ${out}`,
        `stories ${stories.length}, captured ${targets.length} this run, rows ${rows.length}, failed ${storyGaps.length}`,
        `wall ${wallSeconds.toFixed(1)}s (storybook build ${buildSeconds.toFixed(1)}s), capture-process CPU ${((cpu.user + cpu.system) / 1e6).toFixed(1)}s, concurrency ${concurrency}`,
      ].join("\n"),
    );
    const timings = {
      ...timingBreakdown(attempts),
      discarded: attempts.filter((a) => a.discarded).length,
      lanes: concurrency,
      quiet_ms: quietMs,
      timeout_ms: timeout,
      wall_ms: Date.now() - started,
    };
    log(`capture timings: ${JSON.stringify(timings)}`);
    if (process.env.DESIGN_KIT_TIMINGS_FILE)
      writeFileSync(
        process.env.DESIGN_KIT_TIMINGS_FILE,
        `${JSON.stringify(timings, null, 2)}\n`,
      );
    const byReason = {};
    for (const failure of storyGaps)
      byReason[failure.reason] = (byReason[failure.reason] ?? 0) + 1;
    if (storyGaps.length)
      log(`failures by reason: ${JSON.stringify(byReason)}`);
    return { out, rows: rows.length, failed: storyGaps.length };
  } finally {
    await browser?.close().catch(() => {});
    server?.close();
    if (ownedBuild) rmSync(ownedBuild, { recursive: true, force: true });
  }
}

function readJsonOr(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}
