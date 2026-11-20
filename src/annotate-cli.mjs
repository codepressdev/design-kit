/**
 * `design-kit annotate [<url>] [--agent <name>] [--port <n>] [--no-open]`
 *
 * Zero-code local reverse proxy that attaches `<design-kit-annotator>` and the
 * `/__design-kit/fix` loopback receiver to any running local dev server URL.
 * Cross-platform across macOS, Linux, and Windows.
 */

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { resolve } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import {
  createFixMiddleware,
  DEFAULT_FIX_PATH,
  DEFAULT_SCRIPT_PATH,
  generateCapabilityToken,
} from "./annotate/fix-receiver.mjs";
import { getAnnotatorRuntimeScript } from "./annotate/runtime-script.mjs";
import { ConfigError, loadConfig } from "./config.mjs";

const DEFAULT_TARGET_URL = "http://localhost:3000";
const MAX_HTML_BUFFER_BYTES = 20 * 1024 * 1024;
const KNOWN_AGENTS = new Set(["claude", "codex", "agy"]);

/**
 * Inject `<script src="..." defer></script>` into an HTML document before
 * `</body>`, or before `</html>`, or at the end if neither closing tag exists.
 */
export function injectAnnotatorScriptTag(
  html,
  scriptPath = DEFAULT_SCRIPT_PATH,
) {
  const tag = `<script src="${scriptPath}" defer></script>`;
  const bodyIdx = html.toLowerCase().lastIndexOf("</body>");
  if (bodyIdx !== -1) {
    return `${html.slice(0, bodyIdx)}${tag}${html.slice(bodyIdx)}`;
  }
  const htmlIdx = html.toLowerCase().lastIndexOf("</html>");
  if (htmlIdx !== -1) {
    return `${html.slice(0, htmlIdx)}${tag}${html.slice(htmlIdx)}`;
  }
  return `${html}${tag}`;
}

/**
 * Open a URL in the user's default browser without using a shell.
 */
