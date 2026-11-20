/**
 * Pluggable "Send to Fix" transports and origin/source/channel-pinned
 * iframe postMessage bridge (`DK_ANNOTATE_*`).
 *
 * Supports:
 * - `{ type: "http", url, headers?, buildBody? }`
 * - `{ type: "postMessage", targetOrigin, channelId, targetWindow?, timeoutMs? }`
 * - Custom `onSubmit(packet) => Promise<{ message?, runUrl? }>`
 * - Copy Packet fallback (Markdown clipboard)
 *
 * Zero runtime dependencies.
 */

import { formatRedlineMarkdown, sanitizeRedlinePacket } from "./sanitize.mjs";

export const DK_ANNOTATE_MSG = Object.freeze({
  READY: "DK_ANNOTATE_READY",
  SUBMIT: "DK_ANNOTATE_SUBMIT",
  RESULT: "DK_ANNOTATE_RESULT",
  ERROR: "DK_ANNOTATE_ERROR",
  STATE: "DK_ANNOTATE_STATE",
  SET_MODE: "DK_ANNOTATE_SET_MODE",
});

export const DEFAULT_POSTMESSAGE_TIMEOUT_MS = 15000;

/**
 * Validate a returned `runUrl` so only safe http/https/relative links are rendered.
 */
