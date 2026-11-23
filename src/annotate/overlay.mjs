/**
 * <design-kit-annotator> — Zero-dependency, closed Shadow-DOM live-app
 * annotation overlay with Browse <-> Annotate workflow, immediate per-step
 * snapshots, sessionStorage persistence, and pluggable Send to Fix.
 */

import {
  computePairwiseOverlaps,
  MAX_FREEHAND_POINTS,
  sanitizeRedlinePacket,
  sanitizeRoute,
} from "./sanitize.mjs";
import {
  captureCalloutSnapshot,
  compositeAnnotationsOnImage,
} from "./snapshot.mjs";
import {
  buildCssSelector,
  DEFAULT_SOURCEMAP_TIMEOUT_MS,
  extractSourceHints,
} from "./source-hints.mjs";
import {
  createPostMessageBridge,
  dispatchRedlinePacket,
  DK_ANNOTATE_MSG,
  sanitizeRunUrl,
} from "./transport.mjs";

const HOST_TAG = "design-kit-annotator";
const DEFAULT_STORAGE_KEY = "design-kit:annotate:queue:v1";
const MAX_HISTORY_STEPS = 100;

// Focus targets whose own Cmd/Ctrl+Z (text undo, terminal or editor keys) the
// overlay's undo shortcut must never take over.
const NATIVE_UNDO_TARGET_SELECTOR = [
  ".xterm",
  ".xterm-helper-textarea",
  ".monaco-editor",
  ".cm-editor",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
].join(", ");

function isNativeUndoTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return true;
  const tag =
    typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (typeof target.closest === "function") {
    try {
      if (target.closest(NATIVE_UNDO_TARGET_SELECTOR)) return true;
    } catch {
      // ignore selector errors in non-standard DOM shims
    }
  }
  return false;
}

function isApplePlatform(win) {
  const nav = win?.navigator;
  const platform = String(nav?.userAgentData?.platform || nav?.platform || "");
  if (/mac|iphone|ipad|ipod/i.test(platform)) return true;
  return /Mac OS X|iPhone|iPad/.test(String(nav?.userAgent || ""));
}

/**
 * Classify a keydown as the overlay's undo/redo shortcut: Cmd/Ctrl+Z undoes;
 * Cmd/Ctrl+Shift+Z and Ctrl+Y redo. Returns null for anything else.
 */
function historyShortcutOf(event) {
  if (!event || event.altKey || event.isComposing) return null;
  const meta = Boolean(event.metaKey);
  const ctrl = Boolean(event.ctrlKey);
  if (meta === ctrl) return null;
  const key = String(event.key || "").toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && ctrl && !event.shiftKey) return "redo";
  return null;
}

const OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #f4f4f5;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.dk-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
}
.dk-capture {
  position: fixed;
  inset: 0;
  pointer-events: auto;
  cursor: crosshair;
  touch-action: none;
  box-shadow: inset 0 0 0 3px rgba(239, 68, 68, 0.85);
  z-index: 1;
}
.dk-capture[data-tool="pin"] {
  touch-action: pan-y;
}
.dk-capture[hidden] {
  display: none;
  pointer-events: none;
}
.dk-mode-banner {
  display: none;
  position: fixed;
  top: max(8px, env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - 16px);
  min-height: 36px;
  padding: 6px 14px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 999px;
  background: rgba(24, 24, 27, 0.96);
  border: 1.5px solid #ef4444;
  color: #fafafa;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  z-index: 6;
}
.dk-mode-banner[hidden] {
  display: none !important;
}
.dk-mode-banner-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #ef4444;
  flex-shrink: 0;
}
.dk-mode-banner-sub {
  color: #fca5a5;
  font-weight: 500;
}
.dk-svg-layer {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}
.dk-markers {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}
.dk-marker {
  position: fixed;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #ef4444;
  color: #ffffff;
  border: 2px solid #ffffff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.45);
  pointer-events: auto;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.dk-dock {
  position: fixed;
  right: 8px;
  bottom: 8px;
  max-width: calc(100vw - 16px);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
  z-index: 5;
}
.dk-bar {
  pointer-events: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  max-width: calc(100vw - 16px);
  border-radius: 12px;
  background: #18181b;
  color: #f4f4f5;
  border: 1px solid #3f3f46;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  user-select: none;
}
.dk-bar.dk-dragging {
  cursor: grabbing;
}
.dk-bar-primary,
.dk-bar-secondary {
  display: contents;
}
.dk-drag-handle {
  order: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 24px;
  color: #71717a;
  cursor: grab;
  touch-action: none;
  flex-shrink: 0;
  border-radius: 4px;
  font-size: 13px;
  letter-spacing: -1px;
  line-height: 1;
}
.dk-seg {
  order: 2;
}
.dk-tools {
  order: 3;
}
.dk-btn-undo {
  order: 4;
}
.dk-btn-redo {
  order: 5;
}
.dk-count {
  order: 6;
}
.dk-btn-copy {
  order: 7;
}
.dk-btn-send {
  order: 8;
}
.dk-btn-popout {
  order: 9;
}
.dk-btn-collapse {
  order: 10;
}
.dk-drag-handle:hover {
  color: #e4e4e7;
  background: #27272a;
}
.dk-bar.dk-dragging .dk-drag-handle {
  cursor: grabbing;
}
.dk-dock[data-dk-dock-hidden="true"] {
  display: none;
}
.dk-dock.dk-pip-dock {
  position: static;
  right: auto;
  bottom: auto;
  left: auto;
  top: auto;
  max-width: 100%;
  width: 100%;
  align-items: flex-start;
}
.dk-dock.dk-pip-dock .dk-bar {
  max-width: 100%;
  width: 100%;
  border-radius: 0;
  border: none;
  box-shadow: none;
}
.dk-seg {
  display: inline-flex;
  align-items: center;
  background: #09090b;
  border: 1px solid #27272a;
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.dk-btn {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: #d4d4d8;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.dk-btn:hover {
  background: #27272a;
  color: #ffffff;
}
.dk-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  background: transparent;
  color: #d4d4d8;
}
.dk-btn[aria-pressed="true"],
.dk-btn[aria-selected="true"] {
  background: #27272a;
  color: #ffffff;
  border-color: #52525b;
}
.dk-btn-annotate[aria-selected="true"] {
  background: #ef4444;
  color: #ffffff;
  border-color: #ef4444;
}
.dk-tools {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}
.dk-tools[hidden] {
  display: none;
}
.dk-count {
  font-size: 11px;
  font-weight: 600;
  color: #fca5a5;
  padding: 0 4px;
  white-space: nowrap;
}
.dk-btn-send {
  background: #ef4444;
  color: #ffffff;
  border-color: #ef4444;
  font-weight: 600;
}
.dk-btn-send:hover:not(:disabled) {
  background: #dc2626;
}
.dk-btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dk-btn-subtle {
  border-color: #3f3f46;
  color: #e4e4e7;
}
.dk-chips {
  pointer-events: auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  max-width: calc(100vw - 16px);
}
.dk-chips[hidden] {
  display: none;
}
.dk-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: calc(100vw - 24px);
  padding: 3px 8px;
  border-radius: 999px;
  background: #18181b;
  border: 1px solid #3f3f46;
  color: #e4e4e7;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dk-chip-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: #ef4444;
  color: #ffffff;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}
.dk-chip-del {
  appearance: none;
  border: none;
  background: transparent;
  color: #a1a1aa;
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
}
.dk-chip-del:hover {
  color: #ffffff;
}
.dk-toast {
  pointer-events: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 16px);
  padding: 8px 10px;
  border-radius: 10px;
  background: #18181b;
  border: 1px solid #3f3f46;
  color: #f4f4f5;
  font-size: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.dk-toast[hidden] {
  display: none;
}
.dk-toast-ok {
  border-color: #16a34a;
  background: #052e16;
  color: #dcfce7;
}
.dk-toast-err {
  border-color: #dc2626;
  background: #450a0a;
  color: #fee2e2;
}
.dk-toast a {
  color: #86efac;
  font-weight: 600;
  text-decoration: underline;
  white-space: nowrap;
}
.dk-popover {
  position: fixed;
  pointer-events: auto;
  width: 264px;
  max-width: calc(100vw - 16px);
  padding: 10px;
  border-radius: 10px;
  background: #18181b;
  border: 1px solid #3f3f46;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  color: #f4f4f5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 7;
}
.dk-popover[hidden] {
  display: none;
}
.dk-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
  color: #a1a1aa;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.dk-popover-head span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dk-popover-head:active {
  cursor: grabbing;
}
.dk-popover textarea {
  width: 100%;
  min-height: 56px;
  resize: vertical;
  border-radius: 6px;
  border: 1px solid #3f3f46;
  background: #09090b;
  color: #fafafa;
  font-family: inherit;
  font-size: 12px;
  padding: 6px 8px;
}
.dk-popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.dk-launcher {
  pointer-events: auto;
  align-self: flex-end;
  padding: 6px 10px;
  border-radius: 999px;
  background: #18181b;
  color: #fafafa;
  border: 1px solid #3f3f46;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.dk-launcher[hidden] {
  display: none;
}
@media (max-width: 640px), (pointer: coarse) {
  .dk-mode-banner {
    display: inline-flex;
  }
  .dk-marker {
    width: 28px;
    height: 28px;
    font-size: 12px;
  }
}
@media (max-width: 767px), (pointer: coarse) {
  .dk-popover textarea {
    font-size: 16px;
    line-height: 1.4;
    padding: 8px 10px;
  }
}
@media (max-width: 640px) {
  .dk-dock:not(.dk-pip-dock) {
    left: 8px;
    right: 8px;
    bottom: max(8px, env(safe-area-inset-bottom));
    max-width: none;
    align-items: stretch;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar {
    flex-direction: column;
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 6px;
    padding: 8px;
    max-width: 100%;
    width: 100%;
    border-radius: 14px;
  }
  .dk-dock:not(.dk-pip-dock) .dk-drag-handle {
    display: none;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-primary {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-primary > * {
    order: 0;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-primary .dk-btn {
    min-height: 36px;
    padding: 6px 10px;
    border-radius: 7px;
    flex-shrink: 0;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-primary .dk-btn-send {
    margin-left: auto;
  }
  .dk-dock:not(.dk-pip-dock) .dk-count-unit {
    display: none;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-secondary {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding-top: 6px;
    border-top: 1px solid #27272a;
    min-width: 0;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-secondary::-webkit-scrollbar {
    display: none;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-secondary > * {
    order: 0;
    flex-shrink: 0;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-secondary .dk-tools {
    flex-wrap: nowrap;
    gap: 4px;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-secondary .dk-btn {
    min-height: 32px;
    padding: 5px 9px;
    border-radius: 7px;
    flex-shrink: 0;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar[data-mode="browse"] .dk-bar-secondary {
    display: none;
  }
  .dk-dock:not(.dk-pip-dock) .dk-chips {
    justify-content: flex-start;
    max-width: 100%;
  }
  .dk-dock:not(.dk-pip-dock) .dk-toast {
    max-width: 100%;
  }
  .dk-popover {
    padding: 12px;
    border-radius: 12px;
    border-color: #52525b;
    gap: 10px;
  }
  .dk-popover-head {
    font-size: 12px;
    cursor: default;
  }
  .dk-popover-actions .dk-btn {
    min-height: 36px;
    padding: 6px 12px;
  }
}
@media (max-width: 360px) {
  .dk-dock:not(.dk-pip-dock) .dk-bar {
    padding: 6px;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-primary {
    gap: 4px;
  }
  .dk-dock:not(.dk-pip-dock) .dk-bar-primary .dk-btn {
    padding: 6px 7px;
  }
}
`;

function detectTheme(doc, win, pref) {
  if (pref === "dark" || pref === "light") return pref;
  try {
    const html = doc.documentElement;
    const body = doc.body;
    const attr =
      html?.getAttribute("data-theme") ||
      body?.getAttribute("data-theme") ||
      html?.getAttribute("data-color-scheme") ||
      "";
    if (
      /dark/i.test(attr) ||
      html?.classList?.contains("dark") ||
      body?.classList?.contains("dark")
    ) {
      return "dark";
    }
    if (/light/i.test(attr)) return "light";
    if (win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches) {
      return "dark";
    }
  } catch {
    // ignore
  }
  return "light";
}

function currentRoute(win) {
  try {
    const loc = win?.location;
    if (!loc) return "/";
    return sanitizeRoute(`${loc.pathname || "/"}${loc.search || ""}`);
  } catch {
    return "/";
  }
}

function currentViewport(win, doc) {
  return {
    width: Math.max(
      1,
      Math.round(win?.innerWidth || doc?.documentElement?.clientWidth || 1280),
    ),
    height: Math.max(
      1,
      Math.round(win?.innerHeight || doc?.documentElement?.clientHeight || 800),
    ),
    dpr: Number(win?.devicePixelRatio) || 1,
  };
}

function currentVisualViewport(win, doc) {
  const fallback = currentViewport(win, doc);
  const vv = win?.visualViewport;
  if (!vv || typeof vv.width !== "number" || typeof vv.height !== "number") {
    return {
      width: fallback.width,
      height: fallback.height,
      offsetLeft: 0,
      offsetTop: 0,
    };
  }
  return {
    width: Math.max(1, Math.round(vv.width)),
    height: Math.max(1, Math.round(vv.height)),
    offsetLeft: Number.isFinite(vv.offsetLeft) ? vv.offsetLeft : 0,
    offsetTop: Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0,
  };
}

function rectsIntersect(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function findOverlapsInRegion(doc, regionRect, ignoreHost) {
  if (
    !doc?.body ||
    !regionRect ||
    regionRect.width < 2 ||
    regionRect.height < 2
  ) {
    return { maxOverlapPx: 0, pairs: [], primaryEl: null };
  }

  const candidates = [];
  const win = doc.defaultView || globalThis;
  const all = doc.body.querySelectorAll("*");
  let count = 0;

  for (const el of all) {
    if (count >= 400) break;
    if (el === ignoreHost || ignoreHost?.contains?.(el)) continue;
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") continue;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (!r || r.width <= 0 || r.height <= 0) continue;
    const box = { x: r.left, y: r.top, width: r.width, height: r.height };
    if (!rectsIntersect(box, regionRect)) continue;
    let cs;
    try {
      cs = win.getComputedStyle(el);
    } catch {
      cs = null;
    }
    if (cs && (cs.display === "none" || cs.visibility === "hidden")) continue;

    // Only compare leaf-ish or positioned/interactive elements so containers don't falsely overlap children.
    const hasElementChildren = el.children && el.children.length > 0;
    const isLeafOrControl =
      !hasElementChildren ||
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      el.hasAttribute("data-testid");

    if (isLeafOrControl) {
      candidates.push({ el, selector: buildCssSelector(el), rect: box });
      count += 1;
    }
  }

  // Filter out direct ancestor-descendant pairs before pairwise overlap math.
  const entries = [];
  for (let i = 0; i < candidates.length; i += 1) {
    entries.push(candidates[i]);
  }

  const nonNestedPairs = [];
  let maxOverlapPx = 0;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (
        entries[i].el.contains(entries[j].el) ||
        entries[j].el.contains(entries[i].el)
      ) {
        continue;
      }
      const res = computePairwiseOverlaps([entries[i], entries[j]], 1);
      if (res.pairs.length > 0) {
        if (res.maxOverlapPx > maxOverlapPx) maxOverlapPx = res.maxOverlapPx;
        nonNestedPairs.push(res.pairs[0]);
      }
    }
  }

  nonNestedPairs.sort((a, b) => (b.overlapArea || 0) - (a.overlapArea || 0));
  return {
    maxOverlapPx,
    pairs: nonNestedPairs.slice(0, 8),
    primaryEl: entries[0]?.el || null,
  };
}

/**
 * Mount the live-app `<design-kit-annotator>` overlay into a browser document.
 */
export function mountAnnotator(options = {}) {
  const doc =
    options.document ||
    (typeof globalThis.document === "object" ? globalThis.document : null);
  const win =
    doc?.defaultView ||
    (typeof globalThis.window === "object" ? globalThis.window : null);
  if (!doc || !win) {
    throw new Error("mountAnnotator requires a browser document");
  }

  const container = options.container || doc.body || doc.documentElement;
  const storageKey =
    options.storageKey === false
      ? null
      : String(options.storageKey || DEFAULT_STORAGE_KEY);
  const sourceMapTimeoutMs =
    options.sourceMapTimeoutMs ?? DEFAULT_SOURCEMAP_TIMEOUT_MS;
  const sourceMapCache = new Map();

  let mode = options.initialMode === "annotate" ? "annotate" : "browse";
  let tool =
    options.initialTool === "box" ||
    options.initialTool === "arrow" ||
    options.initialTool === "freehand"
      ? options.initialTool
      : "pin";
  let open = options.initialOpen !== false;
  let sending = false;
  let activePopoverItemId = null;
  let items = [];
  let destroyed = false;
  // In-memory undo/redo history of queue snapshots. Each entry is the
  // `items` array as it was before (undo) or after (redo) a user change;
  // item objects are never mutated in place, so a shallow copy is enough.
  let undoStack = [];
  let redoStack = [];
  // Shape being drawn (pointer down, not yet released) in Annotate mode.
  let draft = null;
  const applePlatform = isApplePlatform(win);

  // Restore persisted queue from sessionStorage
  if (storageKey) {
    try {
      const saved = win.sessionStorage?.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          items = parsed.map((it, idx) => ({ ...it, index: idx + 1 }));
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  function persistQueue() {
    if (!storageKey) return;
    try {
      win.sessionStorage?.setItem(storageKey, JSON.stringify(items));
    } catch {
      // Retry without PNG payloads if sessionStorage quota is exceeded
      try {
        const slim = items.map((it) => {
          const copy = { ...it };
          delete copy.snapshot;
          return copy;
        });
        win.sessionStorage?.setItem(storageKey, JSON.stringify(slim));
      } catch {
        // ignore
      }
    }
  }

  // Create host with CLOSED Shadow Root
  const host = doc.createElement(HOST_TAG);
  host.setAttribute("data-design-kit-annotator", "1");
  const shadow = host.attachShadow({ mode: "closed" });

  // Plain typing in the overlay's own fields stays inside it. Outside the
  // closed root a key arrives retargeted to the host, so a host shortcut
  // that only spares keys from fields (the plan canvas's Space-to-pan)
  // would take the note's spaces (#25258). Keys with Ctrl/Meta/Alt still
  // reach the host for its own shortcuts (Cmd/Ctrl+Shift+X), and Escape
  // still does, already handled by the overlay's capture-phase listener.
  const keepTypingInside = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") return;
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (isNativeUndoTarget(path[0] || event.target)) event.stopPropagation();
  };
  for (const type of ["keydown", "keypress", "keyup"]) {
    shadow.addEventListener(type, keepTypingInside);
  }

  const styleEl = doc.createElement("style");
  styleEl.textContent = OVERLAY_CSS;
  shadow.appendChild(styleEl);

  const root = doc.createElement("div");
  root.className = "dk-root";
  shadow.appendChild(root);

  const captureLayer = doc.createElement("div");
  captureLayer.className = "dk-capture";
  captureLayer.hidden = true;
  root.appendChild(captureLayer);

  const modeBanner = doc.createElement("button");
  modeBanner.type = "button";
  modeBanner.className = "dk-mode-banner";
  modeBanner.setAttribute("aria-label", "Switch to Browse mode");
  modeBanner.hidden = true;
  const modeBannerDot = doc.createElement("span");
  modeBannerDot.className = "dk-mode-banner-dot";
  modeBannerDot.setAttribute("aria-hidden", "true");
  const modeBannerText = doc.createElement("span");
  modeBannerText.textContent = "Annotating";
  const modeBannerSub = doc.createElement("span");
  modeBannerSub.className = "dk-mode-banner-sub";
  modeBannerSub.textContent = "· Tap to Browse";
  modeBanner.append(modeBannerDot, modeBannerText, modeBannerSub);
  root.appendChild(modeBanner);

  const svgNs = "http://www.w3.org/2000/svg";
  const svgLayer = doc.createElementNS(svgNs, "svg");
  svgLayer.setAttribute("class", "dk-svg-layer");
  const committedSvgGroup = doc.createElementNS(svgNs, "g");
  committedSvgGroup.setAttribute("class", "dk-svg-committed");
  const draftSvgGroup = doc.createElementNS(svgNs, "g");
  draftSvgGroup.setAttribute("class", "dk-svg-draft");
  svgLayer.appendChild(committedSvgGroup);
  svgLayer.appendChild(draftSvgGroup);
  root.appendChild(svgLayer);

  const markersLayer = doc.createElement("div");
  markersLayer.className = "dk-markers";
  root.appendChild(markersLayer);

  // Note popover
  const popover = doc.createElement("div");
  popover.className = "dk-popover";
  popover.hidden = true;
  const popHead = doc.createElement("div");
  popHead.className = "dk-popover-head";
  const popTitle = doc.createElement("span");
  const popClose = doc.createElement("button");
  popClose.type = "button";
  popClose.className = "dk-chip-del";
  popClose.textContent = "×";
  popClose.setAttribute("aria-label", "Close note");
  popHead.append(popTitle, popClose);

  const popInput = doc.createElement("textarea");
  popInput.placeholder = "Describe what should change…";
  popInput.setAttribute("aria-label", "Annotation note");

  const popActions = doc.createElement("div");
  popActions.className = "dk-popover-actions";
  const popCancel = doc.createElement("button");
  popCancel.type = "button";
  popCancel.className = "dk-btn dk-btn-subtle";
  popCancel.textContent = "Done";
  const popSave = doc.createElement("button");
  popSave.type = "button";
  popSave.className = "dk-btn dk-btn-send";
  popSave.textContent = "Save note";
  popActions.append(popCancel, popSave);

  popover.append(popHead, popInput, popActions);
  root.appendChild(popover);

  // Floating dock (toast + chips + bar + launcher)
  const dock = doc.createElement("div");
  dock.className = "dk-dock";
  root.appendChild(dock);

  const toast = doc.createElement("div");
  toast.className = "dk-toast";
  toast.setAttribute("role", "status");
  toast.hidden = true;
  const toastText = doc.createElement("span");
  const toastLink = doc.createElement("a");
  toastLink.target = "_blank";
  toastLink.rel = "noopener noreferrer";
  toastLink.hidden = true;
  const toastDismiss = doc.createElement("button");
  toastDismiss.type = "button";
  toastDismiss.className = "dk-chip-del";
  toastDismiss.textContent = "×";
  toastDismiss.setAttribute("aria-label", "Dismiss status");
  toast.append(toastText, toastLink, toastDismiss);
  dock.appendChild(toast);
  toastLink.addEventListener("click", (event) => {
    if (!toastLink.href) return;
    event.preventDefault();
    openRun();
  });

  const chipsWrap = doc.createElement("div");
  chipsWrap.className = "dk-chips";
  chipsWrap.hidden = true;
  dock.appendChild(chipsWrap);

  const bar = doc.createElement("div");
  bar.className = "dk-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Screen annotator");
  dock.appendChild(bar);

  const dragHandle = doc.createElement("span");
  dragHandle.className = "dk-drag-handle";
  dragHandle.textContent = "⋮⋮";
  dragHandle.setAttribute("role", "presentation");
  dragHandle.setAttribute("aria-label", "Drag annotator toolbar");
  dragHandle.title = "Drag to move toolbar";

  const modeSeg = doc.createElement("div");
  modeSeg.className = "dk-seg";
  modeSeg.setAttribute("role", "tablist");
  const btnBrowse = doc.createElement("button");
  btnBrowse.type = "button";
  btnBrowse.className = "dk-btn";
  btnBrowse.textContent = "Browse";
  const btnAnnotate = doc.createElement("button");
  btnAnnotate.type = "button";
  btnAnnotate.className = "dk-btn dk-btn-annotate";
  btnAnnotate.textContent = "Annotate";
  modeSeg.append(btnBrowse, btnAnnotate);

  const toolsWrap = doc.createElement("div");
  toolsWrap.className = "dk-tools";
  const toolButtons = {};
  const toolDefs = [
    ["pin", "Pin"],
    ["box", "Region Box"],
    ["arrow", "Move Arrow"],
    ["freehand", "Freehand"],
  ];
  for (const [id, label] of toolDefs) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "dk-btn";
    b.textContent = label;
    b.addEventListener("click", () => setTool(id));
    toolButtons[id] = b;
    toolsWrap.appendChild(b);
  }

  const shortcutMod = applePlatform ? "⌘" : "Ctrl+";
  const btnUndo = doc.createElement("button");
  btnUndo.type = "button";
  btnUndo.className = "dk-btn dk-btn-undo";
  btnUndo.textContent = "Undo";
  btnUndo.title = `Undo (${shortcutMod}Z)`;
  btnUndo.setAttribute("aria-label", "Undo");
  btnUndo.disabled = true;

  const btnRedo = doc.createElement("button");
  btnRedo.type = "button";
  btnRedo.className = "dk-btn dk-btn-redo";
  btnRedo.textContent = "Redo";
  btnRedo.title = applePlatform ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Shift+Z)";
  btnRedo.setAttribute("aria-label", "Redo");
  btnRedo.disabled = true;

  const countBadge = doc.createElement("span");
  countBadge.className = "dk-count";
  const countNum = doc.createElement("span");
  countNum.className = "dk-count-num";
  const countUnit = doc.createElement("span");
  countUnit.className = "dk-count-unit";
  countBadge.append(countNum, countUnit);

  const btnCopy = doc.createElement("button");
  btnCopy.type = "button";
  btnCopy.className = "dk-btn dk-btn-subtle dk-btn-copy";
  btnCopy.textContent = "Copy";
  btnCopy.title = "Copy redline packet";

  const btnSend = doc.createElement("button");
  btnSend.type = "button";
  btnSend.className = "dk-btn dk-btn-send";
  btnSend.textContent = "Send to Fix";

  const canDocPip =
    typeof win.documentPictureInPicture?.requestWindow === "function";
  const hasHostPopOut = typeof options.onPopOut === "function";
  const btnPopOut = doc.createElement("button");
  btnPopOut.type = "button";
  btnPopOut.className = "dk-btn dk-btn-popout";
  btnPopOut.textContent = "↗";
  btnPopOut.title = "Pop out toolbar outside app window";
  btnPopOut.setAttribute("aria-label", "Pop out toolbar");
  btnPopOut.hidden = !(canDocPip || hasHostPopOut);

  const btnCollapse = doc.createElement("button");
  btnCollapse.type = "button";
  btnCollapse.className = "dk-btn dk-btn-collapse";
  btnCollapse.textContent = "×";
  btnCollapse.setAttribute("aria-label", "Collapse annotator");

  const barPrimary = doc.createElement("div");
  barPrimary.className = "dk-bar-primary";
  barPrimary.append(
    dragHandle,
    modeSeg,
    countBadge,
    btnSend,
    btnPopOut,
    btnCollapse,
  );

  const barSecondary = doc.createElement("div");
  barSecondary.className = "dk-bar-secondary";
  barSecondary.append(toolsWrap, btnUndo, btnRedo, btnCopy);

  bar.append(barPrimary, barSecondary);

  const launcher = doc.createElement("button");
  launcher.type = "button";
  launcher.className = "dk-launcher";
  launcher.textContent = "Annotate";
  launcher.hidden = true;
  dock.appendChild(launcher);

  // Control map for coordinate queries (without exposing closed shadowRoot)
  const controls = {
    "mode-banner": modeBanner,
    "mode-browse": btnBrowse,
    "mode-annotate": btnAnnotate,
    "tool-pin": toolButtons.pin,
    "tool-box": toolButtons.box,
    "tool-arrow": toolButtons.arrow,
    "tool-freehand": toolButtons.freehand,
    "send-fix": btnSend,
    undo: btnUndo,
    redo: btnRedo,
    "copy-packet": btnCopy,
    "pop-out": btnPopOut,
    "drag-handle": dragHandle,
    collapse: btnCollapse,
    launcher,
    "note-input": popInput,
    "note-save": popSave,
    popover,
    toast,
    "toast-link": toastLink,
    bar,
  };

  function showToast(kind, message, runUrl) {
    toast.className =
      kind === "ok"
        ? "dk-toast dk-toast-ok"
        : kind === "error"
          ? "dk-toast dk-toast-err"
          : "dk-toast";
    toastText.textContent = message;
    const safeUrl = resolveRunUrl(runUrl);
    if (safeUrl) {
      toastLink.href = safeUrl;
      toastLink.textContent = "Open run ↗";
      toastLink.hidden = false;
    } else {
      toastLink.hidden = true;
      toastLink.removeAttribute("href");
    }
    toast.hidden = false;
  }

  function hideToast() {
    toast.hidden = true;
  }

  /**
   * Resolve a run URL to an absolute http(s) URL. A relative path resolves
   * against `options.runUrlBase` or the host page's own address — never the
   * document the toast happens to sit in (a popped-out toolbar's document is
   * `about:blank`). Unsafe schemes resolve to undefined.
   */
  function resolveRunUrl(rawUrl) {
    const safe = sanitizeRunUrl(rawUrl);
    if (!safe) return undefined;
    try {
      const base =
        typeof options.runUrlBase === "string" && options.runUrlBase
          ? options.runUrlBase
          : win.location.href;
      const resolved = new URL(safe, base);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        return resolved.href;
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  /** The toast's absolute run URL, or "" when no run link is showing. */
  function currentRunUrl() {
    return toast.hidden || toastLink.hidden ? "" : toastLink.href || "";
  }

  /**
   * Open the run the toast links to: through the host's `onOpenRun` when
   * given, otherwise in a new tab opened from the host page's window (so a
   * popped-out toolbar never navigates its own `about:blank` window).
   */
  function openRun() {
    const url = currentRunUrl();
    if (!url) return false;
    if (typeof options.onOpenRun === "function") {
      try {
        options.onOpenRun(url);
      } catch {
        // host handler errors must not break the overlay
      }
      return true;
    }
    try {
      win.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // popup blocked or unavailable
    }
    return true;
  }

  let lastPopoverAnchor = { x: 16, y: 16 };

  function clampPopover(anchorX, anchorY) {
    const vp = currentViewport(win, doc);
    const pad = 8;
    if (vp.width <= 640) {
      const vv = currentVisualViewport(win, doc);
      const sheetWidth = Math.max(120, Math.min(vp.width, vv.width) - pad * 2);
      popover.style.width = `${sheetWidth}px`;
      popover.style.maxWidth = `${sheetWidth}px`;
      popover.style.left = `${Math.round(vv.offsetLeft + pad)}px`;
      popover.style.top = `${Math.round(vv.offsetTop + pad)}px`;
      const rect = popover.getBoundingClientRect();
      const h = rect.height || 160;
      let bottomLimit = vv.offsetTop + vv.height;
      if (!bar.hidden && !dockHidden && !pipWindow) {
        const barRect = bar.getBoundingClientRect();
        if (
          barRect.height > 0 &&
          barRect.top > vv.offsetTop + pad &&
          barRect.top < bottomLimit
        ) {
          bottomLimit = barRect.top;
        }
      }
      const top = Math.max(vv.offsetTop + pad, bottomLimit - h - pad);
      popover.style.top = `${Math.round(top)}px`;
      return;
    }
    popover.style.width = "";
    const maxW = Math.max(120, vp.width - pad * 2);
    popover.style.maxWidth = `${maxW}px`;
    popover.style.left = `${pad}px`;
    popover.style.top = `${pad}px`;
    const rect = popover.getBoundingClientRect();
    const w = Math.min(rect.width || 264, maxW);
    const h = rect.height || 132;
    const left = Math.max(pad, Math.min(anchorX + 12, vp.width - w - pad));
    const top = Math.max(pad, Math.min(anchorY + 12, vp.height - h - pad));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function openPopoverForItem(item, anchorX, anchorY) {
    activePopoverItemId = item.id;
    lastPopoverAnchor = { x: anchorX, y: anchorY };
    popTitle.textContent = `#${item.index} · ${item.kind} · ${item.route}`;
    popInput.value = item.note || "";
    popover.hidden = false;
    clampPopover(anchorX, anchorY);
    try {
      popInput.focus({ preventScroll: true });
    } catch {
      popInput.focus();
    }
  }

  function closePopover() {
    activePopoverItemId = null;
    // Drop focus from the note so a hidden textarea never keeps swallowing
    // keys (the undo shortcut leaves focused text fields alone).
    const focused = shadow.activeElement;
    if (focused && popover.contains(focused)) focused.blur?.();
    popover.hidden = true;
  }

  function saveActiveNote() {
    if (!activePopoverItemId) return;
    const idx = items.findIndex((i) => i.id === activePopoverItemId);
    if (idx !== -1) {
      const item = items[idx];
      const nextNote = popInput.value.trim();
      if ((item.note || "") !== nextNote) {
        recordHistory(`edited note #${item.index}`);
        // Replace the item object so history snapshots keep the old note.
        items = items.slice();
        items[idx] = { ...item, note: nextNote };
        persistQueue();
        render();
        options.onItemsChange?.(items.slice());
      }
    }
    closePopover();
  }

  function describeItem(item) {
    const kind =
      item.kind === "box"
        ? "region"
        : item.kind === "arrow"
          ? "arrow"
          : item.kind === "freehand"
            ? "drawing"
            : "pin";
    return `${kind} #${item.index}`;
  }

  /** Save the queue as it is now, before a user change, as one undo step. */
  function recordHistory(label) {
    undoStack.push({ items: items.slice(), label });
    if (undoStack.length > MAX_HISTORY_STEPS) {
      undoStack.splice(0, undoStack.length - MAX_HISTORY_STEPS);
    }
    redoStack = [];
  }

  function resetHistory() {
    undoStack = [];
    redoStack = [];
  }

  function applyHistorySnapshot(snapshotItems) {
    items = snapshotItems.map((it, idx) =>
      it.index === idx + 1 ? it : { ...it, index: idx + 1 },
    );
    if (
      activePopoverItemId &&
      !items.some((it) => it.id === activePopoverItemId)
    ) {
      closePopover();
    }
    persistQueue();
    render();
    options.onItemsChange?.(items.slice());
  }

  function undo() {
    if (draft) {
      draft = null;
      clearDraftSvg();
      return true;
    }
    const entry = undoStack.pop();
    if (!entry) return false;
    if (!popover.hidden) closePopover();
    redoStack.push({ items: items.slice(), label: entry.label });
    applyHistorySnapshot(entry.items);
    showToast("pending", `Undid: ${entry.label}`);
    render();
    return true;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return false;
    if (!popover.hidden) closePopover();
    undoStack.push({ items: items.slice(), label: entry.label });
    applyHistorySnapshot(entry.items);
    showToast("pending", `Redid: ${entry.label}`);
    render();
    return true;
  }

  // Hit-test underlying page element ignoring the annotator host
  function hitTestElement(x, y) {
    const prevCapture = captureLayer.style.pointerEvents;
    captureLayer.style.pointerEvents = "none";
    let found = null;
    try {
      const list =
        typeof doc.elementsFromPoint === "function"
          ? doc.elementsFromPoint(x, y)
          : [];
      for (const el of list) {
        if (el && el !== host && !host.contains(el)) {
          found = el;
          break;
        }
      }
      if (!found && typeof doc.elementFromPoint === "function") {
        const single = doc.elementFromPoint(x, y);
        if (single && single !== host && !host.contains(single)) found = single;
      }
    } finally {
      captureLayer.style.pointerEvents = prevCapture;
    }
    return found;
  }

  function clearDraftSvg() {
    while (draftSvgGroup.firstChild)
      draftSvgGroup.removeChild(draftSvgGroup.firstChild);
  }

  function appendArrowSvg(targetGroup, x1, y1, x2, y2, itemId) {
    const line = doc.createElementNS(svgNs, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", "#ef4444");
    line.setAttribute("stroke-width", "3");
    if (itemId) line.setAttribute("data-item-id", itemId);
    targetGroup.appendChild(line);

    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist >= 4) {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = 12;
      const p1x = x2 - headLen * Math.cos(angle - Math.PI / 6);
      const p1y = y2 - headLen * Math.sin(angle - Math.PI / 6);
      const p2x = x2 - headLen * Math.cos(angle + Math.PI / 6);
      const p2y = y2 - headLen * Math.sin(angle + Math.PI / 6);
      const head = doc.createElementNS(svgNs, "polygon");
      head.setAttribute("points", `${x2},${y2} ${p1x},${p1y} ${p2x},${p2y}`);
      head.setAttribute("fill", "#ef4444");
      if (itemId) head.setAttribute("data-item-id", itemId);
      targetGroup.appendChild(head);
    }
  }

  function renderCommittedShapes() {
    while (committedSvgGroup.firstChild) {
      committedSvgGroup.removeChild(committedSvgGroup.firstChild);
    }
    if (!open) return;

    const routeNow = currentRoute(win);
    for (const item of items) {
      if (item.route !== routeNow) continue;
      if (
        item.kind === "freehand" &&
        Array.isArray(item.points) &&
        item.points.length > 1
      ) {
        const poly = doc.createElementNS(svgNs, "polyline");
        poly.setAttribute(
          "points",
          item.points.map((p) => `${p.x},${p.y}`).join(" "),
        );
        poly.setAttribute("fill", "none");
        poly.setAttribute("stroke", "#ef4444");
        poly.setAttribute("stroke-width", "3");
        poly.setAttribute("stroke-linecap", "round");
        poly.setAttribute("stroke-linejoin", "round");
        poly.setAttribute("data-item-id", item.id);
        committedSvgGroup.appendChild(poly);
      } else if (item.kind === "box" && item.rect) {
        const r = doc.createElementNS(svgNs, "rect");
        r.setAttribute("x", String(item.rect.x));
        r.setAttribute("y", String(item.rect.y));
        r.setAttribute("width", String(item.rect.width));
        r.setAttribute("height", String(item.rect.height));
        r.setAttribute("fill", "rgba(239, 68, 68, 0.14)");
        r.setAttribute("stroke", "#ef4444");
        r.setAttribute("stroke-width", "2");
        r.setAttribute("stroke-dasharray", "6 4");
        r.setAttribute("data-item-id", item.id);
        committedSvgGroup.appendChild(r);
      } else if (item.kind === "arrow") {
        const fromPt = item.from?.rect
          ? {
              x: item.from.rect.x + item.from.rect.width / 2,
              y: item.from.rect.y + item.from.rect.height / 2,
            }
          : item.point;
        const toPt = item.to?.rect
          ? {
              x: item.to.rect.x + item.to.rect.width / 2,
              y: item.to.rect.y + item.to.rect.height / 2,
            }
          : item.toPoint;
        if (fromPt && toPt) {
          appendArrowSvg(
            committedSvgGroup,
            fromPt.x,
            fromPt.y,
            toPt.x,
            toPt.y,
            item.id,
          );
        }
      }
    }
  }

  function renderDraftPreview(draft) {
    clearDraftSvg();
    if (!draft) return;

    if (draft.kind === "box") {
      const x = Math.min(draft.startX, draft.curX);
      const y = Math.min(draft.startY, draft.curY);
      const w = Math.abs(draft.curX - draft.startX);
      const h = Math.abs(draft.curY - draft.startY);
      const r = doc.createElementNS(svgNs, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("y", String(y));
      r.setAttribute("width", String(w));
      r.setAttribute("height", String(h));
      r.setAttribute("fill", "rgba(239, 68, 68, 0.14)");
      r.setAttribute("stroke", "#ef4444");
      r.setAttribute("stroke-width", "2");
      r.setAttribute("stroke-dasharray", "6 4");
      draftSvgGroup.appendChild(r);
    } else if (draft.kind === "arrow") {
      appendArrowSvg(
        draftSvgGroup,
        draft.startX,
        draft.startY,
        draft.curX,
        draft.curY,
        null,
      );
    } else if (draft.kind === "freehand" && draft.points.length > 1) {
      const poly = doc.createElementNS(svgNs, "polyline");
      poly.setAttribute(
        "points",
        draft.points.map((p) => `${p.x},${p.y}`).join(" "),
      );
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", "#ef4444");
      poly.setAttribute("stroke-width", "3");
      poly.setAttribute("stroke-linecap", "round");
      poly.setAttribute("stroke-linejoin", "round");
      draftSvgGroup.appendChild(poly);
    }
  }

  function isCoarseOrNarrowViewport() {
    const vp = currentViewport(win, doc);
    if (vp.width <= 640) return true;
    try {
      return Boolean(win.matchMedia?.("(pointer: coarse)")?.matches);
    } catch {
      return false;
    }
  }

  function renderMarkers() {
    while (markersLayer.firstChild)
      markersLayer.removeChild(markersLayer.firstChild);
    if (!open) return;

    const routeNow = currentRoute(win);
    const vp = currentViewport(win, doc);
    const markerSize = isCoarseOrNarrowViewport() ? 28 : 22;
    const half = markerSize / 2;
    const pad = half;

    for (const item of items) {
      if (item.route !== routeNow) continue;
      let ax = 20;
      let ay = 20;
      if (item.point) {
        ax = item.point.x;
        ay = item.point.y;
      } else if (item.rect) {
        ax = item.rect.x;
        ay = item.rect.y;
      } else if (item.from?.rect) {
        ax = item.from.rect.x;
        ay = item.from.rect.y;
      } else if (item.points?.[0]) {
        ax = item.points[0].x;
        ay = item.points[0].y;
      }
      // Strictly clamp marker badge within [0, vp.width] x [0, vp.height]
      const cx = Math.max(pad, Math.min(ax, vp.width - pad));
      const cy = Math.max(pad, Math.min(ay, vp.height - pad));

      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "dk-marker";
      btn.textContent = String(item.index);
      btn.style.left = `${Math.round(cx - half)}px`;
      btn.style.top = `${Math.round(cy - half)}px`;
      btn.title = item.note || `#${item.index} (${item.kind})`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openPopoverForItem(item, cx, cy);
      });
      markersLayer.appendChild(btn);
    }
  }

  function render() {
    if (destroyed) return;

    const annotateActive = open && mode === "annotate";
    bar.hidden = !open;
    bar.setAttribute("data-mode", mode);
    launcher.hidden = open || options.showLauncher === false;
    captureLayer.hidden = !annotateActive;
    captureLayer.setAttribute("data-tool", tool);
    modeBanner.hidden = !annotateActive;

    btnBrowse.setAttribute("aria-selected", String(mode === "browse"));
    btnAnnotate.setAttribute("aria-selected", String(mode === "annotate"));
    toolsWrap.hidden = mode !== "annotate";

    for (const [id, b] of Object.entries(toolButtons)) {
      b.setAttribute("aria-pressed", String(tool === id));
    }

    const n = items.length;
    countNum.textContent = String(n);
    countUnit.textContent = n === 1 ? " redline" : " redlines";
    btnSend.disabled = sending || n === 0;
    btnCopy.disabled = n === 0;
    btnSend.textContent = sending ? "Sending…" : "Send to Fix";
    btnUndo.disabled = sending || undoStack.length === 0;
    btnRedo.disabled = sending || redoStack.length === 0;

    // Render chip tray
    while (chipsWrap.firstChild) chipsWrap.removeChild(chipsWrap.firstChild);
    chipsWrap.hidden = !open || n === 0;
    for (const item of items) {
      const chip = doc.createElement("span");
      chip.className = "dk-chip";
      const num = doc.createElement("span");
      num.className = "dk-chip-num";
      num.textContent = String(item.index);
      const label = doc.createElement("span");
      const summary = item.note
        ? `${item.route} — ${item.note}`
        : `${item.route} · ${item.selector || item.kind}`;
      label.textContent = summary.slice(0, 64);
      const del = doc.createElement("button");
      del.type = "button";
      del.className = "dk-chip-del";
      del.textContent = "×";
      del.setAttribute("aria-label", `Remove redline ${item.index}`);
      del.addEventListener("click", () => removeItem(item.id));
      chip.append(num, label, del);
      chipsWrap.appendChild(chip);
    }

    renderCommittedShapes();
    renderMarkers();
    options.onStateChange?.(getStateSnapshot());
  }

  // Capture-phase keyboard listener ONLY attached while Annotate mode is active
  let keydownAttached = false;
  function handleAnnotateKeydown(event) {
    if (event.key === "Escape") {
      if (!popover.hidden) {
        event.preventDefault();
        closePopover();
      } else if (draft) {
        event.preventDefault();
        draft = null;
        clearDraftSvg();
      } else {
        setMode("browse");
      }
    }
  }

  // Undo/redo shortcut: attached while the overlay is open (either mode) on
  // the host document, and on the popped-out toolbar's document.
  function handleHistoryKeydown(event) {
    if (event.defaultPrevented || sending) return;
    const action = historyShortcutOf(event);
    if (!action) return;
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    const target = path[0] || event.target;
    if (isNativeUndoTarget(target)) return;
    const ownerDoc = target?.ownerDocument || doc;
    if (isNativeUndoTarget(ownerDoc.activeElement)) return;
    const shadowFocus = shadow.activeElement;
    if (
      shadowFocus &&
      (isNativeUndoTarget(shadowFocus) ||
        (!popover.hidden && popover.contains(shadowFocus)))
    ) {
      return;
    }
    const handled = action === "undo" ? undo() : redo();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  let historyKeydownAttached = false;
  let pipKeydownDoc = null;
  function syncListeners() {
    const shouldAttach = open && mode === "annotate" && !destroyed;
    if (shouldAttach && !keydownAttached) {
      doc.addEventListener("keydown", handleAnnotateKeydown, true);
      keydownAttached = true;
    } else if (!shouldAttach && keydownAttached) {
      doc.removeEventListener("keydown", handleAnnotateKeydown, true);
      keydownAttached = false;
    }
    const shouldAttachHistory = open && !destroyed;
    if (shouldAttachHistory && !historyKeydownAttached) {
      doc.addEventListener("keydown", handleHistoryKeydown, true);
      historyKeydownAttached = true;
    } else if (!shouldAttachHistory && historyKeydownAttached) {
      doc.removeEventListener("keydown", handleHistoryKeydown, true);
      historyKeydownAttached = false;
    }
    const nextPipDoc =
      shouldAttachHistory && pipWindow && !pipWindow.closed
        ? pipWindow.document
        : null;
    if (pipKeydownDoc !== nextPipDoc) {
      pipKeydownDoc?.removeEventListener("keydown", handleHistoryKeydown, true);
      nextPipDoc?.addEventListener("keydown", handleHistoryKeydown, true);
      pipKeydownDoc = nextPipDoc;
    }
  }

  // Pointer interaction on captureLayer (only active when mode === "annotate")

  captureLayer.addEventListener("pointerdown", (e) => {
    if (mode !== "annotate" || !open) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const isTouchPin = e.pointerType === "touch" && tool === "pin";
    if (!isTouchPin) {
      e.preventDefault();
    }
    e.stopPropagation();

    const x = Math.round(e.clientX);
    const y = Math.round(e.clientY);
    const startEl = hitTestElement(x, y);

    draft = {
      kind: tool,
      pointerType: e.pointerType,
      startX: x,
      startY: y,
      curX: x,
      curY: y,
      startEl,
      points: [{ x, y }],
    };

    if (!isTouchPin) {
      try {
        captureLayer.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore synthetic events without active pointerId
      }
    }
    renderDraftPreview(draft);
  });

  captureLayer.addEventListener("pointermove", (e) => {
    if (!draft) return;
    if (!(draft.kind === "pin" && e.pointerType === "touch")) {
      e.preventDefault();
    }
    const x = Math.round(e.clientX);
    const y = Math.round(e.clientY);
    draft.curX = x;
    draft.curY = y;
    if (
      draft.kind === "freehand" &&
      draft.points.length < MAX_FREEHAND_POINTS
    ) {
      const prev = draft.points[draft.points.length - 1];
      if (!prev || Math.hypot(x - prev.x, y - prev.y) >= 3) {
        draft.points.push({ x, y });
      }
    }
    renderDraftPreview(draft);
  });

  async function finalizeDraft(d) {
    clearDraftSvg();
    const route = currentRoute(win);
    const viewport = currentViewport(win, doc);
    const theme = detectTheme(doc, win, options.theme);
    const index = items.length + 1;
    const id = `rl-${Date.now()}-${index}`;

    const item = {
      id,
      index,
      kind: d.kind,
      note: "",
      route,
      createdAt: new Date().toISOString(),
      viewport,
      theme,
      sourceHints: [],
      owners: [],
    };

    let primaryEl = d.startEl;
    let anchorX = d.curX;
    let anchorY = d.curY;

    if (d.kind === "pin") {
      item.point = { x: d.startX, y: d.startY };
      if (primaryEl && typeof primaryEl.getBoundingClientRect === "function") {
        const r = primaryEl.getBoundingClientRect();
        item.rect = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }
      anchorX = d.startX;
      anchorY = d.startY;
    } else if (d.kind === "box") {
      const rx = Math.min(d.startX, d.curX);
      const ry = Math.min(d.startY, d.curY);
      const rw = Math.max(4, Math.abs(d.curX - d.startX));
      const rh = Math.max(4, Math.abs(d.curY - d.startY));
      item.rect = { x: rx, y: ry, width: rw, height: rh };
      const ov = findOverlapsInRegion(doc, item.rect, host);
      item.overlapPx = ov.maxOverlapPx;
      if (ov.pairs.length > 0) item.overlaps = ov.pairs;
      if (ov.primaryEl) primaryEl = ov.primaryEl;
      anchorX = rx + rw;
      anchorY = ry;
    } else if (d.kind === "arrow") {
      const endEl = hitTestElement(d.curX, d.curY);
      const fromMeta = d.startEl
        ? await extractSourceHints(d.startEl, {
            timeoutMs: sourceMapTimeoutMs,
            sourceMapCache,
          })
        : null;
      const toMeta = endEl
        ? await extractSourceHints(endEl, {
            timeoutMs: sourceMapTimeoutMs,
            sourceMapCache,
          })
        : null;
      const fromRect = d.startEl?.getBoundingClientRect?.();
      const toRect = endEl?.getBoundingClientRect?.();
      item.point = { x: d.startX, y: d.startY };
      item.toPoint = { x: d.curX, y: d.curY };
      item.from = {
        selector: fromMeta?.selector || "",
        tag: d.startEl?.tagName?.toLowerCase?.() || "",
        rect: fromRect
          ? {
              x: Math.round(fromRect.left),
              y: Math.round(fromRect.top),
              width: Math.round(fromRect.width),
              height: Math.round(fromRect.height),
            }
          : { x: d.startX, y: d.startY, width: 1, height: 1 },
        sourceHints: fromMeta?.sourceHints || [],
        owners: fromMeta?.owners || [],
      };
      item.to = {
        selector: toMeta?.selector || "",
        tag: endEl?.tagName?.toLowerCase?.() || "",
        rect: toRect
          ? {
              x: Math.round(toRect.left),
              y: Math.round(toRect.top),
              width: Math.round(toRect.width),
              height: Math.round(toRect.height),
            }
          : { x: d.curX, y: d.curY, width: 1, height: 1 },
        sourceHints: toMeta?.sourceHints || [],
        owners: toMeta?.owners || [],
      };
      anchorX = d.curX;
      anchorY = d.curY;
    } else if (d.kind === "freehand") {
      item.points = d.points.slice(0, MAX_FREEHAND_POINTS);
      item.point = item.points[0] || { x: d.startX, y: d.startY };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const pt of item.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
      if (Number.isFinite(minX) && maxX - minX > 2 && maxY - minY > 2) {
        item.rect = {
          x: Math.round(minX),
          y: Math.round(minY),
          width: Math.round(maxX - minX),
          height: Math.round(maxY - minY),
        };
      }
      const startTag = String(primaryEl?.tagName || "").toLowerCase();
      if (!primaryEl || startTag === "html" || startTag === "body") {
        // When the user circles an element starting on whitespace, hit-test
        // the center of the freehand bounding box and then the stroke midpoint.
        const probes = [];
        if (Number.isFinite(minX)) {
          probes.push({
            x: Math.round((minX + maxX) / 2),
            y: Math.round((minY + maxY) / 2),
          });
        }
        const midPt = item.points[Math.floor(item.points.length / 2)];
        if (midPt) probes.push(midPt);
        for (const probe of probes) {
          const hit = hitTestElement(probe.x, probe.y);
          const hitTag = String(hit?.tagName || "").toLowerCase();
          if (hit && hitTag !== "html" && hitTag !== "body") {
            primaryEl = hit;
            break;
          }
        }
      }
      anchorX = d.curX;
      anchorY = d.curY;
    }

    if (primaryEl) {
      const meta = await extractSourceHints(primaryEl, {
        timeoutMs: sourceMapTimeoutMs,
        sourceMapCache,
      });
      item.selector = meta.selector;
      item.outerHtml = meta.outerHtml;
      item.computedStyle = meta.computedStyle;
      item.sourceHints = meta.sourceHints;
      item.owners = meta.owners;
    }

    // Immediate per-step composited callout PNG snapshot including all
    // persistent annotations currently visible on this route.
    const currentRouteAnnotations = [
      ...items.filter((it) => it.route === route),
      item,
    ];
    let snapshot;
    if (typeof options.captureScreenshot === "function") {
      try {
        const baseDataUrl = await options.captureScreenshot();
        if (baseDataUrl) {
          snapshot = await compositeAnnotationsOnImage(baseDataUrl, item, {
            document: doc,
            allAnnotations: currentRouteAnnotations,
          });
        }
      } catch {
        snapshot = undefined;
      }
    }
    if (!snapshot) {
      snapshot = captureCalloutSnapshot(item, {
        document: doc,
        ignoreTag: HOST_TAG,
        allAnnotations: currentRouteAnnotations,
      });
    }
    if (snapshot) {
      item.snapshot = snapshot;
    }

    if (destroyed) return;
    recordHistory(`added ${describeItem(item)}`);
    items = [...items, item];
    persistQueue();
    render();
    options.onItemsChange?.(items.slice());
    openPopoverForItem(item, anchorX, anchorY);
  }

  captureLayer.addEventListener("pointerup", (e) => {
    if (!draft) return;
    const completed = draft;
    completed.curX = Math.round(e.clientX);
    completed.curY = Math.round(e.clientY);
    draft = null;
    if (
      completed.kind === "pin" &&
      (e.pointerType === "touch" || completed.pointerType === "touch") &&
      Math.hypot(
        completed.curX - completed.startX,
        completed.curY - completed.startY,
      ) > 12
    ) {
      clearDraftSvg();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    void finalizeDraft(completed);
  });

  captureLayer.addEventListener("pointercancel", () => {
    draft = null;
    clearDraftSvg();
  });

  // Draggable dock positioning + Pop-out outside the app window
  const posStorageKey = storageKey ? `${storageKey}:pos` : null;
  let dockPos = null;
  let pipWindow = null;
  let dockHidden = false;

  if (posStorageKey) {
    try {
      const savedPos = win.sessionStorage?.getItem(posStorageKey);
      if (savedPos) {
        const parsed = JSON.parse(savedPos);
        if (
          parsed &&
          typeof parsed.left === "number" &&
          typeof parsed.top === "number" &&
          Number.isFinite(parsed.left) &&
          Number.isFinite(parsed.top)
        ) {
          dockPos = { left: parsed.left, top: parsed.top };
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  function applyDockPosition(nextPos, persist = false) {
    if (!nextPos || pipWindow) return;
    const vp = currentViewport(win, doc);
    const pad = 4;
    const rect = dock.getBoundingClientRect();
    const w = rect.width || 320;
    const h = rect.height || 44;
    const clampedLeft = Math.max(
      pad,
      Math.min(Math.round(nextPos.left), Math.max(pad, vp.width - w - pad)),
    );
    const clampedTop = Math.max(
      pad,
      Math.min(Math.round(nextPos.top), Math.max(pad, vp.height - h - pad)),
    );
    dockPos = { left: clampedLeft, top: clampedTop };
    dock.style.left = `${clampedLeft}px`;
    dock.style.top = `${clampedTop}px`;
    dock.style.right = "auto";
    dock.style.bottom = "auto";
    dock.style.alignItems =
      clampedLeft + w / 2 < vp.width / 2 ? "flex-start" : "flex-end";
    if (persist && posStorageKey) {
      try {
        win.sessionStorage?.setItem(posStorageKey, JSON.stringify(dockPos));
      } catch {
        // ignore storage errors
      }
    }
  }

  function dockBackFromPip() {
    if (!pipWindow) return;
    const oldPip = pipWindow;
    pipWindow = null;
    syncListeners();
    dock.classList.remove("dk-pip-dock");
    btnPopOut.textContent = "↗";
    btnPopOut.title = "Pop out toolbar outside app window";
    btnPopOut.setAttribute("aria-label", "Pop out toolbar");
    if (dock.parentNode !== root) {
      root.appendChild(dock);
    }
    if (dockPos) applyDockPosition(dockPos, false);
    try {
      if (!oldPip.closed) oldPip.close();
    } catch {
      // ignore
    }
  }

  async function togglePopOut(coords) {
    if (hasHostPopOut) {
      options.onPopOut({
        screenX: coords?.screenX,
        screenY: coords?.screenY,
      });
      return;
    }
    if (!canDocPip) return;
    if (pipWindow) {
      dockBackFromPip();
      return;
    }
    try {
      const barRect = bar.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const pip = await win.documentPictureInPicture.requestWindow({
        width: Math.max(460, Math.min(720, Math.ceil(barRect.width) + 24)),
        height: Math.max(88, Math.min(260, Math.ceil(dockRect.height) + 28)),
      });
      pipWindow = pip;
      pip.document.title = "CodePress Annotate";
      const pipStyle = pip.document.createElement("style");
      pipStyle.textContent = `html,body{margin:0;padding:8px;background:#09090b;color:#f4f4f5;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:auto;}\n${OVERLAY_CSS}`;
      pip.document.head.appendChild(pipStyle);
      dock.classList.add("dk-pip-dock");
      dock.style.left = "";
      dock.style.top = "";
      dock.style.right = "";
      dock.style.bottom = "";
      pip.document.body.appendChild(dock);
      btnPopOut.textContent = "↙";
      btnPopOut.title = "Dock toolbar back inside app";
      btnPopOut.setAttribute("aria-label", "Dock toolbar back");
      pip.addEventListener("pagehide", () => {
        if (pipWindow === pip) dockBackFromPip();
      });
      syncListeners();
    } catch {
      // User cancelled or PiP unavailable; stay docked
    }
  }

  // Drag handler for .dk-bar (grip handle or any non-button area)
  let dockDrag = null;
  bar.addEventListener("pointerdown", (e) => {
    if (pipWindow || currentViewport(win, doc).width <= 640) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const target = e.target;
    if (
      target &&
      target !== dragHandle &&
      typeof target.closest === "function" &&
      target.closest("button, a, input, textarea, select")
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const rect = dock.getBoundingClientRect();
    dockDrag = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      detached: false,
    };
    bar.classList.add("dk-dragging");
    try {
      bar.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore synthetic events
    }
  });

  bar.addEventListener("pointermove", (e) => {
    if (!dockDrag) return;
    e.preventDefault();
    const vp = currentViewport(win, doc);
    const edgeMargin = 24;
    if (
      hasHostPopOut &&
      !dockDrag.detached &&
      (e.clientX < -edgeMargin ||
        e.clientY < -edgeMargin ||
        e.clientX > vp.width + edgeMargin ||
        e.clientY > vp.height + edgeMargin)
    ) {
      dockDrag.detached = true;
      bar.classList.remove("dk-dragging");
      try {
        bar.releasePointerCapture?.(dockDrag.pointerId);
      } catch {
        // ignore
      }
      dockDrag = null;
      options.onPopOut({ screenX: e.screenX, screenY: e.screenY });
      return;
    }
    applyDockPosition(
      {
        left: e.clientX - dockDrag.offsetX,
        top: e.clientY - dockDrag.offsetY,
      },
      false,
    );
  });

  const endDockDrag = (e) => {
    if (!dockDrag) return;
    const wasDetached = dockDrag.detached;
    dockDrag = null;
    bar.classList.remove("dk-dragging");
    try {
      if (e?.pointerId != null) bar.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
    if (!wasDetached && dockPos) {
      applyDockPosition(dockPos, true);
    }
  };
  bar.addEventListener("pointerup", endDockDrag);
  bar.addEventListener("pointercancel", endDockDrag);

  // Drag handler for .dk-popover via its header
  let popDrag = null;
  popHead.addEventListener("pointerdown", (e) => {
    if (currentViewport(win, doc).width <= 640) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const target = e.target;
    if (
      target &&
      typeof target.closest === "function" &&
      target.closest("button")
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const rect = popover.getBoundingClientRect();
    popDrag = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    try {
      popHead.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  });
  popHead.addEventListener("pointermove", (e) => {
    if (!popDrag) return;
    e.preventDefault();
    const vp = currentViewport(win, doc);
    const rect = popover.getBoundingClientRect();
    const w = rect.width || 264;
    const h = rect.height || 132;
    const pad = 4;
    const left = Math.max(
      pad,
      Math.min(Math.round(e.clientX - popDrag.offsetX), vp.width - w - pad),
    );
    const top = Math.max(
      pad,
      Math.min(Math.round(e.clientY - popDrag.offsetY), vp.height - h - pad),
    );
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  });
  const endPopDrag = (e) => {
    if (!popDrag) return;
    popDrag = null;
    try {
      if (e?.pointerId != null) popHead.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  };
  popHead.addEventListener("pointerup", endPopDrag);
  popHead.addEventListener("pointercancel", endPopDrag);

  function setDockHidden(nextHidden) {
    dockHidden = Boolean(nextHidden);
    dock.setAttribute("data-dk-dock-hidden", String(dockHidden));
  }

  function getStateSnapshot() {
    return {
      open,
      mode,
      tool,
      sending,
      count: items.length,
      toastText: toast.hidden
        ? ""
        : `${toastText.textContent || ""} ${toastLink.hidden ? "" : toastLink.textContent || ""}`.trim(),
      toastUrl: currentRunUrl(),
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      toastKind: toast.classList.contains("dk-toast-err")
        ? "error"
        : toast.classList.contains("dk-toast-ok")
          ? "ok"
          : toast.hidden
            ? ""
            : "pending",
    };
  }

  // Button handlers
  modeBanner.addEventListener("click", () => setMode("browse"));
  btnBrowse.addEventListener("click", () => setMode("browse"));
  btnAnnotate.addEventListener("click", () => setMode("annotate"));
  btnPopOut.addEventListener("click", (e) => {
    void togglePopOut({ screenX: e.screenX, screenY: e.screenY });
  });
  btnCollapse.addEventListener("click", () => setOpen(false));
  launcher.addEventListener("click", () => setOpen(true));
  popClose.addEventListener("click", closePopover);
  popCancel.addEventListener("click", saveActiveNote);
  popSave.addEventListener("click", saveActiveNote);
  toastDismiss.addEventListener("click", hideToast);
  btnSend.addEventListener("click", () => {
    void submitFix();
  });
  btnCopy.addEventListener("click", () => {
    void copyPacket();
  });
  btnUndo.addEventListener("click", () => {
    undo();
  });
  btnRedo.addEventListener("click", () => {
    redo();
  });

  // Route & resize listeners (passive)
  const onRouteOrResize = () => {
    if (destroyed) return;
    renderCommittedShapes();
    renderMarkers();
    if (dockPos && !pipWindow) {
      applyDockPosition(dockPos, false);
    }
    if (!popover.hidden && activePopoverItemId) {
      clampPopover(lastPopoverAnchor.x, lastPopoverAnchor.y);
    }
  };
  const onVisualViewportChange = () => {
    if (destroyed) return;
    if (!popover.hidden && activePopoverItemId) {
      clampPopover(lastPopoverAnchor.x, lastPopoverAnchor.y);
    }
  };
  win.addEventListener("popstate", onRouteOrResize);
  win.addEventListener("hashchange", onRouteOrResize);
  win.addEventListener("resize", onRouteOrResize);
  win.visualViewport?.addEventListener("resize", onVisualViewportChange, {
    passive: true,
  });
  win.visualViewport?.addEventListener("scroll", onVisualViewportChange, {
    passive: true,
  });

  // Optional parent postMessage bridge for mode control when running in an iframe
  let controlBridge = null;
  if (
    options.transport?.type === "postMessage" &&
    options.transport.targetOrigin &&
    options.transport.channelId
  ) {
    try {
      controlBridge = createPostMessageBridge({
        windowObj: win,
        targetWindow: options.transport.targetWindow ?? win.parent,
        targetOrigin: options.transport.targetOrigin,
        channelId: options.transport.channelId,
        onMessage(data) {
          if (data.type === DK_ANNOTATE_MSG.SET_MODE) {
            if (data.mode === "annotate" || data.mode === "browse") {
              setMode(data.mode);
            }
          }
        },
      });
      controlBridge.send(DK_ANNOTATE_MSG.READY, { route: currentRoute(win) });
    } catch {
      controlBridge = null;
    }
  }

  function setMode(nextMode) {
    const normalized = nextMode === "annotate" ? "annotate" : "browse";
    if (mode === normalized) {
      syncListeners();
      render();
      return;
    }
    mode = normalized;
    if (mode === "browse") {
      draft = null;
      clearDraftSvg();
      closePopover();
    }
    syncListeners();
    render();
    options.onModeChange?.(mode);
  }

  function setTool(nextTool) {
    if (
      nextTool === "pin" ||
      nextTool === "box" ||
      nextTool === "arrow" ||
      nextTool === "freehand"
    ) {
      tool = nextTool;
      render();
    }
  }

  function setOpen(nextOpen) {
    open = Boolean(nextOpen);
    if (!open) {
      draft = null;
      clearDraftSvg();
      closePopover();
    }
    syncListeners();
    render();
  }

  function removeItem(id) {
    const removed = items.find((it) => it.id === id);
    if (!removed) return;
    recordHistory(`removed ${describeItem(removed)}`);
    items = items
      .filter((it) => it.id !== id)
      .map((it, idx) => ({ ...it, index: idx + 1 }));
    if (activePopoverItemId === id) closePopover();
    persistQueue();
    render();
    options.onItemsChange?.(items.slice());
  }

  function clearItems() {
    if (items.length > 0) recordHistory("cleared all redlines");
    items = [];
    closePopover();
    persistQueue();
    render();
    options.onItemsChange?.([]);
  }

  function getPacket() {
    return sanitizeRedlinePacket({
      route: currentRoute(win),
      viewport: currentViewport(win, doc),
      theme: detectTheme(doc, win, options.theme),
      items,
    });
  }

  async function copyPacket() {
    const packet = getPacket();
    const res = await dispatchRedlinePacket(packet, { document: doc });
    showToast("ok", res.message || "Copied redline packet");
    return res;
  }

  async function submitFix() {
    if (sending || items.length === 0) return null;
    if (!popover.hidden) saveActiveNote();

    sending = true;
    render();
    showToast("pending", "Sending…");

    const packet = getPacket();
    try {
      const res = await dispatchRedlinePacket(packet, {
        onSubmit: options.onSubmit,
        transport: options.transport,
        document: doc,
      });
      sending = false;
      clearItems();
      // Sent redlines are never re-queued: a successful send ends history.
      resetHistory();
      const label = res.runUrl
        ? `${res.message || "Fix started"} ·`
        : res.message || "Fix started";
      showToast("ok", label, res.runUrl);
      render();
      return res;
    } catch (err) {
      sending = false;
      render();
      showToast("error", err?.message || "Send to Fix failed");
      throw err;
    }
  }

  function getUiBounds() {
    const out = [];
    const nodes = [
      modeBanner,
      bar,
      chipsWrap,
      toast,
      popover,
      launcher,
      ...Array.from(markersLayer.children),
    ];
    for (const el of nodes) {
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      out.push({
        name: el.className || el.tagName,
        left: Math.round(r.left * 100) / 100,
        top: Math.round(r.top * 100) / 100,
        right: Math.round(r.right * 100) / 100,
        bottom: Math.round(r.bottom * 100) / 100,
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
      });
    }
    return out;
  }

  function getControlRect(name) {
    const el = controls[name];
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      centerX: r.left + r.width / 2,
      centerY: r.top + r.height / 2,
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    dockBackFromPip();
    syncListeners();
    controlBridge?.destroy();
    win.removeEventListener("popstate", onRouteOrResize);
    win.removeEventListener("hashchange", onRouteOrResize);
    win.removeEventListener("resize", onRouteOrResize);
    win.visualViewport?.removeEventListener("resize", onVisualViewportChange);
    win.visualViewport?.removeEventListener("scroll", onVisualViewportChange);
    host.remove();
  }

  container.appendChild(host);
  syncListeners();
  render();
  if (dockPos) {
    applyDockPosition(dockPos, false);
  }

  return {
    host,
    getMode: () => mode,
    setMode,
    getTool: () => tool,
    setTool,
    isOpen: () => open,
    setOpen,
    setDockHidden,
    getState: getStateSnapshot,
    getDockRect: () => {
      const r = dock.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    getItems: () => items.slice(),
    removeItem,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    openRun,
    clearItems,
    getPacket,
    submitFix,
    copyPacket,
    getUiBounds,
    getControlRect,
    getCommittedShapeCount: () => committedSvgGroup.childNodes.length,
    getToastText: () =>
      toast.hidden
        ? ""
        : `${toastText.textContent || ""} ${toastLink.hidden ? "" : toastLink.textContent || ""}`.trim(),
    getToastHref: currentRunUrl,
    destroy,
  };
}
