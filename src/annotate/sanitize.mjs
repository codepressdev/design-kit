/**
 * Redline Context Packet contract, route/security sanitization,
 * pairwise overlap math, and Markdown / XML formatters.
 * Zero runtime dependencies; runs in both Node (>= 20) and browsers.
 */

export const REDLINE_PACKET_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MiB
export const MAX_OUTER_HTML_CHARS = 1600;
export const MAX_NOTE_CHARS = 2000;
export const MAX_OWNERS = 6;
export const MAX_SOURCE_HINTS = 6;
export const MAX_ITEMS = 50;
export const MAX_FREEHAND_POINTS = 256;

const SENSITIVE_PARAM_EXACT = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "authorization",
  "key",
  "api_key",
  "apikey",
  "secret",
  "password",
  "passwd",
  "pwd",
  "code",
  "session",
  "session_id",
  "sessionid",
  "jwt",
  "signature",
  "sig",
  "credential",
  "credentials",
  "bearer",
  "cookie",
  "csrf",
  "xsrf",
  "x-api-key",
  "x-auth-token",
  "cap",
  "capability",
]);

const SENSITIVE_PARAM_SUFFIX =
  /(?:^|[_-])(token|secret|key|password|passwd|auth|credential|signature|sig|jwt|cookie|session)$/i;

const CAPABILITY_PREFIX_RE = /^\/v\d+\/[^/]+(?=\/|$)/;

// Control chars invalid in XML 1.0 (keep TAB 0x09, LF 0x0A, CR 0x0D).
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function isSensitiveParam(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower) return false;
  return SENSITIVE_PARAM_EXACT.has(lower) || SENSITIVE_PARAM_SUFFIX.test(lower);
}

/**
 * Sanitize a route or URL path:
 * - Strips leading capability proxy segments (`/v<n>/<capability>`)
 * - Strips credential / token query parameters while preserving benign params
 * - Drops fragments to avoid leaking OAuth/hash tokens
 */
export function sanitizeRoute(rawRoute) {
  const input = String(rawRoute ?? "").trim();
  if (!input) return "/";

  let url;
  try {
    url = new URL(input, "https://design-kit.invalid");
  } catch {
    const cleaned = input.split("#")[0].split("?")[0];
    const stripped = cleaned.replace(CAPABILITY_PREFIX_RE, "");
    return stripped.startsWith("/") ? stripped || "/" : `/${stripped}`;
  }

  let pathname = url.pathname || "/";
  pathname = pathname.replace(CAPABILITY_PREFIX_RE, "");
  if (!pathname) pathname = "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  const kept = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (!isSensitiveParam(k)) {
      kept.append(k, v);
    }
  }
  const qs = kept.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Strip XML-invalid control characters and escape XML entities.
 */
export function escapeXmlText(value) {
  return String(value ?? "")
    .replace(INVALID_XML_CHARS_RE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Safely escape content for inclusion inside an XML CDATA section so
 * untrusted strings like `]]><script>alert(1)</script>` can never break out.
 */
export function escapeCdata(value) {
  return String(value ?? "")
    .replace(INVALID_XML_CHARS_RE, "")
    .replace(/]]>/g, "]]]]><![CDATA[>");
}

/**
 * Compute overlap in CSS pixels between two axis-aligned rectangles.
 */
export function computeBoxOverlap(a, b) {
  if (!a || !b) {
    return { overlapX: 0, overlapY: 0, overlapArea: 0, overlapPx: 0 };
  }
  const ax1 = Number(a.x) || 0;
  const ay1 = Number(a.y) || 0;
  const ax2 = ax1 + Math.max(0, Number(a.width) || 0);
  const ay2 = ay1 + Math.max(0, Number(a.height) || 0);

  const bx1 = Number(b.x) || 0;
  const by1 = Number(b.y) || 0;
  const bx2 = bx1 + Math.max(0, Number(b.width) || 0);
  const by2 = by1 + Math.max(0, Number(b.height) || 0);

  const overlapX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const overlapY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const overlapArea = overlapX * overlapY;
  const overlapPx =
    overlapArea > 0 ? Math.round(Math.min(overlapX, overlapY)) : 0;

  return {
    overlapX: Math.round(overlapX),
    overlapY: Math.round(overlapY),
    overlapArea: Math.round(overlapArea),
    overlapPx,
  };
}

