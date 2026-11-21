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
  dataUrl: string;
  width: number;
  height: number;
  byteLength: number;
  crossOriginPlaceholders: number;
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
  /** Optional host-provided native screenshot hook returning a PNG data URL. */
  captureScreenshot?: () => Promise<string | null> | string | null;
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

export function captureCalloutSnapshot(
  annotation: Partial<RedlineItem>,
  options?: { document?: Document; ignoreTag?: string },
): SnapshotImage | undefined;

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
