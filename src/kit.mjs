#!/usr/bin/env node
/**
 * The design kit's own tool. It ships inside every kit, so tool and data
 * always match. Pure Node: no dependencies, no network.
 *
 *   node kit.mjs info
 *   node kit.mjs find <query>        (ids, titles and the words on screen)
 *   node kit.mjs show <id> [--full]
 *   node kit.mjs compose --frame <id> [--slot <name>=<file>]… [--theme light|dark]
 *                        [--show-new] --out <file>
 *
 * `--kit <dir>` (or DESIGN_KIT_DIR) points at a kit; the default is the
 * folder this file sits in. Format: the @codepress/design-kit README.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIND_LIMIT = 30;
/** Of FIND_LIMIT, the lines kept for rows found by on-screen text. */
const FIND_TEXT_LINES = 5;
const SHOW_LIMIT = 2048;
const SNIPPET_DEPTH = 8;
/**
 * Bytes of markup one compose may read through <kit-snippet>s. Nesting is
 * capped, but a file of many placeholders pointing at large rows would
 * otherwise grow the page exponentially.
 */
export const COMPOSE_MAX_BYTES = 32 * 1024 * 1024;

class KitError extends Error {}

// ── kit loading ─────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Story rows from index.json plus route rows from routes.json, by id, and
 * each row's visible text from text.json when the kit has one.
 */
export function loadKit(dir) {
  const manifest = readJson(join(dir, "manifest.json"), null);
  const rows = new Map();
  for (const row of [
    ...readJson(join(dir, "index.json"), []),
    ...readJson(join(dir, "routes.json"), []),
  ]) {
    if (row && typeof row.id === "string" && !rows.has(row.id)) {
      rows.set(row.id, row);
    }
  }
  const sorted = [...rows.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const text = readText(dir);
  return {
    dir,
    manifest,
    rows: sorted,
    byId: new Map(rows),
    // Only a kit with text.json has it, so an older kit loads as before.
    ...(text ? { text } : {}),
  };
}

function rowSource(row) {
  return row.kind === "route" || row.id.startsWith("route:")
    ? "routes"
    : "stories";
}

/** A source's stylesheet: `manifest.css[source]`, else `css/<source>.css`. */
function cssFile(kit, source) {
  const named = kit.manifest?.css?.[source];
  return typeof named === "string" && named && !named.includes("..")
    ? named
    : `css/${source}.css`;
}

/**
 * The stylesheet a row needs: a route row of a page source names its own
 * (`css`, inside the kit's css folder), any other row its source's.
 */
function rowCssFile(kit, row) {
  const source = rowSource(row);
  if (
    source === "routes" &&
    typeof row.css === "string" &&
    /^css\/[^/]+\.css$/.test(row.css)
  )
    return row.css;
  return cssFile(kit, source);
}

/** A row's markup, found only through its `file` (never derived from the id). */
function snippetPath(kit, row) {
  if (typeof row.file !== "string" || !row.file) {
    throw new KitError(`${row.id}: its index row has no file`);
  }
  return join(kit.dir, row.file);
}

function readSnippet(kit, row) {
  const file = snippetPath(kit, row);
  if (!existsSync(file)) {
    throw new KitError(`${row.id}: its markup ${file} is missing from the kit`);
  }
  return readFileSync(file, "utf8");
}

// ── near matches ────────────────────────────────────────────────────────────

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length];
}

/** Up to five candidates, closest first. */
export function nearMatches(wanted, candidates) {
  const needle = wanted.toLowerCase();
  const bare = needle.replace(/^(story|route):/, "").replace(/@\d+$/, "");
  return candidates
    .map((candidate) => {
      const hay = candidate.toLowerCase();
      const contains =
        bare.length > 0 && (hay.includes(bare) || bare.includes(hay));
      return {
        candidate,
        score: contains ? -1 : distance(needle, hay),
      };
    })
    .filter(({ score }) => score < Math.max(4, Math.floor(needle.length / 2)))
    .sort((a, b) => a.score - b.score || (a.candidate < b.candidate ? -1 : 1))
    .slice(0, 5)
    .map(({ candidate }) => candidate);
}

function unknown(what, wanted, candidates) {
  const near = nearMatches(wanted, candidates);
  const hint = near.length
    ? ` Did you mean: ${near.join(", ")}?`
    : candidates.length
      ? ""
      : " There are none.";
  return new KitError(`unknown ${what} "${wanted}".${hint}`);
}

function requireRow(kit, id, what) {
  const row = kit.byId.get(id);
  if (!row) {
    throw unknown(
      what,
      id,
      kit.rows.map((r) => r.id),
    );
  }
  return row;
}

// ── a small HTML scanner (enough for browser-serialized markup) ──────────────

const VOID = new Set(
  "area base br col embed hr img input link meta source track wbr".split(" "),
);
const RAW = new Set(["script", "style", "textarea", "title"]);

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/** Tokens with offsets: open / close / text / comment. */
export function tokenize(html) {
  return [...scan(html)];
}

