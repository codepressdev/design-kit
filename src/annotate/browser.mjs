/**
 * Browser entry point for `@codepress/design-kit/annotate` (zero node:* imports).
 */

export {
  computeBoxOverlap,
  computePairwiseOverlaps,
  escapeCdata,
  escapeXmlText,
  formatRedlineMarkdown,
  formatRedlineXml,
  MAX_ITEMS,
  MAX_OUTER_HTML_CHARS,
  MAX_OWNERS,
  MAX_SNAPSHOT_BYTES,
  MAX_SOURCE_HINTS,
  REDLINE_PACKET_VERSION,
  sanitizeRedlinePacket,
  sanitizeRoute,
} from "./sanitize.mjs";
export {
  buildCssSelector,
  DEFAULT_SOURCEMAP_TIMEOUT_MS,
  extractComputedLayout,
  extractSourceHints,
  parseDebugStackFrames,
  resolveSourceMapPosition,
  trimOuterHtml,
} from "./source-hints.mjs";
export { captureCalloutSnapshot } from "./snapshot.mjs";
export {
  createPostMessageBridge,
  DEFAULT_POSTMESSAGE_TIMEOUT_MS,
  dispatchRedlinePacket,
  DK_ANNOTATE_MSG,
  sanitizeRunUrl,
} from "./transport.mjs";
export { mountAnnotator } from "./overlay.mjs";

export function getAnnotatorRuntimeScript() {
  throw new Error(
    "getAnnotatorRuntimeScript() is only available in Node.js environments; in the browser call mountAnnotator() directly.",
  );
}