/**
 * Compute pairwise overlaps between a list of labelled rects `{ selector?, label?, rect }`.
 * Returns `{ maxOverlapPx, pairs }` sorted by overlap area descending.
 */
export function computePairwiseOverlaps(entries, maxPairs = 8) {
  const list = Array.isArray(entries) ? entries : [];
  const pairs = [];
  let maxOverlapPx = 0;

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const ov = computeBoxOverlap(a?.rect, b?.rect);
      if (ov.overlapArea > 0) {
        if (ov.overlapPx > maxOverlapPx) maxOverlapPx = ov.overlapPx;
        pairs.push({
          a: String(a.selector || a.label || `el-${i}`),
          b: String(b.selector || b.label || `el-${j}`),
          overlapX: ov.overlapX,
          overlapY: ov.overlapY,
          overlapPx: ov.overlapPx,
          overlapArea: ov.overlapArea,
        });
      }
    }
  }

  pairs.sort((p1, p2) => p2.overlapArea - p1.overlapArea);
  return {
    maxOverlapPx,
    pairs: pairs.slice(0, maxPairs),
  };
}

function clampNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

function sanitizeRect(rect) {
  if (!rect || typeof rect !== "object") return undefined;
  return {
    x: clampNumber(rect.x, 0),
    y: clampNumber(rect.y, 0),
    width: Math.max(0, clampNumber(rect.width, 0)),
    height: Math.max(0, clampNumber(rect.height, 0)),
  };
}

function sanitizePoint(pt) {
  if (!pt || typeof pt !== "object") return undefined;
  return {
    x: clampNumber(pt.x, 0),
    y: clampNumber(pt.y, 0),
  };
}

function sanitizeSourceHint(hint) {
  if (!hint || typeof hint !== "object" || !hint.file) return null;
  const out = {
    framework: String(hint.framework || "unknown").slice(0, 32),
    file: String(hint.file).replace(INVALID_XML_CHARS_RE, "").slice(0, 512),
    confidence:
      hint.confidence === "high" ||
      hint.confidence === "medium" ||
      hint.confidence === "low"
        ? hint.confidence
        : "medium",
  };
  if (Number.isFinite(Number(hint.line)) && Number(hint.line) > 0) {
    out.line = Math.floor(Number(hint.line));
  }
  if (Number.isFinite(Number(hint.column)) && Number(hint.column) > 0) {
    out.column = Math.floor(Number(hint.column));
  }
  if (hint.component) {
    out.component = String(hint.component)
      .replace(INVALID_XML_CHARS_RE, "")
      .slice(0, 128);
  }
  return out;
}

function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const dataUrl = typeof snapshot.dataUrl === "string" ? snapshot.dataUrl : "";
  if (!dataUrl.startsWith("data:image/png;base64,")) return undefined;
  const b64 = dataUrl.slice("data:image/png;base64,".length);
  const byteLength = Math.floor((b64.length * 3) / 4);
  if (byteLength <= 0 || byteLength > MAX_SNAPSHOT_BYTES) return undefined;
  return {
    dataUrl,
    width: Math.max(1, Math.floor(Number(snapshot.width) || 1)),
    height: Math.max(1, Math.floor(Number(snapshot.height) || 1)),
    byteLength,
    crossOriginPlaceholders: Math.max(
      0,
      Math.floor(Number(snapshot.crossOriginPlaceholders) || 0),
    ),
  };
}

