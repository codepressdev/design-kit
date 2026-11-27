/** Types for `@codepress/design-kit/annotate`. */

export const REDLINE_PACKET_VERSION: 1;
export const MAX_SNAPSHOT_BYTES: number;
export const MAX_OUTER_HTML_CHARS: number;
export const MAX_OWNERS: number;
export const MAX_SOURCE_HINTS: number;
export const MAX_ITEMS: number;
export const DEFAULT_SOURCEMAP_TIMEOUT_MS: number;
export const DEFAULT_POSTMESSAGE_TIMEOUT_MS: number;

export const DK_ANNOTATE_MSG: Readonly<{
  READY: "DK_ANNOTATE_READY";
  SUBMIT: "DK_ANNOTATE_SUBMIT";
  RESULT: "DK_ANNOTATE_RESULT";
  ERROR: "DK_ANNOTATE_ERROR";
  STATE: "DK_ANNOTATE_STATE";
  SET_MODE: "DK_ANNOTATE_SET_MODE";
}>;

export type AnnotatorMode = "browse" | "annotate";
export type AnnotatorTool = "pin" | "box" | "arrow" | "freehand";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  dpr: number;
}

export interface SourceHint {
  framework: string;
  file: string;
  line?: number;
  column?: number;
  component?: string;
  confidence: "high" | "medium" | "low";
}

export interface OverlapPair {
  a: string;
  b: string;
  overlapX: number;
  overlapY: number;
  overlapPx: number;
  overlapArea?: number;
}

export interface SnapshotImage {
  /** A PNG data URL, at most 1 MiB. */
  dataUrl: string;
  /** Image pixels; wider than the CSS viewport when taken at device pixel ratio. */
  width: number;
  height: number;
  byteLength: number;
  crossOriginPlaceholders: number;
  /**
   * What drew the page beneath the callouts: the host's `captureScreenshot`
   * image ("host"), the browser rendering the DOM ("browser"), or the hand
   * painter fallback ("painter"). Not carried into a sanitized packet.
   */
  renderer?: "host" | "browser" | "painter";
}

/** What the overlay hands a host's `captureScreenshot`. */
export interface CaptureScreenshotContext {
  /**
   * The overlay's `<design-kit-annotator>` element. The overlay sets it to
   * `opacity: 0` from the call until the returned image settles (or
   * `captureScreenshotTimeoutMs` passes), so a capture of any frame painted
   * after the call has no marks, toolbar or note in it. A host that reads a
   * frame already on screen when it is called must leave this element out
   * itself.
   */
  overlay: HTMLElement;
}

export interface TargetMetadata {
  selector?: string;
  tag?: string;
  text?: string;
  rect?: Rect;
  outerHtml?: string;
  computedStyle?: Record<string, string>;
  sourceHints?: SourceHint[];
  owners?: string[];
}

export interface RedlineItem {
  id: string;
  index: number;
  kind: AnnotatorTool;
  note: string;
  route: string;
  createdAt: string;
  viewport: ViewportInfo;
  theme: "dark" | "light";
  point?: Point;
  rect?: Rect;
  from?: TargetMetadata;
  to?: TargetMetadata;
  points?: Point[];
  selector?: string;
  outerHtml?: string;
  computedStyle?: Record<string, string>;
  sourceHints: SourceHint[];
  owners: string[];
  overlapPx?: number;
  overlaps?: OverlapPair[];
  snapshot?: SnapshotImage;
}

export interface RedlinePacket {
  version: 1;
  capturedAt: string;
  route: string;
  routes: string[];
  viewport: ViewportInfo;
  theme: "dark" | "light";
  items: RedlineItem[];
}

export interface HttpTransport {
  type: "http";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  buildBody?: (packet: RedlinePacket) => unknown;
  fetchImpl?: typeof fetch;
}

export interface PostMessageTransport {
  type: "postMessage";
  targetOrigin: string;
  channelId: string;
  targetWindow?: Window | null;
  timeoutMs?: number;
  windowObj?: Window | null;
}

export type AnnotatorTransport = HttpTransport | PostMessageTransport;

