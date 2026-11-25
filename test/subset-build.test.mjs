import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureStories, subsetBuildProblem } from "../src/capture-stories.mjs";

/** A Storybook output folder with an index and, optionally, a story-set record. */
function build(record) {
  const dir = mkdtempSync(
    join(process.env.TMPDIR || tmpdir(), "design-kit-subset-"),
  );
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      entries: {
        "a--one": { id: "a--one", title: "A", name: "One", type: "story" },
      },
    }),
  );
  if (record)
    writeFileSync(
      join(dir, "codepress-story-set.json"),
      JSON.stringify(record),
    );
  return dir;
}

test("the design kit refuses a Storybook build of a subset of the stories", async () => {
  const dir = build({
    set: "subset",
    source: "CODEPRESS_STORYBOOK_STORY_FILES",
    files: ["src/a.stories.tsx", "src/b.stories.tsx"],
  });
  assert.match(
    subsetBuildProblem(dir),
    /subset of the stories \(2 stories file/,
  );
  await assert.rejects(
    captureStories(
      { stories: { root: dir } },
      { storybookDir: dir, out: join(dir, "kit"), log: () => {} },
    ),
    /captures only a full build/,
  );
});

test("a full build, and one with no record, are not refused", () => {
  assert.equal(subsetBuildProblem(build({ set: "full" })), null);
  assert.equal(subsetBuildProblem(build(null)), null);
});
