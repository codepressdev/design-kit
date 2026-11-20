/**
 * Framework source hints, component owner chain, CSS selector, trimmed outerHTML,
 * and computed layout style extraction.
 *
 * Supports:
 * - React 18 `_debugSource`
 * - React 19 `_debugStack` with same-origin `.map` resolution (250 ms fail-closed timeout)
 * - Vue 2/3 `__file`
 * - Svelte `__svelte_meta`
 * - `codepress-data-fp` DOM attribute
 *
 * Zero runtime dependencies; works in browsers and Node unit tests.
 */

import {
  MAX_OUTER_HTML_CHARS,
  MAX_OWNERS,
  MAX_SOURCE_HINTS,
} from "./sanitize.mjs";

export const DEFAULT_SOURCEMAP_TIMEOUT_MS = 250;

const VLQ_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_LOOKUP = new Map();
for (let i = 0; i < VLQ_CHARS.length; i += 1) {
  VLQ_LOOKUP.set(VLQ_CHARS[i], i);
}

/**
 * Decode a single Base64 VLQ segment into an array of signed integers.
 */
function decodeVlqSegment(segment) {
  const values = [];
  let i = 0;
  while (i < segment.length) {
    let result = 0;
    let shift = 0;
    let continuation = true;
    while (continuation && i < segment.length) {
      const digit = VLQ_LOOKUP.get(segment[i]);
      i += 1;
      if (digit === undefined) return values;
      continuation = (digit & 32) !== 0;
      result += (digit & 31) << shift;
      shift += 5;
    }
    const isNegative = (result & 1) === 1;
    const value = result >> 1;
    values.push(isNegative ? -value : value);
  }
  return values;
}

/**
 * Resolve a 1-based (generatedLine, generatedColumn) against a Source Map v3 object.
 * Returns `{ file, line, column }` (1-based) or `null` if unmapped/malformed.
 */
export function resolveSourceMapPosition(
  sourceMap,
  generatedLine,
  generatedColumn = 1,
) {
  if (
    !sourceMap ||
    typeof sourceMap !== "object" ||
    typeof sourceMap.mappings !== "string" ||
    !Array.isArray(sourceMap.sources)
  ) {
    return null;
  }

  const targetLineIdx = Math.max(0, Math.floor(Number(generatedLine) || 1) - 1);
  const targetColIdx = Math.max(
    0,
    Math.floor(Number(generatedColumn) || 1) - 1,
  );
  const lines = sourceMap.mappings.split(";");
  if (targetLineIdx >= lines.length) return null;

  let sourceIdx = 0;
  let origLine = 0;
  let origCol = 0;
  let best = null;

  for (let lineIdx = 0; lineIdx <= targetLineIdx; lineIdx += 1) {
    const lineStr = lines[lineIdx];
    let genCol = 0;
    if (!lineStr) continue;
    const segments = lineStr.split(",");
    for (const seg of segments) {
      if (!seg) continue;
      const fields = decodeVlqSegment(seg);
      if (fields.length === 0) continue;
      genCol += fields[0];
      if (fields.length >= 4) {
        sourceIdx += fields[1];
        origLine += fields[2];
        origCol += fields[3];
        if (lineIdx === targetLineIdx && genCol <= targetColIdx) {
          const sourceFile = sourceMap.sources[sourceIdx];
          if (typeof sourceFile === "string" && sourceFile) {
            best = {
              file: sourceMap.sourceRoot
                ? `${sourceMap.sourceRoot}${sourceFile}`
                : sourceFile,
              line: origLine + 1,
              column: origCol + 1,
            };
          }
        }
      }
    }
  }

  return best;
}

/**
 * Parse a `codepress-data-fp` value such as `src/components/Button.tsx:42:5`.
 */
function parseDataFp(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const match = text.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (match) {
    return {
      framework: "data-fp",
      file: match[1],
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : undefined,
      confidence: "high",
    };
  }
  return {
    framework: "data-fp",
    file: text,
    confidence: "high",
  };
}

/**
 * Parse stack frames from React 19 `_debugStack` (Error or string).
 */
