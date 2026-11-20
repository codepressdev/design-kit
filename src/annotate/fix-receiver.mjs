/**
 * Shared `/__design-kit/fix` loopback receiver and local agent auto-fix bridge.
 *
 * Used by:
 * - `@codepress/design-kit/vite` (Vite dev-server middleware)
 * - `@codepress/design-kit/next` (Next.js App Router / Node middleware helper)
 * - `design-kit annotate` (zero-code local proxy CLI)
 *
 * Zero runtime dependencies. Cross-platform (macOS, Linux, Windows).
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  formatRedlineMarkdown,
  MAX_SNAPSHOT_BYTES,
  sanitizeRedlinePacket,
} from "./sanitize.mjs";

export const DEFAULT_FIX_PATH = "/__design-kit/fix";
export const DEFAULT_SCRIPT_PATH = "/__design-kit/annotator.js";
export const DEFAULT_REDLINES_DIR = ".design-kit/redlines";
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const TOKEN_HEADER = "x-design-kit-token";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Generate a per-server random capability token for `X-Design-Kit-Token`. */
export function generateCapabilityToken() {
  return randomBytes(24).toString("hex");
}

/** Constant-time string equality check for capability tokens. */
export function tokensEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const a = Buffer.from(provided.trim(), "utf8");
  const b = Buffer.from(expected.trim(), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Return true if a hostname refers to the local loopback interface. */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== "string") return false;
  const h = hostname.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    h.endsWith(".localhost")
  );
}

/** Return true if a socket remoteAddress is a loopback IP (IPv4 or IPv6). */
export function isLoopbackAddress(remoteAddress) {
  if (typeof remoteAddress !== "string") return false;
  const addr = remoteAddress.trim().toLowerCase();
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.") ||
    addr.startsWith("::ffff:127.")
  );
}

/**
 * Validate the HTTP `Origin` header against the server's host or explicit
 * allowlist. Rejects missing, malformed, non-loopback, or mismatched origins.
 */
export function isOriginAllowed(originHeader, reqHostHeader, allowedOrigins) {
  if (typeof originHeader !== "string" || !originHeader.trim()) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(originHeader.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0) {
    const normalized = parsed.origin.toLowerCase();
    return allowedOrigins.some(
      (candidate) =>
        typeof candidate === "string" &&
        candidate.trim().toLowerCase() === normalized,
    );
  }

  if (!isLoopbackHost(parsed.hostname)) {
    return false;
  }

  if (typeof reqHostHeader === "string" && reqHostHeader.trim()) {
    return parsed.host.toLowerCase() === reqHostHeader.trim().toLowerCase();
  }

  return true;
}

/** Detect path traversal sequences (`..`, `\`, null bytes, or encoded forms). */
export function hasPathTraversal(value) {
  if (typeof value !== "string") return false;
  if (value.includes("\0")) return true;
  if (value.includes("\\")) return true;
  if (value.includes("..")) return true;
  const lower = value.toLowerCase();
  if (
    lower.includes("%2e%2e") ||
    lower.includes("%5c") ||
    lower.includes("%00")
  )
    return true;
  return false;
}

/** Detect unsafe path segment characters (slashes, backslashes, `..`, NUL). */
function hasUnsafeIdentifier(value) {
  if (typeof value !== "string") return false;
  return (
    hasPathTraversal(value) ||
    value.includes("/") ||
    value.includes("\r") ||
    value.includes("\n")
  );
}

/** Verify `targetPath` resolves strictly inside `baseDir` (Windows-safe). */
export function assertPathInside(targetPath, baseDir) {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(prefix)) {
    throw new Error("Path resolves outside allowed directory");
  }
  return resolvedTarget;
}

/** Normalize a relative path to forward slashes for portable Markdown/JSON. */
function toPosixPath(p) {
  return p.split(sep).join("/");
}

/**
 * Validate raw request URL and JSON body for path traversal or malformed fields
 * before sanitizing or writing anything to disk.
 */
