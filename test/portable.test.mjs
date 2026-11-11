import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT_TOOL = fileURLToPath(new URL("../src/kit.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/kit", import.meta.url));
// The OS temp folder, outside any checkout: no node_modules above the kit.
const scratch = mkdtempSync(join(tmpdir(), "design-kit-portable-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the kit's own kit.mjs imports only Node built-ins", () => {
  const source = readFileSync(KIT_TOOL, "utf8");
  const specifiers = [
    ...source.matchAll(
      /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    ),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(
    specifiers.filter((specifier) => !specifier.startsWith("node:")),
    [],
  );
});

test("a copied kit runs its kit.mjs with plain node and no node_modules", () => {
  const kit = join(scratch, "kit");
  cpSync(FIXTURE, kit, { recursive: true });
  copyFileSync(KIT_TOOL, join(kit, "kit.mjs"));
  const page = join(scratch, "page.html");
  const node = (args) =>
    execFileSync(process.execPath, ["kit.mjs", ...args], {
      cwd: kit,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
  assert.match(node(["info"]), /rows: 39/);
  assert.match(
    node(["compose", "--frame", "route:orchestrator@1280", "--out", page]),
    /page\.html/,
  );
  assert.match(
    readFileSync(page, "utf8"),
    /data-kit-id="route:orchestrator@1280"/,
  );
});
