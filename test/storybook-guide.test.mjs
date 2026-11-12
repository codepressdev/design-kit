import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

import { main } from "../src/cli.mjs";

const SKILL = new URL("../skills/storybook-setup/SKILL.md", import.meta.url);

test("storybook-guide prints the packaged storybook-setup skill", async () => {
  const written = [];
  const write = mock.method(process.stdout, "write", (chunk) => {
    written.push(String(chunk));
    return true;
  });
  let code;
  try {
    code = await main(["storybook-guide"]);
  } finally {
    write.mock.restore();
  }
  assert.equal(code, 0);
  assert.equal(written.join(""), readFileSync(SKILL, "utf8"));
  assert.match(written.join(""), /^---\nname: storybook-setup\n/);
});

test("storybook-guide takes no options", async () => {
  const error = mock.method(console, "error", () => {});
  try {
    assert.equal(await main(["storybook-guide", "--root", "."]), 2);
  } finally {
    error.mock.restore();
  }
});
