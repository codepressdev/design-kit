import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import { main } from "../src/cli.mjs";
import { ConfigError, loadConfig, validate } from "../src/config.mjs";

const scratch = mkdtempSync(join(tmpdir(), "design-kit-config-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function configFile(value) {
  const file = join(scratch, `${(counter += 1)}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

const page = (extra = {}) => ({
  name: "home",
  path: "/",
  ready: "main h1",
  slots: { main: ["main"] },
  ...extra,
});

/** Runs the CLI in-process; returns its exit code and what it printed to stderr. */
async function cli(args) {
  const errors = [];
  const restore = mock.method(console, "error", (text) => errors.push(text));
  const log = mock.method(console, "log", () => {});
  try {
    return { code: await main(args), err: errors.join("\n") };
  } finally {
    restore.mock.restore();
    log.mock.restore();
  }
}

test("a config with an unknown key exits 2 and names the field", async () => {
  const file = configFile({
    version: 1,
    pages: { pages: [page()], baseUrl: "http://localhost:3000", widht: [] },
  });
  const result = await cli(["validate", "--config", file]);
  assert.equal(result.code, 2);
  assert.match(result.err, /pages\.widht: unknown key/);
});

test("a page without slots.main exits 2 and names the field", async () => {
  const file = configFile({
    version: 1,
    pages: {
      pages: [page(), page({ name: "about", slots: { list: ["aside"] } })],
    },
  });
  const result = await cli(["capture", "pages", "--config", file]);
  assert.equal(result.code, 2);
  assert.match(result.err, /pages\.pages\[1\]\.slots\.main: is required/);
});

test("validation names types, enums, patterns and nested unknown keys", () => {
  assert.deepEqual(
    validate({
      version: 2,
      theme: { attribute: "class", targets: ["head"] },
      stories: { viewport: { width: "wide", height: 800 }, root: "" },
      pages: { pages: [page({ name: "Home Page", slot: {} })] },
    }),
    [
      "version: must be 1",
      'theme.targets[0]: must be "html" or "body"',
      "stories.viewport.width: must be an integer, not a string",
      "stories.root: must not be empty",
      "pages.pages[0].name: must match ^[a-z0-9][a-z0-9-]*$",
      "pages.pages[0].slot: unknown key",
    ],
  );
});

test("loadConfig resolves paths against the config's folder and fills defaults", () => {
  const file = configFile({
    version: 1,
    out: "kit",
    theme: { attribute: "data-theme" },
    stories: {
      root: "ui",
      staticDir: "storybook-static",
      widths: [{ titles: "^Pages/", width: 390, height: 844 }],
    },
  });
  const config = loadConfig(file);
  assert.equal(config.out, join(scratch, "kit"));
  assert.equal(config.stories.root, join(scratch, "ui"));
  assert.equal(config.stories.staticDir, join(scratch, "ui/storybook-static"));
  assert.equal(config.stories.widths[0].titles.test("Pages/Home"), true);
  assert.deepEqual(config.theme, {
    attribute: "data-theme",
    dark: "dark",
    targets: ["html"],
  });
  assert.equal(config.pages, undefined);
});

test("rules the schema cannot express are checked too", () => {
  const file = configFile({
    version: 1,
    stories: { widths: [{ titles: "(", width: 1, height: 1 }] },
    pages: {
      startCommand: "serve",
      auth: { storageState: "a.json", setup: "b.mjs" },
      pages: [page(), page()],
    },
  });
  assert.throws(
    () => loadConfig(file),
    (error) =>
      error instanceof ConfigError &&
      /stories\.widths\[0\]\.titles: not a regular expression/.test(
        error.message,
      ) &&
      /pages\.auth: give storageState or setup, not both/.test(error.message) &&
      /pages\.waitUrl: is required with pages\.startCommand/.test(
        error.message,
      ) &&
      /pages\.pages\[1\]\.name: "home" is used twice/.test(error.message),
  );
});

test("--help prints the usage from any command, without reading a config", async () => {
  const logs = [];
  const log = mock.method(console, "log", (text) => logs.push(text));
  try {
    assert.equal(await main(["capture", "stories", "--help"]), 0);
    assert.equal(await main(["--help"]), 0);
  } finally {
    log.mock.restore();
  }
  assert.match(logs.join("\n"), /capture stories/);
});