/** `tokenize`, one token at a time, so a reader can stop early. */
function* scan(html) {
  let lower = null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      yield { type: "text", start: i, end: html.length };
      break;
    }
    if (lt > i) yield { type: "text", start: i, end: lt };
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      const end = close < 0 ? html.length : close + 3;
      yield { type: "comment", start: lt, end };
      i = end;
      continue;
    }
    const closing = html[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(
      html.slice(lt + (closing ? 2 : 1), lt + 200),
    );
    if (!nameMatch) {
      yield { type: "text", start: lt, end: lt + 1 };
      i = lt + 1;
      continue;
    }
    // Find the tag's end, respecting quoted attribute values.
    let j = lt + (closing ? 2 : 1) + nameMatch[0].length;
    let quote = null;
    for (; j < html.length; j += 1) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    const end = Math.min(j + 1, html.length);
    const name = nameMatch[0].toLowerCase();
    if (closing) {
      yield { type: "close", name, start: lt, end };
      i = end;
      continue;
    }
    const inner = html.slice(lt + 1 + nameMatch[0].length, end - 1);
    const selfClosing = /\/\s*$/.test(inner);
    yield {
      type: "open",
      name,
      attrs: parseAttributes(inner.replace(/\/\s*$/, "")),
      start: lt,
      end,
      selfClosing: selfClosing || VOID.has(name),
    };
    i = end;
    if (RAW.has(name) && !selfClosing) {
      lower ??= html.toLowerCase();
      const closeAt = lower.indexOf(`</${name}`, end);
      const stop = closeAt < 0 ? html.length : closeAt;
      if (stop > end) yield { type: "text", start: end, end: stop };
      i = stop;
    }
  }
}

/** Each element with its inner range: [{name, attrs, start, end, innerStart, innerEnd, depth}]. */
export function elements(html) {
  const out = [];
  const stack = [];
  for (const token of tokenize(html)) {
    if (token.type === "open") {
      const element = {
        name: token.name,
        attrs: token.attrs,
        start: token.start,
        innerStart: token.end,
        innerEnd: token.end,
        end: token.end,
        depth: stack.length,
        text: "",
      };
      out.push(element);
      if (!token.selfClosing) stack.push(element);
    } else if (token.type === "close") {
      const at = stack.map((e) => e.name).lastIndexOf(token.name);
      if (at < 0) continue;
      while (stack.length > at) {
        const element = stack.pop();
        element.innerEnd = token.start;
        element.end = stack.length === at ? token.end : token.start;
      }
    } else if (token.type === "text" && stack.length) {
      const top = stack[stack.length - 1];
      if (top.text.length < 80) {
        top.text += html.slice(token.start, token.end);
      }
    }
  }
  for (const element of stack) {
    element.innerEnd = html.length;
    element.end = html.length;
  }
  return out;
}

/** Storybook's story root: `#storybook-root` (7 and later) or `#root` (6). */
const STORY_ROOTS = new Set(["storybook-root", "root"]);

/** The element's children only, for a story snippet's root. */
function unwrapStoryRoot(html) {
  const root = elements(html).find(
    (e) => e.depth === 0 && STORY_ROOTS.has(e.attrs.id),
  );
  if (!root) return html;
  return (
    html.slice(0, root.start) +
    html.slice(root.innerStart, root.innerEnd) +
    html.slice(root.end)
  );
}

// ── sanitizing (self-contained, script-free output) ─────────────────────────

const URL_ATTRS = new Set([
  "src",
  "href",
  "xlink:href",
  "poster",
  "action",
  "formaction",
  "data",
  "background",
  "ping",
  "cite",
  "longdesc",
  "lowsrc",
  "manifest",
  "codebase",
]);
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
const DROPPED = new Set(["script", "link", "base", "meta", "set", "animate"]);
/** Dropped with everything inside them: scripts, and SVG animation, which can
 *  set an href to a remote URL after load. */
const DROPPED_WITH_CONTENT = new Set(["script", "set", "animate"]);

/**
 * Named character references the decoder knows: every HTML name for an ASCII
 * punctuation or whitespace character (the ones that can reshape a URL or a
 * CSS function), plus common text entities. Lookup ignores case, which can
 * only make the check see more than the browser does. An attribute holding
 * any other `&name;` is dropped (see UNKNOWN_ENTITY).
 */
const NAMED = {
  excl: "!",
  quot: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  equals: "=",
  gt: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  hat: "^",
  lowbar: "_",
  underbar: "_",
  grave: "`",
  diacriticalgrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  verticalline: "|",
  rcub: "}",
  rbrace: "}",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
  nonbreakingspace: " ",
  shy: "­",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hairsp: " ",
  zwnj: "‌",
  zwj: "‍",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  deg: "°",
  plusmn: "±",
  para: "¶",
  sect: "§",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  check: "✓",
  hearts: "♥",
  star: "☆",
  starf: "★",
};

/** A terminated named reference the decoder does not know. */
export function hasUnknownEntity(value) {
  for (const match of value.matchAll(/&([a-z][a-z0-9]*);/gi)) {
    if (!(match[1].toLowerCase() in NAMED)) return true;
  }
  return false;
}

