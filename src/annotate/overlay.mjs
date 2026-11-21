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
  z-index: 1;
}
.dk-capture[hidden] {
  display: none;
  pointer-events: none;
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
  z-index: 6;
}
.dk-popover[hidden] {
  display: none;
}
.dk-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: #a1a1aa;
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

  const chipsWrap = doc.createElement("div");
  chipsWrap.className = "dk-chips";
  chipsWrap.hidden = true;
  dock.appendChild(chipsWrap);

  const bar = doc.createElement("div");
  bar.className = "dk-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Screen annotator");
  dock.appendChild(bar);

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

  const countBadge = doc.createElement("span");
  countBadge.className = "dk-count";

  const btnCopy = doc.createElement("button");
  btnCopy.type = "button";
  btnCopy.className = "dk-btn dk-btn-subtle";
  btnCopy.textContent = "Copy";
  btnCopy.title = "Copy redline packet";

  const btnSend = doc.createElement("button");
  btnSend.type = "button";
  btnSend.className = "dk-btn dk-btn-send";
  btnSend.textContent = "Send to Fix";

  const btnCollapse = doc.createElement("button");
  btnCollapse.type = "button";
  btnCollapse.className = "dk-btn";
  btnCollapse.textContent = "×";
  btnCollapse.setAttribute("aria-label", "Collapse annotator");

  bar.append(modeSeg, toolsWrap, countBadge, btnCopy, btnSend, btnCollapse);

  const launcher = doc.createElement("button");
  launcher.type = "button";
  launcher.className = "dk-launcher";
  launcher.textContent = "Annotate";
  launcher.hidden = true;
  dock.appendChild(launcher);

  // Control map for coordinate queries (without exposing closed shadowRoot)
  const controls = {
    "mode-browse": btnBrowse,
    "mode-annotate": btnAnnotate,
    "tool-pin": toolButtons.pin,
    "tool-box": toolButtons.box,
    "tool-arrow": toolButtons.arrow,
    "tool-freehand": toolButtons.freehand,
    "send-fix": btnSend,
    "copy-packet": btnCopy,
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
    const safeUrl = sanitizeRunUrl(runUrl);
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

  function clampPopover(anchorX, anchorY) {
    const vp = currentViewport(win, doc);
    const pad = 8;
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
    popTitle.textContent = `#${item.index} · ${item.kind} · ${item.route}`;
    popInput.value = item.note || "";
    popover.hidden = false;
    clampPopover(anchorX, anchorY);
    popInput.focus();
  }

  function closePopover() {
    activePopoverItemId = null;
    popover.hidden = true;
  }

  function saveActiveNote() {
    if (!activePopoverItemId) return;
    const item = items.find((i) => i.id === activePopoverItemId);
    if (item) {
      item.note = popInput.value.trim();
      persistQueue();
      render();
      options.onItemsChange?.(items.slice());
    }
    closePopover();
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

  function renderMarkers() {
    while (markersLayer.firstChild)
      markersLayer.removeChild(markersLayer.firstChild);
    if (!open) return;

    const routeNow = currentRoute(win);
    const vp = currentViewport(win, doc);
    const pad = 12;

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
      btn.style.left = `${Math.round(cx - 11)}px`;
      btn.style.top = `${Math.round(cy - 11)}px`;
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

    bar.hidden = !open;
    launcher.hidden = open || options.showLauncher === false;
    captureLayer.hidden = !(open && mode === "annotate");

    btnBrowse.setAttribute("aria-selected", String(mode === "browse"));
    btnAnnotate.setAttribute("aria-selected", String(mode === "annotate"));
    toolsWrap.hidden = mode !== "annotate";

    for (const [id, b] of Object.entries(toolButtons)) {
      b.setAttribute("aria-pressed", String(tool === id));
    }

    const n = items.length;
    countBadge.textContent = n === 1 ? "1 redline" : `${n} redlines`;
    btnSend.disabled = sending || n === 0;
    btnCopy.disabled = n === 0;
    btnSend.textContent = sending ? "Sending…" : "Send to Fix";

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

  function syncListeners() {
    const shouldAttach = open && mode === "annotate" && !destroyed;
    if (shouldAttach && !keydownAttached) {
      doc.addEventListener("keydown", handleAnnotateKeydown, true);
      keydownAttached = true;
    } else if (!shouldAttach && keydownAttached) {
      doc.removeEventListener("keydown", handleAnnotateKeydown, true);
      keydownAttached = false;
    }
  }

  // Pointer interaction on captureLayer (only active when mode === "annotate")
  let draft = null;

  captureLayer.addEventListener("pointerdown", (e) => {
    if (mode !== "annotate" || !open) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();

    const x = Math.round(e.clientX);
    const y = Math.round(e.clientY);
    const startEl = hitTestElement(x, y);

    draft = {
      kind: tool,
      startX: x,
      startY: y,
      curX: x,
      curY: y,
      startEl,
      points: [{ x, y }],
    };

    try {
      captureLayer.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore synthetic events without active pointerId
    }
    renderDraftPreview(draft);
  });

  captureLayer.addEventListener("pointermove", (e) => {
    if (!draft) return;
    e.preventDefault();
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

    items.push(item);
    persistQueue();
    render();
    options.onItemsChange?.(items.slice());
    openPopoverForItem(item, anchorX, anchorY);
  }

  captureLayer.addEventListener("pointerup", (e) => {
    if (!draft) return;
    e.preventDefault();
    e.stopPropagation();
    const completed = draft;
    completed.curX = Math.round(e.clientX);
    completed.curY = Math.round(e.clientY);
    draft = null;
    void finalizeDraft(completed);
  });

  captureLayer.addEventListener("pointercancel", () => {
    draft = null;
    clearDraftSvg();
  });

  // Button handlers
  btnBrowse.addEventListener("click", () => setMode("browse"));
  btnAnnotate.addEventListener("click", () => setMode("annotate"));
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

  // Route & resize listeners (passive)
  const onRouteOrResize = () => {
    if (destroyed) return;
    renderCommittedShapes();
    renderMarkers();
    if (!popover.hidden && activePopoverItemId) {
      const vp = currentViewport(win, doc);
      clampPopover(vp.width, vp.height);
    }
  };
  win.addEventListener("popstate", onRouteOrResize);
  win.addEventListener("hashchange", onRouteOrResize);
  win.addEventListener("resize", onRouteOrResize);

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
    items = items
      .filter((it) => it.id !== id)
      .map((it, idx) => ({ ...it, index: idx + 1 }));
    if (activePopoverItemId === id) closePopover();
    persistQueue();
    render();
    options.onItemsChange?.(items.slice());
  }

  function clearItems() {
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
    syncListeners();
    controlBridge?.destroy();
    win.removeEventListener("popstate", onRouteOrResize);
    win.removeEventListener("hashchange", onRouteOrResize);
    win.removeEventListener("resize", onRouteOrResize);
    host.remove();
  }

  container.appendChild(host);
  syncListeners();
  render();

  return {
    host,
    getMode: () => mode,
    setMode,
    getTool: () => tool,
    setTool,
    isOpen: () => open,
    setOpen,
    getItems: () => items.slice(),
    removeItem,
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
    getToastHref: () =>
      toast.hidden || toastLink.hidden ? "" : toastLink.href,
    destroy,
  };
}
