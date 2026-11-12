/**
 * The `no story` scan and the `design-kit: no-story <reason>` marker, and a
 * story's own widths (`parameters.designKit.widths`) in capture planning.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  componentsWithoutStories,
  noStoryReason,
  ownWidths,
  plannedViewports,
} from "../src/capture-stories.mjs";

const scratch = mkdtempSync(
  join(process.env.TMPDIR || tmpdir(), "design-kit-gaps-"),
);
after(() => rmSync(scratch, { recursive: true, force: true }));

function project(files) {
  const root = mkdtempSync(join(scratch, "project-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const scan = (root, stories = []) =>
  componentsWithoutStories(stories, {
    gaps: { sourceRoot: join(root, "src"), componentGlob: "src/**/[A-Z]*.tsx" },
    root,
    configDir: root,
  }).sort((a, b) => (a.component < b.component ? -1 : 1));

test("a no-story marker with a reason makes an exempt row; without one the file stays a gap", () => {
  const root = project({
    "src/ImageSourceContext.tsx":
      "// design-kit: no-story context provider\nexport const X = 1;\n",
    "src/Bare.tsx": "// design-kit: no-story\nexport const Y = 1;\n",
    "src/Spaces.tsx": "// design-kit: no-story    \nexport const Z = 1;\n",
    "src/Plain.tsx": "export const Plain = () => null;\n",
    "src/Covered.tsx": "export const Covered = () => null;\n",
    "src/Covered.stories.tsx": "export default {};\n",
  });
  assert.deepEqual(scan(root, [{ componentPath: "./src/Covered.tsx" }]), [
    { component: "src/Bare.tsx", reason: "no story" },
    {
      component: "src/ImageSourceContext.tsx",
      reason: "exempt",
      detail: "context provider",
    },
    { component: "src/Plain.tsx", reason: "no story" },
    { component: "src/Spaces.tsx", reason: "no story" },
  ]);
});

test("the marker is read from line, block and JSX comments only", () => {
  assert.equal(
    noStoryReason("// design-kit: no-story context provider"),
    "context provider",
  );
  assert.equal(
    noStoryReason("/* design-kit: no-story controller, no markup */"),
    "controller, no markup",
  );
  assert.equal(
    noStoryReason("return (\n  {/* design-kit: no-story hook wrapper */}\n"),
    "hook wrapper",
  );
  assert.equal(
    noStoryReason("/**\n * design-kit: no-story re-exports only\n */"),
    "re-exports only",
  );
  assert.equal(noStoryReason("// design-kit: no-story"), null);
  assert.equal(noStoryReason("/* design-kit: no-story */"), null);
  assert.equal(noStoryReason('const s = "design-kit: no-story x";'), null);
  assert.equal(noStoryReason("// design-kit: no-storybook here"), null);
});

test("a story's own widths replace the planned ones, and a malformed list changes nothing", () => {
  const planning = {
    viewport: { width: 1280, height: 800 },
    widths: [{ titles: /^Shell\//, width: 390, height: 844 }],
  };
  const sizes = (list) => list.map((v) => `${v.width}x${v.height}`);

  // Phone-only: captured at 390 (the configured height), never at 1280.
  assert.deepEqual(
    sizes(plannedViewports("Shell/AppShell", null, planning, ownWidths([390]))),
    ["390x844"],
  );
  // Desktop-only story in a title that is also captured at phone width.
  assert.deepEqual(
    sizes(
      plannedViewports("Shell/AppShell", null, planning, ownWidths([1280])),
    ),
    ["1280x800"],
  );
  // A width no config names takes its listed height, else the default one.
  assert.deepEqual(
    sizes(
      plannedViewports(
        "Chat/Bubble",
        null,
        planning,
        ownWidths([{ width: 768, height: 1024 }, 320]),
      ),
    ),
    ["768x1024", "320x800"],
  );
  for (const raw of [[], "390", [0, -1, "390"], null, { width: 390 }])
    assert.equal(ownWidths(raw), null, JSON.stringify(raw));
  assert.deepEqual(
    sizes(plannedViewports("Shell/AppShell", null, planning, ownWidths([]))),
    ["1280x800", "390x844"],
  );
});
