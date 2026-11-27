/**
 * `@codepress/design-kit/annotate` — Open-source, zero-dependency Shadow-DOM
 * live-app annotation overlay and Redline Context Packet contract.
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
export {
  captureCalloutSnapshot,
  captureViewportSnapshot,
} from "./snapshot.mjs";
export {
  createPostMessageBridge,
  DEFAULT_POSTMESSAGE_TIMEOUT_MS,
  dispatchRedlinePacket,
  DK_ANNOTATE_MSG,
  sanitizeRunUrl,
} from "./transport.mjs";
export { mountAnnotator } from "./overlay.mjs";
export { getAnnotatorRuntimeScript } from "./runtime-script.mjs";