export function parseDebugStackFrames(debugStack) {
  const raw =
    typeof debugStack === "string"
      ? debugStack
      : typeof debugStack?.stack === "string"
        ? debugStack.stack
        : "";
  if (!raw) return [];

  const frames = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Match Chrome/V8: `at ComponentName (https://host/src/App.tsx:12:4)` or `at https://host/src/App.tsx:12:4`
    let m = trimmed.match(
      /^at\s+(?:(.+?)\s+\()?((?:https?:\/\/|\/)[^\s)]+):(\d+):(\d+)\)?$/,
    );
    if (!m) {
      // Match Firefox/Safari: `ComponentName@https://host/src/App.tsx:12:4`
      m = trimmed.match(/^([^@]*)@((?:https?:\/\/|\/)[^\s]+):(\d+):(\d+)$/);
    }
    if (!m) continue;
    const component = (m[1] || "").replace(/^Object\./, "").trim();
    const url = m[2];
    const lineNum = Number(m[3]);
    const colNum = Number(m[4]);
    if (/node_modules\/(react|react-dom|scheduler)\//.test(url)) continue;
    frames.push({
      component: component || undefined,
      url,
      line: lineNum,
      column: colNum,
    });
  }
  return frames;
}

function isSameOriginUrl(rawUrl, origin) {
  if (!origin || !rawUrl) return false;
  try {
    const resolved = new URL(rawUrl, origin);
    return resolved.origin === origin;
  } catch {
    return false;
  }
}

async function fetchSameOriginSourceMap(
  scriptUrl,
  origin,
  fetchImpl,
  timeoutMs,
  cache,
) {
  if (!fetchImpl || !isSameOriginUrl(scriptUrl, origin)) return null;

  let mapUrl;
  try {
    const u = new URL(scriptUrl, origin);
    u.search = "";
    u.hash = "";
    mapUrl = `${u.href}.map`;
  } catch {
    return null;
  }

  if (cache && cache.has(mapUrl)) {
    return cache.get(mapUrl);
  }

  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  const boundedMs = Math.max(
    10,
    Number(timeoutMs) || DEFAULT_SOURCEMAP_TIMEOUT_MS,
  );

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore abort errors
      }
      resolve(null);
    }, boundedMs);
  });

  const fetchPromise = (async () => {
    try {
      const resp = await fetchImpl(mapUrl, {
        signal: controller?.signal,
        credentials: "same-origin",
      });
      if (!resp || !resp.ok) return null;
      const json = await resp.json();
      if (
        !json ||
        typeof json !== "object" ||
        typeof json.mappings !== "string"
      ) {
        return null;
      }
      return json;
    } catch {
      return null;
    }
  })();

  const result = await Promise.race([fetchPromise, timeoutPromise]);
  if (timer !== null) clearTimeout(timer);
  if (cache) cache.set(mapUrl, result);
  return result;
}

function getReactFiber(el) {
  if (!el || typeof el !== "object") return null;
  const keys = Object.keys(el);
  for (const key of keys) {
    if (
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$")
    ) {
      return el[key];
    }
  }
  return null;
}

function getFiberComponentName(fiber) {
  if (!fiber) return null;
  const type = fiber.type || fiber.elementType;
  if (!type) return null;
  if (typeof type === "string") return null; // host DOM element
  if (typeof type === "function") {
    return type.displayName || type.name || null;
  }
  if (typeof type === "object") {
    if (type.displayName) return type.displayName;
    if (type.render && (type.render.displayName || type.render.name)) {
      return type.render.displayName || type.render.name;
    }
    if (type.type && (type.type.displayName || type.type.name)) {
      return type.type.displayName || type.type.name;
    }
  }
  return null;
}

function getParentElement(el) {
  return el?.parentElement || el?.parentNode || null;
}

function pushOwner(owners, name) {
  if (!name || typeof name !== "string") return;
  const clean = name.trim();
  if (!clean || clean === "Anonymous" || clean.startsWith("_")) return;
  if (!owners.includes(clean) && owners.length < MAX_OWNERS) {
    owners.push(clean);
  }
}

/**
 * Build a concise, readable CSS selector for a DOM element.
 */