function sanitizeComputedStyle(style) {
  if (!style || typeof style !== "object") return undefined;
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(style)) {
    if (count >= 32) break;
    if (v === undefined || v === null || v === "") continue;
    const key = String(k).slice(0, 48);
    const val = String(v).replace(INVALID_XML_CHARS_RE, "").slice(0, 160);
    out[key] = val;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function sanitizeTargetMeta(target) {
  if (!target || typeof target !== "object") return undefined;
  const out = {};
  if (target.selector) out.selector = String(target.selector).slice(0, 512);
  if (target.tag) out.tag = String(target.tag).slice(0, 48);
  if (target.text)
    out.text = String(target.text)
      .replace(INVALID_XML_CHARS_RE, "")
      .slice(0, 240);
  if (target.rect) out.rect = sanitizeRect(target.rect);
  if (target.outerHtml) {
    out.outerHtml = String(target.outerHtml)
      .replace(INVALID_XML_CHARS_RE, "")
      .slice(0, MAX_OUTER_HTML_CHARS);
  }
  if (target.computedStyle) {
    out.computedStyle = sanitizeComputedStyle(target.computedStyle);
  }
  if (Array.isArray(target.sourceHints)) {
    out.sourceHints = target.sourceHints
      .map(sanitizeSourceHint)
      .filter(Boolean)
      .slice(0, MAX_SOURCE_HINTS);
  }
  if (Array.isArray(target.owners)) {
    out.owners = target.owners
      .map((o) =>
        String(o || "")
          .replace(INVALID_XML_CHARS_RE, "")
          .slice(0, 128),
      )
      .filter(Boolean)
      .slice(0, MAX_OWNERS);
  }
  return out;
}

/**
 * Validate and sanitize a RedlinePacket before dispatch or formatting.
 */
export function sanitizeRedlinePacket(rawPacket) {
  const src = rawPacket && typeof rawPacket === "object" ? rawPacket : {};
  const rawItems = Array.isArray(src.items)
    ? src.items.slice(0, MAX_ITEMS)
    : [];

  const items = rawItems.map((raw, idx) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const kind =
      item.kind === "pin" ||
      item.kind === "box" ||
      item.kind === "arrow" ||
      item.kind === "freehand"
        ? item.kind
        : "pin";

    const clean = {
      id: String(item.id || `item-${idx + 1}`).slice(0, 64),
      index: idx + 1,
      kind,
      note: String(item.note ?? "")
        .replace(INVALID_XML_CHARS_RE, "")
        .trim()
        .slice(0, MAX_NOTE_CHARS),
      route: sanitizeRoute(item.route ?? src.route ?? "/"),
      createdAt: String(item.createdAt || new Date().toISOString()).slice(
        0,
        64,
      ),
      viewport: {
        width: Math.max(
          0,
          Math.floor(Number(item.viewport?.width ?? src.viewport?.width) || 0),
        ),
        height: Math.max(
          0,
          Math.floor(
            Number(item.viewport?.height ?? src.viewport?.height) || 0,
          ),
        ),
        dpr: Math.max(
          1,
          clampNumber(item.viewport?.dpr ?? src.viewport?.dpr, 1),
        ),
      },
      theme:
        item.theme === "dark" || item.theme === "light"
          ? item.theme
          : src.theme === "dark"
            ? "dark"
            : "light",
    };

    if (item.point) clean.point = sanitizePoint(item.point);
    if (item.rect) clean.rect = sanitizeRect(item.rect);
    if (item.from) clean.from = sanitizeTargetMeta(item.from);
    if (item.to) clean.to = sanitizeTargetMeta(item.to);
    if (Array.isArray(item.points)) {
      clean.points = item.points
        .slice(0, MAX_FREEHAND_POINTS)
        .map(sanitizePoint)
        .filter(Boolean);
    }

    if (item.selector) clean.selector = String(item.selector).slice(0, 512);
    if (item.outerHtml) {
      clean.outerHtml = String(item.outerHtml)
        .replace(INVALID_XML_CHARS_RE, "")
        .slice(0, MAX_OUTER_HTML_CHARS);
    }
    if (item.computedStyle) {
      clean.computedStyle = sanitizeComputedStyle(item.computedStyle);
    }
    if (Array.isArray(item.sourceHints)) {
      clean.sourceHints = item.sourceHints
        .map(sanitizeSourceHint)
        .filter(Boolean)
        .slice(0, MAX_SOURCE_HINTS);
    } else {
      clean.sourceHints = [];
    }
    if (Array.isArray(item.owners)) {
      clean.owners = item.owners
        .map((o) =>
          String(o || "")
            .replace(INVALID_XML_CHARS_RE, "")
            .slice(0, 128),
        )
        .filter(Boolean)
        .slice(0, MAX_OWNERS);
    } else {
      clean.owners = [];
    }

    if (Number.isFinite(Number(item.overlapPx))) {
      clean.overlapPx = Math.max(0, Math.round(Number(item.overlapPx)));
    }
    if (Array.isArray(item.overlaps) && item.overlaps.length > 0) {
      clean.overlaps = item.overlaps.slice(0, 8).map((ov) => ({
        a: String(ov.a || "").slice(0, 256),
        b: String(ov.b || "").slice(0, 256),
        overlapX: Math.max(0, Math.round(Number(ov.overlapX) || 0)),
        overlapY: Math.max(0, Math.round(Number(ov.overlapY) || 0)),
        overlapPx: Math.max(0, Math.round(Number(ov.overlapPx) || 0)),
      }));
    }

    const snap = sanitizeSnapshot(item.snapshot);
    if (snap) clean.snapshot = snap;

    return clean;
  });

  const routes = [];
  for (const it of items) {
    if (!routes.includes(it.route)) routes.push(it.route);
  }

  return {
    version: REDLINE_PACKET_VERSION,
    capturedAt: String(src.capturedAt || new Date().toISOString()).slice(0, 64),
    route: sanitizeRoute(src.route ?? items[items.length - 1]?.route ?? "/"),
    routes,
    viewport: {
      width: Math.max(
        0,
        Math.floor(
          Number(src.viewport?.width ?? items[0]?.viewport?.width) || 0,
        ),
      ),
      height: Math.max(
        0,
        Math.floor(
          Number(src.viewport?.height ?? items[0]?.viewport?.height) || 0,
        ),
      ),
      dpr: Math.max(
        1,
        clampNumber(src.viewport?.dpr ?? items[0]?.viewport?.dpr, 1),
      ),
    },
    theme: src.theme === "dark" ? "dark" : "light",
    items,
  };
}

