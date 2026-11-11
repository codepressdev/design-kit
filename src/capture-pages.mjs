/**
 * `design-kit capture pages`: real pages of a running app captured into the
 * kit as `route:` frames with `data-kit-slot` regions.
 *
 * For each width and page: a fresh browser context (signed in from the
 * configured storageState), a fixed clock, UTC, reduced motion and no
 * animations; it waits for the shell and the page's ready selector, marks
 * slots, then serializes the body and the page's sheets. A page that fails
 * is a gaps.json row and the run still succeeds; the run fails only when
 * the app or the browser cannot start.
 *
 * DESIGN_KIT_STOP_TIMEOUT_MS bounds how long stopping the started app and
 * closing the browser may take (default 15000).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CssCollector,
  byKey,
  cssUrls,
  findForbidden,
  forbiddenNeedles,
  isFontUrl,
  isRouteGap,
  isRouteHtmlFile,
  kitHtmlFile,
  kitJson,
  kitRouteId,
  mergeGaps,
  mergeManifest,
  normalizeReactIds,
  rewriteCssUrls,
  selectPages,
} from "./pages.mjs";
import { ConfigError } from "./config.mjs";
import { loadPlaywright } from "./playwright.mjs";

const STOP_TIMEOUT_MS =
  Number(process.env.DESIGN_KIT_STOP_TIMEOUT_MS) > 0
    ? Number(process.env.DESIGN_KIT_STOP_TIMEOUT_MS)
    : 15_000;
/** Inline images and CSS assets up to this size; larger ones are dropped. */
const MAX_INLINE_BYTES = 256 * 1024;
/** Polling interval while waiting for `waitUrl`. */
const WAIT_POLL_MS = 250;

/** No animation or transition runs, and no caret blinks, in a capture. */
const STILL_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

// ---------------------------------------------------------------------------
// The app

/**
 * Runs `startCommand` (in its own process group) and waits until `waitUrl`
 * answers. `stop` signals the group, then kills it after the stop timeout.
 */