export function validateRawRequestSafety(rawBody, reqUrl = "") {
  if (typeof reqUrl === "string" && hasPathTraversal(reqUrl)) {
    return { ok: false, error: "Path traversal in request URL is not allowed" };
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const forbiddenPathKeys = [
    "runId",
    "sessionId",
    "dir",
    "outDir",
    "folder",
    "filename",
    "path",
    "target",
  ];
  for (const key of forbiddenPathKeys) {
    if (key in rawBody && rawBody[key] !== undefined && rawBody[key] !== null) {
      if (
        typeof rawBody[key] !== "string" ||
        hasUnsafeIdentifier(rawBody[key])
      ) {
        return { ok: false, error: `Invalid ${key} value` };
      }
    }
  }

  if (typeof rawBody.route === "string" && hasPathTraversal(rawBody.route)) {
    return { ok: false, error: "Invalid route path" };
  }

  if (!Array.isArray(rawBody.items) || rawBody.items.length === 0) {
    return {
      ok: false,
      error: "Redline packet must include at least one item",
    };
  }

  for (const item of rawBody.items) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Invalid redline item" };
    }
    if (typeof item.id === "string" && hasUnsafeIdentifier(item.id)) {
      return { ok: false, error: "Invalid redline item id" };
    }
    if (typeof item.route === "string" && hasPathTraversal(item.route)) {
      return { ok: false, error: "Invalid redline item route" };
    }
    if (item.snapshot && typeof item.snapshot === "object") {
      for (const k of ["file", "filename", "path"]) {
        if (
          typeof item.snapshot[k] === "string" &&
          hasUnsafeIdentifier(item.snapshot[k])
        ) {
          return { ok: false, error: `Invalid snapshot ${k}` };
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Ensure `/.design-kit/redlines/` is listed in `<root>/.gitignore` (idempotent).
 */
export function ensureGitignoreEntry(root, entry = "/.design-kit/redlines/") {
  const gitignorePath = join(resolve(root), ".gitignore");
  const existingEntries = new Set([
    "/.design-kit/redlines/",
    ".design-kit/redlines/",
    "/.design-kit/redlines",
    ".design-kit/redlines",
    "/.design-kit/",
    ".design-kit/",
    "/.design-kit",
    ".design-kit",
    entry.trim(),
  ]);

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/).map((line) => line.trim());
    if (lines.some((line) => existingEntries.has(line))) {
      return { updated: false, path: gitignorePath };
    }
    const separator =
      content.length === 0 || content.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, `${content}${separator}${entry}\n`, "utf8");
    return { updated: true, path: gitignorePath };
  }

  writeFileSync(gitignorePath, `${entry}\n`, "utf8");
  return { updated: true, path: gitignorePath };
}

function formatTimestampFolder(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function decodePngDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    return null;
  }
  const b64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!b64) return null;
  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (buf.length < PNG_SIGNATURE.length || buf.length > MAX_SNAPSHOT_BYTES) {
    return null;
  }
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  return buf;
}

/**
 * Write a sanitized RedlinePacket to `<root>/.design-kit/redlines/<timestamp>/`
 * (`packet.md`, `packet.json`, `step-*.png`) and update `latest.md` + `.gitignore`.
 */
