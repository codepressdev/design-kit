/**
 * `@codepress/design-kit/next` — Next.js App Router route handler and script
 * helper for live in-app screen annotation and local agent auto-fix.
 *
 * Zero runtime dependencies (uses standard Web `Request` / `Response` and
 * Node built-ins). Dev-only by default (`NODE_ENV !== "production"`).
 */

import {
  createFixMiddleware,
  DEFAULT_FIX_PATH,
  DEFAULT_MAX_BODY_BYTES,
  ensureGitignoreEntry,
  generateCapabilityToken,
  handleFixRequest,
  spawnLocalAgent,
  writeRedlinePacket,
} from "./annotate/fix-receiver.mjs";
import { getAnnotatorRuntimeScript } from "./annotate/runtime-script.mjs";
import { getAnnotatorScriptHtml } from "./vite.mjs";

export {
  createFixMiddleware,
  ensureGitignoreEntry,
  generateCapabilityToken,
  getAnnotatorScriptHtml,
  spawnLocalAgent,
  writeRedlinePacket,
};

/**
 * Create a Next.js App Router `POST` route handler (e.g. in
 * `app/api/design-kit/fix/route.ts`) backed by the same token, origin, size,
 * and path-traversal guards as `@codepress/design-kit/vite`.
 *
 * Refuses requests with `404` in `NODE_ENV === "production"` unless
 * `allowInProduction: true` is explicitly passed.
 */
export function createNextFixHandler(options = {}) {
  const token =
    options.token ||
    process.env.DESIGN_KIT_ANNOTATE_TOKEN ||
    generateCapabilityToken();

  const handler = async (request) => {
    if (
      process.env.NODE_ENV === "production" &&
      options.allowInProduction !== true
    ) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const result = await handleFixRequest(
      {
        method: request.method,
        url: request.url,
        headers: request.headers,
        readBody: async (maxBytes = DEFAULT_MAX_BODY_BYTES) => {
          if (!request.body || typeof request.body.getReader !== "function") {
            const text = await request.text();
            if (Buffer.byteLength(text, "utf8") > maxBytes) {
              const err = new Error("Payload too large");
              err.statusCode = 413;
              throw err;
            }
            return text;
          }
          const reader = request.body.getReader();
          const chunks = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const buf = Buffer.from(value);
            total += buf.length;
            if (total > maxBytes) {
              await reader.cancel?.();
              const err = new Error("Payload too large");
              err.statusCode = 413;
              throw err;
            }
            chunks.push(buf);
          }
          return Buffer.concat(chunks).toString("utf8");
        },
      },
      { ...options, token },
    );

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  };

  handler.token = token;
  return handler;
}

/**
 * Return the self-contained browser JS string to pass to Next.js `<Script>` or
 * `<script dangerouslySetInnerHTML={{ __html: ... }} />`.
 *
 * Returns an empty string in production unless both `enabled: true` and a
 * remote `endpoint` are set.
 */
export function getNextAnnotatorScript(options = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const hasEndpoint =
    typeof options.endpoint === "string" && options.endpoint.trim().length > 0;
  const enabled =
    typeof options.enabled === "boolean"
      ? options.enabled && (!isProd || hasEndpoint)
      : !isProd;

  if (!enabled) return "";

  const annotator =
    options.annotator && typeof options.annotator === "object"
      ? { ...options.annotator }
      : {};

  const resolvedToken = options.token || process.env.DESIGN_KIT_ANNOTATE_TOKEN;
  const transport = hasEndpoint
    ? {
        type: "http",
        url: String(options.endpoint),
        ...(options.headers ? { headers: { ...options.headers } } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
      }
    : {
        type: "http",
        url: options.fixPath || DEFAULT_FIX_PATH,
        headers: {
          ...(options.headers || {}),
          ...(resolvedToken ? { "X-Design-Kit-Token": resolvedToken } : {}),
        },
      };

  return getAnnotatorRuntimeScript({
    autoMount: {
      ...annotator,
      transport,
    },
  });
}