export function buildCssSelector(el) {
  if (!el || typeof el !== "object") return "";
  const tag = String(el.tagName || "").toLowerCase();
  if (!tag) return "";

  if (el.id && typeof el.id === "string") {
    return `#${el.id}`;
  }
  const testId =
    typeof el.getAttribute === "function"
      ? el.getAttribute("data-testid")
      : null;
  if (testId) {
    return `${tag}[data-testid="${testId.replace(/"/g, '\\"')}"]`;
  }

  const parts = [];
  let cur = el;
  let depth = 0;
  while (cur && depth < 4) {
    const curTag = String(cur.tagName || "").toLowerCase();
    if (!curTag || curTag === "html" || curTag === "body") break;
    if (cur.id) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    let seg = curTag;
    const className = typeof cur.className === "string" ? cur.className : "";
    const classes = className
      .trim()
      .split(/\s+/)
      .filter((c) => c && !/^(hover:|focus:|active:)/.test(c))
      .slice(0, 2);
    if (classes.length) {
      seg += `.${classes.join(".")}`;
    } else if (
      cur.parentElement &&
      Array.isArray(Array.from(cur.parentElement.children || []))
    ) {
      const siblings = Array.from(cur.parentElement.children).filter(
        (s) => s.tagName === cur.tagName,
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        if (idx > 0) seg += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(seg);
    cur = cur.parentElement;
    depth += 1;
  }

  return parts.join(" > ") || tag;
}

/**
 * Capture trimmed `outerHTML` bounded to `maxChars`.
 */
export function trimOuterHtml(el, maxChars = MAX_OUTER_HTML_CHARS) {
  if (!el || typeof el.outerHTML !== "string") return "";
  const compact = el.outerHTML.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

const LAYOUT_STYLE_KEYS = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "gap",
  "flexDirection",
  "alignItems",
  "justifyContent",
  "gridTemplateColumns",
  "overflow",
  "overflowX",
  "overflowY",
  "zIndex",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "color",
  "backgroundColor",
  "borderRadius",
  "opacity",
];

/**
 * Extract computed layout styles for a DOM element.
 */
export function extractComputedLayout(el) {
  if (!el || typeof globalThis.getComputedStyle !== "function")
    return undefined;
  try {
    const cs = globalThis.getComputedStyle(el);
    if (!cs) return undefined;
    const out = {};
    for (const key of LAYOUT_STYLE_KEYS) {
      const val = cs[key];
      if (
        val !== undefined &&
        val !== null &&
        val !== "" &&
        val !== "none" &&
        val !== "normal" &&
        val !== "auto"
      ) {
        out[key] = String(val);
      }
    }
    if (typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      out.box = `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
const FRAMEWORK_RANK = {
  react: 5,
  vue: 5,
  svelte: 5,
  "data-fp": 4,
  unknown: 1,
};

function rankAndDedupeHints(hints) {
  const seen = new Set();
  const deduped = [];
  for (const h of hints) {
    if (!h || !h.file) continue;
    const key = `${h.file}:${h.line || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
  }

  deduped.sort((a, b) => {
    const confDiff =
      (CONFIDENCE_RANK[b.confidence] || 0) -
      (CONFIDENCE_RANK[a.confidence] || 0);
    if (confDiff !== 0) return confDiff;
    const fwDiff =
      (FRAMEWORK_RANK[b.framework] || 0) - (FRAMEWORK_RANK[a.framework] || 0);
    if (fwDiff !== 0) return fwDiff;
    return (b.line ? 1 : 0) - (a.line ? 1 : 0);
  });

  return deduped.slice(0, MAX_SOURCE_HINTS);
}

/**
 * Extract ranked framework source hints, component owner chain (<= 6),
 * CSS selector, trimmed outerHTML, and computed layout styles from an element.
 */
export async function extractSourceHints(el, options = {}) {
  const hints = [];
  const owners = [];
  if (!el || typeof el !== "object") {
    return {
      sourceHints: [],
      owners: [],
      selector: "",
      outerHtml: "",
      computedStyle: undefined,
    };
  }

  const origin =
    options.origin ??
    (typeof globalThis.location === "object" ? globalThis.location.origin : "");
  const fetchImpl =
    options.fetchImpl ??
    (typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : null);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCEMAP_TIMEOUT_MS;
  const sourceMapCache = options.sourceMapCache ?? new Map();

  // 1. Walk DOM ancestors for `codepress-data-fp`, Svelte `__svelte_meta`, Vue, and React fibers.
  let cur = el;
  let domSteps = 0;
  let foundFiber = null;
  let foundVue = null;

  while (cur && domSteps < 20) {
    if (typeof cur.getAttribute === "function") {
      const fp = cur.getAttribute("codepress-data-fp");
      if (fp) {
        const parsed = parseDataFp(fp);
        if (parsed) hints.push(parsed);
      }
    }

    // Svelte __svelte_meta
    const svelteMeta = cur.__svelte_meta;
    if (svelteMeta && typeof svelteMeta === "object") {
      const loc = svelteMeta.loc || svelteMeta;
      if (loc.file) {
        hints.push({
          framework: "svelte",
          file: String(loc.file),
          line: Number.isFinite(Number(loc.line))
            ? Number(loc.line) + (svelteMeta.loc ? 1 : 0)
            : undefined,
          column: Number.isFinite(Number(loc.char ?? loc.column))
            ? Number(loc.char ?? loc.column) + (svelteMeta.loc ? 1 : 0)
            : undefined,
          confidence: "high",
        });
        const comp = String(loc.file)
          .split("/")
          .pop()
          ?.replace(/\.svelte$/i, "");
        pushOwner(owners, comp);
      }
    }

    if (!foundFiber) foundFiber = getReactFiber(cur);
    if (!foundVue) foundVue = cur.__vueParentComponent || cur.__vue__ || null;

    cur = getParentElement(cur);
    domSteps += 1;
  }

  // 2. React 18 `_debugSource` + React 19 `_debugStack` + owner chain
  if (foundFiber) {
    let fiber = foundFiber;
    let fiberSteps = 0;
    const debugStacks = [];

    while (fiber && fiberSteps < 40) {
      const name = getFiberComponentName(fiber);
      pushOwner(owners, name);

      if (fiber._debugSource && fiber._debugSource.fileName) {
        hints.push({
          framework: "react",
          file: String(fiber._debugSource.fileName),
          line: Number(fiber._debugSource.lineNumber) || undefined,
          column: Number(fiber._debugSource.columnNumber) || undefined,
          component: name || undefined,
          confidence: "high",
        });
      }

      if (fiber._debugStack && debugStacks.length < 3) {
        debugStacks.push({
          stack: fiber._debugStack,
          component: name || undefined,
        });
      }

      fiber = fiber._debugOwner || fiber.return || null;
      fiberSteps += 1;
    }

    // Resolve React 19 `_debugStack` frames via same-origin `.map` (bounded by 250ms timeout).
    for (const entry of debugStacks) {
      const frames = parseDebugStackFrames(entry.stack);
      for (const frame of frames.slice(0, 3)) {
        let mapped = null;
        if (isSameOriginUrl(frame.url, origin)) {
          const map = await fetchSameOriginSourceMap(
            frame.url,
            origin,
            fetchImpl,
            timeoutMs,
            sourceMapCache,
          );
          if (map) {
            mapped = resolveSourceMapPosition(map, frame.line, frame.column);
          }
        }
        if (mapped) {
          hints.push({
            framework: "react",
            file: mapped.file,
            line: mapped.line,
            column: mapped.column,
            component: frame.component || entry.component,
            confidence: "high",
          });
        } else {
          let displayFile = frame.url;
          try {
            const u = new URL(
              frame.url,
              origin || "https://design-kit.invalid",
            );
            displayFile = u.pathname;
          } catch {
            // keep frame.url
          }
          hints.push({
            framework: "react",
            file: displayFile,
            line: frame.line,
            column: frame.column,
            component: frame.component || entry.component,
            confidence: "medium",
          });
        }
      }
    }
  }

  // 3. Vue 2 / Vue 3 `__file` + parent component chain
  if (foundVue) {
    let inst = foundVue;
    let vueSteps = 0;
    while (inst && vueSteps < 20) {
      const type = inst.type || inst.$options || inst;
      const compName = type?.name || type?.__name || null;
      pushOwner(owners, compName);
      if (type?.__file) {
        hints.push({
          framework: "vue",
          file: String(type.__file),
          component: compName || undefined,
          confidence: "high",
        });
      }
      inst = inst.parent || inst.$parent || null;
      vueSteps += 1;
    }
  }

  return {
    sourceHints: rankAndDedupeHints(hints),
    owners: owners.slice(0, MAX_OWNERS),
    selector: buildCssSelector(el),
    outerHtml: trimOuterHtml(el, MAX_OUTER_HTML_CHARS),
    computedStyle: extractComputedLayout(el),
  };
}