export function writeRedlinePacket(rawPacket, options = {}) {
  const root = resolve(options.root || process.cwd());
  const redlinesDirOpt = options.outDir || DEFAULT_REDLINES_DIR;
  if (hasPathTraversal(String(redlinesDirOpt))) {
    throw new Error("outDir must not contain path traversal segments");
  }
  const redlinesRoot = resolve(root, redlinesDirOpt);
  if (!options.allowOutsideRoot) {
    assertPathInside(redlinesRoot, root);
  }

  const packet = sanitizeRedlinePacket(rawPacket);
  if (!packet.items.length) {
    throw new Error("Redline packet must include at least one item");
  }

  mkdirSync(redlinesRoot, { recursive: true });

  const baseStamp = formatTimestampFolder(options.now || new Date());
  let runId = baseStamp;
  let runDir = join(redlinesRoot, runId);
  let suffix = 1;
  while (existsSync(runDir)) {
    suffix += 1;
    runId = `${baseStamp}-${suffix}`;
    runDir = join(redlinesRoot, runId);
  }
  assertPathInside(runDir, redlinesRoot);
  mkdirSync(runDir, { recursive: true });

  const images = [];
  const jsonItems = packet.items.map((item) => {
    const stepFile = `step-${item.index}.png`;
    const pngBuf = decodePngDataUrl(item.snapshot?.dataUrl);
    if (pngBuf) {
      const imgPath = assertPathInside(join(runDir, stepFile), runDir);
      writeFileSync(imgPath, pngBuf);
      images.push({
        index: item.index,
        file: stepFile,
        path: imgPath,
        relativePath: toPosixPath(relative(root, imgPath)),
        byteLength: pngBuf.length,
      });
      const { dataUrl: _omitted, ...snapshotMeta } = item.snapshot;
      return {
        ...item,
        snapshotFile: stepFile,
        snapshot: {
          ...snapshotMeta,
          file: stepFile,
        },
      };
    }
    return item;
  });

  const packetJsonObj = {
    ...packet,
    runId,
    items: jsonItems,
  };

  const packetJsonPath = assertPathInside(join(runDir, "packet.json"), runDir);
  writeFileSync(
    packetJsonPath,
    `${JSON.stringify(packetJsonObj, null, 2)}\n`,
    "utf8",
  );

  const baseMarkdown = formatRedlineMarkdown(packet);
  const relativeDir = toPosixPath(relative(root, runDir));
  const relativePacketMd = toPosixPath(
    relative(root, join(runDir, "packet.md")),
  );
  const latestMdPath = assertPathInside(
    join(redlinesRoot, "latest.md"),
    redlinesRoot,
  );
  const relativeLatestMd = toPosixPath(relative(root, latestMdPath));

  const packetImagesBlock = images.length
    ? `\n\n## Screenshots\n\n${images
        .map(
          (img) =>
            `- Step #${img.index}: \`${img.file}\` (${img.byteLength} bytes)`,
        )
        .join("\n")}\n`
    : "\n";

  const packetMdContent = `${baseMarkdown}${packetImagesBlock}`;
  const packetMdPath = assertPathInside(join(runDir, "packet.md"), runDir);
  writeFileSync(packetMdPath, packetMdContent, "utf8");

  const latestImagesBlock = images.length
    ? `\n\n## Screenshots\n\n${images
        .map(
          (img) =>
            `- Step #${img.index}: \`${runId}/${img.file}\` (${img.byteLength} bytes)`,
        )
        .join("\n")}\n`
    : "\n";
  const latestHeader = `> Latest redline run: \`${runId}\` · Packet: \`${relativePacketMd}\` · JSON: \`${toPosixPath(relative(root, packetJsonPath))}\`\n\n`;
  writeFileSync(
    latestMdPath,
    `${latestHeader}${baseMarkdown}${latestImagesBlock}`,
    "utf8",
  );

  let gitignoreUpdated = false;
  if (options.gitignore !== false) {
    const gi = ensureGitignoreEntry(root);
    gitignoreUpdated = gi.updated;
  }

  return {
    runId,
    dir: runDir,
    relativeDir,
    packetMd: packetMdPath,
    relativePacketMd,
    packetJson: packetJsonPath,
    relativePacketJson: toPosixPath(relative(root, packetJsonPath)),
    latestMd: latestMdPath,
    relativeLatestMd,
    images,
    gitignoreUpdated,
    itemCount: packet.items.length,
    packet,
  };
}

/**
 * Resolve an `agent` setting (`"claude" | "codex" | "agy" | string[]`) into a
 * safe `{ name, command, args }` argv tuple. Never interpolates untrusted DOM
 * content or uses a shell.
 */
export function resolveAgentInvocation(agent, context) {
  if (!agent) return null;

  const count = context.itemCount;
  const noun = count === 1 ? "redline" : "redlines";
  const prompt = `Fix the ${count} UI ${noun} recorded in ${context.relativePacketMd} (also copied to ${context.relativeLatestMd}). Read the packet and inspect any step-*.png screenshots in ${context.relativeDir} before making changes.`;

  if (typeof agent === "string") {
    const trimmed = agent.trim();
    if (!trimmed) return null;
    if (trimmed === "claude") {
      return { name: "claude", command: "claude", args: ["-p", prompt] };
    }
    if (trimmed === "codex") {
      return { name: "codex", command: "codex", args: ["exec", prompt] };
    }
    if (trimmed === "agy") {
      return { name: "agy", command: "agy", args: ["-p", prompt] };
    }
    throw new Error(
      `Unsupported agent "${trimmed}". Use "claude", "codex", "agy", or a command argv array.`,
    );
  }

  if (Array.isArray(agent)) {
    if (
      agent.length === 0 ||
      typeof agent[0] !== "string" ||
      !agent[0].trim()
    ) {
      throw new Error("Custom agent argv array must start with a command");
    }
    const command = agent[0];
    let hasPlaceholder = false;
    const args = agent.slice(1).map((arg) => {
      const str = String(arg);
      if (
        str.includes("{packet}") ||
        str.includes("{latest}") ||
        str.includes("{dir}") ||
        str.includes("{json}") ||
        str.includes("{runId}") ||
        str.includes("{prompt}")
      ) {
        hasPlaceholder = true;
        return str
          .replaceAll("{packet}", context.packetMd)
          .replaceAll("{latest}", context.latestMd)
          .replaceAll("{dir}", context.dir)
          .replaceAll("{json}", context.packetJson)
          .replaceAll("{runId}", context.runId)
          .replaceAll("{prompt}", prompt);
      }
      return str;
    });
    if (!hasPlaceholder) {
      args.push(prompt);
    }
    return { name: basename(command), command, args };
  }

  throw new Error(
    'agent option must be "claude", "codex", "agy", or a string[] argv array',
  );
}

