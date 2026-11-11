/** Types for @codepress/design-kit's programmatic API. */

export const CONFIG_NAME: "design-kit.config.json";
export const SCHEMA_PATH: string;

export class ConfigError extends Error {
  exitCode: 2;
}

export interface Size {
  width: number;
  height: number;
}

export interface PageConfig {
  name: string;
  title?: string;
  path: string;
  ready: string;
  sourceFile?: string;
  slots: { main: string[]; [slot: string]: string[] };
  layoutSlots?: Record<string, { main: string[]; [slot: string]: string[] }>;
}

/** A loaded, validated config with its paths resolved. */
export interface DesignKitConfig {
  file: string;
  configDir: string;
  raw: Record<string, unknown>;
  out?: string;
  theme?: {
    attribute: string;
    dark: string;
    light?: string;
    targets: ("html" | "body")[];
  };
  stories?: Record<string, unknown>;
  pages?: {
    baseUrl?: string;
    fixedTime: string;
    widths: Size[];
    pages: PageConfig[];
    [key: string]: unknown;
  };
}

export function findConfig(from?: string): string | null;
export function loadConfig(file?: string): DesignKitConfig;
export function resolveConfig(raw: unknown, path: string): DesignKitConfig;
/** "<field>: <problem>" for every place `value` breaks the v1 schema. */
export function validate(value: unknown): string[];

export function playwrightVersion(from?: string): string;

export function captureStories(
  config: DesignKitConfig,
  options?: {
    out?: string;
    storybookDir?: string;
    only?: string[];
    base?: string;
    log?: (message: string) => void;
  },
): Promise<{ out: string; rows: number; failed: number }>;

/** Returned by a `page` hook; both run inside the capture of one page. */
export interface PageHookResult {
  /** The ready selector never appeared; may throw a clearer error. */
  readyFailed?(): void | Promise<void>;
  /** Runs just before serialization, in place of the optional screenshot. */
  beforeSerialize?(info: { shotPath: string }): void | Promise<void>;
}

export interface CaptureHookInfo {
  page: PageConfig;
  viewport: Size;
}

export interface CapturePagesOptions {
  out?: string;
  only?: string[];
  ready?: Record<string, string>;
  screenshots?: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** A storageState file path or a Playwright storage state object. */
  storageState?: string | object;
  forbidStrings?: string[];
  stripOrigins?: string[];
  hooks?: {
    /** Runs on each fresh context; may return a cleanup. */
    context?(
      context: unknown,
      info: CaptureHookInfo,
    ): void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>;
    /** Runs on each page before it navigates. */
    page?(
      page: unknown,
      info: CaptureHookInfo,
    ): void | PageHookResult | Promise<void | PageHookResult>;
  };
  /** The Playwright to drive; default the project's own. */
  playwright?: { chromium: unknown };
  log?: (message: string) => void;
  /** Set `interrupted` to stop between pages; `browser` is set once launched. */
  session?: { interrupted: boolean; browser: unknown };
}

/** 0, or 130 when `session.interrupted` stopped the run (nothing written). */
export function capturePages(
  config: DesignKitConfig,
  options?: CapturePagesOptions,
): Promise<number>;

/** What to look for per forbidden value: as written, a token's long segments, and escaped. */
export function forbiddenNeedles(values: string[]): string[];
/** The first needle `text` contains, or null. */
export function findForbidden(text: string, needles: string[]): string | null;

export function loadKit(dir: string): unknown;
export function find(kit: unknown, query: string): unknown[];
export function compose(
  kit: unknown,
  options: {
    frame: string;
    slots?: { name: string; content: string }[];
    theme?: "light" | "dark";
    showNew?: boolean;
  },
): string;
/** Runs one `kit` command; returns its exit code. */
export function runKit(
  argv: string[],
  io?: { out(text: string): void; err(text: string): void },
  env?: Record<string, string | undefined>,
  defaultDir?: string,
): number;