/** An attribute value as the browser reads it: character references decoded. */
export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (whole, ref) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

function encodeAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The allowlist for a decoded URL: relative references, fragments and
 * `data:`. Any other scheme (http, https, javascript, file, …) and
 * protocol-relative `//host` URLs are refused. Browsers drop ASCII tabs and
 * newlines inside URLs and ignore leading control characters and spaces, so
 * those are removed before the scheme is read.
 */
export function isSafeUrl(decoded) {
  const url = decoded.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (url.startsWith("//") || url.startsWith("\\\\") || url.startsWith("/\\"))
    return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(url);
  return !scheme || scheme[1] === "data";
}

/**
 * The candidate URLs of a srcset, parsed as the HTML spec does: a URL runs
 * to the next whitespace (trailing commas trimmed), and its descriptors run
 * to the next comma outside parentheses. `a.png 1x,https://…/b.png 2x` is
 * two candidates; a bare comma separates them as well as ", ".
 */
export function srcsetUrls(value) {
  const urls = [];
  let pos = 0;
  while (pos < value.length) {
    while (pos < value.length && /[\s,]/.test(value[pos])) pos += 1;
    if (pos >= value.length) break;
    const start = pos;
    while (pos < value.length && !/\s/.test(value[pos])) pos += 1;
    const url = value.slice(start, pos);
    urls.push(url.replace(/,+$/, ""));
    if (url.endsWith(",")) continue;
    let depth = 0;
    for (; pos < value.length; pos += 1) {
      const ch = value[pos];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        pos += 1;
        break;
      }
    }
  }
  return urls;
}

/**
 * Every candidate must be safe, and no token after whitespace or a comma may
 * start a remote or script URL either: a second, cruder reading that can only
 * refuse more (a `data:` URI holding ",https:" is dropped too).
 */
function isSafeSrcset(decoded) {
  if (!srcsetUrls(decoded).every((url) => isSafeUrl(url))) return false;
  return decoded
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((token) => isSafeUrl(token));
}

/** Drops scripts, links, handlers and every remote or javascript: URL. */
export function sanitizeMarkup(html) {
  let out = "";
  let i = 0;
  const tokens = tokenize(html);
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];
    if (token.type !== "open") continue;
    if (DROPPED.has(token.name)) {
      out += html.slice(i, token.start);
      i = token.end;
      if (DROPPED_WITH_CONTENT.has(token.name) && !token.selfClosing) {
        const close = tokens.findIndex(
          (n, k) => k > t && n.type === "close" && n.name === token.name,
        );
        if (close >= 0) {
          i = tokens[close].end;
          t = close;
        }
      }
      continue;
    }
    let changed = false;
    const kept = [];
    for (const [name, value] of Object.entries(token.attrs)) {
      if (name.startsWith("on")) {
        changed = true;
        continue;
      }
      if (name === "srcdoc") {
        changed = true;
        continue;
      }
      // Fail closed: a reference this decoder cannot read (say `&lpar;` or a
      // rarer name) could hide a comma, a parenthesis or a scheme, so the
      // attribute goes. Captured markup only ever carries &amp; &quot; &nbsp;
      // &lt; &gt;.
      if (hasUnknownEntity(value)) {
        changed = true;
        if (name === "href") kept.push(["href", "#"]);
        continue;
      }
      const unsafe =
        (URL_ATTRS.has(name) && !isSafeUrl(decodeEntities(value))) ||
        (SRCSET_ATTRS.has(name) && !isSafeSrcset(decodeEntities(value)));
      if (unsafe) {
        changed = true;
        if (name === "href") kept.push(["href", "#"]);
        continue;
      }
      // `style`, and any other attribute whose value holds a url() (SVG's
      // fill, stroke, mask, clip-path, filter, marker-*…), is CSS to the
      // browser: read it as the browser will (entities decoded) and run it
      // through the same allowlist.
      const decoded = decodeEntities(value);
      if (
        name === "style" ||
        /url\s*\(/i.test(unescapeFetchingNames(decoded))
      ) {
        const cleaned = sanitizeCss(decoded);
        if (cleaned !== decoded) {
          changed = true;
          kept.push([name, encodeAttr(cleaned)]);
          continue;
        }
      }
      kept.push([name, value.replace(/"/g, "&quot;")]);
    }
    if (changed) {
      // Values are already encoded for a double-quoted attribute.
      const attrs = kept.map(([name, value]) => ` ${name}="${value}"`).join("");
      out += `${html.slice(i, token.start)}<${token.name}${attrs}${token.selfClosing && !VOID.has(token.name) ? " /" : ""}>`;
      i = token.end;
    }
    const text = tokens[t + 1];
    if (token.name === "style" && text?.type === "text") {
      out +=
        html.slice(i, text.start) +
        sanitizeCss(html.slice(text.start, text.end));
      i = text.end;
      t += 1;
    }
  }
  return out + html.slice(i);
}

/** A CSS string or url() body as the browser reads it: escapes resolved. */
function unescapeCss(value) {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "\ufffd";
    })
    .replace(/\\\n/g, "")
    .replace(/\\(.)/g, "$1");
}