export interface SubmitResult {
  ok: boolean;
  mode: "callback" | "http" | "postMessage" | "copy";
  message: string;
  runUrl?: string;
  copied?: boolean;
  markdown?: string;
  packet: RedlinePacket;
}

export interface AnnotatorOptions {
  initialMode?: AnnotatorMode;
  initialTool?: AnnotatorTool;
  initialOpen?: boolean;
  showLauncher?: boolean;
  transport?: AnnotatorTransport;
  /**
   * Milliseconds before an Undo, Redo or Copy toast hides on its own
   * (default 4000; 0 keeps every toast until dismissed). Send to Fix toasts
   * always stay until dismissed.
   */
  toastAutoHideMs?: number;
  /**
   * Optional host-provided native capture of the viewport beneath the
   * overlay, called once per new mark before its note opens. Return a PNG
   * data URL of the page at any resolution (device pixels are kept, within
   * the 1 MiB cap) without the overlay (see `CaptureScreenshotContext`); the
   * overlay draws every callout on it once. Return null, throw, or reject to
   * fall back to the overlay's DOM capture.
   */
  captureScreenshot?: (
    context: CaptureScreenshotContext,
  ) => Promise<string | null> | string | null;
  /**
   * Milliseconds the overlay waits for `captureScreenshot` (default 3000).
   * Past it the overlay shows again and uses its DOM capture; a later image
   * is ignored.
   */
  captureScreenshotTimeoutMs?: number;
  /**
   * Milliseconds the browser-rendered DOM capture may take (default 1500)
   * before the overlay falls back to its hand painter. 0 always uses the
   * painter.
   */
  snapshotTimeoutMs?: number;
  /** Optional host callback to pop the toolbar out into a native floating window. */
  onPopOut?: (coords: { screenX?: number; screenY?: number }) => void;
  /** Optional callback fired whenever toolbar state (mode, tool, count, toast, history) changes. */
  onStateChange?: (state: AnnotatorState) => void;
  /**
   * Optional host handler for the toast's "Open run" link. It receives the
   * absolute run URL. Without it the link opens in a new tab from the host
   * page's window (also when the toolbar is popped out).
   */
  onOpenRun?: (url: string) => void;
  /**
   * Base a relative run URL resolves against. Defaults to the host page's
   * address (never a popped-out toolbar's `about:blank` document).
   */
  runUrlBase?: string;
  onSubmit?: (
    packet: RedlinePacket,
  ) => Promise<{ message?: string; runUrl?: string } | void>;
  storageKey?: string | false;
  theme?: "auto" | "dark" | "light";
  sourceMapTimeoutMs?: number;
  onModeChange?: (mode: AnnotatorMode) => void;
  onItemsChange?: (items: RedlineItem[]) => void;
  container?: HTMLElement;
  document?: Document;
}

export interface AnnotatorState {
  open: boolean;
  mode: AnnotatorMode;
  tool: AnnotatorTool;
  sending: boolean;
  count: number;
  toastText: string;
  toastKind: "" | "pending" | "ok" | "error";
  /** Absolute run URL the toast links to, or "". */
  toastUrl: string;
  canUndo: boolean;
  canRedo: boolean;
}

