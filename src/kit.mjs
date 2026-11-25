#!/usr/bin/env node
/**
 * The design kit's own tool. It ships inside every kit, so tool and data
 * always match. Pure Node: no dependencies, no network.
 *
 *   node kit.mjs info [--json]
 *   node kit.mjs find <query>        (ids, titles and the words on screen)
 *   node kit.mjs show <id> [--full]
 *   node kit.mjs compose --frame <id> [--slot <name>=<file>]… [--theme light|dark]
 *                        [--show-new] [--css pruned|full] --out <file>
 *   node kit.mjs figure --img <file> [--href <#cp-page:key>] [--caption <text>]
 *                       [--alt <text>] [--width <px>] --out <file>
 *   node kit.mjs figure --page <file.html> [--href <#cp-page:key>] [--caption <text>]
 *                       [--alt <text>] [--width <px>] [--fit <px>] [--height <px>] --out <file>
 *
 * `--kit <dir>` (or DESIGN_KIT_DIR) points at a kit; the default is the
 * folder this file sits in. Format: the @codepress/design-kit README.
 */
import { randomBytes } from "node:crypto";
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
    const name = match[1].toLowerCase();
    // The browser keeps the first of two same-named attributes, so the
    // sanitizer must check that one: `<img src="https://…" src="a.png">`
    // loads the remote one.
    if (!Object.hasOwn(attrs, name))
      attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/**
 * Where the comment opening at `lt` ends, as the browser reads it: `<!-->`
 * and `<!--->` are empty comments, and `--!>` closes a comment as well as
 * `-->`. Reading a comment as longer than the browser does would let markup
 * after its real end pass the sanitizer as comment text.
 */
