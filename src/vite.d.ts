/** Types for `@codepress/design-kit/vite`. */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnnotatorOptions, RedlinePacket } from "./annotate/index.d.ts";

export type LocalAgentTarget = "claude" | "codex" | "agy" | string[] | false;

export interface WrittenRedlineImage {
  index: number;
  file: string;
  path: string;
  relativePath: string;
  byteLength: number;
}

export interface WrittenRedlineResult {
  runId: string;
  dir: string;
  relativeDir: string;
  packetMd: string;
  relativePacketMd: string;
  packetJson: string;
  relativePacketJson: string;
  latestMd: string;
  relativeLatestMd: string;
  images: WrittenRedlineImage[];
  gitignoreUpdated: boolean;
  itemCount: number;
  packet: RedlinePacket;
}

export interface DesignKitAnnotateOptions {
  /** Local coding agent to spawn asynchronously on Send to Fix. */
  agent?: LocalAgentTarget;
  /** Remote HTTP endpoint (webhook or CodePress endpoint) instead of local `/__design-kit/fix`. */
  endpoint?: string;
  /** Extra HTTP headers sent to `endpoint` (or `/__design-kit/fix`). */
  headers?: Record<string, string>;
  /** Fetch credentials mode when posting to `endpoint`. */
  credentials?: RequestCredentials;
  /**
   * Enable or disable the plugin. In `vite build` (production), zero bytes are
   * injected unless BOTH `enabled` evaluates to `true` AND `endpoint` is set.
   */
  enabled?: boolean | ((config: unknown) => boolean);
  /** Project root directory (defaults to Vite's `config.root` or `process.cwd()`). */
  root?: string;
  /** Redlines output directory relative to `root` (default: `.design-kit/redlines`). */
  outDir?: string;
  /** Ensure `/.design-kit/redlines/` is in `.gitignore` (default: `true`). */
  gitignore?: boolean;
  /** URL prefix for dev middleware routes (default: `/__design-kit`). */
  routePrefix?: string;
  /** Override fix endpoint path (default: `<routePrefix>/fix`). */
  fixPath?: string;
  /** Override runtime script path (default: `<routePrefix>/annotator.js`). */
  scriptPath?: string;
  /** Override per-server capability token (default: random 24-byte hex). */
  token?: string;
  /** Maximum POST body size in bytes (default: 8 MB). */
  maxBodyBytes?: number;
  /** Explicit origin allowlist for `/__design-kit/fix` CSRF checks. */
  allowedOrigins?: string[];
  /** Extra options forwarded to `mountAnnotator`. */
  annotator?: Omit<
    AnnotatorOptions,
    "onSubmit" | "onModeChange" | "onItemsChange" | "container" | "document"
  >;
  /** Optional server-side hook invoked after writing a redline packet. */
  onPacket?: (
    written: WrittenRedlineResult,
  ) =>
    | void
    | { message?: string; runUrl?: string }
    | Promise<void | { message?: string; runUrl?: string }>;
  /** Optional error callback if spawning the local agent fails (e.g. ENOENT). */
  onAgentError?: (error: Error) => void;
}

export interface ViteLikePlugin {
  name: string;
  configResolved(config: { root?: string; command?: string }): void;
  configureServer(server: {
    middlewares: {
      use(
        fn: (
          req: IncomingMessage,
          res: ServerResponse,
          next: () => void,
        ) => void,
      ): void;
    };
  }): void;
  transformIndexHtml(html: string):
    | string
    | {
        html: string;
        tags: Array<{
          tag: string;
          attrs?: Record<string, string | boolean>;
          children?: string;
          injectTo?: "head" | "body" | "head-prepend" | "body-prepend";
        }>;
      };
}

export const DEFAULT_FIX_PATH: "/__design-kit/fix";
export const DEFAULT_SCRIPT_PATH: "/__design-kit/annotator.js";
export const DEFAULT_REDLINES_DIR: ".design-kit/redlines";
export const DEFAULT_MAX_BODY_BYTES: number;

export function designKitAnnotate(
  options?: DesignKitAnnotateOptions,
): ViteLikePlugin;
export default designKitAnnotate;

export function getAnnotatorScriptHtml(
  options?: DesignKitAnnotateOptions,
): string;

export function createFixMiddleware(
  options?: DesignKitAnnotateOptions,
): ((
  req: IncomingMessage,
  res: ServerResponse,
  next?: () => void,
) => Promise<void>) & { token: string; fixPath: string };

export function generateCapabilityToken(): string;

export function ensureGitignoreEntry(
  root: string,
  entry?: string,
): { updated: boolean; path: string };

export function writeRedlinePacket(
  rawPacket: unknown,
  options?: {
    root?: string;
    outDir?: string;
    gitignore?: boolean;
    now?: Date;
    allowOutsideRoot?: boolean;
  },
): WrittenRedlineResult;

export function spawnLocalAgent(
  agent: LocalAgentTarget,
  context: WrittenRedlineResult,
  options?: {
    root?: string;
    onError?: (error: Error) => void;
  },
): {
  spawned: boolean;
  name: string;
  command: string;
  args: string[];
  pid: number | null;
} | null;
