/**
 * Live viewport composited callout PNG snapshotter.
 *
 * `captureViewportSnapshot` has the browser render the viewport DOM (SVG
 * foreignObject) at device pixel ratio; `captureCalloutSnapshot` is the hand
 * painter it falls back to. Both draw the redline callouts on top and keep
 * the PNG data URL <= 1 MiB. Any cross-origin <img> becomes a labelled
 * placeholder box so canvas.toDataURL() never throws SecurityError.
 *
 * Zero runtime dependencies.
 */

import { MAX_SNAPSHOT_BYTES } from "./sanitize.mjs";

const MAX_CANVAS_WIDTH = 1280;
const MAX_CANVAS_HEIGHT = 960;

function isSameOriginImage(img, pageOrigin, pageHref) {
  const src = img.currentSrc || img.getAttribute?.("src") || img.src || "";
  if (!src) return true;
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  if (!pageOrigin || pageOrigin === "null") return false;
  try {
    const resolved = new URL(src, pageHref || pageOrigin);
    if (resolved.origin === pageOrigin) return true;
    // Cross-origin: only safe if explicitly loaded with CORS anonymous AND complete,
    // but even then servers can omit ACAO; default to placeholder unless same-origin.
    return false;
  } catch {
    return false;
  }
}

function getCrossOriginLabel(img, pageHref) {
  const alt = (img.getAttribute?.("alt") || "").trim();
  const src = img.currentSrc || img.getAttribute?.("src") || img.src || "";
  let host = "";
  try {
    host = new URL(src, pageHref || "https://design-kit.invalid").hostname;
  } catch {
    host = "external";
  }
  if (alt)
    return `Cross-origin image (${host || "external"}): ${alt.slice(0, 28)}`;
  return `Cross-origin image (${host || "external"})`;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function isTransparent(color) {
  if (!color) return true;
  return (
    color === "transparent" ||
    color === "rgba(0, 0, 0, 0)" ||
    color === "rgba(0,0,0,0)"
  );
}

function drawCalloutOverlay(ctx, annotation, bounds) {
  const maxX = bounds?.width || ctx.canvas.width;
  const maxY = bounds?.height || ctx.canvas.height;
  const accent = "#ef4444";
  const accentFill = "rgba(239, 68, 68, 0.14)";
  const badgeBg = "#ef4444";
  const badgeFg = "#ffffff";
  const indexLabel = String(annotation.index || 1);

  ctx.save();

  const drawBadge = (bx, by) => {
    const r = 11;
    const cx = Math.max(r + 2, Math.min(bx, maxX - r - 2));
    const cy = Math.max(r + 2, Math.min(by, maxY - r - 2));
    ctx.fillStyle = badgeBg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = badgeFg;
    ctx.font = "bold 11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(indexLabel, cx, cy + 0.5);
  };

  if (annotation.kind === "pin") {
    if (
      annotation.rect &&
      annotation.rect.width > 0 &&
      annotation.rect.height > 0
    ) {
      const r = annotation.rect;
      ctx.fillStyle = accentFill;
      ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
    const px = annotation.point?.x ?? annotation.rect?.x ?? 20;
    const py = annotation.point?.y ?? annotation.rect?.y ?? 20;
    ctx.fillStyle = "rgba(239, 68, 68, 0.25)";
    ctx.beginPath();
    ctx.arc(px, py, 16, 0, Math.PI * 2);
    ctx.fill();
    drawBadge(px, py);
  } else if (annotation.kind === "box" && annotation.rect) {
    const r = annotation.rect;
    ctx.fillStyle = accentFill;
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.setLineDash([]);
    drawBadge(r.x, r.y);
  } else if (annotation.kind === "arrow") {
    const fromPt = annotation.from?.rect
      ? {
          x: annotation.from.rect.x + annotation.from.rect.width / 2,
          y: annotation.from.rect.y + annotation.from.rect.height / 2,
        }
      : annotation.point || { x: 20, y: 20 };
    const toPt = annotation.to?.rect
      ? {
          x: annotation.to.rect.x + annotation.to.rect.width / 2,
          y: annotation.to.rect.y + annotation.to.rect.height / 2,
        }
      : annotation.toPoint || fromPt;

    if (annotation.from?.rect) {
      const r = annotation.from.rect;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(fromPt.x, fromPt.y);
    ctx.lineTo(toPt.x, toPt.y);
    ctx.stroke();

    // Arrowhead
    const angle = Math.atan2(toPt.y - fromPt.y, toPt.x - fromPt.x);
    const headLen = 12;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(toPt.x, toPt.y);
    ctx.lineTo(
      toPt.x - headLen * Math.cos(angle - Math.PI / 6),
      toPt.y - headLen * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      toPt.x - headLen * Math.cos(angle + Math.PI / 6),
      toPt.y - headLen * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();

    drawBadge(fromPt.x, fromPt.y);
  } else if (
    annotation.kind === "freehand" &&
    Array.isArray(annotation.points) &&
    annotation.points.length > 0
  ) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(annotation.points[0].x, annotation.points[0].y);
    for (let i = 1; i < annotation.points.length; i += 1) {
      ctx.lineTo(annotation.points[i].x, annotation.points[i].y);
    }
    ctx.stroke();
    drawBadge(annotation.points[0].x, annotation.points[0].y);
  }

  ctx.restore();
}

const MAX_PAINT_NODES = 6000;

function intersectRect(a, b) {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function isEmptyRect(r) {
  return r.right <= r.left || r.bottom <= r.top;
}

function clipsOverflow(value) {
  return (
    value === "hidden" ||
    value === "clip" ||
    value === "auto" ||
    value === "scroll"
  );
}

/**
 * Walk the DOM once and return what to paint, in paint order. Each entry
 * carries the clip of its scroll/overflow ancestors, so content scrolled out
 * of a list does not paint over the list's headers, and a coarse stacking
 * bucket (negative z, in-flow, positioned, positive z) so sticky and
 * overlaid layers paint above the in-flow content they cover, as the browser
 * paints them. Subtrees that are display:none or entirely clipped are skipped
 * so the node budget is spent on what is visible.
 */
function collectPaintEntries(doc, win, vw, vh, ignoreTag) {
  const viewport = { left: 0, top: 0, right: vw, bottom: vh };
  const entries = [];
  const stack = [{ node: doc.body, clip: viewport, z: 0, positioned: false }];
  let visited = 0;
  let order = 0;

  while (stack.length > 0 && visited < MAX_PAINT_NODES) {
    const frame = stack.pop();
    const node = frame.node;
    if (!node || node.nodeType !== 1) continue;
    const tag = String(node.tagName || "").toLowerCase();
    if (
      tag === ignoreTag ||
      tag === "script" ||
      tag === "style" ||
      tag === "noscript" ||
      tag === "template"
    ) {
      continue;
    }
    visited += 1;

    let rect;
    let cs;
    try {
      rect = node.getBoundingClientRect();
      cs = win.getComputedStyle(node);
    } catch {
      continue;
    }
    // display:none and opacity:0 hide the whole subtree.
    if (!cs || cs.display === "none" || Number(cs.opacity) === 0) continue;

    const position = cs.position || "static";
    let clip = position === "fixed" ? viewport : frame.clip;
    let z = frame.z;
    let positioned = frame.positioned;
    if (position !== "static") {
      positioned = true;
      const zi = parseInt(cs.zIndex, 10);
      if (Number.isFinite(zi)) z = zi;
    }

    const hasBox = rect && rect.width > 0 && rect.height > 0;
    if (
      hasBox &&
      cs.visibility !== "hidden" &&
      !(
        rect.right < clip.left ||
        rect.bottom < clip.top ||
        rect.left > clip.right ||
        rect.top > clip.bottom
      )
    ) {
      const bucket = z < 0 ? 0 : z > 0 ? 3 : positioned ? 2 : 1;
      entries.push({ el: node, rect, cs, clip, bucket, z, order: order++ });
    }

    // An <svg> is painted as a whole by paintSvg.
    if (tag === "svg") continue;

    if (
      hasBox &&
      (clipsOverflow(cs.overflowX) || clipsOverflow(cs.overflowY))
    ) {
      clip = intersectRect(clip, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      });
    }
    // Children of a fully clipped box can only show if they are fixed;
    // skip them to keep the walk within budget.
    if (isEmptyRect(clip)) continue;

    const children = node.children;
    if (children && children.length) {
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({ node: children[i], clip, z, positioned });
      }
    }
  }

  entries.sort((a, b) => a.bucket - b.bucket || a.z - b.z || a.order - b.order);
  return entries;
}

function svgNumber(el, name, fallback = 0) {
  const raw = el.getAttribute?.(name);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function svgPoints(el) {
  const raw = String(el.getAttribute?.("points") || "").trim();
  const nums = raw
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

function svgShapePath(el, PathCtor) {
  const tag = String(el.tagName || "").toLowerCase();
  const p = new PathCtor();
  switch (tag) {
    case "path": {
      const d = el.getAttribute?.("d");
      return d ? new PathCtor(d) : null;
    }
    case "line":
      p.moveTo(svgNumber(el, "x1"), svgNumber(el, "y1"));
      p.lineTo(svgNumber(el, "x2"), svgNumber(el, "y2"));
      return p;
    case "circle":
      p.arc(
        svgNumber(el, "cx"),
        svgNumber(el, "cy"),
        svgNumber(el, "r"),
        0,
        Math.PI * 2,
      );
      return p;
    case "ellipse":
      if (typeof p.ellipse !== "function") return null;
      p.ellipse(
        svgNumber(el, "cx"),
        svgNumber(el, "cy"),
        svgNumber(el, "rx"),
        svgNumber(el, "ry"),
        0,
        0,
        Math.PI * 2,
      );
      return p;
    case "rect": {
      const x = svgNumber(el, "x");
      const y = svgNumber(el, "y");
      const w = svgNumber(el, "width");
      const h = svgNumber(el, "height");
      const rx = Math.min(
        svgNumber(el, "rx", svgNumber(el, "ry")),
        w / 2,
        h / 2,
      );
      if (rx > 0 && typeof p.roundRect === "function")
        p.roundRect(x, y, w, h, rx);
      else p.rect(x, y, w, h);
      return p;
    }
    case "polyline":
    case "polygon": {
      const pts = svgPoints(el);
      if (pts.length === 0) return null;
      p.moveTo(pts[0][0], pts[0][1]);
      for (const [px, py] of pts.slice(1)) p.lineTo(px, py);
      if (tag === "polygon") p.closePath();
      return p;
    }
    default:
      return null;
  }
}

/**
 * Paint an inline <svg> icon from its shapes (path, line, circle, ellipse,
 * rect, polyline, polygon) using each shape's computed fill and stroke, so
 * icon sets like lucide show up instead of leaving blank spaces. Gradients,
 * masks, text and <use> are not drawn.
 */
function paintSvg(ctx, svg, rect, win) {
  const PathCtor = win.Path2D || globalThis.Path2D;
  if (typeof PathCtor !== "function") return;
  const vb = svg.viewBox?.baseVal;
  const vbW = vb && vb.width > 0 ? vb.width : rect.width;
  const vbH = vb && vb.height > 0 ? vb.height : rect.height;
  const vbX = vb && vb.width > 0 ? vb.x : 0;
  const vbY = vb && vb.height > 0 ? vb.y : 0;
  // preserveAspectRatio xMidYMid meet, the default.
  const scale = Math.min(rect.width / vbW, rect.height / vbH);
  const offX = rect.left + (rect.width - vbW * scale) / 2;
  const offY = rect.top + (rect.height - vbH * scale) / 2;

  const shapes = svg.querySelectorAll?.(
    "path, line, circle, ellipse, rect, polyline, polygon",
  );
  if (!shapes) return;
  let drawn = 0;
  for (const shape of shapes) {
    if (drawn++ > 200) break;
    if (shape.closest?.("defs, clipPath, mask, pattern, symbol, marker"))
      continue;
    let cs;
    try {
      cs = win.getComputedStyle(shape);
    } catch {
      continue;
    }
    if (!cs || cs.display === "none" || cs.visibility === "hidden") continue;
    let path;
    try {
      path = svgShapePath(shape, PathCtor);
    } catch {
      continue;
    }
    if (!path) continue;
    const opacity = Number(cs.opacity);
    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    ctx.translate(-vbX, -vbY);
    if (Number.isFinite(opacity) && opacity < 1) ctx.globalAlpha *= opacity;
    const fill = cs.fill;
    if (
      fill &&
      fill !== "none" &&
      !fill.startsWith("url(") &&
      !isTransparent(fill)
    ) {
      ctx.fillStyle = fill;
      try {
        ctx.fill(path, cs.fillRule === "evenodd" ? "evenodd" : "nonzero");
      } catch {
        // Ignore an unpaintable fill
      }
    }
    const stroke = cs.stroke;
    const strokeWidth = parseFloat(cs.strokeWidth);
    if (
      stroke &&
      stroke !== "none" &&
      !stroke.startsWith("url(") &&
      !isTransparent(stroke) &&
      strokeWidth > 0
    ) {
      ctx.strokeStyle = stroke;
      // vector-effect: non-scaling-stroke keeps the width in screen pixels.
      ctx.lineWidth =
        cs.vectorEffect === "non-scaling-stroke"
          ? strokeWidth / scale
          : strokeWidth;
      ctx.lineCap = cs.strokeLinecap || "butt";
      ctx.lineJoin = cs.strokeLinejoin || "miter";
      try {
        ctx.stroke(path);
      } catch {
        // Ignore an unpaintable stroke
      }
    }
    ctx.restore();
  }
}

function paintDomToContext(ctx, doc, vw, vh, ignoreTag) {
  const win = doc.defaultView || globalThis;
  const pageOrigin = win.location?.origin || "";
  const pageHref = win.location?.href || "";
  let crossOriginPlaceholders = 0;

  // Base background
  const bodyCs =
    doc.body && win.getComputedStyle ? win.getComputedStyle(doc.body) : null;
  const htmlCs =
    doc.documentElement && win.getComputedStyle
      ? win.getComputedStyle(doc.documentElement)
      : null;
  const bg = !isTransparent(bodyCs?.backgroundColor)
    ? bodyCs.backgroundColor
    : !isTransparent(htmlCs?.backgroundColor)
      ? htmlCs.backgroundColor
      : "#ffffff";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, vw, vh);

  if (!doc.body) {
    return crossOriginPlaceholders;
  }

  const entries = collectPaintEntries(doc, win, vw, vh, ignoreTag);

  for (const { el, rect, cs, clip } of entries) {
    const tagName = String(el.tagName || "").toLowerCase();
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      clip.left,
      clip.top,
      clip.right - clip.left,
      clip.bottom - clip.top,
    );
    ctx.clip();
    if (tagName === "svg") {
      paintSvg(ctx, el, rect, win);
      ctx.restore();
      continue;
    }
    const x = rect.left;
    const y = rect.top;
    const w = rect.width;
    const h = rect.height;
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;

    // Background fill
    if (!isTransparent(cs.backgroundColor)) {
      ctx.save();
      drawRoundedRect(ctx, x, y, w, h, radius);
      ctx.fillStyle = cs.backgroundColor;
      ctx.fill();
      ctx.restore();
    }

    // Border stroke
    const borderW = parseFloat(cs.borderTopWidth) || 0;
    if (
      borderW > 0 &&
      cs.borderTopStyle !== "none" &&
      !isTransparent(cs.borderTopColor)
    ) {
      ctx.save();
      drawRoundedRect(ctx, x, y, w, h, radius);
      ctx.strokeStyle = cs.borderTopColor;
      ctx.lineWidth = Math.min(borderW, 4);
      ctx.stroke();
      ctx.restore();
    }

    // Canvas elements (same-origin / untainted safe)
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "canvas" && el.width > 0 && el.height > 0) {
      try {
        ctx.drawImage(el, x, y, w, h);
      } catch {
        // Ignore tainted canvas
      }
    }

    // Images (cross-origin safe)
    if (tag === "img") {
      const sameOrigin = isSameOriginImage(el, pageOrigin, pageHref);
      if (sameOrigin && el.complete && el.naturalWidth > 0) {
        try {
          ctx.drawImage(el, x, y, w, h);
        } catch {
          crossOriginPlaceholders += 1;
          drawCrossOriginPlaceholder(
            ctx,
            x,
            y,
            w,
            h,
            getCrossOriginLabel(el, pageHref),
          );
        }
      } else if (!sameOrigin) {
        crossOriginPlaceholders += 1;
        drawCrossOriginPlaceholder(
          ctx,
          x,
          y,
          w,
          h,
          getCrossOriginLabel(el, pageHref),
        );
      }
    }

    // Form control values (<input>, <textarea>, <select>)
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const inputType = String(el.getAttribute?.("type") || "").toLowerCase();
      if (
        inputType !== "password" &&
        inputType !== "hidden" &&
        inputType !== "checkbox" &&
        inputType !== "radio"
      ) {
        let val = "";
        let isPlaceholder = false;
        if (tag === "select") {
          const opt = el.options?.[el.selectedIndex];
          val = String(opt?.text || el.value || "").trim();
        } else {
          val = String(el.value || "").trim();
          if (!val) {
            val = String(el.getAttribute?.("placeholder") || "").trim();
            isPlaceholder = Boolean(val);
          }
        }
        if (val) {
          const fontSize = Math.max(
            9,
            Math.min(32, parseFloat(cs.fontSize) || 13),
          );
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.fillStyle = isPlaceholder ? "#71717a" : cs.color || "#111827";
          ctx.font = `${cs.fontWeight || "400"} ${fontSize}px system-ui, -apple-system, sans-serif`;
          ctx.textBaseline = "top";
          const padL = parseFloat(cs.paddingLeft) || 6;
          const padT = parseFloat(cs.paddingTop) || 4;
          ctx.fillText(
            val.slice(0, 140),
            x + padL,
            y + padT,
            Math.max(10, w - padL * 2),
          );
          ctx.restore();
        }
      }
    }

    // Direct text nodes
    const textParts = [];
    for (const child of el.childNodes || []) {
      if (child.nodeType === 3) {
        const t = String(child.nodeValue || "").trim();
        if (t) textParts.push(t);
      }
    }
    if (textParts.length > 0) {
      const text = textParts.join(" ").slice(0, 240);
      const fontSize = Math.max(9, Math.min(48, parseFloat(cs.fontSize) || 13));
      const fontWeight = cs.fontWeight || "400";
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = cs.color || "#111827";
      ctx.font = `${fontWeight} ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "top";
      const padL = parseFloat(cs.paddingLeft) || 2;
      const padR = parseFloat(cs.paddingRight) || 2;
      const padT = parseFloat(cs.paddingTop) || 2;
      const maxTextW = Math.max(10, w - padL - padR);
      const lineH = Math.round(fontSize * 1.35);
      if (h >= lineH * 1.8 && typeof ctx.measureText === "function") {
        const words = text.split(/\s+/);
        let line = "";
        let cy = y + padT;
        for (const word of words) {
          const test = line ? `${line} ${word}` : word;
          if (line && ctx.measureText(test).width > maxTextW) {
            ctx.fillText(line, x + padL, cy, maxTextW);
            line = word;
            cy += lineH;
            if (cy > y + h) break;
          } else {
            line = test;
          }
        }
        if (line && cy <= y + h) {
          ctx.fillText(line, x + padL, cy, maxTextW);
        }
      } else {
        ctx.fillText(text, x + padL, y + padT, maxTextW);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  return crossOriginPlaceholders;
}

function drawCrossOriginPlaceholder(ctx, x, y, w, h, label) {
  ctx.save();
  ctx.fillStyle = "#27272a";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#71717a";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  ctx.setLineDash([]);
  ctx.fillStyle = "#e4e4e7";
  ctx.font = "11px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2, Math.max(16, w - 8));
  ctx.restore();
}

function base64ByteLength(dataUrl) {
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return 0;
  return Math.floor(((dataUrl.length - idx - 1) * 3) / 4);
}

function drawAllCallouts(ctx, annotation, allAnnotations, vw, vh) {
  const bounds = vw && vh ? { width: vw, height: vh } : null;
  if (Array.isArray(allAnnotations) && allAnnotations.length > 0) {
    for (const other of allAnnotations) {
      if (!other || other === annotation || other.id === annotation?.id) {
        continue;
      }
      drawCalloutOverlay(ctx, other, bounds);
    }
  }
  if (annotation) {
    drawCalloutOverlay(ctx, annotation, bounds);
  }
}

/**
 * Composite all active callouts (including persistent freehand strokes) onto
 * a host-provided real screenshot PNG data URL, bounded to <= 1 MiB.
 */
export async function compositeAnnotationsOnImage(
  baseDataUrl,
  annotation,
  options = {},
) {
  const doc =
    options.document ||
    (typeof globalThis.document === "object" ? globalThis.document : null);
  const win = doc?.defaultView || globalThis;
  const allAnnotations = options.allAnnotations;
  if (
    !baseDataUrl ||
    typeof baseDataUrl !== "string" ||
    !doc ||
    typeof doc.createElement !== "function" ||
    typeof win.Image !== "function"
  ) {
    return undefined;
  }

  const vw = Math.max(
    1,
    Math.round(win.innerWidth || doc.documentElement?.clientWidth || 1280),
  );
  const vh = Math.max(
    1,
    Math.round(win.innerHeight || doc.documentElement?.clientHeight || 800),
  );

  const img = await new Promise((resolve) => {
    const el = new win.Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = baseDataUrl;
  });
  if (!img || !img.naturalWidth || !img.naturalHeight) return undefined;

  // Keep the host image's own resolution (a native capture is usually at
  // device pixels), stepping down only to fit the size cap.
  const nativeScale = Math.max(
    0.1,
    Math.min(
      img.naturalWidth / vw,
      MAX_RASTER_SCALE,
      MAX_RASTER_DIMENSION / vw,
      MAX_RASTER_DIMENSION / vh,
    ),
  );
  try {
    return encodeWithinCap(
      doc,
      vw,
      vh,
      encodeLadder(nativeScale, vw, vh),
      (ctx) => {
        ctx.drawImage(img, 0, 0, vw, vh);
        drawAllCallouts(ctx, annotation, allAnnotations, vw, vh);
      },
      { crossOriginPlaceholders: 0, renderer: "host" },
    );
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Capture a live composited callout PNG snapshot for an annotation item,
 * including all persistent annotations currently visible on the same route.
 * Always resolves (never throws SecurityError) and keeps PNG <= 1 MiB.
 */
export function captureCalloutSnapshot(annotation, options = {}) {
  const doc =
    options.document ||
    (typeof globalThis.document === "object" ? globalThis.document : null);
  const win = doc?.defaultView || globalThis;
  const ignoreTag = options.ignoreTag || "design-kit-annotator";
  const allAnnotations = options.allAnnotations;

  if (!doc || typeof doc.createElement !== "function") {
    return undefined;
  }

  const vw = Math.max(
    1,
    Math.round(win.innerWidth || doc.documentElement?.clientWidth || 1280),
  );
  const vh = Math.max(
    1,
    Math.round(win.innerHeight || doc.documentElement?.clientHeight || 800),
  );
  const initialScale = Math.min(
    1,
    MAX_CANVAS_WIDTH / vw,
    MAX_CANVAS_HEIGHT / vh,
  );

  const scales = [
    initialScale,
    initialScale * 0.75,
    initialScale * 0.5,
    initialScale * 0.35,
  ];

  for (const scale of scales) {
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    const canvas = doc.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return undefined;

    ctx.scale(scale, scale);
    let crossOriginPlaceholders = 0;
    try {
      crossOriginPlaceholders = paintDomToContext(ctx, doc, vw, vh, ignoreTag);
    } catch {
      // Fallback to neutral backdrop if DOM inspection fails
      ctx.fillStyle = "#18181b";
      ctx.fillRect(0, 0, vw, vh);
    }
    drawAllCallouts(ctx, annotation, allAnnotations, vw, vh);

    try {
      const dataUrl = canvas.toDataURL("image/png");
      const byteLength = base64ByteLength(dataUrl);
      if (byteLength > 0 && byteLength <= MAX_SNAPSHOT_BYTES) {
        return {
          dataUrl,
          width: cw,
          height: ch,
          byteLength,
          crossOriginPlaceholders,
        };
      }
    } catch {
      // SecurityError fallback: render clean overlay-only canvas so SecurityError never escapes
      const safeCanvas = doc.createElement("canvas");
      safeCanvas.width = cw;
      safeCanvas.height = ch;
      const safeCtx = safeCanvas.getContext?.("2d");
      if (!safeCtx) return undefined;
      safeCtx.scale(scale, scale);
      safeCtx.fillStyle = "#18181b";
      safeCtx.fillRect(0, 0, vw, vh);
      drawAllCallouts(safeCtx, annotation, allAnnotations, vw, vh);
      const safeUrl = safeCanvas.toDataURL("image/png");
      return {
        dataUrl: safeUrl,
        width: cw,
        height: ch,
        byteLength: base64ByteLength(safeUrl),
        crossOriginPlaceholders: crossOriginPlaceholders + 1,
      };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Browser-rendered capture: the live viewport DOM is cloned with its computed
// styles inlined, serialized into an SVG <foreignObject>, and drawn to a
// canvas by the browser's own renderer at device pixel ratio. Text wrapping,
// truncation, borders, shadows and icons match the screen because the browser
// lays them out again from the same resolved values. Any failure (a throw, a
// tainted canvas, the deadline) falls back to `paintDomToContext` above.
// ---------------------------------------------------------------------------

export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 1500;
const MAX_RASTER_SCALE = 3;
const MAX_RASTER_DIMENSION = 4096;
const MAX_RASTER_NODES = 20000;
// Same-origin frames rendered inside the capture, nested at most this deep.
const MAX_FRAME_DEPTH = 2;
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// Properties a child takes from its parent when it sets none itself.
const INHERITED_PROPERTIES = new Set([
  "border-collapse",
  "border-spacing",
  "caption-side",
  "caret-color",
  "color",
  "color-scheme",
  "cursor",
  "direction",
  "empty-cells",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "hyphens",
  "letter-spacing",
  "line-break",
  "line-height",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "orphans",
  "overflow-wrap",
  "paint-order",
  "quotes",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "text-align",
  "text-align-last",
  "text-anchor",
  "text-decoration-skip-ink",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-orientation",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "visibility",
  "white-space",
  "white-space-collapse",
  "widows",
  "word-break",
  "word-spacing",
  "word-wrap",
  "writing-mode",
  "-webkit-font-smoothing",
  "-webkit-hyphens",
  "-webkit-line-break",
  "-webkit-locale",
  "-webkit-text-fill-color",
  "-webkit-text-size-adjust",
  "-webkit-text-stroke-color",
  "-webkit-text-stroke-width",
  "-webkit-user-modify",
]);

// Never written: motion would restart from its first frame inside the image,
// and the rest only affect interaction.
function isSkippedProperty(name) {
  return (
    name.startsWith("animation") ||
    name.startsWith("transition") ||
    name.startsWith("--") ||
    name === "will-change" ||
    name === "pointer-events" ||
    name === "user-select" ||
    name === "-webkit-user-select" ||
    name === "-webkit-user-drag" ||
    name === "cursor" ||
    name === "caret-color" ||
    name === "view-transition-name"
  );
}

// Written on every element: the box keeps the size the screen gave it, and
// a width computed as 0px because its style was none on a default element
// still reads 0px where the page set a style (Tailwind's preflight gives
// every element a solid border style with 0px widths).
const ALWAYS_WRITTEN = new Set([
  "width",
  "height",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "outline-width",
  "column-rule-width",
]);

// Read by name: Chromium leaves these out of a computed style's list, and
// line-clamped text needs them.
const EXTRA_PROPERTIES = [
  "-webkit-box-orient",
  "-webkit-line-clamp",
  "-webkit-box-align",
  "-webkit-box-pack",
  "-webkit-box-flex",
  "-webkit-box-direction",
];

function propertyNames(cs) {
  const names = [];
  const seen = new Set();
  for (let i = 0; i < cs.length; i += 1) {
    names.push(cs[i]);
    seen.add(cs[i]);
  }
  for (const name of EXTRA_PROPERTIES) {
    if (!seen.has(name)) names.push(name);
  }
  return names;
}

const SKIPPED_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "noscript",
  "template",
  "title",
  "base",
]);

// url -> Promise<string | null> (a data URL), kept across captures so the
// second mark on a page does not fetch fonts and images again.
const resourceCache = new Map();
const defaultStyleCache = new Map();

function rasterFailure(message) {
  const error = new Error(message);
  error.name = "SnapshotRasterError";
  return error;
}

function checkDeadline(deadline) {
  if (Date.now() > deadline) throw rasterFailure("snapshot timed out");
}

function withDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return Promise.reject(rasterFailure("snapshot timed out"));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(rasterFailure("snapshot timed out")),
        remaining,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function blobToDataUrl(win, blob) {
  return new Promise((resolve) => {
    const Reader = win.FileReader || globalThis.FileReader;
    if (typeof Reader !== "function") return resolve(null);
    const reader = new Reader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function fetchAsDataUrl(win, url) {
  if (url.startsWith("data:")) return Promise.resolve(url);
  if (resourceCache.has(url)) return resourceCache.get(url);
  const fetchImpl = win.fetch?.bind(win) || globalThis.fetch;
  const pending = (async () => {
    if (typeof fetchImpl !== "function") return null;
    try {
      const res = await fetchImpl(url, {
        credentials: "same-origin",
        cache: "force-cache",
      });
      if (!res.ok) return null;
      return await blobToDataUrl(win, await res.blob());
    } catch {
      return null;
    }
  })();
  // blob: URLs are page-lifetime; a failed fetch may succeed later.
  pending.then((value) => {
    if (!value || url.startsWith("blob:")) resourceCache.delete(url);
  });
  resourceCache.set(url, pending);
  return pending;
}

function isSameOriginUrl(url, pageOrigin, pageHref) {
  if (!url) return false;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  if (!pageOrigin || pageOrigin === "null") return false;
  try {
    return new URL(url, pageHref || pageOrigin).origin === pageOrigin;
  } catch {
    return false;
  }
}

const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

/**
 * Default computed values for an element of this namespace and tag, read
 * from a blank standards-mode document. A property equal to its default need
 * not be written.
 */
function getDefaultStyle(sandbox, ns, tag) {
  const key = `${ns}|${tag}`;
  const cached = defaultStyleCache.get(key);
  if (cached) return cached;
  const sdoc = sandbox.doc();
  const values = new Map();
  if (sdoc) {
    let el;
    try {
      el =
        ns === SVG_NS
          ? sdoc.createElementNS(SVG_NS, tag)
          : sdoc.createElement(tag);
    } catch {
      el = sdoc.createElement("div");
    }
    const parent =
      ns === SVG_NS && tag !== "svg"
        ? sdoc.body.appendChild(sdoc.createElementNS(SVG_NS, "svg"))
        : sdoc.body;
    parent.appendChild(el);
    const cs = sdoc.defaultView.getComputedStyle(el);
    for (const name of propertyNames(cs)) {
      values.set(name, cs.getPropertyValue(name));
    }
    if (parent !== sdoc.body) parent.remove();
    else el.remove();
  }
  defaultStyleCache.set(key, values);
  return values;
}

function createSandbox(doc) {
  let frame = null;
  return {
    frame: () => frame,
    doc() {
      if (frame) return frame.contentDocument;
      frame = doc.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText =
        "position:fixed;left:-10000px;top:0;width:800px;height:600px;visibility:hidden;border:0;pointer-events:none";
      (doc.documentElement || doc.body).appendChild(frame);
      const sdoc = frame.contentDocument;
      if (!sdoc) return null;
      sdoc.open();
      sdoc.write("<!DOCTYPE html><html><head></head><body></body></html>");
      sdoc.close();
      return sdoc;
    },
    dispose() {
      frame?.remove();
      frame = null;
    },
  };
}

// WebKit resolves `calc(infinity * 1px)` (Tailwind's rounded-full) to a
// float-max length that its own parser then rejects, dropping the radius
// and any ring drawn along it. Any length past a million px draws the same.
const HUGE_LENGTH_RE = /\d{8,}(?:\.\d+)?(?:e\+?\d+)?px/gi;

function clampHugeLengths(value) {
  return value && value.length > 9
    ? value.replace(HUGE_LENGTH_RE, "1000000px")
    : value;
}

// WebKit draws CSS box-shadows wrongly when an SVG image is painted onto a
// canvas: blur is lost (a soft shadow becomes a hard grey bar) and inset
// shadows vanish. There, a spread-only ring (Tailwind's ring-*) is drawn as
// the equivalent outline and blurred shadows are left out.
function isWebKitCanvasEngine(win) {
  const ua = String(win.navigator?.userAgent || "");
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

function splitShadowLayers(value) {
  const layers = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      layers.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers.filter(Boolean);
}

function isInvisibleColor(color) {
  if (!color || color === "transparent") return true;
  const alpha = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (alpha) return Number(alpha[1]) === 0;
  const rgba = /^rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/.exec(color);
  return rgba ? Number(rgba[1]) === 0 : false;
}

function webKitShadowOverrides(cs) {
  const value = cs.boxShadow;
  if (!value || value === "none") return null;
  let ring = null;
  for (const layer of splitShadowLayers(value)) {
    const inset = /\binset\b/.test(layer);
    const lengths = (layer.match(/-?[\d.]+px/g) || []).map(parseFloat);
    const color = layer
      .replace(/\binset\b/, "")
      .replace(/-?[\d.]+px/g, "")
      .trim();
    if (isInvisibleColor(color)) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    if (!ring && x === 0 && y === 0 && blur === 0 && spread > 0) {
      ring = { color, spread, inset };
    }
  }
  const overrides = { "box-shadow": "none" };
  if (ring && (cs.outlineStyle === "none" || !cs.outlineStyle)) {
    overrides["outline-style"] = "solid";
    overrides["outline-width"] = `${ring.spread}px`;
    overrides["outline-color"] = ring.color;
    overrides["outline-offset"] = ring.inset ? `${-ring.spread}px` : "0px";
  }
  return overrides;
}

function styleDeclarations(cs, parentCs, defaults, overrides) {
  let text = "";
  for (const name of propertyNames(cs)) {
    if (isSkippedProperty(name)) continue;
    if (overrides && name in overrides) continue;
    const value = clampHugeLengths(cs.getPropertyValue(name));
    if (!value) continue;
    const always = ALWAYS_WRITTEN.has(name);
    const differsFromDefault =
      clampHugeLengths(defaults.get(name) || "") !== value;
    const differsFromParent =
      INHERITED_PROPERTIES.has(name) &&
      (!parentCs || parentCs.getPropertyValue(name) !== value);
    if (always || differsFromDefault || differsFromParent) {
      text += `${name}:${value};`;
    }
  }
  if (overrides) {
    for (const [name, value] of Object.entries(overrides)) {
      if (value !== null && value !== undefined && value !== "") {
        text += `${name}:${value};`;
      }
    }
  }
  return text;
}

function allDeclarations(cs) {
  let text = "";
  for (const name of propertyNames(cs)) {
    if (isSkippedProperty(name)) continue;
    const value = clampHugeLengths(cs.getPropertyValue(name));
    if (value) text += `${name}:${value};`;
  }
  return text;
}

function hasPseudoContent(pcs) {
  const content = pcs?.content;
  return Boolean(content) && content !== "none" && content !== "normal";
}

function isInlineDisplay(display) {
  return (
    display === "inline" ||
    display === "contents" ||
    display === "ruby" ||
    display === "ruby-text"
  );
}

function scrollsChildren(cs) {
  return (
    cs.overflowX !== "visible" ||
    cs.overflowY !== "visible" ||
    cs.overflow === "hidden"
  );
}

function crossOriginLabelFor(el, url, pageHref) {
  const alt = (el.getAttribute?.("alt") || "").trim();
  let host = "external";
  try {
    host = new URL(url, pageHref || "https://design-kit.invalid").hostname;
  } catch {
    host = "external";
  }
  return alt
    ? `Cross-origin image (${host}): ${alt.slice(0, 28)}`
    : `Cross-origin image (${host})`;
}

/**
 * Measure where a sticky element would sit unstuck, by reading its box with
 * position:static for one synchronous layout. Nothing paints in between.
 */
function stickyOffset(el) {
  const prevAttr = el.getAttribute("style");
  const live = el.getBoundingClientRect();
  el.style.setProperty("position", "static", "important");
  const natural = el.getBoundingClientRect();
  if (prevAttr === null) el.removeAttribute("style");
  else el.setAttribute("style", prevAttr);
  return { dx: live.left - natural.left, dy: live.top - natural.top };
}

/**
 * Clone the live document into an inert document with every computed style
 * inlined. Returns the serialized XHTML plus what it needs (pseudo-element
 * rules, used font families, placeholder count).
 */
function cloneViewportDom(doc, win, vw, vh, opts) {
  const { ignoreTag, deadline, sandbox, ignoreNodes, depth } = opts;
  const out = doc.implementation.createHTMLDocument("");
  const pageOrigin = win.location?.origin || "";
  const pageHref = win.location?.href || "";
  const resourceJobs = [];
  const frameJobs = [];
  const fontFamilies = new Set();
  const pseudoRules = [];
  let crossOriginPlaceholders = 0;
  let pseudoCount = 0;
  const webKitShadows = isWebKitCanvasEngine(win);
  let nodes = 0;

  const rewriteUrls = (value) => {
    if (!value || value.indexOf("url(") < 0) return value;
    return value.replace(CSS_URL_RE, (match, _q, raw) => {
      if (raw.startsWith("data:")) {
        // A raster still goes through the resource pass (WebKit resizes a
        // large one); anything else stays inline.
        if (!RASTER_DATA_URL_RE.test(raw)) return match;
        const token = `__dk_res_${resourceJobs.length}__`;
        resourceJobs.push({ token, url: raw, css: true });
        return `url("${token}")`;
      }
      let abs = raw;
      try {
        abs = new URL(raw, pageHref).href;
      } catch {
        return "none";
      }
      if (!isSameOriginUrl(abs, pageOrigin, pageHref)) return "none";
      const token = `__dk_res_${resourceJobs.length}__`;
      resourceJobs.push({ token, url: abs, css: true });
      return `url("${token}")`;
    });
  };

  const noteFonts = (cs) => {
    const families = cs.getPropertyValue("font-family");
    if (!families) return;
    for (const part of families.split(",")) {
      const name = part
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase();
      if (name) fontFamilies.add(name);
    }
  };

  const placeholderFor = (el, cs, label) => {
    crossOriginPlaceholders += 1;
    const div = out.createElement("div");
    // inline-block with overflow:hidden sits on the line by its bottom edge,
    // as the replaced element it stands in for does.
    const display = isInlineDisplay(cs.display) ? "inline-block" : "block";
    div.setAttribute(
      "style",
      styleDeclarations(cs, null, getDefaultStyle(sandbox, XHTML_NS, "div"), {
        display,
        overflow: "hidden",
        "background-color": "#27272a",
        "background-image": "none",
        "box-shadow": "inset 0 0 0 1.5px #71717a",
        color: "#e4e4e7",
        "-webkit-text-fill-color": "#e4e4e7",
        font: "11px system-ui, -apple-system, sans-serif",
        "line-height": cs.height && cs.height !== "auto" ? cs.height : "normal",
        "text-align": "center",
        "white-space": "nowrap",
        "text-overflow": "ellipsis",
      }),
    );
    div.textContent = label;
    return div;
  };

  const pseudoRule = (el, cs, clone, which) => {
    let pcs;
    try {
      pcs = win.getComputedStyle(el, which);
    } catch {
      return;
    }
    if (!hasPseudoContent(pcs)) return;
    if (!clone.__dkPseudoClass) {
      pseudoCount += 1;
      clone.__dkPseudoClass = `dk-ps-${pseudoCount}`;
      const existing = clone.getAttribute("class");
      clone.setAttribute(
        "class",
        existing
          ? `${existing} ${clone.__dkPseudoClass}`
          : clone.__dkPseudoClass,
      );
    }
    noteFonts(pcs);
    pseudoRules.push(
      `.${clone.__dkPseudoClass}${which}{${rewriteUrls(allDeclarations(pcs))}}`,
    );
  };

  // Returns the clone for `el` (or null to drop it).
  const cloneElement = (el, parentCs, extra) => {
    nodes += 1;
    if (nodes > MAX_RASTER_NODES) throw rasterFailure("too many nodes");
    if ((nodes & 255) === 0) checkDeadline(deadline);

    const tag = String(el.localName || el.tagName || "").toLowerCase();
    const ns = el.namespaceURI || XHTML_NS;
    if (tag === ignoreTag || SKIPPED_TAGS.has(tag) || ignoreNodes.has(el)) {
      return null;
    }
    const cs = win.getComputedStyle(el);
    if (!cs) return null;
    // A hidden SVG may hold the <symbol>s its icons <use>, so keep it.
    if (cs.display === "none" && ns !== SVG_NS) return null;

    const overrides = { ...(extra || {}) };
    const position = cs.position;

    if (position === "sticky") {
      const { dx, dy } = stickyOffset(el);
      overrides.position = "relative";
      overrides.top = `${dy}px`;
      overrides.left = `${dx}px`;
      overrides.bottom = "auto";
      overrides.right = "auto";
      overrides.isolation = "isolate";
    }

    // Chromium reports a line-clamped `display: -webkit-box` as flow-root,
    // which would drop the clamp and its ellipsis.
    const clamp = cs.getPropertyValue("-webkit-line-clamp");
    if (clamp && clamp !== "none" && !/box/.test(cs.display)) {
      overrides.display =
        cs.display === "inline" || cs.display.startsWith("inline")
          ? "-webkit-inline-box"
          : "-webkit-box";
    }

    // A styled button shows no native bezel on screen, but WebKit draws one
    // inside the image when its computed appearance is `button`.
    if (tag === "button" && cs.appearance && cs.appearance !== "none") {
      overrides.appearance = "none";
      overrides["-webkit-appearance"] = "none";
    }

    if (webKitShadows) {
      const shadow = webKitShadowOverrides(cs);
      if (shadow) Object.assign(overrides, shadow);
    }

    // The clone never scrolls: clip as the screen does, with no scrollbar.
    for (const axis of ["overflow-x", "overflow-y"]) {
      const value = cs.getPropertyValue(axis);
      if (value === "auto" || value === "scroll") overrides[axis] = "hidden";
    }

    const defaults = getDefaultStyle(sandbox, ns, tag);
    noteFonts(cs);

    if (ns === XHTML_NS) {
      if (tag === "iframe") {
        // A same-origin frame is rendered by the same pipeline and placed
        // as an image; a cross-origin one cannot be read.
        let frameDoc = null;
        try {
          frameDoc = el.contentDocument;
        } catch {
          frameDoc = null;
        }
        if (frameDoc?.documentElement && depth < MAX_FRAME_DEPTH) {
          const img = out.createElement("img");
          const token = `__dk_frame_${frameJobs.length}__`;
          frameJobs.push({ token, frameDoc });
          img.setAttribute("src", token);
          img.setAttribute("decoding", "sync");
          img.setAttribute(
            "style",
            styleDeclarations(
              cs,
              parentCs,
              getDefaultStyle(sandbox, XHTML_NS, "img"),
              { ...overrides, "object-fit": "fill" },
            ) + `;background-color:__dk_framebg_${frameJobs.length - 1}__`,
          );
          return img;
        }
        return placeholderFor(el, cs, "Embedded frame");
      }
      if (tag === "embed" || tag === "object") {
        return placeholderFor(el, cs, "Embedded frame");
      }
      if (tag === "img") {
        const src = el.currentSrc || el.getAttribute("src") || "";
        if (src && !isSameOriginUrl(src, pageOrigin, pageHref)) {
          return placeholderFor(el, cs, crossOriginLabelFor(el, src, pageHref));
        }
      }
      if (tag === "canvas" || tag === "video") {
        let dataUrl = null;
        try {
          if (tag === "canvas") {
            dataUrl = el.width > 0 && el.height > 0 ? el.toDataURL() : null;
          } else if (el.videoWidth > 0) {
            const c = doc.createElement("canvas");
            c.width = el.videoWidth;
            c.height = el.videoHeight;
            c.getContext("2d").drawImage(el, 0, 0);
            dataUrl = c.toDataURL();
          }
        } catch {
          return placeholderFor(el, cs, "Cross-origin media");
        }
        const img = out.createElement("img");
        img.setAttribute("decoding", "sync");
        if (dataUrl) img.setAttribute("src", dataUrl);
        img.setAttribute(
          "style",
          styleDeclarations(
            cs,
            parentCs,
            getDefaultStyle(sandbox, XHTML_NS, "img"),
            {
              ...overrides,
              "object-fit": tag === "video" ? cs.objectFit : "fill",
            },
          ),
        );
        return img;
      }
    }

    let clone;
    try {
      clone = out.importNode(el, false);
    } catch {
      clone =
        ns === SVG_NS
          ? out.createElementNS(SVG_NS, tag)
          : out.createElement(tag === "body" || tag === "html" ? "div" : tag);
    }
    for (const attr of Array.from(clone.attributes || [])) {
      if (/^on/i.test(attr.name)) clone.removeAttribute(attr.name);
    }

    // Form state lives in properties, not attributes.
    if (ns === XHTML_NS) {
      if (tag === "input") {
        const type = String(el.type || "").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          if (el.checked) clone.setAttribute("checked", "");
          else clone.removeAttribute("checked");
        } else if (type === "password") {
          clone.setAttribute("value", "x".repeat(String(el.value).length));
        } else if (type !== "file") {
          clone.setAttribute("value", String(el.value ?? ""));
        }
      } else if (tag === "textarea") {
        clone.textContent = String(el.value ?? "");
      } else if (tag === "img") {
        clone.removeAttribute("srcset");
        clone.removeAttribute("sizes");
        clone.removeAttribute("loading");
        // WebKit decodes a large image inside an SVG image asynchronously and
        // draws it blank; a sync decode keeps it.
        clone.setAttribute("decoding", "sync");
        const src = el.currentSrc || el.getAttribute("src") || "";
        if (src && !src.startsWith("data:")) {
          const token = `__dk_res_${resourceJobs.length}__`;
          resourceJobs.push({ token, url: new URL(src, pageHref).href });
          clone.setAttribute("src", token);
        }
      } else if (tag === "option") {
        if (el.selected) clone.setAttribute("selected", "");
        else clone.removeAttribute("selected");
      }
    }

    // Inner scroll offsets: the clone starts at scroll 0, so shift the
    // scrolled content back by the live offset.
    const scrollTop = el.scrollTop || 0;
    const scrollLeft = el.scrollLeft || 0;
    const scrolled =
      (scrollTop !== 0 || scrollLeft !== 0) &&
      tag !== "html" &&
      tag !== "body" &&
      scrollsChildren(cs);

    clone.setAttribute(
      "style",
      rewriteUrls(styleDeclarations(cs, parentCs, defaults, overrides)),
    );

    pseudoRule(el, cs, clone, "::before");
    pseudoRule(el, cs, clone, "::after");
    if (tag === "input" || tag === "textarea") {
      try {
        const ph = win.getComputedStyle(el, "::placeholder");
        if (ph && ph.color) {
          if (!clone.__dkPseudoClass) {
            pseudoCount += 1;
            clone.__dkPseudoClass = `dk-ps-${pseudoCount}`;
            clone.setAttribute(
              "class",
              `${clone.getAttribute("class") || ""} ${clone.__dkPseudoClass}`.trim(),
            );
          }
          pseudoRules.push(
            `.${clone.__dkPseudoClass}::placeholder{color:${ph.color};opacity:${ph.opacity || 1}}`,
          );
        }
      } catch {
        // ::placeholder unsupported
      }
    }

    if (tag === "textarea") return clone;

    const isFlexOrGrid = /flex|grid/.test(cs.display);
    const positionedScroller = cs.position !== "static";
    const shift =
      scrollLeft !== 0
        ? `${-scrollLeft}px ${-scrollTop}px`
        : `0px ${-scrollTop}px`;
    let target = clone;
    if (scrolled && !isFlexOrGrid) {
      // Block flow: one wrapper moves every in-flow child together.
      const wrapper = out.createElement("div");
      wrapper.setAttribute(
        "style",
        `display:flow-root;margin:0;padding:0;border:0;translate:${shift};`,
      );
      clone.appendChild(wrapper);
      target = wrapper;
    }

    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        if (scrolled && isFlexOrGrid && child.nodeValue.trim()) {
          const span = out.createElement("span");
          span.setAttribute("style", `translate:${shift};`);
          span.textContent = child.nodeValue;
          target.appendChild(span);
        } else {
          target.appendChild(out.createTextNode(child.nodeValue));
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      let childExtra = null;
      let outOfFlow = false;
      if (scrolled) {
        let childPos = "static";
        try {
          childPos = win.getComputedStyle(child).position;
        } catch {
          childPos = "static";
        }
        outOfFlow = childPos === "absolute" || childPos === "fixed";
        // An absolute child scrolls with a positioned scroller; a fixed one,
        // or one placed against an outer box, does not.
        if (childPos === "absolute" && positionedScroller) {
          childExtra = { translate: shift };
        } else if (!outOfFlow && isFlexOrGrid) {
          childExtra = { translate: shift };
        }
      }
      const childClone = cloneElement(child, cs, childExtra);
      if (!childClone) continue;
      // Out-of-flow children stay outside the block-flow wrapper, whose
      // translate would otherwise become their containing block.
      if (outOfFlow) clone.appendChild(childClone);
      else target.appendChild(childClone);
    }
    return clone;
  };

  const htmlEl = doc.documentElement;
  const bodyEl = doc.body;
  const htmlCs = win.getComputedStyle(htmlEl);
  const scrollX = win.scrollX || win.pageXOffset || 0;
  const scrollY = win.scrollY || win.pageYOffset || 0;

  // The page root becomes a positioned <div>, moved by the window scroll, so
  // absolutely positioned content is placed against the document origin and
  // fixed content against the image's viewport, as on screen.
  const root = out.createElementNS(XHTML_NS, "div");
  root.setAttribute(
    "style",
    styleDeclarations(htmlCs, null, getDefaultStyle(sandbox, XHTML_NS, "div"), {
      position: "relative",
      top: `${-scrollY}px`,
      left: `${-scrollX}px`,
      margin: "0",
      "min-height": `${vh}px`,
    }),
  );
  if (bodyEl) {
    const bodyCs = win.getComputedStyle(bodyEl);
    const body = out.createElementNS(XHTML_NS, "div");
    body.setAttribute(
      "style",
      rewriteUrls(
        styleDeclarations(
          bodyCs,
          htmlCs,
          getDefaultStyle(sandbox, XHTML_NS, "div"),
          null,
        ),
      ),
    );
    pseudoRule(bodyEl, bodyCs, body, "::before");
    pseudoRule(bodyEl, bodyCs, body, "::after");
    noteFonts(bodyCs);
    for (const child of Array.from(bodyEl.childNodes)) {
      if (child.nodeType === 3) {
        body.appendChild(out.createTextNode(child.nodeValue));
      } else if (child.nodeType === 1) {
        const c = cloneElement(child, bodyCs, null);
        if (c) body.appendChild(c);
      }
    }
    root.appendChild(body);
  }
  // Fixed content that lives directly under <html> (outside <body>).
  for (const child of Array.from(htmlEl.children)) {
    if (child === bodyEl || child.localName === "head") continue;
    const c = cloneElement(child, htmlCs, null);
    if (c) root.appendChild(c);
  }

  return {
    root,
    resourceJobs,
    frameJobs,
    fontFamilies,
    pseudoRules,
    crossOriginPlaceholders,
  };
}

/** @font-face rules for the families the clone uses, with data URL sources. */
async function collectFontCss(doc, win, fontFamilies, deadline) {
  const rules = [];
  const sheets = Array.from(doc.styleSheets || []);
  const visit = (ruleList, baseHref) => {
    for (const rule of Array.from(ruleList || [])) {
      if (rule.type === 5 /* CSSRule.FONT_FACE_RULE */) {
        const family = String(rule.style?.getPropertyValue("font-family") || "")
          .trim()
          .replace(/^["']|["']$/g, "")
          .toLowerCase();
        if (family && fontFamilies.has(family)) {
          rules.push({ cssText: rule.cssText, baseHref });
        }
      } else if (rule.cssRules) {
        visit(rule.cssRules, baseHref);
      }
    }
  };
  for (const sheet of sheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet
    }
    visit(list, sheet.href || win.location?.href || "");
  }
  const pageOrigin = win.location?.origin || "";
  const pageHref = win.location?.href || "";
  const out = [];
  for (const { cssText, baseHref } of rules) {
    checkDeadline(deadline);
    const jobs = [];
    cssText.replace(CSS_URL_RE, (match, _q, raw) => {
      jobs.push(raw);
      return match;
    });
    const resolved = new Map();
    await withDeadline(
      Promise.all(
        jobs.map(async (raw) => {
          if (raw.startsWith("data:")) return;
          let abs;
          try {
            abs = new URL(raw, baseHref).href;
          } catch {
            return;
          }
          if (!isSameOriginUrl(abs, pageOrigin, pageHref)) return;
          const data = await fetchAsDataUrl(win, abs);
          if (data) resolved.set(raw, data);
        }),
      ),
      deadline,
    );
    out.push(
      cssText.replace(CSS_URL_RE, (match, _q, raw) =>
        resolved.has(raw) ? `url("${resolved.get(raw)}")` : match,
      ),
    );
  }
  return out.join("\n");
}

// The "Embedded frame" placeholder as an image, for a same-origin frame whose
// own render failed after its element was already cloned.
function framePlaceholderUrl() {
  const svg =
    `<svg xmlns="${SVG_NS}" width="160" height="40" viewBox="0 0 160 40" preserveAspectRatio="none">` +
    `<rect width="160" height="40" fill="#27272a" stroke="#71717a" stroke-width="3"/>` +
    `<text x="80" y="24" fill="#e4e4e7" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">Embedded frame</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const RASTER_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i;
// WebKit decodes a raster larger than about 512 KB decoded (131,072 pixels)
// asynchronously inside an SVG image, and draws it blank.
const WEBKIT_SYNC_DECODE_MAX_PIXELS = 120000;

// WebKit draws a large raster inside an SVG image blank. An <img> keeps it
// with decoding="sync", but a CSS image cannot ask for that, so a large CSS
// raster goes in scaled down to a size WebKit decodes synchronously: softer,
// but present.
async function webKitSafeCssImage(doc, win, dataUrl) {
  if (!dataUrl || !RASTER_DATA_URL_RE.test(dataUrl)) return dataUrl;
  let image;
  try {
    image = new win.Image();
    image.src = dataUrl;
    await image.decode();
  } catch {
    return dataUrl;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height || width * height <= WEBKIT_SYNC_DECODE_MAX_PIXELS) {
    return dataUrl;
  }
  const k = Math.sqrt(WEBKIT_SYNC_DECODE_MAX_PIXELS / (width * height));
  const canvas = doc.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * k));
  canvas.height = Math.max(1, Math.floor(height * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  try {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return /^data:image\/jpe?g/i.test(dataUrl)
      ? canvas.toDataURL("image/jpeg", 0.92)
      : canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

function loadImage(win, src) {
  return new Promise((resolve, reject) => {
    const img = new win.Image();
    img.decoding = "sync";
    img.onload = () => resolve(img);
    img.onerror = () => reject(rasterFailure("rendered image failed to load"));
    img.src = src;
  });
}

function rasterScaleFor(win, vw, vh, requested) {
  const dpr = Number(requested) || Number(win.devicePixelRatio) || 1;
  return Math.max(
    0.1,
    Math.min(
      dpr,
      MAX_RASTER_SCALE,
      MAX_RASTER_DIMENSION / vw,
      MAX_RASTER_DIMENSION / vh,
    ),
  );
}

/**
 * The scales an image is encoded at until it fits the 1 MiB cap: the full
 * scale, stepped down while still sharper than CSS pixels, then the
 * painter's ladder.
 */
function encodeLadder(scale, vw, vh) {
  const painterStart = Math.min(
    1,
    MAX_CANVAS_WIDTH / vw,
    MAX_CANVAS_HEIGHT / vh,
  );
  const steps = [scale];
  for (const f of [0.8, 0.66, 0.5, 0.4]) {
    if (scale * f > 1) steps.push(scale * f);
  }
  steps.push(
    painterStart,
    painterStart * 0.75,
    painterStart * 0.5,
    painterStart * 0.35,
  );
  const seen = new Set();
  return steps.filter((s) => {
    const key = Math.round(s * 1000);
    if (seen.has(key) || s > scale + 1e-6) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Draw `paint(ctx)` (in CSS pixels) at each ladder scale and return the
 * first PNG within MAX_SNAPSHOT_BYTES. `checkTaint` reads one pixel first so
 * a tainted canvas fails here, before any encode.
 */
function encodeWithinCap(
  doc,
  vw,
  vh,
  scales,
  paint,
  extra,
  maxBytes = MAX_SNAPSHOT_BYTES,
) {
  for (const scale of scales) {
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    const canvas = doc.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) throw rasterFailure("no 2d context");
    ctx.scale(cw / vw, ch / vh);
    paint(ctx);
    // Throws SecurityError on a tainted canvas.
    ctx.getImageData(0, 0, 1, 1);
    const dataUrl = canvas.toDataURL("image/png");
    const byteLength = base64ByteLength(dataUrl);
    if (byteLength > 0 && byteLength <= maxBytes) {
      return { dataUrl, width: cw, height: ch, byteLength, ...extra };
    }
  }
  return undefined;
}

function viewportSize(doc, win) {
  return {
    vw: Math.max(
      1,
      Math.round(win.innerWidth || doc.documentElement?.clientWidth || 1280),
    ),
    vh: Math.max(
      1,
      Math.round(win.innerHeight || doc.documentElement?.clientHeight || 800),
    ),
  };
}

function rootBackground(doc, win) {
  const bodyCs = doc.body ? win.getComputedStyle(doc.body) : null;
  const htmlCs = doc.documentElement
    ? win.getComputedStyle(doc.documentElement)
    : null;
  if (!isTransparent(htmlCs?.backgroundColor)) return htmlCs.backgroundColor;
  if (!isTransparent(bodyCs?.backgroundColor)) return bodyCs.backgroundColor;
  return "#ffffff";
}

/**
 * Render the live viewport with the browser's own renderer. Resolves a
 * SnapshotImage or rejects; callers fall back to the hand painter.
 */
/**
 * Clone and serialize `doc`'s viewport into a loaded SVG image of it.
 * Same-origin frames inside it are rendered the same way and nested as
 * SVG images.
 */
async function renderDocumentImage(doc, opts) {
  const { deadline, depth } = opts;
  const win = doc.defaultView || globalThis;
  if (
    typeof win.XMLSerializer !== "function" ||
    typeof win.Image !== "function" ||
    !doc.implementation?.createHTMLDocument ||
    !doc.documentElement
  ) {
    throw rasterFailure("browser rendering unavailable");
  }
  const { vw, vh } = viewportSize(doc, win);
  const sandbox = opts.sandbox || createSandbox(doc);
  let cloned;
  try {
    sandbox.doc();
    cloned = cloneViewportDom(doc, win, vw, vh, {
      ignoreTag: opts.ignoreTag,
      deadline,
      sandbox,
      depth,
      ignoreNodes: new Set([sandbox.frame()].filter(Boolean)),
    });
  } finally {
    if (!opts.sandbox) sandbox.dispose();
  }

  const fontCss = await collectFontCss(doc, win, cloned.fontFamilies, deadline);
  const resources = await withDeadline(
    Promise.all(cloned.resourceJobs.map((job) => fetchAsDataUrl(win, job.url))),
    deadline,
  );
  if (isWebKitCanvasEngine(win)) {
    const safe = await withDeadline(
      Promise.all(
        cloned.resourceJobs.map((job, i) =>
          job.css ? webKitSafeCssImage(doc, win, resources[i]) : resources[i],
        ),
      ),
      deadline,
    );
    safe.forEach((data, i) => {
      resources[i] = data;
    });
  }
  // Each same-origin frame goes in as its own rendered SVG, which keeps it
  // vector at any scale. (A PNG of the frame nested in the page's SVG is
  // dropped by WebKit when the page is drawn above 1x.) A frame that cannot
  // be rendered becomes the labelled placeholder.
  const frames = [];
  for (const job of cloned.frameJobs) {
    try {
      const inner = await renderDocumentImage(job.frameDoc, {
        ...opts,
        sandbox: undefined,
        depth: depth + 1,
      });
      frames.push({ src: inner.img.src, background: inner.background });
      cloned.crossOriginPlaceholders += inner.crossOriginPlaceholders;
    } catch (error) {
      if (error?.name === "SnapshotRasterError" && Date.now() > deadline) {
        throw error;
      }
      frames.push({ src: framePlaceholderUrl(), background: "#27272a" });
      cloned.crossOriginPlaceholders += 1;
    }
  }

  const styleEl = cloned.root.ownerDocument.createElementNS(XHTML_NS, "style");
  // Scrollbars are hidden: the clone sits at scroll 0, so a thumb would
  // show the wrong position.
  styleEl.textContent = `${fontCss}\n*{scrollbar-width:none}*::-webkit-scrollbar{display:none}\n${cloned.pseudoRules.join("\n")}`;
  cloned.root.insertBefore(styleEl, cloned.root.firstChild);

  let xhtml = new win.XMLSerializer().serializeToString(cloned.root);
  // Same-origin images, CSS urls and frames, inlined; a failed one is dropped.
  xhtml = xhtml
    .replace(/__dk_res_(\d+)__/g, (_m, i) => {
      const data = resources[Number(i)];
      return data ? data.replace(/"/g, "%22") : "";
    })
    .replace(/__dk_frame_(\d+)__/g, (_m, i) => frames[Number(i)]?.src || "")
    .replace(
      /__dk_framebg_(\d+)__/g,
      (_m, i) => frames[Number(i)]?.background || "transparent",
    );
  checkDeadline(deadline);

  const svg =
    `<svg xmlns="${SVG_NS}" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}">` +
    `<foreignObject x="0" y="0" width="${vw}" height="${vh}">${xhtml}</foreignObject></svg>`;
  const img = await withDeadline(
    loadImage(
      win,
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    ),
    deadline,
  );
  if (typeof img.decode === "function") {
    try {
      await withDeadline(img.decode(), deadline);
    } catch (error) {
      if (error?.name === "SnapshotRasterError") throw error;
    }
  }
  return {
    img,
    vw,
    vh,
    background: rootBackground(doc, win),
    crossOriginPlaceholders: cloned.crossOriginPlaceholders,
  };
}

async function rasterizeViewport(annotation, options) {
  const doc = options.document;
  const win = doc.defaultView || globalThis;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  if (timeoutMs <= 0) throw rasterFailure("snapshot timed out");
  const { vw, vh } = viewportSize(doc, win);
  const scale = rasterScaleFor(win, vw, vh, options.scale);
  const { img, background, crossOriginPlaceholders } =
    await renderDocumentImage(doc, {
      ignoreTag: options.ignoreTag || "design-kit-annotator",
      deadline,
      depth: 0,
    });
  checkDeadline(deadline);

  const shot = encodeWithinCap(
    doc,
    vw,
    vh,
    encodeLadder(scale, vw, vh),
    (ctx) => {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, vw, vh);
      ctx.drawImage(img, 0, 0, vw, vh);
      drawAllCallouts(ctx, annotation, options.allAnnotations, vw, vh);
    },
    { crossOriginPlaceholders, renderer: "browser" },
  );
  if (!shot) throw rasterFailure("snapshot over the size cap");
  return shot;
}

/**
 * Capture a composited callout PNG of the live viewport, rendered by the
 * browser from the DOM (SVG foreignObject) at device pixel ratio (at most
 * 3x), with every annotation in `allAnnotations` drawn once on top. Falls
 * back to the hand painter (`captureCalloutSnapshot`) on any throw, a
 * tainted canvas, or `timeoutMs` (default 1500). Never rejects; resolves
 * undefined only when no canvas is available at all.
 */
export async function captureViewportSnapshot(annotation, options = {}) {
  const doc =
    options.document ||
    (typeof globalThis.document === "object" ? globalThis.document : null);
  if (!doc || typeof doc.createElement !== "function") return undefined;
  try {
    return await rasterizeViewport(annotation, { ...options, document: doc });
  } catch {
    const painted = captureCalloutSnapshot(annotation, {
      ...options,
      document: doc,
    });
    return painted ? { ...painted, renderer: "painter" } : painted;
  }
}