/**
 * Spawn the configured local coding agent CLI asynchronously using safe argv
 * arrays (`shell: false`). Never blocks the HTTP response.
 */
export function spawnLocalAgent(agent, context, options = {}) {
  const invocation = resolveAgentInvocation(agent, context);
  if (!invocation) return null;

  const spawnFn = options.spawnImpl || spawn;
  const child = spawnFn(invocation.command, invocation.args, {
    cwd: resolve(options.root || process.cwd()),
    stdio: "ignore",
    detached: true,
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      DESIGN_KIT_REDLINE_RUN_ID: context.runId,
      DESIGN_KIT_REDLINE_DIR: context.dir,
      DESIGN_KIT_REDLINE_MD: context.packetMd,
      DESIGN_KIT_REDLINE_LATEST: context.latestMd,
      DESIGN_KIT_REDLINE_JSON: context.packetJson,
    },
  });

  if (child && typeof child.on === "function") {
    child.on("error", (err) => {
      if (typeof options.onError === "function") {
        options.onError(err, invocation);
      } else {
        console.error(
          `[design-kit] Redlines saved to ${context.relativeLatestMd}, but failed to start agent "${invocation.command}": ${err?.message || err}`,
        );
      }
    });
  }
  if (child && typeof child.unref === "function") {
    child.unref();
  }

  return {
    spawned: true,
    name: invocation.name,
    command: invocation.command,
    args: invocation.args,
    pid: child?.pid ?? null,
  };
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  if (typeof headers.get === "function") {
    return headers.get(target) ?? undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

class PayloadTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} byte limit`);
    this.statusCode = 413;
  }
}

/**
 * Read a Node `IncomingMessage` body with a strict byte cap.
 * Rejects immediately with `PayloadTooLargeError` once `maxBytes` is exceeded.
 */
export function readNodeBodyWithLimit(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const contentLengthHeader = getHeader(req.headers, "content-length");
    if (contentLengthHeader !== undefined) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        req.resume?.();
        rejectBody(new PayloadTooLargeError(maxBytes));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        req.pause?.();
        fail(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", fail);
  });
}

/**
 * Framework-agnostic handler for `POST /__design-kit/fix`.
 */
export async function handleFixRequest(request, options = {}) {
  const method = String(request.method || "").toUpperCase();
  if (method !== "POST") {
    return {
      status: 405,
      body: { error: "Method not allowed; use POST" },
    };
  }

  const reqUrl = String(request.url || "");
  if (hasPathTraversal(reqUrl)) {
    return {
      status: 400,
      body: { error: "Path traversal in request URL is not allowed" },
    };
  }

  const expectedToken = options.token;
  const providedToken = getHeader(request.headers, TOKEN_HEADER);
  if (!tokensEqual(providedToken, expectedToken)) {
    return {
      status: 403,
      body: { error: "Invalid or missing X-Design-Kit-Token" },
    };
  }

  const origin = getHeader(request.headers, "origin");
  const host = getHeader(request.headers, "host");
  if (!isOriginAllowed(origin, host, options.allowedOrigins)) {
    return {
      status: 403,
      body: { error: "Origin not allowed" },
    };
  }

  const maxBodyBytes = Math.max(
    1024,
    Number(options.maxBodyBytes) || DEFAULT_MAX_BODY_BYTES,
  );

  const contentLengthHeader = getHeader(request.headers, "content-length");
  if (contentLengthHeader !== undefined) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      return {
        status: 413,
        body: { error: "Request body exceeds maximum size limit" },
      };
    }
  }

  let rawText;
  try {
    rawText = await request.readBody(maxBodyBytes);
  } catch (err) {
    if (err instanceof PayloadTooLargeError || err?.statusCode === 413) {
      return {
        status: 413,
        body: { error: "Request body exceeds maximum size limit" },
      };
    }
    return {
      status: 400,
      body: { error: err?.message || "Failed to read request body" },
    };
  }

  if (Buffer.byteLength(rawText, "utf8") > maxBodyBytes) {
    return {
      status: 413,
      body: { error: "Request body exceeds maximum size limit" },
    };
  }

  let rawBody;
  try {
    rawBody = JSON.parse(rawText);
  } catch {
    return {
      status: 400,
      body: { error: "Request body must be valid JSON" },
    };
  }

  const safety = validateRawRequestSafety(rawBody, reqUrl);
  if (!safety.ok) {
    return {
      status: 400,
      body: { error: safety.error },
    };
  }

  let written;
  try {
    written = writeRedlinePacket(rawBody, {
      root: options.root,
      outDir: options.outDir,
      gitignore: options.gitignore,
      allowOutsideRoot: options.allowOutsideRoot,
    });
  } catch (err) {
    return {
      status: 400,
      body: { error: err?.message || "Failed to write redline packet" },
    };
  }

  let hookResult = null;
  if (typeof options.onPacket === "function") {
    hookResult = (await options.onPacket(written)) || null;
  }

  let agentInfo = null;
  if (options.agent) {
    try {
      agentInfo = spawnLocalAgent(options.agent, written, {
        root: options.root,
        spawnImpl: options.spawnImpl,
        onError: options.onAgentError,
      });
    } catch (err) {
      return {
        status: 500,
        body: { error: err?.message || "Failed to spawn local agent" },
      };
    }
  }

  const count = written.itemCount;
  const noun = count === 1 ? "redline" : "redlines";
  const defaultMessage = agentInfo
    ? `Saved ${count} ${noun} & started ${agentInfo.name}`
    : `Saved ${count} ${noun} to ${written.relativeLatestMd}`;

  return {
    status: 200,
    body: {
      ok: true,
      runId: written.runId,
      message: String(hookResult?.message || defaultMessage),
      ...(hookResult?.runUrl ? { runUrl: hookResult.runUrl } : {}),
      dir: written.relativeDir,
      packetMd: written.relativePacketMd,
      latestMd: written.relativeLatestMd,
      images: written.images.map((img) => img.file),
      agent: agentInfo?.name || null,
    },
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

/**
 * Create a Connect / Express / Node `http` middleware that handles
 * `POST /__design-kit/fix`.
 */
export function createFixMiddleware(options = {}) {
  const fixPath = options.fixPath || DEFAULT_FIX_PATH;
  const token = options.token || generateCapabilityToken();

  const middleware = async (req, res, next) => {
    const rawUrl = String(req.url || "");
    const pathname = rawUrl.split("?")[0];

    // Reject path traversal attempts aimed at the fix prefix (e.g. /__design-kit/fix/../x)
    const isFixTarget =
      pathname === fixPath || pathname.startsWith(`${fixPath}/`);
    if (!isFixTarget) {
      if (typeof next === "function") {
        next();
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (pathname !== fixPath) {
      sendJson(res, 400, { error: "Invalid fix endpoint path" });
      return;
    }

    const remoteAddress = req.socket?.remoteAddress;
    const hasExplicitAllowlist =
      Array.isArray(options.allowedOrigins) &&
      options.allowedOrigins.length > 0;
    if (
      !hasExplicitAllowlist &&
      remoteAddress &&
      !isLoopbackAddress(remoteAddress)
    ) {
      sendJson(res, 403, { error: "Only loopback connections are allowed" });
      return;
    }

    const result = await handleFixRequest(
      {
        method: req.method,
        url: rawUrl,
        headers: req.headers,
        readBody: (limit) => readNodeBodyWithLimit(req, limit),
      },
      { ...options, token },
    );
    sendJson(res, result.status, result.body);
  };

  middleware.token = token;
  middleware.fixPath = fixPath;
  return middleware;
}
