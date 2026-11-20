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

  if (!doc.body || typeof doc.createTreeWalker !== "function") {
    return crossOriginPlaceholders;
  }

  const elements = [];
  const stack = [doc.body];
  let visited = 0;
  const MAX_NODES = 1200;

  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop();
    if (!node || node.nodeType !== 1) continue;
    const tag = String(node.tagName || "").toLowerCase();
    if (
      tag === ignoreTag ||
      tag === "script" ||
      tag === "style" ||
      tag === "noscript"
    ) {
      continue;
    }
    visited += 1;
    elements.push(node);
    const children = node.children;
    if (children && children.length) {
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
    }
  }

  for (const el of elements) {
    let rect;
    let cs;
    try {
      rect = el.getBoundingClientRect();
      cs = win.getComputedStyle(el);
    } catch {
      continue;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh)
      continue;
    if (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      Number(cs.opacity) === 0
    )
      continue;

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

    // Images (cross-origin safe)
    const tag = String(el.tagName || "").toLowerCase();
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

    // Direct text nodes
    const textParts = [];
    for (const child of el.childNodes || []) {
      if (child.nodeType === 3) {
        const t = String(child.nodeValue || "").trim();
        if (t) textParts.push(t);
      }
    }
    if (textParts.length > 0) {
      const text = textParts.join(" ").slice(0, 120);
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
      const padT = parseFloat(cs.paddingTop) || 2;
      ctx.fillText(text, x + padL, y + padT, Math.max(10, w - padL * 2));
      ctx.restore();
    }
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

/**
 * Capture a live composited callout PNG snapshot for a single annotation item.
 * Always resolves (never throws SecurityError) and keeps PNG <= 1 MiB.
 */
export function captureCalloutSnapshot(annotation, options = {}) {
  const doc =
    options.document ||
    (typeof globalThis.document === "object" ? globalThis.document : null);
  const win = doc?.defaultView || globalThis;
  const ignoreTag = options.ignoreTag || "design-kit-annotator";

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
    drawCalloutOverlay(ctx, annotation);

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
      drawCalloutOverlay(safeCtx, annotation);
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