export interface UiBound {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ControlRect extends Rect {
  centerX: number;
  centerY: number;
}

export interface AnnotatorController {
  host: HTMLElement;
  getMode(): AnnotatorMode;
  setMode(mode: AnnotatorMode): void;
  getTool(): AnnotatorTool;
  setTool(tool: AnnotatorTool): void;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  getItems(): RedlineItem[];
  removeItem(id: string): void;
  clearItems(): void;
  /** Undo the last queue change (or cancel a shape being drawn); false when there is nothing to undo. */
  undo(): boolean;
  /** Redo the last undone queue change; false when there is nothing to redo. */
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Open the toast's run link through `onOpenRun` or a new tab; false when no link is showing. */
  openRun(): boolean;
  setDockHidden(hidden: boolean): void;
  getState(): AnnotatorState;
  getPacket(): RedlinePacket;
  submitFix(): Promise<SubmitResult | null>;
  copyPacket(): Promise<SubmitResult>;
  getUiBounds(): UiBound[];
  getControlRect(name: string): ControlRect | null;
  getToastText(): string;
  getToastHref(): string;
  destroy(): void;
}

export interface RuntimeScriptOptions {
  autoMount?:
    | boolean
    | Omit<
        AnnotatorOptions,
        "onSubmit" | "onModeChange" | "onItemsChange" | "container" | "document"
      >;
}

export function mountAnnotator(options?: AnnotatorOptions): AnnotatorController;
export function getAnnotatorRuntimeScript(
  options?: RuntimeScriptOptions,
): string;
export function sanitizeRoute(rawRoute: string): string;
export function sanitizeRedlinePacket(rawPacket: unknown): RedlinePacket;
export function formatRedlineMarkdown(rawPacket: unknown): string;
export function formatRedlineXml(rawPacket: unknown): string;
export function escapeXmlText(value: unknown): string;
export function escapeCdata(value: unknown): string;
export function computeBoxOverlap(
  a: Rect,
  b: Rect,
): {
  overlapX: number;
  overlapY: number;
  overlapArea: number;
  overlapPx: number;
};
export function computePairwiseOverlaps(
  entries: Array<{ selector?: string; label?: string; rect: Rect }>,
  maxPairs?: number,
): { maxOverlapPx: number; pairs: OverlapPair[] };

export function extractSourceHints(
  element: unknown,
  options?: {
    origin?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    sourceMapCache?: Map<string, unknown>;
  },
): Promise<{
  sourceHints: SourceHint[];
  owners: string[];
  selector: string;
  outerHtml: string;
  computedStyle?: Record<string, string>;
}>;

export function resolveSourceMapPosition(
  sourceMap: unknown,
  generatedLine: number,
  generatedColumn?: number,
): { file: string; line: number; column: number } | null;

export function parseDebugStackFrames(
  debugStack: unknown,
): Array<{ component?: string; url: string; line: number; column: number }>;

export function buildCssSelector(el: unknown): string;
export function trimOuterHtml(el: unknown, maxChars?: number): string;
export function extractComputedLayout(
  el: unknown,
): Record<string, string> | undefined;

/** The hand painter: draws the viewport from computed styles at <= 1x. */
export function captureCalloutSnapshot(
  annotation: Partial<RedlineItem> | null,
  options?: {
    document?: Document;
    ignoreTag?: string;
    allAnnotations?: Array<Partial<RedlineItem>>;
  },
): SnapshotImage | undefined;

/**
 * The browser renders the viewport DOM (SVG foreignObject) at device pixel
 * ratio, at most 3x, leaving out `ignoreTag` (the overlay); callouts are
 * drawn on top once. Falls back to `captureCalloutSnapshot` on any error, a
 * tainted canvas, or `timeoutMs` (default 1500). Never rejects.
 */
export function captureViewportSnapshot(
  annotation: Partial<RedlineItem> | null,
  options?: {
    document?: Document;
    ignoreTag?: string;
    allAnnotations?: Array<Partial<RedlineItem>>;
    timeoutMs?: number;
    /** Pixel ratio to render at; defaults to `devicePixelRatio`. */
    scale?: number;
  },
): Promise<SnapshotImage | undefined>;

export function sanitizeRunUrl(rawUrl: unknown): string | undefined;

export function createPostMessageBridge(options: {
  targetOrigin: string;
  channelId: string;
  targetWindow?: Window | null;
  windowObj?: Window | null;
  onMessage?: (data: Record<string, unknown>, event: MessageEvent) => void;
}): {
  channelId: string;
  targetOrigin: string;
  send(
    type: string,
    payload?: Record<string, unknown>,
  ): Record<string, unknown>;
  subscribe(
    fn: (data: Record<string, unknown>, event: MessageEvent) => void,
  ): () => void;
  destroy(): void;
};

export function dispatchRedlinePacket(
  rawPacket: unknown,
  options?: {
    onSubmit?: AnnotatorOptions["onSubmit"];
    transport?: AnnotatorTransport;
    document?: Document;
  },
): Promise<SubmitResult>;