export async function startApp(
  { startCommand, waitUrl, cwd, startTimeoutMs },
  log,
) {
  log(`starting the app: ${startCommand}`);
  const child = spawn(startCommand, {
    cwd,
    shell: true,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let exited = child.exitCode !== null;
  const exit = new Promise((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    }),
  );
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };
  const stop = async () => {
    if (exited) return;
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), STOP_TIMEOUT_MS);
    await exit;
    clearTimeout(timer);
  };
  process.on("exit", () => {
    if (!exited) signal("SIGTERM");
  });
  const deadline = Date.now() + startTimeoutMs;
  for (;;) {
    if (exited)
      throw new Error(`the start command exited before ${waitUrl} answered`);
    try {
      const response = await fetch(waitUrl, { redirect: "manual" });
      if (response.status < 500) break;
    } catch {
      // Not serving yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`${waitUrl} did not answer within ${startTimeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  log(`the app answers at ${waitUrl}`);
  return { stop };
}

async function importModule(file) {
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Capture

/** Fetches app-served assets once per run and turns them into data URIs. */
class AssetInliner {
  cache = new Map();
  constructor(context) {
    this.context = context;
  }

  async fetch(url) {
    const response = await this.context().request.get(url, { timeout: 10_000 });
    return { response, body: await response.body() };
  }

  async inline(url) {
    if (this.cache.has(url)) return this.cache.get(url);
    let data = null;
    try {
      const { response, body } = await this.fetch(url);
      if (response.ok() && body.length <= MAX_INLINE_BYTES) {
        const type = (
          response.headers()["content-type"] ?? "application/octet-stream"
        )
          .split(";")[0]
          .trim();
        data = `data:${type};base64,${body.toString("base64")}`;
      }
    } catch {
      data = null;
    }
    this.cache.set(url, data);
    return data;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** In the page: marks slots and serializes the body, its attributes and sheets. */
function extractPage({ slots, layoutSlots, layout, appOrigin, themeClasses }) {
  const shell = layout ? document.querySelector(layout.selector) : null;
  const chosen = layout
    ? shell?.getAttribute(layout.attribute) || layout.default
    : "default";
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const marked = [];
  for (const [slot, selectors] of Object.entries(
    layoutSlots?.[chosen] ?? slots,
  )) {
    for (const selector of selectors) {
      const el = [...document.querySelectorAll(selector)].find(visible);
      if (!el) continue;
      const filled =
        el.children.length > 0 || (el.textContent ?? "").trim() !== "";
      if (!filled) continue;
      el.setAttribute("data-kit-slot", slot);
      marked.push(slot);
      break;
    }
  }

  const attrs = (el) => {
    const out = {};
    for (const { name, value } of [...el.attributes]) {
      if (name === "class") {
        const classes = value
          .split(/\s+/)
          .filter((c) => c && !themeClasses.includes(c));
        if (classes.length) out.class = classes.join(" ");
      } else if (
        name === "style" ||
        name === "lang" ||
        name === "dir" ||
        name.startsWith("data-")
      ) {
        out[name] = value;
      }
    }
    return out;
  };

  const sheets = [];
  for (const sheet of [...document.styleSheets]) {
    const owner = sheet.ownerNode;
    if (sheet.disabled || owner?.hasAttribute?.("data-kit-capture")) continue;
    let rules;
    try {
      rules = [...sheet.cssRules].map((rule) => rule.cssText);
    } catch {
      // A cross-origin sheet without CORS: it cannot travel in the kit.
      console.warn(`design-kit: unreadable sheet ${sheet.href}`);
      continue;
    }
    sheets.push({ href: sheet.href, media: sheet.media.mediaText, rules });
  }

  const clone = document.body.cloneNode(true);
  clone
    .querySelectorAll(
      "script, noscript, style, link, template, [data-kit-capture]",
    )
    .forEach((el) => el.remove());
  const images = [];
  clone.querySelectorAll("img[src], image[href], source[src]").forEach((el) => {
    const attr = el.tagName.toLowerCase() === "image" ? "href" : "src";
    const raw = el.getAttribute(attr);
    if (raw.startsWith("data:")) return;
    const url = new URL(raw, document.baseURI).href;
    el.setAttribute(attr, url);
    images.push(url);
  });
  clone
    .querySelectorAll("[srcset]")
    .forEach((el) => el.removeAttribute("srcset"));
  clone
    .querySelectorAll("iframe[src]")
    .forEach((el) => el.removeAttribute("src"));
  // A sandboxed frame's srcdoc can carry a per-render nonce (as `NONCE="…"`
  // or in JSON); every copy of it is pinned.
  clone.querySelectorAll("iframe[srcdoc]").forEach((el) => {
    let doc = el.getAttribute("srcdoc");
    const nonces = new Set(
      [
        ...doc.matchAll(
          /\bNONCE=["']([0-9a-f]{8,})["']|"nonce":"([0-9a-f]{8,})"/gi,
        ),
      ].map((match) => match[1] ?? match[2]),
    );
    for (const nonce of nonces) doc = doc.split(nonce).join("kit-nonce");
    el.setAttribute("srcdoc", doc);
  });
  // A framework may set an attribute on a later commit, which moves it to the
  // end; sorted attributes make two captures of one state identical.
  for (const el of [clone, ...clone.querySelectorAll("*")]) {
    const sorted = [...el.attributes]
      .map(({ name, value }) => [name, value])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name] of sorted) el.removeAttribute(name);
    for (const [name, value] of sorted) el.setAttribute(name, value);
  }
  // Links keep their path, never the capture's origin and port.
  clone.querySelectorAll("[href]").forEach((el) => {
    const href = el.getAttribute("href");
    if (href.startsWith(appOrigin))
      el.setAttribute("href", href.slice(appOrigin.length) || "/");
  });
  return {
    html: clone.innerHTML,
    layout: chosen,
    slots: marked,
    htmlAttrs: attrs(document.documentElement),
    bodyAttrs: attrs(document.body),
    sheets,
    images,
    finalPath: location.pathname,
  };
}

async function capturePage(context, page, viewport, run) {
  const { settings, baseUrl, shotPath, hooks, themeClasses } = run;
  const tab = await context.newPage();
  try {
    await tab.clock.setFixedTime(Date.parse(settings.fixedTime));
    // Callers compiled with esbuild's keepNames wrap functions passed to
    // evaluate in a `__name` helper the page lacks.
    await tab.addInitScript("globalThis.__name = (fn) => fn;");
    await tab.addInitScript((css) => {
      const add = () => {
        const style = document.createElement("style");
        style.setAttribute("data-kit-capture", "");
        style.textContent = css;
        document.documentElement.appendChild(style);
      };
      if (document.documentElement) add();
      else document.addEventListener("DOMContentLoaded", add, { once: true });
    }, STILL_CSS);
    const pageHooks = (await hooks.page?.(tab, { page, viewport })) ?? {};
    tab.setDefaultTimeout(run.timeoutMs);
    await tab.goto(new URL(page.path, baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    if (settings.shellReady) {
      await tab
        .locator(settings.shellReady)
        .first()
        .waitFor({ state: "visible" });
    }
    const ready = tab.locator(page.ready).first();
    try {
      await ready.waitFor({ state: "visible" });
    } catch (error) {
      await pageHooks.readyFailed?.();
      throw new Error(
        `ready selector ${JSON.stringify(page.ready)} never appeared within ${run.timeoutMs} ms (${error.message.split("\n")[0]})`,
      );
    }
    // Late data and lazy sections settle; a page that polls never goes idle,
    // which is fine: the ready selector already holds.
    await tab
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {});
    await tab.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    // A page's path may carry a query (`?tab=settings`), which the app may
    // rewrite; only a different pathname is a redirect.
    const finalPath = new URL(tab.url()).pathname;
    const wantPath = new URL(page.path, baseUrl).pathname;
    if (finalPath !== wantPath)
      throw new Error(`redirected from ${wantPath} to ${finalPath}`);

    // The serialized DOM keeps no scroll, so neither does the screenshot.
    await tab.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of document.querySelectorAll("*"))
        if (el.scrollTop || el.scrollLeft) el.scrollTo(0, 0);
    });
    if (pageHooks.beforeSerialize)
      await pageHooks.beforeSerialize({ shotPath });
    else if (run.screenshots) await tab.screenshot({ path: shotPath });

    return await tab.evaluate(extractPage, {
      slots: page.slots,
      layoutSlots: page.layoutSlots ?? null,
      layout: settings.layout,
      appOrigin: new URL(baseUrl).origin,
      themeClasses,
    });
  } finally {
    await tab.close();
  }
}

/** The classes the capture strips from <html>/<body>: compose sets them. */
function themeClassesOf(theme) {
  if (theme && theme.attribute !== "class") return [];
  const dark = theme?.dark ?? "dark";
  return theme?.light ? [dark, theme.light] : [dark, "light"];
}

/**
 * Captures the configured pages into `out`.
 *
 * Options (all optional except what the config leaves out): `out`, `only`
 * (page names), `ready` ({name: selector} overrides), `screenshots` (a
 * folder for each page's PNG), `timeoutMs`, `baseUrl` and `storageState`
 * (a path or a Playwright storage state object; both override the config),
 * `forbidStrings` (added to the config's), `stripOrigins` (more origins to
 * remove from markup), `hooks` ({context, page}, over the config's hooks
 * module), `playwright` ({chromium}), `log`, and `session` ({interrupted,
 * browser}: set `interrupted` to stop between pages; `browser` is set once
 * launched so a signal handler can close it).
 *
 * Returns 0, or 130 when interrupted (nothing is written then). Throws,
 * writing nothing, when any page's markup carries a forbidStrings value.
 */
/** A page's markup carries a forbidStrings value. */
class ForbiddenStringError extends Error {
  constructor() {
    super("the page's markup carries a forbidStrings value");
  }
}

export async function capturePages(config, options = {}) {
  const settings = config.pages;
  if (!settings) {
    throw new ConfigError(
      "design-kit.config.json has no pages section; add one to capture pages",
    );
  }
  const log =
    options.log ??
    ((message) => process.stderr.write(`[design-kit] ${message}\n`));
  const session = options.session ?? { interrupted: false, browser: null };
  const startedAt = performance.now();
  const out = path.resolve(
    options.out ??
      config.out ??
      path.join(process.env.TMPDIR || os.tmpdir(), "design-kit"),
  );
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  const pages = selectPages(settings.pages, {
    only: options.only,
    ready: options.ready,
  });
  if (!options.baseUrl && !settings.baseUrl && !settings.startCommand) {
    throw new ConfigError(
      "pages.baseUrl, or pages.startCommand with pages.waitUrl, is required (or pass --base-url)",
    );
  }
  const configHooks = settings.hooks ? await importModule(settings.hooks) : {};
  const hooks = {
    context: options.hooks?.context ?? configHooks.context,
    page: options.hooks?.page ?? configHooks.page,
  };
  const needles = forbiddenNeedles([
    ...settings.forbidStrings,
    ...(options.forbidStrings ?? []),
  ]);
  const themeClasses = themeClassesOf(config.theme);

  const stops = [];
  const shutdown = async () => {
    const browser = session.browser;
    const closing = browser
      ? Promise.race([
          browser.close().catch(() => {}),
          new Promise((resolve) =>
            setTimeout(resolve, STOP_TIMEOUT_MS).unref(),
          ),
        ])
      : Promise.resolve();
    await Promise.all([
      closing,
      (async () => {
        for (const stop of [...stops].reverse()) await stop();
      })(),
    ]);
  };

  const shotsDir =
    options.screenshots ??
    fs.mkdtempSync(
      path.join(process.env.TMPDIR || os.tmpdir(), "design-kit-shots-"),
    );
  const timings = {};
  const gaps = [];
  const leaks = [];
  const rows = [];
  const files = new Map();
  const fontUrls = new Map();
  const css = new CssCollector();
  let current = null;
  const inliner = new AssetInliner(() => current);
  const fontFiles = new Map();

  try {
    let baseUrl = options.baseUrl ?? settings.baseUrl;
    if (!baseUrl) {
      const t = performance.now();
      const app = await startApp(settings, log);
      stops.push(app.stop);
      baseUrl = new URL(settings.waitUrl).origin;
      timings.servers_ready_s = (performance.now() - t) / 1000;
    }
    const appOrigin = new URL(baseUrl).origin;
    const { chromium } = options.playwright ?? loadPlaywright(config.configDir);
    // A caller's signal handler closes the browser; Playwright's own would
    // exit before the app is stopped.
    session.browser = await chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    let storageState = options.storageState ?? settings.auth.storageState;
    if (!options.storageState && settings.auth.setup) {
      const setup = await importModule(settings.auth.setup);
      storageState = await (setup.default ?? setup.setup)({
        browser: session.browser,
        baseUrl,
        config,
      });
    }
    const captureStart = performance.now();

    for (const viewport of settings.widths) {
      for (const page of pages) {
        if (session.interrupted) return 130;
        const id = kitRouteId(page.name, viewport.width);
        const context = await session.browser.newContext({
          baseURL: baseUrl,
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          timezoneId: "UTC",
          locale: "en-US",
          colorScheme: "light",
          reducedMotion: "reduce",
          ...(storageState ? { storageState } : {}),
        });
        current = context;
        let cleanup = null;
        const pageStart = performance.now();
        try {
          cleanup =
            (await hooks.context?.(context, { page, viewport })) ?? null;
          const shotPath = path.join(
            shotsDir,
            `${path.basename(kitHtmlFile(id), ".html")}.png`,
          );
          const capture = await capturePage(context, page, viewport, {
            settings,
            baseUrl,
            shotPath,
            hooks,
            themeClasses,
            timeoutMs,
            screenshots: Boolean(options.screenshots),
          });
          if (!capture.slots.includes("main"))
            throw new Error(
              `no non-empty main slot in the ${capture.layout} layout`,
            );

          let html = capture.html;
          for (const url of new Set(capture.images)) {
            const data = await inliner.inline(url);
            html = html.replace(
              new RegExp(
                `(src|href)="${escapeRegExp(url.replace(/&/g, "&amp;"))}"`,
                "g",
              ),
              data ? `$1="${data}"` : `$1=""`,
            );
          }
          // No capture-time origin or port survives into the kit, and React's
          // timing-dependent ids are renumbered.
          html = normalizeReactIds(html).replaceAll(appOrigin, "");
          for (const origin of options.stripOrigins ?? [])
            html = html.replaceAll(origin, "");
          html = html.replaceAll(
            `http://127.0.0.1:${new URL(appOrigin).port}`,
            "",
          );

          const found = findForbidden(
            [
              html,
              JSON.stringify(capture.htmlAttrs),
              JSON.stringify(capture.bodyAttrs),
            ].join("\n"),
            needles,
          );
          if (found) throw new ForbiddenStringError();

          // CSS assets on the app origin (other than fonts) are inlined.
          const inlined = new Map();
          for (const sheet of capture.sheets) {
            const base = sheet.href ?? new URL(page.path, appOrigin).href;
            for (const rule of sheet.rules)
              for (const url of cssUrls(rule, base)) {
                const parsed = new URL(url);
                if (
                  parsed.origin !== appOrigin ||
                  isFontUrl(parsed, settings.fontsPath)
                )
                  continue;
                const data = await inliner.inline(url);
                if (data) inlined.set(url, data);
              }
          }
          css.add(capture.sheets, (rule, href) =>
            rewriteCssUrls(
              rule,
              href ?? new URL(page.path, appOrigin).href,
              appOrigin,
              inlined,
              { fontsPath: settings.fontsPath, fonts: fontUrls },
            ),
          );
          if (settings.copyFonts) {
            for (const [url, name] of fontUrls) {
              if (fontFiles.has(name)) continue;
              try {
                const { response, body } = await inliner.fetch(url);
                if (response.ok()) fontFiles.set(name, body);
              } catch {
                // A font that cannot be fetched stays out; compose drops it.
              }
            }
          }

          const file = kitHtmlFile(id);
          files.set(file, html);
          rows.push({
            id,
            kind: "route",
            title: `${page.title ?? page.name} (${viewport.width})`,
            file,
            width: viewport.width,
            height: viewport.height,
            bytes: Buffer.byteLength(html),
            slots: [...capture.slots].sort(),
            ...(page.sourceFile ? { source_file: page.sourceFile } : {}),
            path: page.path,
            body_class: capture.bodyAttrs.class ?? "",
            html_attrs: capture.htmlAttrs,
            body_attrs: capture.bodyAttrs,
          });
          log(
            `captured ${id} (${capture.layout}, slots ${capture.slots.join(",")}, ${Math.round(Buffer.byteLength(html) / 1024)} KB, ${((performance.now() - pageStart) / 1000).toFixed(1)}s)`,
          );
        } catch (error) {
          if (error instanceof ForbiddenStringError) {
            leaks.push(id);
            log(`${id}: ${error.message}`);
            continue;
          }
          const reason = String(error?.message ?? error)
            .split("\n")
            .slice(0, 3)
            .join(" ");
          gaps.push({ id, route: page.name, reason });
          log(`gap ${id}: ${reason}`);
        } finally {
          await cleanup?.().catch?.(() => {});
          await context.close();
          current = null;
        }
      }
    }
    timings.capture_s = (performance.now() - captureStart) / 1000;
  } finally {
    await shutdown();
    if (!options.screenshots)
      fs.rmSync(shotsDir, { recursive: true, force: true });
  }

  // A leaked value fails the whole capture: no page of this run is written,
  // so a CI job stops before it uploads anything.
  if (leaks.length)
    throw new Error(
      `${leaks.join(", ")} carried a forbidStrings value; nothing was written`,
    );
  writePagesKit(out, {
    rows,
    files,
    css: css.toString(),
    gaps,
    needles,
    pages,
    widths: settings.widths,
    fonts: fontFiles,
    theme: config.theme,
    configDir: config.configDir,
  });
  timings.total_s = (performance.now() - startedAt) / 1000;
  const cpu = process.cpuUsage();
  log(
    `done: ${rows.length} captured, ${gaps.length} gaps, into ${out}; ` +
      Object.entries(timings)
        .map(([k, v]) => `${k}=${v.toFixed(1)}`)
        .join(" ") +
      ` this_process_cpu_s=${((cpu.user + cpu.system) / 1e6).toFixed(1)}`,
  );
  return 0;
}

function writePagesKit(
  out,
  { rows, files, css, gaps, needles, pages, widths, fonts, theme, configDir },
) {
  fs.mkdirSync(path.join(out, "html"), { recursive: true });
  fs.mkdirSync(path.join(out, "css"), { recursive: true });
  // This half's files only: earlier page captures go, story files stay.
  for (const name of fs.readdirSync(path.join(out, "html")))
    if (isRouteHtmlFile(name)) fs.rmSync(path.join(out, "html", name));

  const sortedRows = [...rows].sort(byKey((row) => row.id));
  const written = [
    ...[...files.entries()].sort(byKey(([file]) => file)),
    ["routes.json", kitJson(sortedRows)],
    ["css/routes.css", css],
  ];
  for (const [file, text] of written) {
    if (findForbidden(text, needles))
      throw new Error(
        `${file} carries a forbidStrings value; refusing to write the kit`,
      );
    fs.writeFileSync(path.join(out, file), text);
  }
  if (fonts.size) {
    fs.mkdirSync(path.join(out, "fonts"), { recursive: true });
    for (const [name, body] of fonts) {
      const target = path.join(out, "fonts", path.basename(name));
      if (!fs.existsSync(target)) fs.writeFileSync(target, body);
    }
  }
  // kit.mjs travels with every kit, so a pages-only kit composes too.
  const tool = path.join(out, "kit.mjs");
  if (!fs.existsSync(tool))
    fs.copyFileSync(new URL("./kit.mjs", import.meta.url), tool);

  const gapsPath = path.join(out, "gaps.json");
  fs.writeFileSync(
    gapsPath,
    kitJson(mergeGaps(readJson(gapsPath), gaps.filter(isRouteGap))),
  );

  const manifestPath = path.join(out, "manifest.json");
  const manifest = mergeManifest(readJson(manifestPath), {
    sha: gitSha(configDir),
    builtAt: new Date().toISOString(),
    captured: sortedRows.length,
    failed: gaps.length,
    pages: pages.map((page) => page.name),
    widths: widths.map((viewport) => viewport.width),
    theme,
  });
  fs.writeFileSync(manifestPath, kitJson(manifest));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function gitSha(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}
