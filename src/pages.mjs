/**
 * The pure half of `design-kit capture pages`: page selection, slot choice,
 * CSS and markup normalization, the forbidden-string check, and the merges
 * that keep the stories writer's files. The browser and server work lives
 * in capture-pages.mjs.
 *
 * Kit files this half owns:
 *   html/route--<name>@<width>.html  body content of the page, scripts removed
 *                                    (id `route:<name>@<width>`; no ":" in paths)
 *   routes.json                      one row per capture
 *   css/routes.css                   every rule the captured pages loaded, deduped
 *                                    (css/routes--<source>.css for a page source)
 *   gaps.json                        shared; this half owns rows with `route`
 *                                    or an id starting `route:`
 *
 * Page sources: a config whose `pages.source` names one (such as `web` or
 * `terminal`) rewrites only its own rows, files, stylesheet and gap rows, so
 * several apps capture into one kit. Its rows carry `source` and `css`. Rows
 * with no `source` (a capture without one, or a kit from before sources)
 * belong to a sourced capture only when it declares their page name. A
 * capture without a source owns every route row, as before sources existed.
 */

export function kitRouteId(name, width) {
  return `route:${name}@${width}`;
}

/**
 * The snippet's path in the kit. Ids keep `route:`, but file names use
 * `route--`: GitHub Actions artifacts reject ':' in paths, and kit.mjs finds
 * a snippet through the row's `file` only.
 */
export function kitHtmlFile(id) {
  return `html/${id.replace(/^route:/, "route--")}.html`;
}

/** A file this half wrote into html/ (either naming), cleared before a run. */
export function isRouteHtmlFile(name) {
  return name.startsWith("route--") || name.startsWith("route:");
}

/** `--only a,b` and `--ready name=selector` applied to the configured pages. */
export function selectPages(pages, { only, ready } = {}) {
  const known = new Set(pages.map((page) => page.name));
  for (const name of [...(only ?? []), ...Object.keys(ready ?? {})]) {
    if (!known.has(name))
      throw new Error(
        `unknown page ${JSON.stringify(name)}; pages are ${[...known].join(", ")}`,
      );
  }
  return pages
    .filter((page) => !only?.length || only.includes(page.name))
    .map((page) =>
      ready?.[page.name] ? { ...page, ready: ready[page.name] } : page,
    );
}

/** The slot selectors for each layout: the page's `slots`, or its `layoutSlots[layout]`. */
export function slotsByLayout(page) {
  return { default: page.slots, ...(page.layoutSlots ?? {}) };
}

export const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/i;

/** Whether a resolved URL on the app's origin is one of its fonts. */
export function isFontUrl(url, fontsPath) {
  return fontsPath
    ? url.pathname.startsWith(fontsPath)
    : FONT_FILE.test(url.pathname);
}

/** The font's file name in the kit's fonts/ folder. */
export function fontName(url, fontsPath) {
  return fontsPath
    ? url.pathname.slice(fontsPath.length)
    : url.pathname.split("/").pop();
}

/**
 * Rewrites a rule's `url()`s so the CSS travels without the app server:
 * the app's fonts point at the kit's `fonts/` folder beside `css/`, data URIs
 * and fragments stay, and anything else on the app origin becomes the data
 * URI in `inlined` or is dropped to `none`, so no capture-time port leaks
 * into the kit. `fonts` receives each font URL it rewrote.
 */
export function rewriteCssUrls(
  cssText,
  base,
  appOrigin,
  inlined = new Map(),
  { fontsPath = null, fonts = null } = {},
) {
  return cssText.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
    (whole, _quote, raw) => {
      if (raw.startsWith("data:") || raw.startsWith("#")) return whole;
      let resolved;
      try {
        resolved = new URL(raw, base);
      } catch {
        return whole;
      }
      const data = inlined.get(resolved.href);
      if (data) return `url("${data}")`;
      if (resolved.origin === appOrigin && isFontUrl(resolved, fontsPath)) {
        fonts?.set(resolved.href, fontName(resolved, fontsPath));
        return `url("../fonts/${fontName(resolved, fontsPath)}")`;
      }
      if (resolved.origin === appOrigin) return "none";
      return whole;
    },
  );
}

