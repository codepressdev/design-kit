/**
 * Playwright is a peer dependency: the project brings its own (and the
 * Chromium it installed). It is looked up from the working directory, then
 * `from` (the config's folder), then this package.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const NAMES = ["@playwright/test", "playwright"];

function requirers(from) {
  return [
    createRequire(join(process.cwd(), "package.json")),
    ...(from ? [createRequire(join(from, "package.json"))] : []),
    createRequire(import.meta.url),
  ];
}

function find(from, load) {
  for (const require of requirers(from)) {
    for (const name of NAMES) {
      try {
        return load(require, name);
      } catch {
        // Not installed here; try the next place.
      }
    }
  }
  throw new Error(
    "Playwright is not installed: add @playwright/test (or playwright) to the project and run `npx playwright install chromium`",
  );
}

/** The version of the Playwright a capture would drive. */
export function playwrightVersion(from) {
  return find(from, (require, name) => require(`${name}/package.json`).version);
}

/** `{ chromium, version }` from the project's Playwright. */
export function loadPlaywright(from) {
  return find(from, (require, name) => {
    const { chromium } = require(name);
    if (!chromium) throw new Error(`${name} has no chromium`);
    return { chromium, version: require(`${name}/package.json`).version };
  });
}
