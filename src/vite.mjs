/**
 * `@codepress/design-kit/vite` — Vite dev-server plugin and generic dev
 * middleware for live in-app screen annotation and local agent auto-fix.
 *
 * Injects `<design-kit-annotator>` in `serve` (dev) mode only, with zero bytes
 * added to `vite build` production output unless both `enabled` and a remote
 * `endpoint` are explicitly configured.
 */

import { resolve } from "node:path";

import {
  createFixMiddleware,
  DEFAULT_FIX_PATH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REDLINES_DIR,
  DEFAULT_SCRIPT_PATH,
  ensureGitignoreEntry,
  generateCapabilityToken,
  spawnLocalAgent,
  writeRedlinePacket,
} from "./annotate/fix-receiver.mjs";
import { getAnnotatorRuntimeScript } from "./annotate/runtime-script.mjs";

export {
  createFixMiddleware,
  DEFAULT_FIX_PATH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REDLINES_DIR,
  DEFAULT_SCRIPT_PATH,
  ensureGitignoreEntry,
  generateCapabilityToken,
  spawnLocalAgent,
  writeRedlinePacket,
};

function normalizePrefix(routePrefix) {
  if (!routePrefix || typeof routePrefix !== "string") return "/__design-kit";
  const trimmed = routePrefix.trim().replace(/\/+$/, "");
  if (!trimmed) return "/__design-kit";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function buildAutoMountOptions(options, fixPath, token) {
  const annotator =
    options.annotator && typeof options.annotator === "object"
      ? { ...options.annotator }
      : {};

  if (options.endpoint) {
    return {
      ...annotator,
      transport: {
        type: "http",
        url: String(options.endpoint),
        ...(options.headers ? { headers: { ...options.headers } } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
      },
    };
  }

  return {
    ...annotator,
    transport: {
      type: "http",
      url: fixPath,
      headers: {
        ...(options.headers || {}),
        "X-Design-Kit-Token": token,
      },
    },
  };
}

/**
 * Build an inline `<script>...</script>` tag string that boots
 * `<design-kit-annotator>` for non-Vite HTML/SSR frameworks (Next.js, Astro,
 * Rails, Django, etc.).
 *
 * Returns an empty string when `enabled` is false (default: enabled only when
 * `NODE_ENV !== "production"`, unless both `enabled: true` and `endpoint` are
 * set).
 */
export function getAnnotatorScriptHtml(options = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const hasEndpoint =
    typeof options.endpoint === "string" && options.endpoint.trim().length > 0;
  const enabled =
    typeof options.enabled === "boolean"
      ? options.enabled && (!isProd || hasEndpoint)
      : !isProd;

  if (!enabled) return "";

  const prefix = normalizePrefix(options.routePrefix);
  const fixPath = options.fixPath || `${prefix}/fix`;
  const token = options.token || "";
  const autoMount = buildAutoMountOptions(options, fixPath, token);
  const script = getAnnotatorRuntimeScript({ autoMount });
  return `<script data-design-kit-annotator="true">${script}</script>`;
}

/**
 * Vite plugin that injects `<design-kit-annotator>` in `serve` (dev) mode and
 * mounts `/__design-kit/fix` to save `.design-kit/redlines/` packets and
 * optionally dispatch a local coding agent (`claude`, `codex`, `agy`, or
 * `string[]`).
 *
 * Production `vite build` output contains zero annotator bytes unless BOTH
 * `enabled` (truthy) AND a remote `endpoint` are explicitly provided.
 */
export function designKitAnnotate(options = {}) {
  const prefix = normalizePrefix(options.routePrefix);
  const fixPath = options.fixPath || `${prefix}/fix`;
  const scriptPath = options.scriptPath || `${prefix}/annotator.js`;
  const token = options.token || generateCapabilityToken();

  let projectRoot = options.root ? resolve(options.root) : process.cwd();
  let isBuild = false;
  let active = true;

  const hasRemoteEndpoint =
    typeof options.endpoint === "string" && options.endpoint.trim().length > 0;

  function evaluateActive(config) {
    isBuild = config?.command === "build";
    const explicitEnabled =
      typeof options.enabled === "function"
        ? Boolean(options.enabled(config))
        : typeof options.enabled === "boolean"
          ? options.enabled
          : undefined;

    if (isBuild) {
      // Production builds receive zero bytes unless BOTH enabled AND a remote
      // endpoint are explicitly configured.
      return explicitEnabled === true && hasRemoteEndpoint;
    }

    return explicitEnabled === undefined ? true : explicitEnabled;
  }

  function buildRuntimeJs() {
    const autoMount = buildAutoMountOptions(options, fixPath, token);
    return getAnnotatorRuntimeScript({ autoMount });
  }

  return {
    name: "design-kit-annotate",

    configResolved(config) {
      if (config?.root && !options.root) {
        projectRoot = resolve(config.root);
      }
      active = evaluateActive(config);
    },

    configureServer(server) {
      if (!active) return;

      const fixMiddleware = createFixMiddleware({
        root: projectRoot,
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

      const runtimeJs = buildRuntimeJs();

      server.middlewares.use((req, res, next) => {
        const pathname = String(req.url || "").split("?")[0];
        if (
          pathname === scriptPath &&
          (req.method === "GET" || req.method === "HEAD")
        ) {
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          );
          res.setHeader("Cache-Control", "no-store");
          if (req.method === "HEAD") {
            res.end();
          } else {
            res.end(runtimeJs);
          }
          return;
        }
        if (pathname === fixPath || pathname.startsWith(`${fixPath}/`)) {
          void fixMiddleware(req, res, next);
          return;
        }
        next();
      });
    },

    transformIndexHtml(html) {
      if (!active) return html;

      if (isBuild) {
        return {
          html,
          tags: [
            {
              tag: "script",
              attrs: { "data-design-kit-annotator": "true" },
              children: buildRuntimeJs(),
              injectTo: "body",
            },
          ],
        };
      }

      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: { src: scriptPath, defer: true },
            injectTo: "body",
          },
        ],
      };
    },
  };
}

export default designKitAnnotate;
