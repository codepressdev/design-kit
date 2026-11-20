/**
 * Assembles a self-contained, zero-dependency browser bundle string for
 * `<design-kit-annotator>` directly from the sibling ESM modules.
 */

import { readFileSync } from "node:fs";

const MODULE_FILES = [
  "./sanitize.mjs",
  "./source-hints.mjs",
  "./snapshot.mjs",
  "./transport.mjs",
  "./overlay.mjs",
];

let cachedCoreBundle = null;

function stripEsmSyntax(source) {
  return source
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(
      /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm,
      "",
    );
}

function buildCoreBundle() {
  if (cachedCoreBundle !== null) return cachedCoreBundle;
  const parts = MODULE_FILES.map((rel) => {
    const raw = readFileSync(new URL(rel, import.meta.url), "utf8");
    return `// --- ${rel} ---\n${stripEsmSyntax(raw)}`;
  });

  cachedCoreBundle = `(function(globalScope){
"use strict";
${parts.join("\n\n")}
var api = {
  REDLINE_PACKET_VERSION: REDLINE_PACKET_VERSION,
  DK_ANNOTATE_MSG: DK_ANNOTATE_MSG,
  mountAnnotator: mountAnnotator,
  sanitizeRoute: sanitizeRoute,
  sanitizeRedlinePacket: sanitizeRedlinePacket,
  formatRedlineMarkdown: formatRedlineMarkdown,
  formatRedlineXml: formatRedlineXml,
  computeBoxOverlap: computeBoxOverlap,
  computePairwiseOverlaps: computePairwiseOverlaps,
  extractSourceHints: extractSourceHints,
  captureCalloutSnapshot: captureCalloutSnapshot,
  createPostMessageBridge: createPostMessageBridge,
  dispatchRedlinePacket: dispatchRedlinePacket
};
globalScope.__designKitAnnotate = api;
})(typeof globalThis !== "undefined" ? globalThis : window);`.replace(
    /<\/(script)/gi,
    "<\\/$1",
  );

  return cachedCoreBundle;
}

function safeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Return a self-contained browser JS script that installs `window.__designKitAnnotate`
 * and optionally auto-mounts `<design-kit-annotator>`.
 */
export function getAnnotatorRuntimeScript(options = {}) {
  const core = buildCoreBundle();
  if (!options || !options.autoMount) {
    return core;
  }

  const mountOpts =
    typeof options.autoMount === "object" && options.autoMount !== null
      ? options.autoMount
      : {};
  const serialized = safeInlineJson(mountOpts);

  return `${core}
(function(){
  var boot = function(){
    if (typeof globalThis !== "undefined" && globalThis.__designKitAnnotate && !globalThis.__designKitAnnotatorInstance) {
      globalThis.__designKitAnnotatorInstance = globalThis.__designKitAnnotate.mountAnnotator(${serialized});
    }
  };
  if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();`;
}