/** Every `url()` target in a rule, resolved, for inlining. */
export function cssUrls(cssText, base) {
  const out = [];
  for (const match of cssText.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
    const raw = match[2];
    if (raw.startsWith("data:") || raw.startsWith("#")) continue;
    try {
      out.push(new URL(raw, base).href);
    } catch {
      // Not a URL a browser would fetch either.
    }
  }
  return out;
}

/**
 * Accumulates sheets across pages into one ordered, deduplicated stylesheet
 * whose bytes do not depend on load timing.
 *
 * Sheets are the unit: two pages that load the same bundle chunk contribute
 * it once, so the cascade inside each sheet is kept. Linked sheets come
 * first, in the order captures first meet them. Inline `<style>` sheets
 * (hoisted component styles, keyframes, toasts) are keyed by their content
 * and come after, sorted by that key: frameworks insert them by render
 * timing, so their place in `document.styleSheets` varies between two
 * captures of one commit. A rule already emitted by an earlier sheet, in that
 * final order, is not repeated.
 */
export class CssCollector {
  linked = new Map();
  inline = new Map();

  add(sheets, rewrite) {
    for (const sheet of sheets) {
      const target = sheet.href ? this.linked : this.inline;
      const key = sheet.href
        ? `href:${new URL(sheet.href).pathname}|${sheet.media}`
        : `inline:${sheet.media}|${sheet.rules.join("\n")}`;
      if (target.has(key)) continue;
      target.set(key, {
        media: sheet.media,
        rules: sheet.rules.map((rule) => rewrite(rule, sheet.href)),
      });
    }
  }

  toString() {
    const ordered = [
      ...this.linked.values(),
      ...[...this.inline.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, sheet]) => sheet),
    ];
    const seenRules = new Set();
    const chunks = [];
    for (const { media, rules } of ordered) {
      const fresh = rules.filter((rule) => {
        if (seenRules.has(rule)) return false;
        seenRules.add(rule);
        return true;
      });
      if (!fresh.length) continue;
      const body = fresh.join("\n");
      chunks.push(
        media && media !== "all" ? `@media ${media} {\n${body}\n}` : body,
      );
    }
    return chunks.length ? `${chunks.join("\n")}\n` : "";
  }
}

/**
 * React's `useId` values (`_r_1u_`, and React 18's `:r1u:`) depend on how many
 * ids rendered before, which varies with load timing, so two captures of the
 * same commit would differ. Renumbers them in document order; every reference
 * to an id (aria-controls, for, ...) gets the same new value.
 */
export function normalizeReactIds(html) {
  const ids = new Map();
  return html.replace(/_r_[0-9a-z]+_|:r[0-9a-z]+:/g, (id) => {
    let next = ids.get(id);
    if (!next) {
      next = `_k${ids.size}_`;
      ids.set(id, next);
    }
    return next;
  });
}

/** A token shaped like a JWT: two or three dot-separated base64 segments. */
const TOKEN = /^[A-Za-z0-9_\-+/=]+(?:\.[A-Za-z0-9_\-+/=]+){1,2}$/;

/**
 * Everything to look for, per forbidden value: the value, each long segment
 * of a token-shaped one (a JWT's payload is the identity half of it), and the
 * value as it reads once serialized into markup: in an attribute (`&quot;`),
 * inside a JSON string (`\"`), or both.
 */