export function sanitizeRunUrl(rawUrl) {
  if (typeof rawUrl !== "string") return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Create a strict origin-, source-, and channelId-pinned postMessage bridge
 * for iframe <-> parent `DK_ANNOTATE_*` communication.
 *
 * Messages from any non-matching `event.source`, non-matching `event.origin`,
 * or non-matching `event.data.channelId` are silently ignored.
 */
export function createPostMessageBridge(options = {}) {
  const win =
    options.windowObj ||
    (typeof globalThis.window === "object" ? globalThis.window : null);
  const targetWindow = options.targetWindow ?? win?.parent ?? null;
  const targetOrigin = options.targetOrigin || "";
  const channelId = String(options.channelId || "").trim();
  const onMessage =
    typeof options.onMessage === "function" ? options.onMessage : null;

  if (!channelId) {
    throw new Error("createPostMessageBridge requires a non-empty channelId");
  }
  if (!targetOrigin) {
    throw new Error(
      "createPostMessageBridge requires an explicit targetOrigin",
    );
  }

  const listeners = new Set();
  if (onMessage) listeners.add(onMessage);

  const handleMessage = (event) => {
    if (!event) return;
    // Strict source pinning: ignore messages from non-parent / other windows.
    if (targetWindow && event.source !== targetWindow) return;
    // Strict origin pinning: ignore messages from any unexpected origin.
    if (event.origin !== targetOrigin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    // Strict channel pinning: ignore messages for other channels.
    if (data.channelId !== channelId) return;
    if (typeof data.type !== "string" || !data.type.startsWith("DK_ANNOTATE_"))
      return;

    for (const fn of listeners) {
      fn(data, event);
    }
  };

  win?.addEventListener?.("message", handleMessage);

  return {
    channelId,
    targetOrigin,
    send(type, payload = {}) {
      if (!targetWindow || typeof targetWindow.postMessage !== "function") {
        throw new Error("postMessage targetWindow is unavailable");
      }
      const message = { ...payload, type, channelId };
      targetWindow.postMessage(message, targetOrigin);
      return message;
    },
    subscribe(fn) {
      if (typeof fn === "function") listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      listeners.clear();
      win?.removeEventListener?.("message", handleMessage);
    },
  };
}

async function copyTextToClipboard(text, doc) {
  if (
    typeof globalThis.navigator === "object" &&
    globalThis.navigator?.clipboard &&
    typeof globalThis.navigator.clipboard.writeText === "function"
  ) {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to textarea fallback
    }
  }
  if (doc && doc.body && typeof doc.createElement === "function") {
    try {
      const ta = doc.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      doc.body.appendChild(ta);
      ta.select();
      const ok =
        typeof doc.execCommand === "function" ? doc.execCommand("copy") : false;
      ta.remove();
      return Boolean(ok);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Dispatch a RedlinePacket via custom `onSubmit`, HTTP transport,
 * pinned `postMessage` iframe transport, or Copy Packet fallback.
 */
export async function dispatchRedlinePacket(rawPacket, options = {}) {
  const packet = sanitizeRedlinePacket(rawPacket);

  // 1. Custom callback
  if (typeof options.onSubmit === "function") {
    const res = (await options.onSubmit(packet)) || {};
    return {
      ok: true,
      mode: "callback",
      message: String(res.message || "Fix started"),
      runUrl: sanitizeRunUrl(res.runUrl || res.run_url),
      packet,
    };
  }

  const transport = options.transport;

  // 2. HTTP transport
  if (transport && transport.type === "http") {
    if (!transport.url) {
      throw new Error("HTTP transport requires a url");
    }
    const fetchImpl = transport.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is unavailable for HTTP transport");
    }
    const body =
      typeof transport.buildBody === "function"
        ? transport.buildBody(packet)
        : packet;

    const resp = await fetchImpl(transport.url, {
      method: transport.method || "POST",
      headers: {
        "Content-Type": "application/json",
        ...(transport.headers || {}),
      },
      credentials: transport.credentials || "same-origin",
      body: JSON.stringify(body),
    });

    let data = {};
    try {
      data = await resp.json();
    } catch {
      data = {};
    }

    if (!resp.ok) {
      throw new Error(
        data?.error || data?.message || `Send to Fix failed (${resp.status})`,
      );
    }

    return {
      ok: true,
      mode: "http",
      message: String(data?.message || "Fix started"),
      runUrl: sanitizeRunUrl(data?.runUrl || data?.run_url),
      packet,
    };
  }

  // 3. Origin/source/channel-pinned iframe postMessage transport
  if (transport && transport.type === "postMessage") {
    const win =
      transport.windowObj ||
      (typeof globalThis.window === "object" ? globalThis.window : null);
    const targetWindow = transport.targetWindow ?? win?.parent ?? null;
    const targetOrigin =
      transport.targetOrigin ||
      (typeof globalThis.document === "object" && globalThis.document.referrer
        ? new URL(globalThis.document.referrer).origin
        : "");
    const channelId = String(transport.channelId || "design-kit-annotate");
    const timeoutMs = Math.max(
      50,
      Number(transport.timeoutMs) || DEFAULT_POSTMESSAGE_TIMEOUT_MS,
    );
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const bridge = createPostMessageBridge({
      windowObj: win,
      targetWindow,
      targetOrigin,
      channelId,
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        bridge.destroy();
        reject(new Error("Timed out waiting for parent window response"));
      }, timeoutMs);

      bridge.subscribe((data) => {
        if (settled) return;
        if (data.requestId !== requestId) return;
        if (data.type === DK_ANNOTATE_MSG.RESULT) {
          settled = true;
          clearTimeout(timer);
          bridge.destroy();
          resolve({
            ok: true,
            mode: "postMessage",
            message: String(data.message || "Fix started"),
            runUrl: sanitizeRunUrl(data.runUrl || data.run_url),
            packet,
          });
        } else if (data.type === DK_ANNOTATE_MSG.ERROR) {
          settled = true;
          clearTimeout(timer);
          bridge.destroy();
          reject(
            new Error(
              String(data.error || data.message || "Send to Fix failed"),
            ),
          );
        }
      });

      try {
        bridge.send(DK_ANNOTATE_MSG.SUBMIT, { requestId, packet });
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        bridge.destroy();
        reject(err);
      }
    });
  }

  // 4. Copy Packet fallback
  const markdown = formatRedlineMarkdown(packet);
  const copied = await copyTextToClipboard(
    markdown,
    options.document ||
      (typeof globalThis.document === "object" ? globalThis.document : null),
  );
  return {
    ok: true,
    mode: "copy",
    copied,
    message: copied ? "Copied redline packet" : "Packet ready",
    markdown,
    packet,
  };
}
