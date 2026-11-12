/**
 * @codepress/design-kit's programmatic API. The command line (`design-kit`)
 * is a thin layer over these.
 */
export {
  CONFIG_NAME,
  ConfigError,
  SCHEMA_PATH,
  findConfig,
  loadConfig,
  resolveConfig,
  validate,
} from "./config.mjs";
export { captureStories, playwrightVersion } from "./capture-stories.mjs";
export { assertPageSources, capturePages } from "./capture-pages.mjs";
export { findForbidden, forbiddenNeedles } from "./pages.mjs";
export { compose, find, loadKit, run as runKit } from "./kit.mjs";