export function forbiddenNeedles(values) {
  const out = [];
  for (const value of values) {
    if (!value) continue;
    out.push(value);
    if (TOKEN.test(value))
      out.push(...value.split(".").filter((part) => part.length >= 8));
    out.push(
      value.replace(/&/g, "&amp;").replace(/"/g, "&quot;"),
      JSON.stringify(value).slice(1, -1),
      JSON.stringify(value).slice(1, -1).replace(/"/g, "&quot;"),
    );
  }
  return [...new Set(out)].filter(Boolean);
}

/** The first needle `text` contains, or null. */
export function findForbidden(text, needles) {
  return needles.find((needle) => text.includes(needle)) ?? null;
}

/** A row this half owns: kit.mjs treats the same rows as the route half's. */
export function isRouteGap(row) {
  return row.route != null || (row.id ?? "").startsWith("route:");
}

/** The page a route row or route gap row is for. */
export function routeRowPage(row) {
  if (row.route != null) return String(row.route);
  return String(row.id ?? "")
    .replace(/^route:/, "")
    .replace(/@\d+$/, "");
}

/** The stylesheet a page source's rows use: `css/routes.css` without one. */
export function routeCssFile(source) {
  return source ? `css/routes--${source}.css` : "css/routes.css";
}

/**
 * Whether a capture replaces an existing route row (or route gap row): a
 * capture without a source replaces every one; a sourced capture replaces
 * its own source's rows and unsourced rows of a page it declares.
 */
export function ownsRouteRow(row, { source = null, pageNames = new Set() }) {
  if (!source) return true;
  if (row.source != null) return row.source === source;
  return pageNames.has(routeRowPage(row));
}

/**
 * Pages this capture declares that the kit already holds from another
 * source, as `{ name, other }` (one per page): page names are unique across
 * sources, since a row id is `route:<name>@<width>` whatever its source.
 */
export function sourceCollisions(rows, { source = null, pageNames }) {
  if (!source) return [];
  const found = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.source == null) continue;
    if (row.source === source) continue;
    const name = routeRowPage(row);
    if (pageNames.has(name) && !found.has(name))
      found.set(name, String(row.source));
  }
  return [...found].map(([name, other]) => ({ name, other }));
}

/**
 * Replaces this half's rows in an existing gaps.json, keeping the stories'
 * and, for a sourced capture, other sources' route rows (`owns` says which
 * route rows this capture replaces; default every one).
 */
export function mergeGaps(existing, mine, owns = () => true) {
  const rows = Array.isArray(existing)
    ? existing.filter((row) => row && typeof row === "object")
    : [];
  const kept = rows.filter((row) => !isRouteGap(row));
  const otherRoutes = rows.filter((row) => isRouteGap(row) && !owns(row));
  return [
    ...kept,
    ...[...otherRoutes, ...mine].sort(
      byKey((row) => row.id ?? row.route ?? ""),
    ),
  ];
}

/** routes.json after a capture: other sources' rows kept, this run's added, by id. */
export function mergeRoutes(existing, mine, owns = () => true) {
  const kept = Array.isArray(existing)
    ? existing.filter((row) => row && typeof row === "object" && !owns(row))
    : [];
  return [...kept, ...mine].sort(byKey((row) => row.id ?? ""));
}

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

/**
 * This half of manifest.json, merged as the stories capture merges its half:
 * `sources.routes` and `counts.routes` are replaced, the other sources are
 * kept, `counts.failed` is the sum of every source's `failed`, and
 * `sha`/`built_at` (and `theme`, when configured) go to the last writer.
 *
 * A sourced capture (`run.source`) records its own numbers under
 * `sources.routes.page_sources[<source>]`, keeps the other page sources'
 * entries, and makes `sources.routes` the whole kit's: `run.total` gives the
 * captured and failed counts, pages and widths across every page source.
 */
export function mergeManifest(existing, run) {
  const manifest = asObject(existing);
  const own = {
    captured: run.captured,
    failed: run.failed,
    pages: run.pages,
    widths: run.widths,
  };
  const routes = run.source
    ? {
        ...(run.total ?? own),
        page_sources: {
          ...asObject(asObject(asObject(manifest.sources).routes).page_sources),
          [run.source]: own,
        },
      }
    : own;
  const sources = { ...asObject(manifest.sources), routes };
  const failed = Object.values(sources).reduce(
    (sum, source) => sum + (Number(asObject(source).failed) || 0),
    0,
  );
  return {
    ...manifest,
    kit_version: 1,
    sha: run.sha,
    built_at: run.builtAt,
    sources,
    counts: { ...asObject(manifest.counts), routes: routes.captured, failed },
    ...(run.theme ? { theme: run.theme } : {}),
  };
}

export function byKey(key) {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** Stable JSON for kit files: two-space indent, newline. */
export function kitJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
