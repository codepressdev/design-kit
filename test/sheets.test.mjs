import assert from "node:assert/strict";
import { test } from "node:test";

import { sheetStore } from "../src/capture-stories.mjs";

// Two captures' sheets as extract returns them: fresh arrays and strings.
const sheet = (key, ...rules) => ({ key: `${key}`, rules: [...rules] });

test("equal sheets from different captures share one entry", () => {
  const keep = sheetStore();
  const [a] = keep([sheet("/app.css", ".a{color:red}", ".b{margin:0}")]);
  const [b] = keep([sheet("/app.css", ".a{color:red}", ".b{margin:0}")]);
  assert.equal(a, b);
  assert.deepEqual(a, sheet("/app.css", ".a{color:red}", ".b{margin:0}"));
});

test("a shared key with different rules keeps each capture's own rules", () => {
  const keep = sheetStore();
  const [first] = keep([sheet("/theme.css", ".x{color:red}")]);
  const [second] = keep([sheet("/theme.css", ".x{color:blue}")]);
  const [again] = keep([sheet("/theme.css", ".x{color:red}")]);
  assert.notEqual(first, second);
  assert.deepEqual(first.rules, [".x{color:red}"]);
  assert.deepEqual(second.rules, [".x{color:blue}"]);
  assert.equal(again, first);
});

test("a capture's sheets keep their order", () => {
  const keep = sheetStore();
  const kept = keep([
    sheet("inline:.z{}", ".z{}"),
    sheet("/app.css", ".a{}"),
    sheet("/theme.css", ".t{}"),
  ]);
  assert.deepEqual(
    kept.map((entry) => entry.key),
    ["inline:.z{}", "/app.css", "/theme.css"],
  );
});
