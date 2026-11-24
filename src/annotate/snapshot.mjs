/**
 * Live viewport composited callout PNG snapshotter.
 *
 * Paints the current viewport DOM + redline callout overlay into a PNG
 * data URL bounded to <= 1 MiB. Any cross-origin <img> is replaced with a
 * labelled placeholder box so canvas.toDataURL() never throws SecurityError.
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

function drawCalloutOverlay(ctx, annotation) {
  const accent = "#ef4444";
  const accentFill = "rgba(239, 68, 68, 0.14)";
  const badgeBg = "#ef4444";
  const badgeFg = "#ffffff";
  const indexLabel = String(annotation.index || 1);

  ctx.save();

  const drawBadge = (bx, by) => {
    const r = 11;
    const cx = Math.max(r + 2, Math.min(bx, ctx.canvas.width - r - 2));
    const cy = Math.max(r + 2, Math.min(by, ctx.canvas.height - r - 2));
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

function drawAllCallouts(ctx, annotation, allAnnotations) {
  if (Array.isArray(allAnnotations) && allAnnotations.length > 0) {
    for (const other of allAnnotations) {
      if (!other || other === annotation || other.id === annotation?.id) {
        continue;
      }
      drawCalloutOverlay(ctx, other);
    }
  }
  if (annotation) {
    drawCalloutOverlay(ctx, annotation);
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
    try {
      ctx.drawImage(img, 0, 0, vw, vh);
      drawAllCallouts(ctx, annotation, allAnnotations);
      const dataUrl = canvas.toDataURL("image/png");
      const byteLength = base64ByteLength(dataUrl);
      if (byteLength > 0 && byteLength <= MAX_SNAPSHOT_BYTES) {
        return {
          dataUrl,
          width: cw,
          height: ch,
          byteLength,
          crossOriginPlaceholders: 0,
        };
      }
    } catch {
      return undefined;
    }
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
    drawAllCallouts(ctx, annotation, allAnnotations);

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
      drawAllCallouts(safeCtx, annotation, allAnnotations);
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