const CSS_URL_OR_STRING =
  /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^)\\])*))\s*\)|"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/gi;

/** An identifier with CSS escapes in it (`u\\72l`, `\\75rl`, `@\\69mport`). */
const ESCAPED_NAME =
  /(@?)((?:[a-z0-9_-]|\\[0-9a-f]{1,6}\s?|\\[^\n\r\f0-9a-f])*\\(?:[0-9a-f]{1,6}\s?|[^\n\r\f0-9a-f])(?:[a-z0-9_-]|\\[0-9a-f]{1,6}\s?|\\[^\n\r\f0-9a-f])*)(?=(\()?)/gi;

/**
 * A function name or at-keyword can be written with escapes and still work
 * (`u\\72l(https://…)` is a url()), so an escaped `url`/`src` before `(`
 * and an escaped `@import` are written plainly first, for the checks below
 * to see. Other escaped identifiers are left alone.
 */
function unescapeFetchingNames(css) {
  return css.replace(ESCAPED_NAME, (whole, at, name, paren) => {
    const plain = unescapeCss(name).toLowerCase();
    if (at && plain === "import") return "@import";
    if (!at && paren && (plain === "url" || plain === "src")) return plain;
    return whole;
  });
}

/**
 * Remote references become inert: every `@import` is removed, a `url()`
 * outside the allowlist (see isSafeUrl) becomes `none`, and so does a bare
 * string that names one (`image-set("https://…")`), after CSS escapes are
 * resolved.
 */
export function sanitizeCss(css) {
  return unescapeFetchingNames(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(CSS_URL_OR_STRING, (whole, dq, sq, bare, str, sstr) => {
      if (dq !== undefined || sq !== undefined || bare !== undefined) {
        return isSafeUrl(unescapeCss((dq ?? sq ?? bare).trim()))
          ? whole
          : "none";
      }
      const text = unescapeCss(str ?? sstr);
      return /^\s*[a-z][a-z0-9+.-]*:|^\s*\/\//i.test(text) && !isSafeUrl(text)
        ? '""'
        : whole;
    });
}

const ASSET_TYPES = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

/**
 * Every relative `url()` in a kit stylesheet that names a file inside the kit
 * (`../fonts/x.woff2`, `../assets/logo.svg`, …) becomes a data URI. One that
 * names nothing in the kit becomes `none`, so the page never asks for it.
 * `fonts/x` without `../` is read from the kit's fonts folder as well.
 * Fragments, `data:` and absolute URLs are left to the sanitizer.
 */
export function inlineAssets(kit, css, cssDir = join(kit.dir, "css")) {
  const root = resolve(kit.dir);
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
    (whole, _quote, raw) => {
      const ref = raw.trim();
      if (!ref || ref.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(ref))
        return whole;
      if (ref.startsWith("//") || ref.startsWith("/")) return whole;
      const path = ref.replace(/[?#].*$/, "");
      let file = resolve(cssDir, path);
      const inside = (candidate) =>
        candidate.startsWith(root + sep) && existsSync(candidate);
      if (!inside(file) && /^(?:\.\.\/|\.\/)?fonts\//.test(path)) {
        file = join(root, "fonts", basename(path));
      }
      if (!inside(file)) return "none";
      const type = ASSET_TYPES[extname(file).toLowerCase()];
      if (!type) return "none";
      return `url("data:${type};base64,${readFileSync(file).toString("base64")}")`;
    },
  );
}

// ── compose ─────────────────────────────────────────────────────────────────

function expandSnippets(kit, html, used, budget, depth = 0) {
  const found = elements(html).filter((e) => e.name === "kit-snippet");
  if (!found.length) return html;
  if (depth >= SNIPPET_DEPTH) {
    throw new KitError(
      `<kit-snippet> nesting is deeper than ${SNIPPET_DEPTH}; is a snippet including itself?`,
    );
  }
  let out = "";
  let i = 0;
  for (const element of found) {
    if (element.start < i) continue; // inside an earlier placeholder
    const id = element.attrs.id;
    if (!id) throw new KitError("<kit-snippet> without an id attribute");
    const row = requireRow(kit, id, "<kit-snippet id>");
    used.add(rowCssFile(kit, row));
    let markup = readSnippet(kit, row);
    budget.left -= markup.length;
    if (budget.left < 0) {
      throw new KitError(
        `too large: the page grows past ${budget.max} bytes while expanding <kit-snippet> elements; use fewer or smaller snippets.`,
      );
    }
    if (rowSource(row) === "stories") markup = unwrapStoryRoot(markup);
    out +=
      html.slice(i, element.start) +
      expandSnippets(kit, markup, used, budget, depth + 1);
    i = element.end;
  }
  return out + html.slice(i);
}

function fillSlots(kit, row, html, slots) {
  if (!slots.length) return html;
  const marked = elements(html).filter((e) => "data-kit-slot" in e.attrs);
  const names = [
    ...new Set([
      ...(row.slots ?? []),
      ...marked.map((e) => e.attrs["data-kit-slot"]),
    ]),
  ];
  const replacements = [];
  for (const { name, content } of slots) {
    const element = marked.find((e) => e.attrs["data-kit-slot"] === name);
    if (!element) throw unknown(`slot of ${row.id}`, name, names);
    replacements.push({ element, content });
  }
  replacements.sort((a, b) => b.element.innerStart - a.element.innerStart);
  for (const { element, content } of replacements) {
    html =
      html.slice(0, element.innerStart) +
      content +
      html.slice(element.innerEnd);
  }
  return html;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

const ATTR_NAME = /^(?:class|style|lang|dir|data-[a-z0-9-]+)$/;

/**
 * How the kit's app switches theme, as the capture recorded it in
 * `manifest.theme`: a class (the default, `dark` on `<html>` and `<body>`)
 * or an attribute such as `data-theme`, set on `targets`. A theme with no
 * value (light, by default) means "the dark value removed".
 */
export const DEFAULT_THEME = Object.freeze({
  attribute: "class",
  dark: "dark",
  targets: ["html", "body"],
});

export function kitTheme(manifest) {
  const theme = manifest?.theme;
  if (!theme || typeof theme !== "object") return DEFAULT_THEME;
  const attribute =
    typeof theme.attribute === "string" && theme.attribute
      ? theme.attribute
      : "class";
  return {
    attribute,
    dark: typeof theme.dark === "string" ? theme.dark : "dark",
    ...(typeof theme.light === "string" ? { light: theme.light } : {}),
    targets:
      Array.isArray(theme.targets) && theme.targets.length
        ? theme.targets.filter((t) => t === "html" || t === "body")
        : attribute === "class"
          ? ["html", "body"]
          : ["html"],
  };
}

/**
 * The captured <html>/<body> attributes (class, style, lang, dir, data-*),
 * with the theme value replaced by the one asked for when `target` is one of
 * the theme's targets.
 */
function attributes(captured, extraClass, theme, choice, target, fixed) {
  const attrs = {};
  for (const [name, value] of Object.entries(captured ?? {})) {
    if (ATTR_NAME.test(name) && typeof value === "string") attrs[name] = value;
  }
  const applies = theme.targets.includes(target);
  const value = choice === "dark" ? theme.dark : theme.light;
  const themeValues = new Set(
    [theme.dark, theme.light].filter((name) => typeof name === "string"),
  );
  // Class themes: the default class theme also drops a captured `light`.
  if (theme.attribute === "class" && theme.light === undefined)
    themeValues.add("light");
  const classes = [
    ...new Set(
      `${attrs.class ?? ""} ${extraClass ?? ""}`
        .split(/\s+/)
        .filter(
          (name) =>
            name && !(theme.attribute === "class" && themeValues.has(name)),
        ),
    ),
  ];
  if (applies && theme.attribute === "class" && value) classes.push(value);
  if (applies && theme.attribute !== "class") {
    const name = theme.attribute.toLowerCase();
    if (value) attrs[name] = value;
    else if (attrs[name] === theme.dark) delete attrs[name];
  }
  delete attrs.class;
  if (attrs.style !== undefined) attrs.style = sanitizeCss(attrs.style);
  const all = {
    ...(classes.length ? { class: classes.join(" ") } : {}),
    ...attrs,
    ...fixed,
  };
  return Object.entries(all)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join("");
}

/**
 * One self-contained page: the frame's markup with slots filled and
 * snippets expanded, its CSS (and that of any other source a snippet came
 * from) inlined with fonts as data URIs, and no scripts or remote URLs.
 */
export function compose(
  kit,
  {
    frame,
    slots = [],
    theme = "light",
    showNew = false,
    maxBytes = COMPOSE_MAX_BYTES,
  },
) {
  const row = requireRow(kit, frame, "frame");
  if (theme !== "light" && theme !== "dark") {
    throw new KitError(`unknown theme "${theme}". Use light or dark.`);
  }
  const used = new Set([rowCssFile(kit, row)]);
  const filled = fillSlots(kit, row, readSnippet(kit, row), slots);
  const body = expandSnippets(kit, filled, used, {
    left: maxBytes - filled.length,
    max: maxBytes,
  });

  // Stories' sheet first, then the route sheets, as before page sources.
  const storiesCss = cssFile(kit, "stories");
  const css = [...used]
    .sort((a, b) =>
      a === storiesCss ? -1 : b === storiesCss ? 1 : a < b ? -1 : a > b ? 1 : 0,
    )
    .map((name) => {
      const file = join(kit.dir, name);
      if (!existsSync(file)) {
        throw new KitError(`the kit has no ${name} for ${frame}`);
      }
      return inlineAssets(kit, readFileSync(file, "utf8"), dirname(file));
    })
    .join("\n");
  const showNewCss = showNew
    ? "\n[data-kit-new]{outline:2px dashed #e5484d !important;outline-offset:2px}"
    : "";

  const switcher = kitTheme(kit.manifest);
  const sha = kit.manifest?.sha ?? "unknown";
  const htmlAttrs = attributes(row.html_attrs, "", switcher, theme, "html", {
    "data-kit-sha": sha,
    "data-kit-id": frame,
    lang: row.html_attrs?.lang ?? "en",
  });
  const bodyAttrs = attributes(
    row.body_attrs,
    row.body_class,
    switcher,
    theme,
    "body",
    {},
  );
  const page = `<!doctype html>
<html${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(row.title ?? frame)}</title>
<style>
${sanitizeCss(css)}${showNewCss}
</style>
</head>
<body${bodyAttrs}>
${sanitizeMarkup(body)}
</body>
</html>
`;
  return page;
}

// ── visible text (text.json) ────────────────────────────────────────────────

/** Characters of visible text text.json keeps per row. */
export const TEXT_LIMIT = 600;
/** Characters of a `find` excerpt. */
const EXCERPT_CHARS = 60;
/** Elements whose content is never read on screen as text. */
const HIDDEN_CONTENT = new Set([
  "script",
  "style",
  "svg",
  "head",
  "template",
  "noscript",
  "title",
]);
/** Phrasing elements that sit inside a word; every other tag separates words. */
const INLINE = new Set(
  "a abbr b bdi bdo cite code data dfn em i kbd mark q s samp small strong sub sup time u var wbr".split(
    " ",
  ),
);

/** Each `data-kit-slot` element's inner range, for slot-first text. */
function slotRanges(html) {
  if (!html.includes("data-kit-slot")) return [];
  return elements(html)
    .filter((element) => element.attrs["data-kit-slot"] !== undefined)
    .map((element) => [element.innerStart, element.innerEnd]);
}

/**
 * The words a row shows: text content outside scripts, styles, SVG, the head
 * and templates, entities decoded and whitespace collapsed, at most `limit`
 * characters. Attribute values are never text. The text of the row's slots
 * (a page's `main`) comes first and the rest of the markup after it, so a
 * page's own words are kept ahead of the navigation and top bar every page
 * repeats.
 */
export function visibleText(html, limit = TEXT_LIMIT) {
  const ranges = slotRanges(html);
  const lastSlotEnd = Math.max(0, ...ranges.map(([, end]) => end));
  const inSlot = (at) => ranges.some(([from, to]) => at >= from && at < to);
  // [slot text, the rest]
  const parts = ["", ""];
  const add = (at, words) => {
    const part = inSlot(at) ? 0 : 1;
    if (words === " " && (parts[part] === "" || parts[part].endsWith(" ")))
      return;
    parts[part] += words;
  };
  let hidden = null;
  let depth = 0;
  for (const token of scan(html)) {
    if (hidden) {
      if (token.name !== hidden) continue;
      if (token.type === "open" && !token.selfClosing) depth += 1;
      else if (token.type === "close" && (depth -= 1) === 0) hidden = null;
      continue;
    }
    if (token.type === "open" || token.type === "close") {
      if (
        token.type === "open" &&
        HIDDEN_CONTENT.has(token.name) &&
        !token.selfClosing
      ) {
        hidden = token.name;
        depth = 1;
      } else if (!INLINE.has(token.name)) {
        add(token.start, " ");
      }
      continue;
    }
    if (token.type !== "text") continue;
    add(
      token.start,
      decodeEntities(html.slice(token.start, token.end)).replace(/\s+/g, " "),
    );
    // Enough collected: a row's text is a search aid, not its content.
    const [slot, rest] = parts;
    if (slot.length > limit * 2 && slot.trim().length > limit) break;
    if (
      token.end >= lastSlotEnd &&
      slot.length + rest.length > limit * 2 &&
      `${slot} ${rest}`.trim().length > limit
    )
      break;
  }
  return [...`${parts[0]} ${parts[1]}`.replace(/\s+/g, " ").trim()]
    .slice(0, limit)
    .join("");
}

/**
 * text.json's content: each row's visible text by id, from its markup.
 * `read(file)` returns a row's markup by its kit-relative `file`; a row
 * whose file is missing or leaves the kit has no entry. The first row of an
 * id wins, as in `loadKit`.
 */
export function kitText(rows, read) {
  const text = {};
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || seen.has(row.id)) continue;
    seen.add(row.id);
    const file = row.file;
    if (typeof file !== "string" || !file || file.split(/[\\/]/).includes(".."))
      continue;
    let html;
    try {
      html = read(file);
    } catch {
      continue;
    }
    if (typeof html !== "string") continue;
    const words = visibleText(html);
    if (words) text[row.id] = words;
  }
  return Object.fromEntries(
    Object.entries(text).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** text.json as written: stable keys, one row per line. */
export function kitTextJson(text) {
  return `${JSON.stringify(text, null, 1)}\n`;
}

/** Rebuilds `dir`/text.json from the rows and markup already in the kit. */
export function writeKitText(dir) {
  const kit = loadKit(dir);
  const json = kitTextJson(
    kitText(kit.rows, (file) => readFileSync(join(dir, file), "utf8")),
  );
  writeFileSync(join(dir, "text.json"), json);
  return json;
}

/** text.json, if the kit has a readable one: id → visible text. */
function readText(dir) {
  const file = join(dir, "text.json");
  if (!existsSync(file)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // An optional search aid: a broken one leaves find as it is without it.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const text = new Map();
  for (const [id, words] of Object.entries(parsed))
    if (typeof words === "string") text.set(id, words);
  return text;
}

/** About EXCERPT_CHARS of `words` around `at`, cut words marked with "…". */
function excerpt(words, at, length) {
  const chars = [...words];
  // `at` counts UTF-16 units; recount it in characters.
  const from = [...words.slice(0, at)].length;
  let start = Math.max(0, from - Math.floor((EXCERPT_CHARS - length) / 2));
  const end = Math.min(chars.length, start + EXCERPT_CHARS);
  start = Math.max(0, end - EXCERPT_CHARS);
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("").trim()}${end < chars.length ? "…" : ""}`;
}

// ── show / find / info ──────────────────────────────────────────────────────

export function outline(html, limit = SHOW_LIMIT) {
  const lines = [];
  let size = 0;
  let truncated = false;
  for (const element of elements(html)) {
    if (element.depth > 4) continue;
    const classes = (element.attrs.class ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join("");
    const marks = ["id", "role", "data-kit-slot", "aria-label", "data-testid"]
      .filter((name) => element.attrs[name])
      .map((name) => `[${name}=${element.attrs[name].slice(0, 40)}]`)
      .join("");
    const text = element.text.replace(/\s+/g, " ").trim().slice(0, 40);
    const line = `${"  ".repeat(element.depth)}<${element.name}${classes}${marks}>${text ? ` "${text}"` : ""}`;
    // The limit is bytes: an outline line can carry non-ASCII text.
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > limit) {
      truncated = true;
      break;
    }
    lines.push(line);
    size += bytes;
  }
  return { lines, truncated };
}

function formatBytes(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/**
 * Rows holding every word of `query` in their id, title, component, source
 * file or visible text (text.json), best first: a word in the id ranks
 * above one in the title, component or source file, which ranks above one
 * only in the text, and among rows that tie, one whose text holds the whole
 * query as written comes first. A row a word matched only through its text
 * carries an `excerpt` around that phrase, or else the first such word.
 */
export function findMatches(kit, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const phrase = terms.join(" ");
  const scored = [];
  for (const row of kit.rows) {
    const id = row.id.toLowerCase();
    const hay = [row.id, row.title, row.component, row.source_file]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const words = kit.text?.get(row.id) ?? "";
    let lowered = null;
    let score = 0;
    let textHit = null;
    let matched = true;
    for (const term of terms) {
      if (id.includes(term)) continue;
      if (hay.includes(term)) {
        score += 1;
        continue;
      }
      lowered ??= words.toLowerCase();
      const at = lowered.indexOf(term);
      if (at < 0) {
        matched = false;
        break;
      }
      score += 2;
      textHit ??= { at, length: term.length };
    }
    if (!matched) continue;
    // The whole query as written, in the text: the excerpt shows it, and it
    // ranks first among rows that tie.
    const at = textHit && terms.length > 1 ? lowered.indexOf(phrase) : -1;
    if (at >= 0) textHit = { at, length: phrase.length };
    scored.push({
      row,
      score,
      phrase: at >= 0 ? 0 : 1,
      ...(textHit
        ? { excerpt: excerpt(words, textHit.at, textHit.length) }
        : {}),
    });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.phrase - b.phrase ||
      (a.row.id < b.row.id ? -1 : 1),
  );
  return scored.map(({ row, excerpt: cut }) =>
    cut === undefined ? { row } : { row, excerpt: cut },
  );
}

/** Rows holding every word of `query`, best first (see findMatches). */
export function find(kit, query) {
  return findMatches(kit, query).map(({ row }) => row);
}

function findLines(kit, query) {
  const matches = findMatches(kit, query);
  if (!matches.length) {
    const near = nearMatches(
      query,
      kit.rows.map((row) => row.id),
    );
    throw new KitError(
      `nothing matches "${query}".${near.length ? ` Near: ${near.join(", ")}` : ""}`,
    );
  }
  const line = ({ row, excerpt: cut }) =>
    `${row.id}  ${row.kind ?? rowSource(row)}  ${row.width ?? "?"}w  ${formatBytes(row.bytes ?? 0)}  ${row.title ?? ""}${cut === undefined ? "" : `  "${cut}"`}`;
  if (matches.length <= FIND_LIMIT) return matches.map(line);
  const room = FIND_LIMIT - 1;
  // A row with an excerpt was found by on-screen text; any other, by name.
  const byText = matches.filter((match) => match.excerpt !== undefined);
  if (!byText.length) {
    return [
      ...matches.slice(0, room).map(line),
      `… ${matches.length - room} more; add a word to narrow it`,
    ];
  }
  // Names fill the list first, but the last lines are kept for text hits,
  // so an agent sees them even when names alone would fill it.
  const byName = matches.filter((match) => match.excerpt === undefined);
  const textRoom = Math.min(
    byText.length,
    Math.max(FIND_TEXT_LINES, room - byName.length),
  );
  const names = byName.slice(0, room - textRoom);
  const texts = byText.slice(0, room - names.length);
  const left = [
    ...(byName.length > names.length
      ? [`+${byName.length - names.length} more by name`]
      : []),
    ...(byText.length > texts.length
      ? [`+${byText.length - texts.length} more by on-screen text`]
      : []),
  ];
  return [
    ...names.map(line),
    ...texts.map(line),
    `${left.join(", ")}; narrow the query`,
  ];
}

function showText(kit, id, full) {
  const row = requireRow(kit, id, "id");
  const html = readSnippet(kit, row);
  if (full) return html;
  const head = [
    `${row.id}  (${row.kind ?? rowSource(row)}, ${row.width ?? "?"}x${row.height ?? "?"})`,
    `title: ${row.title ?? ""}`,
    `file: ${snippetPath(kit, row)}  ${formatBytes(Buffer.byteLength(html))}`,
    ...(row.source_file ? [`source: ${row.source_file}`] : []),
    ...(row.slots?.length ? [`slots: ${row.slots.join(", ")}`] : []),
    "outline:",
  ].join("\n");
  const tail = "… (outline cut; --full prints the markup)";
  const { lines, truncated } = outline(
    html,
    SHOW_LIMIT - Buffer.byteLength(head) - Buffer.byteLength(tail) - 2,
  );
  return [head, ...lines, ...(truncated ? [tail] : [])].join("\n");
}

function infoText(kit) {
  const routes = kit.rows.filter((row) => rowSource(row) === "routes").length;
  return [
    JSON.stringify(kit.manifest ?? { missing: "manifest.json" }, null, 2),
    `rows: ${kit.rows.length} (stories ${kit.rows.length - routes}, routes ${routes})`,
  ].join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: kit.mjs [--kit <dir>] <command>
  info                         print the manifest
  find <query>                 list up to ${FIND_LIMIT} rows whose id, title or on-screen text holds every word
  show <id> [--full]           path, size and an outline (--full: the markup)
  compose --frame <id> [--slot <name>=<file>]… [--theme light|dark] [--show-new] --out <file>`;

function parseArgs(argv) {
  const options = { slots: [], positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new KitError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--kit") options.kit = value();
    else if (arg === "--frame") options.frame = value();
    else if (arg === "--slot") options.slots.push(value());
    else if (arg === "--theme") options.theme = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--full") options.full = true;
    else if (arg === "--show-new") options.showNew = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new KitError(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

/** Runs one command; returns the exit code. */
export function run(
  argv,
  io = { out: console.log, err: console.error },
  env = process.env,
  defaultDir = dirname(fileURLToPath(import.meta.url)),
) {
  try {
    const options = parseArgs(argv);
    const [command, ...rest] = options.positional;
    if (options.help || !command) {
      io.out(USAGE);
      return command || options.help ? 0 : 2;
    }
    const dir = resolve(options.kit ?? env.DESIGN_KIT_DIR ?? defaultDir);
    const kit = loadKit(dir);
    if (command === "info") {
      io.out(infoText(kit));
    } else if (command === "find") {
      if (!rest.length) throw new KitError("find needs a query");
      io.out(findLines(kit, rest.join(" ")).join("\n"));
    } else if (command === "show") {
      if (rest.length !== 1) throw new KitError("show needs one id");
      io.out(showText(kit, rest[0], options.full));
    } else if (command === "compose") {
      if (!options.frame) throw new KitError("compose needs --frame <id>");
      if (!options.out) throw new KitError("compose needs --out <file>");
      const slots = options.slots.map((spec) => {
        const at = spec.indexOf("=");
        if (at <= 0) throw new KitError(`--slot ${spec}: use <name>=<file>`);
        const file = resolve(spec.slice(at + 1));
        if (!existsSync(file))
          throw new KitError(`--slot ${spec}: no such file`);
        return { name: spec.slice(0, at), content: readFileSync(file, "utf8") };
      });
      const page = compose(kit, {
        frame: options.frame,
        slots,
        theme: options.theme ?? "light",
        showNew: options.showNew,
      });
      writeFileSync(resolve(options.out), page);
      io.out(
        `${resolve(options.out)}  ${formatBytes(Buffer.byteLength(page))}`,
      );
    } else {
      throw new KitError(`unknown command "${command}"\n${USAGE}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof KitError) {
      io.err(`kit: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

/**
 * Whether this file is the script node was started with (symlinks resolved).
 * Only a file named `kit.mjs` can be: a bundler that inlines this module into
 * another program keeps `import.meta.url` pointing at that program, which is
 * also the script node started, and the program would then run the kit's
 * command line on its own arguments.
 */
export function isMain(moduleUrl = import.meta.url, script = process.argv[1]) {
  if (!script) return false;
  let self;
  try {
    self = fileURLToPath(moduleUrl);
  } catch {
    // Not a file URL: an evaluated bundle, never the script node started.
    return false;
  }
  if (basename(self) !== "kit.mjs") return false;
  try {
    return realpathSync(self) === realpathSync(resolve(script));
  } catch {
    return moduleUrl === pathToFileURL(resolve(script)).href;
  }
}

if (isMain()) {
  process.exitCode = run(process.argv.slice(2));
}