function commentEnd(html, lt) {
  if (html.startsWith(">", lt + 4)) return lt + 5;
  if (html.startsWith("->", lt + 4)) return lt + 6;
  const ends = [
    [html.indexOf("-->", lt + 4), 3],
    [html.indexOf("--!>", lt + 4), 4],
  ].filter(([at]) => at >= 0);
  if (!ends.length) return html.length;
  const [at, length] = ends.reduce((a, b) => (b[0] < a[0] ? b : a));
  return at + length;
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
      yield { type: "comment", start: lt, end: commentEnd(html, lt) };
      i = commentEnd(html, lt);
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
/** Elements this scanner reads as raw text that foreign content parses as markup. */
const RAW_TEXT = new Set(["style", "title", "textarea"]);

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
    // Inside <svg> or <math> the browser parses a <style>, <title> or
    // <textarea>'s content as markup (`<svg><style><img onerror=…>`), where
    // this scanner reads raw text. One whose text holds anything tag-like is
    // dropped with its content, wherever it sits.
    const text = tokens[t + 1];
    const markupInRaw =
      RAW_TEXT.has(token.name) &&
      !token.selfClosing &&
      text?.type === "text" &&
      /<[a-z!/?]/i.test(html.slice(text.start, text.end));
    if (DROPPED.has(token.name) || markupInRaw) {
      out += html.slice(i, token.start);
      i = token.end;
      if (
        (DROPPED_WITH_CONTENT.has(token.name) || markupInRaw) &&
        !token.selfClosing
      ) {
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

/**
 * An identifier run, escapes included (`u\\72l`, `\\75rl`, `@\\69mport`).
 * Each run is matched once, first character to last; a run without an
 * escape is left as it is. A regex that demanded the escape itself retried
 * a long run (base64 in an inlined image) from every start, which is
 * quadratic and stalled compose for minutes.
 */
const ESCAPED_NAME =
  /(@?)((?:[a-z0-9_-]+|\\[0-9a-f]{1,6}\s?|\\[^\n\r\f0-9a-f])+)(?=(\()?)/gi;

/**
 * A function name or at-keyword can be written with escapes and still work
 * (`u\\72l(https://…)` is a url()), so an escaped `url`/`src` before `(`
 * and an escaped `@import` are written plainly first, for the checks below
 * to see. Other escaped identifiers are left alone.
 */
function unescapeFetchingNames(css) {
  return css.replace(ESCAPED_NAME, (whole, at, name, paren) => {
    if (!name.includes("\\")) return whole;
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
  return replaceUrlsAndStrings(
    unescapeFetchingNames(css).replace(/@import[^;]*;?/gi, ""),
  );
}

const CSS_SPACE = /\s/;

/**
 * The end of a quoted string that opens at `start`, read as the browser
 * does: a backslash escapes the next character (a backslash-newline is a
 * line continuation) and an unescaped newline ends it as a bad string.
 * Returns the index after the closing quote, or `bad: true` with the index
 * of the newline (or the end of the text).
 */
function readCssString(css, start) {
  const quote = css[start];
  let pos = start + 1;
  while (pos < css.length) {
    const ch = css[pos];
    if (ch === "\\") pos += 2;
    else if (ch === quote) return { end: pos + 1, bad: false };
    else if (ch === "\n" || ch === "\r" || ch === "\f")
      return { end: pos, bad: true };
    else pos += 1;
  }
  return { end: css.length, bad: true };
}

/** The `url(…)` that opens at `start`, or null when it does not close. */
function readCssUrl(css, start) {
  let pos = start + 4;
  while (pos < css.length && CSS_SPACE.test(css[pos])) pos += 1;
  let value;
  if (css[pos] === '"' || css[pos] === "'") {
    const string = readCssString(css, pos);
    if (string.bad) return null;
    value = css.slice(pos + 1, string.end - 1);
    pos = string.end;
    while (pos < css.length && CSS_SPACE.test(css[pos])) pos += 1;
    if (css[pos] !== ")") return null;
  } else {
    const from = pos;
    while (pos < css.length && css[pos] !== ")") {
      if (css[pos] === "\\") {
        if (pos + 1 >= css.length || css[pos + 1] === "\n") return null;
        pos += 2;
      } else pos += 1;
    }
    if (pos >= css.length) return null;
    value = css.slice(from, pos);
  }
  return { end: pos + 1, value };
}

/**
 * One linear pass over the CSS, tokenized as the browser reads it: a
 * comment is inert and kept, an escape outside a string (`\'` in a Tailwind
 * selector such as `[stroke=\'#ccc\']`) is part of an identifier and opens
 * no string, a string ends at its quote or an unescaped newline. A `url()`
 * outside the allowlist becomes `none`; a string naming a remote URL
 * becomes `""`. Written as a scanner, not a regex: the regex this replaced
 * recursed once per character of a match, so an escaped quote that paired
 * with a quote megabytes later (past inlined fonts) overflowed the stack.
 */
function replaceUrlsAndStrings(css) {
  let out = "";
  let copied = 0;
  let pos = 0;
  const replace = (start, end, text) => {
    out += css.slice(copied, start) + text;
    copied = end;
  };
  while (pos < css.length) {
    const ch = css[pos];
    if (ch === "/" && css[pos + 1] === "*") {
      const close = css.indexOf("*/", pos + 2);
      pos = close < 0 ? css.length : close + 2;
    } else if (ch === "\\") {
      pos += css[pos + 1] === "\n" ? 1 : 2;
    } else if (
      (ch === "u" || ch === "U") &&
      css.slice(pos, pos + 4).toLowerCase() === "url("
    ) {
      const url = readCssUrl(css, pos);
      if (!url) {
        pos += 1;
        continue;
      }
      if (!isSafeUrl(unescapeCss(url.value.trim())))
        replace(pos, url.end, "none");
      pos = url.end;
    } else if (ch === '"' || ch === "'") {
      const string = readCssString(css, pos);
      const text = unescapeCss(
        css.slice(pos + 1, string.bad ? string.end : string.end - 1),
      );
      if (/^\s*[a-z][a-z0-9+.-]*:|^\s*\/\//i.test(text) && !isSafeUrl(text))
        replace(pos, string.end, '""');
      pos = string.end;
    } else pos += 1;
  }
  return out + css.slice(copied);
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

// ── behaviours (clickable mockups) ──────────────────────────────────────────

/** Attributes that make compose inline the behaviour script. */
const BEHAVIOUR_ATTRS = [
  "data-kit-toggle",
  "data-kit-tabs",
  "data-kit-tab",
  "data-kit-panel",
  "data-kit-state",
  "data-kit-set",
  "data-kit-after",
];

/**
 * Hides what the behaviours hide even when the element's own CSS sets a
 * display (a captured story root with `display:flex` would ignore `hidden`).
 * The script marks toggle targets with `data-kit-target`.
 */
const BEHAVIOURS_CSS =
  "\n[data-kit-panel][hidden],[data-kit-state][hidden],[data-kit-target][hidden]{display:none !important}";

/** --show-new outlines behaviour triggers too, in a second colour. */
const SHOW_TRIGGERS_CSS =
  "\n[data-kit-toggle],[data-kit-tab],[data-kit-set]{outline:2px dashed #0090ff !important;outline-offset:2px}";

/**
 * The behaviour layer compose inlines once, at the end of the body, when the
 * page uses one of BEHAVIOUR_ATTRS. Plain DOM, no network and no storage, so
 * it runs in a `sandbox="allow-scripts"` frame with an opaque origin.
 *
 * - `data-kit-toggle="<id>"`: a click shows or hides the element with that
 *   id and sets `aria-expanded` on its triggers; a click outside it, or Esc,
 *   closes what a toggle opened.
 * - `data-kit-tabs` holds `[data-kit-tab="<name>"]` triggers and
 *   `[data-kit-panel="<name>"]` panels; a click shows its panel, hides the
 *   others and sets `aria-selected`.
 * - `data-kit-set="<group>:<name>"` shows every `[data-kit-state]` of the
 *   group in that state and hides the rest of the group.
 * - `data-kit-after="<ms>:<state>"` (or `"<ms>:<group>:<state>"`) on a
 *   `[data-kit-state]` element schedules a transition after `<ms>` ms
 *   (clamped to 50–10000 ms) whenever that state is entered by a user
 *   action or chained timer, never on initial page boot.
 *
 * A trigger that already has `data-state` (Radix-style markup) gets
 * open/closed or active/inactive there as well, so its captured styling
 * follows. Triggers that are not focusable get `tabindex="0"`, and Enter or
 * Space clicks them.
 */
const BEHAVIOURS_JS = `(function () {
  "use strict";
  if (window.__designKitBehaviours) return;
  window.__designKitBehaviours = true;
  var doc = document;
  var TRIGGERS = "[data-kit-toggle],[data-kit-tab],[data-kit-set]";
  var NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
  var opened = [];
  function list(selector, root) {
    return Array.prototype.slice.call((root || doc).querySelectorAll(selector));
  }
  function show(el, on) {
    if (on) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "");
  }
  function pair(value) {
    var at = (value || "").indexOf(":");
    return at > 0 ? [value.slice(0, at), value.slice(at + 1)] : null;
  }
  function mirror(el, value) {
    if (el.hasAttribute("data-state")) el.setAttribute("data-state", value);
  }
  function focusable(el) {
    if (NATIVE.test(el.tagName) || el.hasAttribute("tabindex")) return;
    el.setAttribute("tabindex", "0");
    if (!el.hasAttribute("role")) {
      el.setAttribute("role", el.hasAttribute("data-kit-tab") ? "tab" : "button");
    }
  }

  function triggersOf(id) {
    return list("[data-kit-toggle]").filter(function (t) {
      return t.getAttribute("data-kit-toggle") === id;
    });
  }
  function setOpen(target, open) {
    show(target, open);
    triggersOf(target.id).forEach(function (t) {
      t.setAttribute("aria-expanded", open ? "true" : "false");
      mirror(t, open ? "open" : "closed");
    });
    var at = opened.indexOf(target);
    if (open && at < 0) opened.push(target);
    if (!open && at >= 0) opened.splice(at, 1);
  }
  function closeOpened(clicked) {
    opened.slice().forEach(function (target) {
      var inside =
        clicked &&
        (target.contains(clicked) ||
          triggersOf(target.id).some(function (t) {
            return t.contains(clicked);
          }));
      if (!inside) setOpen(target, false);
    });
  }

  function own(box, selector) {
    return list(selector, box).filter(function (el) {
      return el.closest("[data-kit-tabs]") === box;
    });
  }
  function selectTab(box, name) {
    own(box, "[data-kit-tab]").forEach(function (t) {
      var on = t.getAttribute("data-kit-tab") === name;
      t.setAttribute("aria-selected", on ? "true" : "false");
      mirror(t, on ? "active" : "inactive");
    });
    own(box, "[data-kit-panel]").forEach(function (p) {
      var on = p.getAttribute("data-kit-panel") === name;
      show(p, on);
      mirror(p, on ? "active" : "inactive");
    });
  }

  var timers = Object.create(null);
  function parseAfter(value, defaultGroup) {
    if (!value) return null;
    var first = value.indexOf(":");
    if (first <= 0) return null;
    var msStr = value.slice(0, first).trim();
    if (!/^\\d+$/.test(msStr)) return null;
    var rest = value.slice(first + 1);
    if (!rest) return null;
    var second = rest.indexOf(":");
    var targetGroup = second < 0 ? defaultGroup : rest.slice(0, second);
    var targetName = second < 0 ? rest : rest.slice(second + 1);
    if (!targetGroup || !targetName) return null;
    var delay = Math.min(10000, Math.max(50, parseInt(msStr, 10)));
    return { delay: delay, group: targetGroup, name: targetName };
  }
  function setState(group, name, allowAfter) {
    if (timers[group]) {
      clearTimeout(timers[group]);
      delete timers[group];
    }
    var next = null;
    list("[data-kit-state]").forEach(function (el) {
      var state = pair(el.getAttribute("data-kit-state"));
      if (state && state[0] === group) {
        var on = state[1] === name;
        show(el, on);
        if (on && allowAfter && !next && el.hasAttribute("data-kit-after")) {
          next = parseAfter(el.getAttribute("data-kit-after"), group);
        }
      }
    });
    if (next) {
      timers[group] = setTimeout(function () {
        delete timers[group];
        setState(next.group, next.name, true);
      }, next.delay);
    }
  }

  list("[data-kit-toggle]").forEach(function (t) {
    focusable(t);
    var target = doc.getElementById(t.getAttribute("data-kit-toggle"));
    if (!target) return;
    target.setAttribute("data-kit-target", "");
    t.setAttribute("aria-controls", target.id);
    t.setAttribute("aria-expanded", target.hasAttribute("hidden") ? "false" : "true");
  });
  list("[data-kit-tabs]").forEach(function (box) {
    var tabs = own(box, "[data-kit-tab]");
    if (!tabs.length) return;
    tabs.forEach(focusable);
    var current = tabs.filter(function (t) {
      return t.getAttribute("aria-selected") === "true" || t.getAttribute("data-state") === "active";
    })[0] || tabs[0];
    selectTab(box, current.getAttribute("data-kit-tab"));
  });
  // Each group starts in the state of its first visible element.
  var groups = Object.create(null);
  list("[data-kit-state]").forEach(function (el) {
    var state = pair(el.getAttribute("data-kit-state"));
    if (state && !(state[0] in groups) && !el.hasAttribute("hidden")) groups[state[0]] = state[1];
  });
  Object.keys(groups).forEach(function (group) {
    setState(group, groups[group], false);
  });
  list("[data-kit-set]").forEach(focusable);

  doc.addEventListener("click", function (event) {
    var el = event.target;
    if (!el || !el.closest) return;
    closeOpened(el);
    var trigger = el.closest(TRIGGERS);
    if (!trigger) return;
    // A link or button in a trigger (a captured story's own links) would
    // navigate the mockup away or submit; the click only switches state.
    var control = el.closest("a,button");
    if (control && trigger.contains(control)) event.preventDefault();
    var state = pair(trigger.getAttribute("data-kit-set"));
    if (state) setState(state[0], state[1], true);
    var box = trigger.hasAttribute("data-kit-tab") && trigger.closest("[data-kit-tabs]");
    if (box) selectTab(box, trigger.getAttribute("data-kit-tab"));
    if (trigger.hasAttribute("data-kit-toggle")) {
      var target = doc.getElementById(trigger.getAttribute("data-kit-toggle"));
      if (target) setOpen(target, target.hasAttribute("hidden"));
    }
  });
  doc.addEventListener("keydown", function (event) {
    var el = event.target;
    if (event.key === "Escape" && opened.length) {
      var back = triggersOf(opened[opened.length - 1].id)[0];
      closeOpened(null);
      if (back && back.focus) back.focus();
      return;
    }
    if (
      (event.key === "Enter" || event.key === " ") &&
      el && el.matches && el.matches(TRIGGERS) && !NATIVE.test(el.tagName)
    ) {
      event.preventDefault();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
  });
})();`;

/**
 * The author's own inline scripts in a slot fragment, held out of compose:
 * each becomes a comment placeholder carrying `key` (random per compose, so
 * kit markup cannot name one) before snippets expand and the sanitizer runs,
 * and comes back after. A script with `src`, `href` or `xlink:href` stays in
 * place for the sanitizer to drop, as does an unterminated one and an earlier
 * compose's behaviour script (compose inlines a fresh one). Only `type` and
 * `id` are kept on the tag.
 */
function holdAuthorScripts(content, key, held) {
  if (!/<script/i.test(content)) return content;
  const tokens = tokenize(content);
  let out = "";
  let i = 0;
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];
    if (token.type !== "open" || token.name !== "script" || token.selfClosing)
      continue;
    let close = t + 1;
    if (tokens[close]?.type === "text") close += 1;
    if (tokens[close]?.type !== "close" || tokens[close].name !== "script")
      continue;
    t = close;
    const attrs = token.attrs;
    if (
      ["src", "href", "xlink:href", "data-kit-behaviours"].some((name) =>
        Object.hasOwn(attrs, name),
      )
    )
      continue;
    const kept = ["type", "id"]
      .filter((name) => Object.hasOwn(attrs, name))
      .map((name) => ` ${name}="${escapeAttr(decodeEntities(attrs[name]))}"`)
      .join("");
    out += `${content.slice(i, token.start)}<!--kit-author-script ${key} ${held.length}-->`;
    held.push(
      `<script${kept}>${content.slice(token.end, tokens[close].start)}</script>`,
    );
    i = tokens[close].end;
  }
  return out + content.slice(i);
}

/** Each held script back in its placeholder's place, once. */
function restoreAuthorScripts(html, key, held) {
  if (!held.length) return html;
  const placed = new Set();
  return html.replace(
    new RegExp(`<!--kit-author-script ${key} (\\d+)-->`, "g"),
    (_, n) => {
      const index = Number(n);
      if (placed.has(index) || index >= held.length) return "";
      placed.add(index);
      return held[index];
    },
  );
}

// ── CSS pruning ─────────────────────────────────────────────────────────────
//
// A composed page carries the kit's whole stylesheets, megabytes of rules for
// classes the page never names. compose keeps only the rules a page can use:
// a style rule goes only when every selector in its list needs a class or id
// the page lacks, and of rules repeated in the same at-rule context only the
// last stays (it is the one the cascade uses). Everything else (@font-face,
// @keyframes, @property, rules with no class or id) stays as written.

/** At-rules whose blocks hold rules that are pruned like the top level. */
const CSS_WRAPPERS = new Set([
  "media",
  "supports",
  "layer",
  "container",
  "scope",
]);

const CSS_IDENT_CHAR = /[A-Za-z0-9_\-\u0080-￿]/;

/**
 * Where the CSS token at `i` ends when it is one whose characters never count
 * as structure (an escape, a comment, a string or an unquoted `url(…)`);
 * otherwise -1.
 */
function cssSkip(css, i) {
  const ch = css[i];
  if (ch === "\\") return Math.min(i + 2, css.length);
  if (ch === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if (ch === '"' || ch === "'") {
    let j = i + 1;
    while (j < css.length) {
      const c = css[j];
      if (c === "\\") j += 2;
      else if (c === ch) return j + 1;
      // An unterminated string ends at the line's end, as the browser reads it.
      else if (c === "\n") return j;
      else j += 1;
    }
    return css.length;
  }
  if (
    (ch === "u" || ch === "U") &&
    (i === 0 || !CSS_IDENT_CHAR.test(css[i - 1])) &&
    /^url\(\s*[^\s"')]/i.test(css.slice(i, i + 64))
  ) {
    let j = css.indexOf("(", i) + 1;
    while (j < css.length && css[j] !== ")") j += css[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, css.length);
  }
  return -1;
}

/** The first `{`, `;` or `}` outside brackets from `i`, or `end`. */
function cssPreludeEnd(css, i, end) {
  let nested = 0;
  while (i < end) {
    const skip = cssSkip(css, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const ch = css[i];
    if (ch === "(" || ch === "[") nested += 1;
    else if ((ch === ")" || ch === "]") && nested > 0) nested -= 1;
    else if (!nested && (ch === "{" || ch === ";" || ch === "}")) return i;
    i += 1;
  }
  return end;
}

/** Just past the `}` that closes the block opening at `open`, or -1. */
function cssBlockEnd(css, open, end) {
  let depth = 0;
  let i = open;
  while (i < end) {
    const skip = cssSkip(css, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}" && --depth === 0) return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * A list of rules as nodes: `rule` (a style rule, kept or dropped whole),
 * `wrapper` (an at-rule from CSS_WRAPPERS, pruned inside) and `keep`
 * (everything else, written back as it was). Comments between rules go.
 */
function parseCssList(css, start, end) {
  const nodes = [];
  let i = start;
  while (i < end) {
    const ch = css[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      i = cssSkip(css, i);
      continue;
    }
    const stop = cssPreludeEnd(css, i, end);
    if (stop >= end || css[stop] !== "{") {
      // A statement (`@layer a, b;`) or junk the browser skips: as written.
      const through = Math.min(stop + 1, end);
      nodes.push({ type: "keep", text: css.slice(i, through) });
      i = through;
      continue;
    }
    const closedAt = cssBlockEnd(css, stop, end);
    const closed = closedAt >= 0;
    const blockEnd = closed ? closedAt : end;
    const prelude = css.slice(i, stop);
    const atRule = /^@([A-Za-z-]+)/.exec(prelude);
    const name = atRule?.[1].toLowerCase();
    if (name && CSS_WRAPPERS.has(name)) {
      const layerName = prelude.slice(atRule[0].length).trim();
      nodes.push({
        type: "wrapper",
        head: css.slice(i, stop + 1),
        // A named layer's first block sets the layer order, so even an
        // emptied one stays; each unnamed layer is a layer of its own.
        named: name === "layer" && layerName !== "",
        anonymous: name === "layer" && layerName === "",
        children: parseCssList(css, stop + 1, closed ? blockEnd - 1 : blockEnd),
      });
    } else if (name) {
      nodes.push({ type: "keep", text: css.slice(i, blockEnd) });
    } else {
      nodes.push({ type: "rule", prelude, text: css.slice(i, blockEnd) });
    }
    i = blockEnd;
  }
  return nodes;
}

/**
 * A rule's text with comments gone and whitespace outside strings collapsed,
 * so the same rule written by two sheets compares equal.
 */
function cssKey(text) {
  let out = "";
  // Whether `out` ends in an escape, string or url(): its last character is
  // then not the punctuation it looks like (`.\\{ .a` keeps its space).
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const skip = cssSkip(text, i);
    if (skip >= 0) {
      if (text[i] !== "/") {
        out += text.slice(i, skip);
        quoted = true;
      }
      i = skip;
      continue;
    }
    if (/\s/.test(text[i])) {
      while (i < text.length && /\s/.test(text[i])) i += 1;
      const afterPunctuation = !quoted && /[{};,]$/.test(out);
      if (!afterPunctuation && !/^[{};,]/.test(text[i] ?? "")) out += " ";
      continue;
    }
    out += text[i];
    quoted = false;
    i += 1;
  }
  return out.trim();
}

/** The parts of a selector list, split on commas outside brackets. */
function selectorParts(prelude) {
  const parts = [];
  let nested = 0;
  let from = 0;
  let i = 0;
  while (i < prelude.length) {
    const skip = cssSkip(prelude, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const ch = prelude[i];
    if (ch === "(" || ch === "[") nested += 1;
    else if ((ch === ")" || ch === "]") && nested > 0) nested -= 1;
    else if (ch === "," && !nested) {
      parts.push(prelude.slice(from, i));
      from = i + 1;
    }
    i += 1;
  }
  parts.push(prelude.slice(from));
  return parts;
}

/** Just past the bracket closing the one at `i`. */
function closeBracket(text, i) {
  let depth = 0;
  while (i < text.length) {
    const skip = cssSkip(text, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const ch = text[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if ((ch === ")" || ch === "]") && --depth === 0) return i + 1;
    i += 1;
  }
  return text.length;
}

/** The identifier at `i`, escapes resolved, and where it ends. */
function readCssIdent(text, i) {
  let j = i;
  while (j < text.length) {
    if (text[j] === "\\" && j + 1 < text.length && text[j + 1] !== "\n") {
      const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(text.slice(j + 1, j + 8));
      j += 1 + (hex ? hex[0].length : 1);
    } else if (CSS_IDENT_CHAR.test(text[j])) j += 1;
    else break;
  }
  return [unescapeCss(text.slice(i, j)), j];
}

/**
 * Whether one selector can match on the page: every class and id it needs is
 * there. Attribute parts and the arguments of functional pseudo-classes and
 * pseudo-elements (`:is`, `:where`, `:has`, `:not`, `::part`, …) never count.
 */
function selectorCanMatch(selector, names) {
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "[" || ch === "(") {
      i = closeBracket(selector, i);
      continue;
    }
    const skip = cssSkip(selector, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    if (ch === "." || ch === "#") {
      const [name, next] = readCssIdent(selector, i + 1);
      if (name && !names.has(name)) return false;
      i = Math.max(next, i + 1);
      continue;
    }
    if (CSS_IDENT_CHAR.test(ch)) {
      // A tag name or pseudo name: read whole, so a `.` cannot start inside.
      i = readCssIdent(selector, i)[1];
      continue;
    }
    i += 1;
  }
  return true;
}

/**
 * Kept rules as text, last-first so the last copy of a repeated rule is the
 * one kept. `context` names the at-rules around them; `seen` is shared.
 */
function prunedCss(nodes, names, context, seen, counter) {
  const out = [];
  for (let n = nodes.length - 1; n >= 0; n -= 1) {
    const node = nodes[n];
    if (node.type === "rule") {
      if (
        !selectorParts(node.prelude).some((part) =>
          selectorCanMatch(part, names),
        )
      )
        continue;
      const key = `${context}\u0000${cssKey(node.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(node.text);
    } else if (node.type === "wrapper") {
      const inner = prunedCss(
        node.children,
        names,
        `${context}\u0001${cssKey(node.head)}${node.anonymous ? `#${(counter.n += 1)}` : ""}`,
        seen,
        counter,
      );
      if (!inner.length && !node.named) continue;
      out.push(`${node.head}\n${inner.join("\n")}\n}`);
    } else {
      out.push(node.text);
    }
  }
  return out.reverse();
}

/**
 * The stylesheet with every style rule no element can match removed and
 * repeated rules written once (see the section comment). `names` holds every
 * class and id the page can have.
 */
export function pruneCss(css, names) {
  return prunedCss(parseCssList(css, 0, css.length), names, "", new Set(), {
    n: 0,
  }).join("\n");
}

/**
 * Every class and id a composed page can show: those on its elements (hidden
 * ones and <template> content included), every word in the author's own
 * scripts (one may add a class), and the theme classes.
 */
function pageNames(elementList, scripts, theme) {
  const names = new Set(["dark", "light"]);
  if (theme.attribute === "class") {
    for (const value of [theme.dark, theme.light]) if (value) names.add(value);
  }
  for (const element of elementList) {
    const { class: classes, id } = element.attrs;
    if (classes) {
      for (const name of decodeEntities(classes).split(/[\t\n\f\r ]+/)) {
        if (name) names.add(name);
      }
    }
    if (id) names.add(decodeEntities(id));
  }
  for (const script of scripts) {
    for (const word of script.split(/[\s"'`]+/)) {
      if (!word) continue;
      names.add(word);
      names.add(word.replace(/^[.#]+/, ""));
    }
  }
  return names;
}

// ── compose ─────────────────────────────────────────────────────────────────

/**
 * `data-kit-snippet="<id>"` on each top-level element of a snippet's markup,
 * so the composed page records which real piece every part came from. A
 * nested `<kit-snippet>` at the top is left alone: its own expansion stamps
 * the elements that replace it.
 */
function stampSnippetRoots(html, id, carried = "") {
  let out = "";
  let i = 0;
  for (const root of elements(html)) {
    if (root.depth !== 0) continue;
    const stamp =
      root.name !== "kit-snippet" && !("data-kit-snippet" in root.attrs)
        ? ` data-kit-snippet="${escapeAttr(id)}"`
        : "";
    if (!stamp && !carried) continue;
    const at = root.start + 1 + root.name.length;
    out += `${html.slice(i, at)}${stamp}${carried}`;
    i = at;
  }
  return out + html.slice(i);
}

/**
 * The behaviour attributes a `<kit-snippet>` passes on to the top-level
 * elements of the markup it expands to, so a captured story can be one state
 * of a group (`data-kit-state`), a trigger, a tab or a panel. They go first
 * in the tag, so they win over any the captured element already has.
 */
const CARRIED_ATTRS = ["hidden", ...BEHAVIOUR_ATTRS];

function carriedAttributes(attrs) {
  return CARRIED_ATTRS.filter((name) => Object.hasOwn(attrs, name))
    .map((name) => ` ${name}="${escapeAttr(decodeEntities(attrs[name]))}"`)
    .join("");
}

function expandSnippets(kit, html, used, budget, depth = 0, ids = []) {
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
    if (!ids.includes(row.id)) ids.push(row.id);
    out +=
      html.slice(i, element.start) +
      expandSnippets(
        kit,
        stampSnippetRoots(markup, row.id, carriedAttributes(element.attrs)),
        used,
        budget,
        depth + 1,
        ids,
      );
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

/** The parts of a route row a theme variant replaces (capture-pages.mjs). */
const THEME_VARIANT_FIELDS = [
  "file",
  "bytes",
  "slots",
  "body_class",
  "html_attrs",
  "body_attrs",
];

/**
 * The capture a compose in `theme` uses. A frame whose source captured each
 * theme (`theme_switch: "capture"`) is never re-themed by class: `theme`
 * picks its capture in that theme (`row.theme`, or `row.variants[theme]`),
 * and without one the frame's own capture is used as captured, with a
 * `warning` saying so. Any other frame (`switch: true`) has its theme class
 * toggled, as before. No `theme` keeps the frame's own capture.
 */
export function themedFrame(row, theme) {
  if (row?.theme_switch !== "capture") return { row, switch: true };
  const own = row.theme === "dark" ? "dark" : "light";
  if (theme === undefined || theme === own) return { row, switch: false };
  const variant = row.variants?.[theme];
  if (
    variant &&
    typeof variant === "object" &&
    typeof variant.file === "string" &&
    /^html\/[^/]+\.html$/.test(variant.file)
  ) {
    const picked = { ...row, theme };
    for (const key of THEME_VARIANT_FIELDS)
      if (key in variant) picked[key] = variant[key];
    return { row: picked, switch: false };
  }
  return {
    row,
    switch: false,
    warning: `${row.id} has no ${theme} capture in this kit; composed its ${own} capture unchanged (no theme class added). Compose --theme ${own}, or fetch a newer kit.`,
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
 * from) inlined with fonts as data URIs, and no remote URLs. Only the rules
 * the page's classes and ids can use are kept, each once (see pruneCss);
 * `css: "full"` keeps every rule. The only
 * scripts are the inline ones the slot fragments brought and, when the page
 * uses a behaviour attribute, the behaviour layer; nothing executable from
 * the kit's own markup survives.
 */
export function compose(
  kit,
  {
    frame,
    slots = [],
    theme,
    showNew = false,
    maxBytes = COMPOSE_MAX_BYTES,
    css: cssMode = "pruned",
    warn = () => {},
  },
) {
  const found = requireRow(kit, frame, "frame");
  if (theme !== undefined && theme !== "light" && theme !== "dark") {
    throw new KitError(`unknown theme "${theme}". Use light or dark.`);
  }
  const picked = themedFrame(found, theme);
  const row = picked.row;
  if (picked.warning) warn(picked.warning);
  if (cssMode !== "pruned" && cssMode !== "full") {
    throw new KitError(`unknown css "${cssMode}". Use pruned or full.`);
  }
  const used = new Set([rowCssFile(kit, row)]);
  // The author's inline scripts sit out the sanitizer; everything else in
  // the fragments (handlers, remote scripts, snippets) goes through it.
  const scriptKey = randomBytes(16).toString("hex");
  const heldScripts = [];
  const authored = Array.isArray(slots)
    ? slots.map((slot) => ({
        ...slot,
        content: holdAuthorScripts(slot.content, scriptKey, heldScripts),
      }))
    : slots;
  const filled = fillSlots(kit, row, readSnippet(kit, row), authored);
  const snippetIds = [];
  const sanitized = sanitizeMarkup(
    expandSnippets(
      kit,
      filled,
      used,
      { left: maxBytes - filled.length, max: maxBytes },
      0,
      snippetIds,
    ),
  );
  const bodyElements = elements(sanitized);
  const behaves = bodyElements.some((e) =>
    BEHAVIOUR_ATTRS.some((name) => Object.hasOwn(e.attrs, name)),
  );
  const body = restoreAuthorScripts(sanitized, scriptKey, heldScripts);

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
  const showNewCss =
    (showNew
      ? "\n[data-kit-new]{outline:2px dashed #e5484d !important;outline-offset:2px}"
      : "") +
    (behaves ? BEHAVIOURS_CSS : "") +
    (showNew && behaves ? SHOW_TRIGGERS_CSS : "");
  const behaviourScript = behaves
    ? `<script data-kit-behaviours>\n${BEHAVIOURS_JS}\n</script>\n`
    : "";

  // A frame captured in each theme keeps its capture's attributes: no
  // target gets a theme class, so nothing re-themes half the page.
  const kitSwitch = kitTheme(kit.manifest);
  const switcher = picked.switch ? kitSwitch : { ...kitSwitch, targets: [] };
  const choice = theme ?? "light";
  const sha = kit.manifest?.sha ?? "unknown";
  const htmlAttrs = attributes(row.html_attrs, "", switcher, choice, "html", {
    "data-kit-sha": sha,
    "data-kit-id": frame,
    lang: row.html_attrs?.lang ?? "en",
  });
  const bodyAttrs = attributes(
    row.body_attrs,
    row.body_class,
    switcher,
    choice,
    "body",
    {},
  );
  // The kit's CSS, cut to the rules this page's classes and ids can use
  // (`css: "full"` keeps every rule).
  const safeCss = sanitizeCss(css);
  const pageCss =
    cssMode === "full"
      ? safeCss
      : pruneCss(
          safeCss,
          pageNames(
            [
              ...bodyElements,
              ...elements(`<html${htmlAttrs}><body${bodyAttrs}>`),
            ],
            heldScripts,
            switcher,
          ),
        );
  // What this page used, for whoever wants to count it later. Recorded in
  // the page only; kit.mjs never sends it anywhere.
  const usage = {
    kit_sha: sha,
    frame,
    snippets: snippetIds,
    new_parts: bodyElements.filter((e) => "data-kit-new" in e.attrs).length,
  };
  const page = `<!doctype html>
<html${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="design-kit-usage" content="${escapeAttr(JSON.stringify(usage))}">
<title>${escapeAttr(row.title ?? frame)}</title>
<style>
${pageCss}${showNewCss}
</style>
</head>
<body${bodyAttrs}>
${body}
${behaviourScript}</body>
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

/**
 * An id attribute a library or React generated (`radix-…`, React's `useId`
 * values as the capture renumbers them): it changes between builds and says
 * nothing about the element, so the outline leaves it out.
 */
const GENERATED_ID = /^radix-|_r_?[0-9a-z]+_|_k\d+_|:r[0-9a-z]+:/;

/** One outline line per element down to depth 4, with its depth. */
function outlineEntries(html) {
  const entries = [];
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
      .filter((name) => name !== "id" || !GENERATED_ID.test(element.attrs.id))
      .map((name) => `[${name}=${element.attrs[name].slice(0, 40)}]`)
      .join("");
    const text = element.text.replace(/\s+/g, " ").trim().slice(0, 40);
    entries.push({
      depth: element.depth,
      line: `${"  ".repeat(element.depth)}<${element.name}${classes}${marks}>${text ? ` "${text}"` : ""}`,
    });
  }
  return entries;
}

/**
 * Runs of identical siblings, each with the lines nested under it, printed
 * once with `×N` after the first line.
 */
function collapseRuns(entries) {
  // ends[i]: the index after the last line nested under line i.
  const ends = new Array(entries.length).fill(entries.length);
  const open = [];
  entries.forEach((entry, i) => {
    while (open.length && entries[open.at(-1)].depth >= entry.depth)
      ends[open.pop()] = i;
    open.push(i);
  });
  const same = (a, b, length) => {
    for (let k = 0; k < length; k += 1)
      if (entries[a + k].line !== entries[b + k].line) return false;
    return true;
  };
  const lines = [];
  const walk = (from, to) => {
    let i = from;
    while (i < to) {
      const length = ends[i] - i;
      let next = ends[i];
      let count = 1;
      while (
        next < to &&
        entries[next].depth === entries[i].depth &&
        ends[next] - next === length &&
        same(i, next, length)
      ) {
        count += 1;
        next = ends[next];
      }
      lines.push(`${entries[i].line}${count > 1 ? ` ×${count}` : ""}`);
      walk(i + 1, ends[i]);
      i = next;
    }
  };
  walk(0, entries.length);
  return lines;
}

/**
 * A markup outline of at most `limit` bytes: one line per element down to
 * depth 4, identical sibling runs collapsed to one line with `×N`, and
 * generated ids left out.
 */
export function outline(html, limit = SHOW_LIMIT) {
  const lines = [];
  let size = 0;
  let truncated = false;
  for (const line of collapseRuns(outlineEntries(html))) {
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

/** Letters and digits only, lowercased: how a title can restate an id. */
function flat(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `story:x@1280` → `story:x`: the id without its width. */
function baseId(id) {
  return id.replace(/@\d+$/, "");
}

/** The width an id ends in, as written. */
function idWidth(id) {
  return /@(\d+)$/.exec(id)?.[1] ?? null;
}

/** Sizes of a width group: `131/136 KB`, `443 B/1.2 KB`, or `4.9 KB` when they print the same. */
function groupBytes(rows) {
  const sizes = rows.map((row) => row.bytes ?? 0);
  const kb = (bytes) =>
    bytes >= 10 * 1024
      ? `${Math.round(bytes / 1024)}`
      : `${(bytes / 1024).toFixed(1)}`;
  // Widths that print the same size print it once.
  const once = (values) => [...new Set(values)].join("/");
  if (sizes.every((bytes) => bytes >= 1024)) return `${once(sizes.map(kb))} KB`;
  return once(
    sizes.map((bytes) => (bytes >= 1024 ? `${kb(bytes)} KB` : `${bytes} B`)),
  );
}

/**
 * Matches gathered into lines: rows that differ only by `@<width>` and found
 * the same way (the same excerpt, or none) share one line, at the place of
 * the first of them.
 */
function widthGroups(matches) {
  const groups = new Map();
  for (const match of matches) {
    // An id without a width never shares a line.
    const id = match.row.id;
    const key = `${idWidth(id) ? baseId(id) : `${id}\0`}\0${match.excerpt ?? ""}`;
    const group = groups.get(key);
    if (group) group.rows.push(match.row);
    else groups.set(key, { rows: [match.row], excerpt: match.excerpt });
  }
  return [...groups.values()];
}

/** One find line: id (with its widths), sizes, title unless it restates the id, excerpt. */
function groupLine({ rows, excerpt: cut }) {
  const base = baseId(rows[0].id);
  const widths = rows.map((row) => idWidth(row.id));
  const id = rows.length === 1 ? rows[0].id : `${base}@{${widths.join(",")}}`;
  const name = flat(base.replace(/^[a-z]+:/, ""));
  const titles = [];
  for (const row of rows) {
    const title = (row.title ?? "").replace(/\s*\(\d+\)$/, "").trim();
    if (title && flat(title) !== name && !titles.includes(title))
      titles.push(title);
  }
  return [
    id,
    groupBytes(rows),
    ...(titles.length ? [titles.join(" | ")] : []),
    ...(cut === undefined ? [] : [`"${cut}"`]),
  ].join("  ");
}

/**
 * `kit find`'s lines for `findMatches` results, at most FIND_LIMIT: rows that
 * differ only by width share a line (`route:x@{1280,390}`), a title that only
 * restates the id is left out, and a last line counts the rows not shown.
 * Rows found by name come first, but a few lines are kept for rows found only
 * by their on-screen text.
 */
export function findMatchLines(matches) {
  const count = (groups) =>
    groups.reduce((sum, group) => sum + group.rows.length, 0);
  // A row with an excerpt was found by on-screen text; any other, by name.
  const byName = widthGroups(
    matches.filter((match) => match.excerpt === undefined),
  );
  const byText = widthGroups(
    matches.filter((match) => match.excerpt !== undefined),
  );
  // Keep the order findMatches ranked them in when everything fits.
  if (byName.length + byText.length <= FIND_LIMIT)
    return widthGroups(matches).map(groupLine);
  const room = FIND_LIMIT - 1;
  if (!byText.length) {
    return [
      ...byName.slice(0, room).map(groupLine),
      `… ${count(byName.slice(room))} more; add a word to narrow it`,
    ];
  }
  // Names fill the list first, but the last lines are kept for text hits,
  // so an agent sees them even when names alone would fill it.
  const textRoom = Math.min(
    byText.length,
    Math.max(FIND_TEXT_LINES, room - byName.length),
  );
  const names = byName.slice(0, room - textRoom);
  const texts = byText.slice(0, room - names.length);
  const left = [
    ...(byName.length > names.length
      ? [`+${count(byName.slice(names.length))} more by name`]
      : []),
    ...(byText.length > texts.length
      ? [`+${count(byText.slice(texts.length))} more by on-screen text`]
      : []),
  ];
  return [
    ...names.map(groupLine),
    ...texts.map(groupLine),
    `${left.join(", ")}; narrow the query`,
  ];
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
  return findMatchLines(matches);
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
    ...(row.theme_switch === "capture"
      ? [
          `themes: ${[row.theme ?? "light", ...Object.keys(row.variants ?? {})].join(", ")} (captured; compose --theme picks one)`,
        ]
      : []),
    "outline:",
  ].join("\n");
  const tail = "… (outline cut; --full prints the markup)";
  const { lines, truncated } = outline(
    html,
    SHOW_LIMIT - Buffer.byteLength(head) - Buffer.byteLength(tail) - 2,
  );
  return [head, ...lines, ...(truncated ? [tail] : [])].join("\n");
}

/** gaps.json's ids: the frames a capture failed on. */
function failedIds(dir) {
  try {
    const gaps = JSON.parse(readFileSync(join(dir, "gaps.json"), "utf8"));
    if (!Array.isArray(gaps)) return [];
    return gaps.map((gap) => gap?.id).filter((id) => typeof id === "string");
  } catch {
    // Optional: info prints the count without the ids.
    return [];
  }
}

/**
 * The kit's one-line summary: `sha7 built <iso> · stories N · routes N ·
 * failed N`, with the failed ids when there are five or fewer. `kit info`
 * prints it, and so does `design-kit fetch` after `path=`.
 */
export function kitSummaryLine(kit) {
  const manifest = kit.manifest ?? {};
  const routes = kit.rows.filter((row) => rowSource(row) === "routes").length;
  const sha = typeof manifest.sha === "string" ? manifest.sha.slice(0, 7) : "";
  const built =
    typeof manifest.built_at === "string" ? `built ${manifest.built_at}` : "";
  const ids = failedIds(kit.dir);
  const counted = manifest.counts?.failed;
  const failed = typeof counted === "number" ? counted : ids.length;
  const head = kit.manifest
    ? [sha, built].filter(Boolean).join(" ") || "manifest.json"
    : "no manifest.json";
  return [
    head,
    `stories ${kit.rows.length - routes}`,
    `routes ${routes}`,
    `failed ${failed}${failed > 0 && failed <= 5 && ids.length ? ` (${ids.join(", ")})` : ""}`,
  ].join(" · ");
}

/** `info`: the summary line; `json` prints manifest.json. */
function infoText(kit, json) {
  if (json)
    return JSON.stringify(
      kit.manifest ?? { missing: "manifest.json" },
      null,
      2,
    );
  return kitSummaryLine(kit);
}

// ── figure ──────────────────────────────────────────────────────────────────

/** Image types `figure` embeds, by file extension. */
const FIGURE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** Above this many image bytes `figure` warns: the page carries them all. */
export const FIGURE_WARN_BYTES = 1024 * 1024;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A figure's link: a fragment or relative link, never a scheme. */
function checkFigureHref(href) {
  if (
    href !== undefined &&
    (!href || !isSafeUrl(href) || /^data:/i.test(href.trim()))
  )
    throw new KitError(
      `--href ${href}: use a fragment such as '#cp-page:<key>' or a relative link`,
    );
}

/**
 * A self-contained `<figure>`: the image as a data URI, inside a link when
 * `href` is given, with an escaped caption. `href` must be a fragment or a
 * relative link (`#cp-page:<key>` links plan pages); `width` is CSS pixels.
 */
export function figureHtml({ image, type, href, caption, alt, width }) {
  checkFigureHref(href);
  let style = "max-width:100%;height:auto;display:block";
  if (width !== undefined) {
    const px = Number(width);
    if (!(Number.isFinite(px) && px > 0))
      throw new KitError(
        `--width ${width}: use a positive number of CSS pixels`,
      );
    style = `width:${px}px;${style}`;
  }
  const src = `data:${type};base64,${image.toString("base64")}`;
  let img = `<img src="${src}" alt="${escapeHtml(alt ?? caption ?? "")}" style="${style}">`;
  if (href !== undefined) img = `<a href="${escapeHtml(href)}">${img}</a>`;
  const figcaption =
    caption === undefined
      ? ""
      : `\n  <figcaption>${escapeHtml(caption)}</figcaption>`;
  return `<figure style="margin:0">\n  ${img}${figcaption}\n</figure>\n`;
}

// ── figure --page ───────────────────────────────────────────────────────────
// A composed page shown in a plan page as itself, scaled: its markup and CSS
// in a declarative shadow root, not an iframe (plan pages allow no nested
// frames). Inside a shadow root `:root`, `html` and `body` match nothing and
// the plan page's inherited styles flow in, so the page's <html> and <body>
// become elements of their own and its selectors follow them.

/** Design width when neither --width nor the page's data-kit-id says. */
export const FIGURE_PAGE_WIDTH = 1280;
/** Displayed width by default. */
export const FIGURE_PAGE_FIT = 640;
/** Default crop: height = width × this (16:10). */
const FIGURE_PAGE_RATIO = 0.625;
/** Elements dropped with their content besides what sanitizeMarkup drops. */
const PAGE_DROPPED = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
]);
const PAGE_ATTR = /^(?:class|style|lang|dir|id|data-[a-z0-9-]+)$/;
const VIEWPORT_UNIT =
  /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(s|l|d)?(vh|vw|vmin|vmax|vb|vi)(?![A-Za-z0-9_-])/i;

function positivePx(name, value, fallback) {
  if (value === undefined) return fallback;
  const px = Number(value);
  if (!(Number.isFinite(px) && px > 0))
    throw new KitError(`${name} ${value}: use a positive number of CSS pixels`);
  return px;
}

function px(value) {
  return `${Number(value.toFixed(4))}px`;
}

/** Viewport units as pixels of the design box; strings and url()s untouched. */
export function viewportToPixels(css, width, height) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "\\" || css[i] === "[") {
      // An escape continues an identifier (`.h-\[100dvh\]` is a class
      // name), and an attribute selector's value is no length.
      const end =
        css[i] === "[" ? closeBracket(css, i) : readCssIdent(css, i)[1];
      out += css.slice(i, Math.max(end, i + 1));
      i = Math.max(end, i + 1);
      continue;
    }
    const skip = cssSkip(css, i);
    if (skip >= 0) {
      out += css.slice(i, skip);
      i = skip;
      continue;
    }
    const ch = css[i];
    const prev = i > 0 ? css[i - 1] : "";
    if (/[-.0-9]/.test(ch) && !CSS_IDENT_CHAR.test(prev) && prev !== ".") {
      const match = VIEWPORT_UNIT.exec(css.slice(i, i + 40));
      if (match) {
        const unit = match[3].toLowerCase();
        const base =
          unit === "vh" || unit === "vb"
            ? height
            : unit === "vw" || unit === "vi"
              ? width
              : unit === "vmin"
                ? Math.min(width, height)
                : Math.max(width, height);
        out += px((Number(match[1]) * base) / 100);
        i += match[0].length;
        continue;
      }
    }
    if (CSS_IDENT_CHAR.test(ch)) {
      // A whole identifier, escapes included (`--x-2vh`, `h-screen`,
      // `h-\[100vh\]`), so no number starts inside.
      const j = readCssIdent(css, i)[1];
      out += css.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * A selector with `:root`, `html` and `body` pointed at the elements that
 * stand in for them, at the same specificity: `.cp-page-root` is a class as
 * `:root` is a pseudo-class, and the two custom elements are type selectors.
 */
export function pageSelector(selector) {
  let out = "";
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "[") {
      const end = closeBracket(selector, i);
      out += selector.slice(i, end);
      i = end;
      continue;
    }
    const skip = cssSkip(selector, i);
    if (skip >= 0) {
      out += selector.slice(i, skip);
      i = skip;
      continue;
    }
    if (ch === ":" || ch === "." || ch === "#") {
      // A pseudo, class or id name: never a type selector.
      let j = i + 1;
      if (ch === ":" && selector[j] === ":") j += 1;
      const [name, next] = readCssIdent(selector, j);
      if (ch === ":" && j === i + 1 && name.toLowerCase() === "root")
        out += ".cp-page-root";
      else out += selector.slice(i, next);
      i = Math.max(next, i + 1);
      continue;
    }
    if (CSS_IDENT_CHAR.test(ch)) {
      const [name, next] = readCssIdent(selector, i);
      const lower = name.toLowerCase();
      out +=
        lower === "html"
          ? "cp-page-html"
          : lower === "body"
            ? "cp-page-body"
            : selector.slice(i, next);
      i = Math.max(next, i + 1);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function mediaLength(text) {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)?$/i.exec(text.trim());
  if (!match) return null;
  if (!match[2] && Number(match[1]) !== 0) return null;
  return (
    Number(match[1]) * (match[2] && match[2].toLowerCase() !== "px" ? 16 : 1)
  );
}

const COMPARE = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "=": (a, b) => a === b,
};
const FLIP = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };

/** One `( … )` media feature against the box, or null when not a size. */
function mediaFeature(feature, width, height) {
  const size = { width, height };
  const text = feature.trim().toLowerCase();
  const colon = /^(min-|max-)?(width|height)\s*:\s*(.+)$/.exec(text);
  if (colon) {
    const value = mediaLength(colon[3]);
    if (value === null) return null;
    const actual = size[colon[2]];
    return colon[1] === "min-"
      ? actual >= value
      : colon[1] === "max-"
        ? actual <= value
        : actual === value;
  }
  const orientation = /^orientation\s*:\s*(portrait|landscape)$/.exec(text);
  if (orientation) return (orientation[1] === "portrait") === height >= width;
  // Range syntax: `width >= 48rem`, `40rem <= width < 64rem`.
  const parts = text.split(/\s*(<=|>=|<|>|=)\s*/);
  if (parts.length !== 3 && parts.length !== 5) return null;
  const at = parts.findIndex((p) => p === "width" || p === "height");
  if (at < 0 || at % 2) return null;
  const actual = size[parts[at]];
  const checks = [];
  if (at > 0) checks.push([parts[at - 2], FLIP[parts[at - 1]]]);
  if (at + 2 < parts.length) checks.push([parts[at + 2], parts[at + 1]]);
  let result = true;
  for (const [valueText, op] of checks) {
    const value = mediaLength(valueText);
    if (value === null || !COMPARE[op]) return null;
    result = result && COMPARE[op](actual, value);
  }
  return result;
}

/**
 * Whether an `@media` prelude holds at the design box: true or false when
 * every query is a screen/all/print type and size or orientation features,
 * else null (the browser decides, as it would anyway).
 */
export function mediaMatches(prelude, width, height) {
  const queries = selectorParts(prelude.replace(/^@media\b/i, ""));
  let any = false;
  for (const raw of queries) {
    let query = raw
      .trim()
      .toLowerCase()
      .replace(/^only\s+/, "");
    const negated = /^not\s/.test(query);
    if (negated) query = query.replace(/^not\s+/, "");
    if (!query) return null;
    let holds = true;
    const type = /^(all|screen|print)\b\s*/.exec(query);
    if (type) {
      if (type[1] === "print") holds = false;
      query = query.slice(type[0].length);
      if (query && !/^and\b/.test(query)) return null;
      query = query.replace(/^and\s*/, "");
    }
    while (query) {
      const feature = /^\(([^()]*)\)\s*/.exec(query);
      if (!feature) return null;
      const value = mediaFeature(feature[1], width, height);
      if (value === null) return null;
      holds = holds && value;
      query = query.slice(feature[0].length);
      if (query) {
        if (!/^and\b/.test(query)) return null;
        query = query.replace(/^and\s*/, "");
        if (!query) return null;
      }
    }
    any = any || (negated ? !holds : holds);
  }
  return any;
}

/** Pseudo-classes an inert figure never enters. */
const USER_ACTION = new Set([
  "hover",
  "active",
  "focus",
  "focus-visible",
  "focus-within",
]);
/** Functional pseudo-classes whose argument must match for the whole to. */
const REQUIRED_ARGUMENT = new Set(["is", "where", "has", "matches", "any"]);

/**
 * Whether one selector can match in a figure, whose markup no script changes
 * and no one hovers, focuses or presses: every class and id it needs is in
 * `names` (inside `:is()`, `:where()` and `:has()` too, where one of the
 * argument's selectors must be able to match), and it needs no user-action
 * state outside `:not()`.
 */
export function figureSelectorCanMatch(selector, names) {
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "[") {
      i = closeBracket(selector, i);
      continue;
    }
    const skip = cssSkip(selector, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    if (ch === "." || ch === "#") {
      const [name, next] = readCssIdent(selector, i + 1);
      if (name && !names.has(name)) return false;
      i = Math.max(next, i + 1);
      continue;
    }
    if (ch === ":") {
      const element = selector[i + 1] === ":";
      const [name, next] = readCssIdent(selector, i + (element ? 2 : 1));
      const lower = name.toLowerCase();
      if (!element && USER_ACTION.has(lower)) return false;
      if (selector[next] === "(") {
        const close = closeBracket(selector, next);
        if (
          !element &&
          REQUIRED_ARGUMENT.has(lower) &&
          !selectorParts(selector.slice(next + 1, close - 1)).some((part) =>
            figureSelectorCanMatch(part, names),
          )
        )
          return false;
        i = close;
        continue;
      }
      i = Math.max(next, i + 1);
      continue;
    }
    if (CSS_IDENT_CHAR.test(ch)) {
      i = readCssIdent(selector, i)[1];
      continue;
    }
    i += 1;
  }
  return true;
}

/**
 * A rule's body with its nested rules' selectors (CSS nesting, such as
 * Tailwind's `&:where(.dark, :root:not(.light-mode) *)` variants) pointed at
 * the stand-in elements as `pageSelector` points the rule's own. A nested
 * at-rule's prelude is left alone.
 */
export function pageNestedSelectors(body) {
  return body.replace(/(?<=^|[{};])([^{};]*)\{/g, (match, prelude) =>
    /^\s*@/.test(prelude) ? match : `${pageSelector(prelude)}{`,
  );
}

/** The page's CSS for inside the shadow root, plus what must sit outside. */
function shadowCss(nodes, box, names, fonts, properties) {
  const out = [];
  for (const node of nodes) {
    if (node.type === "rule") {
      const selector = pageSelector(node.prelude);
      if (
        selectorParts(selector).some((part) =>
          figureSelectorCanMatch(part, names),
        )
      )
        out.push(
          selector + pageNestedSelectors(node.text.slice(node.prelude.length)),
        );
    } else if (node.type === "wrapper") {
      const inner = shadowCss(node.children, box, names, fonts, properties);
      const media = /^@media\b/i.test(node.head)
        ? mediaMatches(node.head.slice(0, -1), box.width, box.height)
        : null;
      if (media === true) out.push(...inner);
      else if (media === null && (inner.length || node.named))
        out.push(`${node.head}\n${inner.join("\n")}\n}`);
    } else if (/^@font-face\b/i.test(node.text)) {
      fonts.push(node.text);
    } else {
      const property = /^@property\s+(--[^\s{]+)\s*\{([^}]*)\}/i.exec(
        node.text,
      );
      if (property) {
        const initial = /initial-value\s*:\s*([^;}]*)/i.exec(property[2]);
        if (initial)
          properties.push({
            name: property[1],
            value: initial[1].trim(),
            inherits: /inherits\s*:\s*true/i.test(property[2]),
          });
      }
      out.push(node.text);
    }
  }
  return out;
}

/** A page's <html> or <body> attributes as the stand-in element carries them. */
function pageAttributes(attrs, extraClass, box) {
  const kept = [];
  let classes = extraClass;
  for (const [name, raw] of Object.entries(attrs ?? {})) {
    if (!PAGE_ATTR.test(name)) continue;
    let value = decodeEntities(raw);
    if (name === "class") {
      classes = [extraClass, value].filter(Boolean).join(" ");
      continue;
    }
    if (name === "style")
      value = viewportToPixels(sanitizeCss(value), box.width, box.height);
    kept.push(` ${name}="${escapeAttr(value)}"`);
  }
  return `${classes ? ` class="${escapeAttr(classes)}"` : ""}${kept.join("")}`;
}

/** Markup with the given elements removed, content and all. */
function withoutElements(html, names) {
  const ranges = elements(html)
    .filter((element) => names.has(element.name))
    .sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const range of ranges) {
    if (range.start < at) continue;
    out += html.slice(at, range.start);
    at = range.end;
  }
  return out + html.slice(at);
}

/** Every inline style attribute's viewport units as design-box pixels. */
function inlineStylesToPixels(html, box) {
  return html.replace(
    /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (whole, lead, dq, sq) => {
      const value = viewportToPixels(dq ?? sq, box.width, box.height);
      return dq !== undefined ? `${lead}"${value}"` : `${lead}'${value}'`;
    },
  );
}

/**
 * A self-contained `<figure>` that renders `page` (a composed page or any
 * self-contained HTML page) at `width` × `height` design pixels, scaled to
 * `fit` CSS pixels wide and clipped, inside a declarative shadow root.
 * Returns the fragment and how many <script> elements were dropped.
 */
export function pageFigureHtml(
  page,
  { href, caption, alt, width, fit, height } = {},
) {
  checkFigureHref(href);
  const tokens = tokenize(page);
  const open = (name) =>
    tokens.find((t) => t.type === "open" && t.name === name);
  const htmlTag = open("html");
  const bodyTag = open("body");
  const recorded = /@(\d+)$/.exec(
    decodeEntities(htmlTag?.attrs["data-kit-id"] ?? ""),
  );
  const boxWidth = positivePx(
    "--width",
    width,
    recorded ? Number(recorded[1]) : FIGURE_PAGE_WIDTH,
  );
  const shown = positivePx("--fit", fit, FIGURE_PAGE_FIT);
  const boxHeight = positivePx(
    "--height",
    height,
    boxWidth * FIGURE_PAGE_RATIO,
  );
  const box = { width: boxWidth, height: boxHeight };
  const scale = shown / boxWidth;

  const scripts = tokens.filter(
    (t) => t.type === "open" && t.name === "script",
  ).length;
  const styles = [];
  tokens.forEach((token, at) => {
    const text = tokens[at + 1];
    if (
      token.type === "open" &&
      token.name === "style" &&
      !token.selfClosing &&
      text?.type === "text"
    )
      styles.push(page.slice(text.start, text.end));
  });

  // The body's content: between <body> and its close, else after </head>.
  const closeOf = (name) =>
    tokens.findLast((t) => t.type === "close" && t.name === name);
  const headClose = closeOf("head");
  const start = bodyTag?.end ?? headClose?.end ?? htmlTag?.end ?? 0;
  const stop = closeOf("body")?.start ?? closeOf("html")?.start ?? page.length;
  let body = page.slice(start, Math.max(start, stop));
  if (!bodyTag) body = body.replace(/<!doctype[^>]*>/gi, "");
  body = sanitizeMarkup(
    withoutElements(body, new Set(["style", "head", ...PAGE_DROPPED])),
  );
  body = inlineStylesToPixels(body, box);

  const htmlOpen = `<cp-page-html${pageAttributes(htmlTag?.attrs, "cp-page-root", box)}>`;
  const bodyOpen = `<cp-page-body${pageAttributes(bodyTag?.attrs, "", box)}>`;
  // Every class and id the figure has: with no scripts, nothing adds one.
  const names = new Set();
  for (const element of elements(`${htmlOpen}${bodyOpen}${body}`)) {
    const { class: classes, id } = element.attrs;
    for (const name of decodeEntities(classes ?? "").split(/[\t\n\f\r ]+/))
      if (name) names.add(name);
    if (id) names.add(decodeEntities(id));
  }
  const fonts = [];
  const properties = [];
  const sheet = sanitizeCss(styles.join("\n"));
  const css = viewportToPixels(
    shadowCss(
      parseCssList(sheet, 0, sheet.length),
      box,
      names,
      fonts,
      properties,
    ).join("\n"),
    box.width,
    box.height,
  );
  const declarations = (list) =>
    list.map((p) => `${p.name}:${p.value}`).join(";");
  const local = properties.filter((p) => !p.inherits);
  const inherited = properties.filter((p) => p.inherits);
  // The lowest cascade layer (declared first): the stand-ins' defaults, the
  // inherited properties reset, and @property initial values, which Chromium
  // ignores inside a shadow root.
  const base = [
    "cp-page-html{all:initial;display:block;min-height:100%}",
    "cp-page-body{display:block;margin:8px}",
    inherited.length ? `cp-page-html{${declarations(inherited)}}` : "",
    local.length ? `*,::before,::after,::backdrop{${declarations(local)}}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const label = alt ?? caption ?? "";
  const shownHeight = px(boxHeight * scale);
  // inline-block: an atomic inline, so the link's (or any host ancestor's)
  // text-decoration, which propagates rather than inherits, stops here.
  const outer = [
    "display:inline-block",
    "vertical-align:top",
    "position:relative",
    "overflow:hidden",
    `width:${px(shown)}`,
    "max-width:100%",
    `height:${shownHeight}`,
    "margin:0",
    "padding:0",
    "border:0",
  ].join(";");
  const inner = [
    `width:${px(boxWidth)}`,
    `height:${px(boxHeight)}`,
    "overflow:hidden",
    `transform:scale(${Number(scale.toFixed(6))})`,
    "transform-origin:0 0",
    "pointer-events:none",
  ].join(";");
  let view = `<div data-kit-figure-page role="img" aria-label="${escapeHtml(label)}" style="${outer}">
<template shadowrootmode="open">
<style>
@layer cp-page-base{
${base}
}
${css}
</style>
<div class="cp-page-box" inert style="${inner}">
${htmlOpen}
${bodyOpen}
${body.trim()}
</cp-page-body>
</cp-page-html>
</div>
</template>
</div>`;
  if (href !== undefined)
    view = `<a href="${escapeHtml(href)}" style="display:block;width:fit-content;max-width:100%;text-decoration:none">${view}</a>`;
  const fontCss = fonts.length
    ? `\n  <style>\n${fonts.join("\n")}\n</style>`
    : "";
  const figcaption =
    caption === undefined
      ? ""
      : `\n  <figcaption>${escapeHtml(caption)}</figcaption>`;
  return {
    html: `<figure style="margin:0">${fontCss}\n  ${view}${figcaption}\n</figure>\n`,
    scripts,
  };
}

/**
 * `figure --img <file> | --page <file> --out <file>`: writes the fragment;
 * no kit needed.
 */
function figureCommand(options, io) {
  if (options.img !== undefined && options.page !== undefined)
    throw new KitError(
      "figure takes --img or --page, not both: --img embeds a screenshot, --page renders a composed page",
    );
  if (options.img === undefined && options.page === undefined)
    throw new KitError(
      "figure needs --img <file.png|jpg|webp> or --page <file.html>",
    );
  if (!options.out) throw new KitError("figure needs --out <file>");
  let html;
  if (options.page !== undefined) {
    const file = resolve(options.page);
    if (!existsSync(file))
      throw new KitError(`--page ${options.page}: no such file`);
    const result = pageFigureHtml(readFileSync(file, "utf8"), {
      href: options.href,
      caption: options.caption,
      alt: options.alt,
      width: options.width,
      fit: options.fit,
      height: options.height,
    });
    html = result.html;
    if (result.scripts)
      io.err(
        `kit: warning: dropped ${result.scripts} <script> element${result.scripts === 1 ? "" : "s"} from ${options.page}; the figure is static`,
      );
  } else {
    if (options.fit !== undefined || options.height !== undefined)
      throw new KitError("--fit and --height go with --page");
    const file = resolve(options.img);
    const type = FIGURE_TYPES[extname(file).toLowerCase()];
    if (!type)
      throw new KitError(
        `--img ${options.img}: use a .png, .jpg or .webp file`,
      );
    if (!existsSync(file))
      throw new KitError(`--img ${options.img}: no such file`);
    const image = readFileSync(file);
    html = figureHtml({
      image,
      type,
      href: options.href,
      caption: options.caption,
      alt: options.alt,
      width: options.width,
    });
    if (image.length > FIGURE_WARN_BYTES)
      io.err(
        `kit: warning: ${options.img} is ${formatBytes(image.length)}; the page carries it all (shrink it below 1 MB)`,
      );
  }
  const bytes = Buffer.byteLength(html);
  if (options.page !== undefined && bytes > FIGURE_WARN_BYTES)
    io.err(
      `kit: warning: the figure is ${formatBytes(bytes)}; the page carries it all (compose with --css pruned, or crop less, to shrink it below 1 MB)`,
    );
  const out = resolve(options.out);
  writeFileSync(out, html);
  io.out(`${out}  ${formatBytes(bytes)}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: kit.mjs [--kit <dir>] <command>
  info [--json]                sha, build time and counts (--json: the manifest)
  find <query>                 up to ${FIND_LIMIT} lines of rows whose id, title or on-screen text holds
                               every word; widths of one frame share a line: id@{1280,390}
  show <id> [--full]           path, size and an outline (--full: the markup)
  compose --frame <id> [--slot <name>=<file>]… [--theme light|dark] [--show-new] [--css pruned|full] --out <file>
                               --css full keeps every rule of the kit's CSS; the default
                               keeps only rules the page's classes and ids can use;
                               --theme uses the frame's capture in that theme when its source
                               captured each one (show lists them), else toggles the theme class
  figure --img <file.png|jpg|webp> [--href '#cp-page:<key>'] [--caption <text>] [--alt <text>] [--width <px>] --out <file>
                               a self-contained <figure>: the image as a data URI, linked when
                               --href is given, the caption escaped (no kit needed)
  figure --page <file.html> [--href '#cp-page:<key>'] [--caption <text>] [--alt <text>] [--width <px>] [--fit <px>] [--height <px>] --out <file>
                               a composed page's own markup and CSS in a shadow root, laid out at
                               --width (default: the frame's width, else 1280) by --height (default
                               width x 0.625) and scaled to --fit px wide (default 640); no scripts`;

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
    else if (arg === "--css") options.css = value();
    else if (arg === "--img") options.img = value();
    else if (arg === "--page") options.page = value();
    else if (arg === "--fit") options.fit = value();
    else if (arg === "--height") options.height = value();
    else if (arg === "--href") options.href = value();
    else if (arg === "--caption") options.caption = value();
    else if (arg === "--alt") options.alt = value();
    else if (arg === "--width") options.width = value();
    else if (arg === "--full") options.full = true;
    else if (arg === "--json") options.json = true;
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
    if (command === "figure") {
      if (rest.length) throw new KitError(`figure takes no ${rest[0]}`);
      figureCommand(options, io);
      return 0;
    }
    const dir = resolve(options.kit ?? env.DESIGN_KIT_DIR ?? defaultDir);
    const kit = loadKit(dir);
    if (command === "info") {
      io.out(infoText(kit, options.json));
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
        theme: options.theme,
        showNew: options.showNew,
        css: options.css ?? "pruned",
        warn: (message) => io.err(`kit: warning: ${message}`),
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
