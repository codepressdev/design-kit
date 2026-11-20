/** Types for `@codepress/design-kit/next`. */

import type { DesignKitAnnotateOptions } from "./vite.d.ts";

export {
  createFixMiddleware,
  ensureGitignoreEntry,
  generateCapabilityToken,
  getAnnotatorScriptHtml,
  spawnLocalAgent,
  writeRedlinePacket,
} from "./vite.d.ts";

export interface NextFixHandlerOptions extends DesignKitAnnotateOptions {
  /** Allow the route handler to run when `NODE_ENV === "production"` (default: `false`). */
  allowInProduction?: boolean;
}

export function createNextFixHandler(
  options?: NextFixHandlerOptions,
): ((request: Request) => Promise<Response>) & { token: string };

export function getNextAnnotatorScript(
  options?: DesignKitAnnotateOptions,
): string;