/**
 * Format a RedlinePacket as compact, human- and agent-readable Markdown.
 */
export function formatRedlineMarkdown(rawPacket) {
  const packet = sanitizeRedlinePacket(rawPacket);
  const lines = [];
  lines.push(`# Screen Annotations (${packet.items.length})`);
  lines.push(
    `- Routes: ${packet.routes.length ? packet.routes.join(", ") : packet.route}`,
  );
  lines.push(
    `- Viewport: ${packet.viewport.width}x${packet.viewport.height} @${packet.viewport.dpr}x (${packet.theme})`,
  );
  lines.push("");

  for (const item of packet.items) {
    lines.push(`## #${item.index} [${item.kind}] ${item.route}`);
    if (item.note) lines.push(`Note: ${item.note}`);
    if (item.selector) lines.push(`- Selector: \`${item.selector}\``);
    if (item.sourceHints.length > 0) {
      const formatted = item.sourceHints
        .map((h) => {
          const loc = h.line
            ? `${h.file}:${h.line}${h.column ? `:${h.column}` : ""}`
            : h.file;
          return `${loc} (${h.framework})`;
        })
        .join(", ");
      lines.push(`- Source hints: ${formatted}`);
    }
    if (item.owners.length > 0) {
      lines.push(`- Component stack: ${item.owners.join(" > ")}`);
    }
    if (item.kind === "box" && item.rect) {
      lines.push(
        `- Region: x=${item.rect.x}, y=${item.rect.y}, w=${item.rect.width}, h=${item.rect.height}`,
      );
      if (item.overlapPx > 0) {
        lines.push(`- Overlap detected: ${item.overlapPx}px`);
      }
    }
    if (item.kind === "arrow") {
      if (item.from?.selector)
        lines.push(`- Move from: \`${item.from.selector}\``);
      if (item.to?.selector) lines.push(`- Move to: \`${item.to.selector}\``);
    }
    if (item.computedStyle) {
      const summary = Object.entries(item.computedStyle)
        .slice(0, 10)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      lines.push(`- Layout: ${summary}`);
    }
    if (item.snapshot) {
      lines.push(
        `- Snapshot: PNG ${item.snapshot.width}x${item.snapshot.height} (${item.snapshot.byteLength} bytes)`,
      );
    }
    if (item.outerHtml) {
      lines.push("```html");
      lines.push(item.outerHtml);
      lines.push("```");
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

/**
 * Format a RedlinePacket as bounded, XML/CDATA-safe `<screen_annotations>`.
 */
export function formatRedlineXml(rawPacket) {
  const packet = sanitizeRedlinePacket(rawPacket);
  const lines = [];
  lines.push(
    `<screen_annotations version="${packet.version}" route="${escapeXmlText(packet.route)}" viewport="${packet.viewport.width}x${packet.viewport.height}@${packet.viewport.dpr}" theme="${escapeXmlText(packet.theme)}" count="${packet.items.length}">`,
  );

  for (const item of packet.items) {
    lines.push(
      `  <annotation index="${item.index}" id="${escapeXmlText(item.id)}" kind="${escapeXmlText(item.kind)}" route="${escapeXmlText(item.route)}" viewport="${item.viewport.width}x${item.viewport.height}@${item.viewport.dpr}" theme="${escapeXmlText(item.theme)}">`,
    );
    if (item.note) {
      lines.push(`    <note><![CDATA[${escapeCdata(item.note)}]]></note>`);
    }
    if (item.selector) {
      lines.push(`    <selector>${escapeXmlText(item.selector)}</selector>`);
    }
    if (item.owners.length > 0) {
      lines.push(
        `    <owners>${escapeXmlText(item.owners.join(" > "))}</owners>`,
      );
    }
    if (item.sourceHints.length > 0) {
      lines.push("    <source_hints>");
      for (const h of item.sourceHints) {
        const lineAttr = h.line ? ` line="${h.line}"` : "";
        const colAttr = h.column ? ` column="${h.column}"` : "";
        const compAttr = h.component
          ? ` component="${escapeXmlText(h.component)}"`
          : "";
        lines.push(
          `      <hint framework="${escapeXmlText(h.framework)}" confidence="${escapeXmlText(h.confidence)}" file="${escapeXmlText(h.file)}"${lineAttr}${colAttr}${compAttr} />`,
        );
      }
      lines.push("    </source_hints>");
    }
    if (item.rect) {
      lines.push(
        `    <rect x="${item.rect.x}" y="${item.rect.y}" width="${item.rect.width}" height="${item.rect.height}" />`,
      );
    }
    if (item.point) {
      lines.push(`    <point x="${item.point.x}" y="${item.point.y}" />`);
    }
    if (item.overlapPx !== undefined) {
      lines.push(`    <overlap max_px="${item.overlapPx}">`);
      for (const ov of item.overlaps || []) {
        lines.push(
          `      <pair a="${escapeXmlText(ov.a)}" b="${escapeXmlText(ov.b)}" overlap_x="${ov.overlapX}" overlap_y="${ov.overlapY}" overlap_px="${ov.overlapPx}" />`,
        );
      }
      lines.push("    </overlap>");
    }
    if (item.from) {
      lines.push(
        `    <move_from selector="${escapeXmlText(item.from.selector || "")}" />`,
      );
    }
    if (item.to) {
      lines.push(
        `    <move_to selector="${escapeXmlText(item.to.selector || "")}" />`,
      );
    }
    if (item.computedStyle) {
      lines.push("    <computed_style>");
      for (const [k, v] of Object.entries(item.computedStyle)) {
        lines.push(
          `      <prop name="${escapeXmlText(k)}">${escapeXmlText(v)}</prop>`,
        );
      }
      lines.push("    </computed_style>");
    }
    if (item.outerHtml) {
      lines.push(
        `    <outer_html><![CDATA[${escapeCdata(item.outerHtml)}]]></outer_html>`,
      );
    }
    if (item.snapshot) {
      lines.push(
        `    <snapshot width="${item.snapshot.width}" height="${item.snapshot.height}" bytes="${item.snapshot.byteLength}" cross_origin_placeholders="${item.snapshot.crossOriginPlaceholders}" />`,
      );
    }
    lines.push("  </annotation>");
  }

  lines.push("</screen_annotations>");
  return lines.join("\n");
}