export function openBrowserUrl(url, options = {}) {
  const spawnFn = options.spawnImpl || spawn;
  const platform = options.platform || process.platform;
  let command;
  let args;

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawnFn(command, args, {
      stdio: "ignore",
      detached: true,
      shell: false,
      windowsHide: true,
    });
    child?.on?.("error", () => {});
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

function detectDefaultTargetUrl() {
  try {
    const config = loadConfig();
    const candidate = config?.pages?.baseUrl || config?.pages?.waitUrl;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  } catch {
    // No config file; fall back to default local URL.
  }
  return DEFAULT_TARGET_URL;
}

/**
 * Parse CLI arguments for `design-kit annotate`.
 */
export function parseAnnotateArgs(argv) {
  let targetUrl = null;
  let agent = null;
  const agentArgs = [];
  let port = undefined;
  let root = undefined;
  let endpoint = undefined;
  let noOpen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }
    if (
      arg === "--agent" ||
      arg === "--agent-arg" ||
      arg === "--port" ||
      arg === "--root" ||
      arg === "--endpoint"
    ) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ConfigError(`${arg} needs a value`);
      }
      i += 1;
      if (arg === "--agent") agent = value;
      else if (arg === "--agent-arg") agentArgs.push(value);
      else if (arg === "--port") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new ConfigError(
            "--port must be an integer between 0 and 65535",
          );
        }
        port = parsed;
      } else if (arg === "--root") {
        root = resolve(value);
      } else if (arg === "--endpoint") {
        endpoint = value;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new ConfigError(`unknown option ${arg}`);
    }
    if (targetUrl !== null) {
      throw new ConfigError(`unexpected extra argument ${arg}`);
    }
    targetUrl = arg;
  }

  const resolvedUrl = targetUrl || detectDefaultTargetUrl();
  let parsedUrl;
  try {
    parsedUrl = new URL(resolvedUrl);
  } catch {
    throw new ConfigError(`invalid target URL: ${resolvedUrl}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ConfigError(
      `target URL must use http: or https:, got ${parsedUrl.protocol}`,
    );
  }

  let resolvedAgent = null;
  if (agent) {
    if (agentArgs.length > 0) {
      resolvedAgent = [agent, ...agentArgs];
    } else if (KNOWN_AGENTS.has(agent)) {
      resolvedAgent = agent;
    } else {
      resolvedAgent = [agent];
    }
  }

  return {
    targetUrl: parsedUrl.href,
    agent: resolvedAgent,
    port,
    root: root || process.cwd(),
    endpoint,
    noOpen,
  };
}

function decompressBuffer(buf, encoding) {
  const enc = String(encoding || "")
    .trim()
    .toLowerCase();
  if (!enc || enc === "identity") return buf;
  if (enc === "gzip" || enc === "x-gzip") return gunzipSync(buf);
  if (enc === "deflate") return inflateSync(buf);
  if (enc === "br") return brotliDecompressSync(buf);
  return buf;
}

function rewriteLocationHeader(location, targetOrigin, proxyOrigin) {
  if (typeof location !== "string") return location;
  if (location.startsWith(targetOrigin)) {
    return `${proxyOrigin}${location.slice(targetOrigin.length)}`;
  }
  return location;
}

/**
 * Start the local reverse proxy that injects `<design-kit-annotator>` and
 * mounts `/__design-kit/fix`.
 */
export async function startAnnotateProxy(options = {}) {
  const target = new URL(options.targetUrl || DEFAULT_TARGET_URL);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Unsupported target protocol: ${target.protocol}`);
  }

  const fixPath = options.fixPath || DEFAULT_FIX_PATH;
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
  const token = options.token || generateCapabilityToken();
  const root = resolve(options.root || process.cwd());
  const requestedPort = options.port ?? 0;

  const autoMount = {
    ...(options.annotator || {}),
    transport: options.endpoint
      ? {
          type: "http",
          url: String(options.endpoint),
          ...(options.headers ? { headers: { ...options.headers } } : {}),
        }
      : {
          type: "http",
          url: fixPath,
          headers: {
            "X-Design-Kit-Token": token,
          },
        },
  };

  const runtimeJs = getAnnotatorRuntimeScript({ autoMount });

  const fixMiddleware = createFixMiddleware({
    root,
    outDir: options.outDir,
    gitignore: options.gitignore,
    agent: options.agent,
    token,
    fixPath,
    maxBodyBytes: options.maxBodyBytes,
    allowedOrigins: options.allowedOrigins,
    onPacket: options.onPacket,
    spawnImpl: options.spawnImpl,
    onAgentError: options.onAgentError,
  });

  let proxyOrigin = "";

  const server = createServer((req, res) => {
    const rawUrl = String(req.url || "/");
    const pathname = rawUrl.split("?")[0];

    if (
      pathname === scriptPath &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "HEAD") res.end();
      else res.end(runtimeJs);
      return;
    }

    if (pathname === fixPath || pathname.startsWith(`${fixPath}/`)) {
      void fixMiddleware(req, res);
      return;
    }

    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    const forwardHeaders = { ...req.headers };
    forwardHeaders.host = target.host;
    // Ask upstream for uncompressed payloads so HTML injection needs no re-encoding.
    forwardHeaders["accept-encoding"] = "identity";
    if (forwardHeaders.origin && proxyOrigin) {
      if (forwardHeaders.origin === proxyOrigin) {
        forwardHeaders.origin = target.origin;
      }
    }
    if (forwardHeaders.referer && proxyOrigin) {
      if (forwardHeaders.referer.startsWith(proxyOrigin)) {
        forwardHeaders.referer = `${target.origin}${forwardHeaders.referer.slice(proxyOrigin.length)}`;
      }
    }

    const upstreamReq = requestFn(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: rawUrl,
        headers: forwardHeaders,
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        if (headers.location && proxyOrigin) {
          headers.location = rewriteLocationHeader(
            headers.location,
            target.origin,
            proxyOrigin,
          );
        }

        const contentType = String(headers["content-type"] || "").toLowerCase();
        const isHtml = contentType.includes("text/html");

        if (!isHtml || req.method === "HEAD") {
          res.writeHead(upstreamRes.statusCode || 200, headers);
          upstreamRes.pipe(res);
          return;
        }

        const chunks = [];
        let total = 0;
        let overflowed = false;

        upstreamRes.on("data", (chunk) => {
          if (overflowed) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > MAX_HTML_BUFFER_BYTES) {
            overflowed = true;
            res.writeHead(upstreamRes.statusCode || 200, headers);
            for (const c of chunks) res.write(c);
            res.write(buf);
            upstreamRes.pipe(res);
            return;
          }
          chunks.push(buf);
        });

        upstreamRes.on("end", () => {
          if (overflowed) return;
          let htmlBuf = Buffer.concat(chunks);
          try {
            htmlBuf = decompressBuffer(htmlBuf, headers["content-encoding"]);
          } catch {
            // If decompression fails, serve raw bytes unchanged.
            res.writeHead(upstreamRes.statusCode || 200, headers);
            res.end(htmlBuf);
            return;
          }
          const injected = injectAnnotatorScriptTag(
            htmlBuf.toString("utf8"),
            scriptPath,
          );
          const outBuf = Buffer.from(injected, "utf8");
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          headers["content-length"] = String(outBuf.length);
          res.writeHead(upstreamRes.statusCode || 200, headers);
          res.end(outBuf);
        });

        upstreamRes.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502, {
              "Content-Type": "text/plain; charset=utf-8",
            });
          }
          res.end("design-kit annotate: upstream response error");
        });
      },
    );

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(
        `design-kit annotate: could not reach ${target.origin} (${err.message})`,
      );
    });

    req.pipe(upstreamReq);
  });

  // Tunnel WebSocket upgrades (e.g. Vite/Next HMR) transparently for http targets.
  server.on("upgrade", (req, socket, head) => {
    if (target.protocol !== "http:") {
      socket.destroy();
      return;
    }
    const port = Number(target.port) || 80;
    const upstream = netConnect(port, target.hostname, () => {
      const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        if (k.toLowerCase() === "host") {
          headerLines.push(`Host: ${target.host}`);
        } else {
          headerLines.push(`${k}: ${v}`);
        }
      }
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (err) => rejectListen(err);
    server.once("error", onError);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr ? addr.port : requestedPort;
  proxyOrigin = `http://127.0.0.1:${actualPort}`;

  return {
    server,
    url: proxyOrigin,
    port: actualPort,
    targetUrl: target.href,
    token,
    fixPath,
    scriptPath,
    close() {
      return new Promise((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * CLI entry point for `design-kit annotate`.
 */
export async function annotateCommand(argv, deps = {}) {
  const opts = parseAnnotateArgs(argv);
  const log = deps.log || console.log;

  const proxy = await startAnnotateProxy({
    targetUrl: opts.targetUrl,
    agent: opts.agent,
    port: opts.port ?? 0,
    root: opts.root,
    endpoint: opts.endpoint,
  });

  log(`design-kit annotate: ${proxy.url} → ${proxy.targetUrl}`);
  if (opts.endpoint) {
    log(`Send to Fix endpoint: ${opts.endpoint}`);
  } else {
    const agentLabel = Array.isArray(opts.agent)
      ? opts.agent.join(" ")
      : opts.agent || "none (writes .design-kit/redlines/latest.md)";
    log(`Redlines: .design-kit/redlines/latest.md · Agent: ${agentLabel}`);
  }

  if (!opts.noOpen) {
    openBrowserUrl(proxy.url);
  }

  if (deps.signal) {
    await new Promise((resolveDone) => {
      if (deps.signal.aborted) {
        resolveDone();
        return;
      }
      deps.signal.addEventListener("abort", () => resolveDone(), {
        once: true,
      });
    });
    await proxy.close();
    return 0;
  }

  await new Promise((resolveDone) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolveDone();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  await proxy.close();
  return 0;
}
