import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  FIGURE_WARN_BYTES,
  decodeEntities,
  elements,
  run,
} from "../src/kit.mjs";

const dir = mkdtempSync(join(tmpdir(), "design-kit-figure-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function figure(args) {
  const out = [];
  const err = [];
  const code = run(["figure", ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("figure writes a self-contained <figure>: the image as a data URI, linked to the plan page, the caption escaped", () => {
  const img = join(dir, "shot.png");
  writeFileSync(img, PNG);
  const out = join(dir, "figure.html");
  const result = figure([
    "--img",
    img,
    "--href",
    "#cp-page:orchestrator-plan",
    "--caption",
    'New <Card> & "chip"',
    "--width",
    "640",
    "--out",
    out,
  ]);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.match(result.out, /figure\.html {2}\d/);
  const html = readFileSync(out, "utf8");
  const tags = elements(html);
  assert.deepEqual(
    tags.map((node) => node.name),
    ["figure", "a", "img", "figcaption"],
  );
  const link = tags.find((node) => node.name === "a");
  assert.equal(link.attrs.href, "#cp-page:orchestrator-plan");
  const image = tags.find((node) => node.name === "img");
  const src = image.attrs.src;
  assert.ok(src.startsWith("data:image/png;base64,"));
  assert.deepEqual(Buffer.from(src.split(",")[1], "base64"), PNG);
  assert.match(image.attrs.style, /^width:640px;max-width:100%/);
  assert.equal(decodeEntities(image.attrs.alt), 'New <Card> & "chip"');
  assert.match(
    html,
    /<figcaption>New &lt;Card&gt; &amp; &quot;chip&quot;<\/figcaption>/,
  );
  assert.doesNotMatch(html, /<Card>/);
});

test("figure without --href or --caption is the image alone; --alt wins", () => {
  const img = join(dir, "plain.webp");
  writeFileSync(img, PNG);
  const out = join(dir, "plain.html");
  assert.equal(figure(["--img", img, "--alt", "a <b>", "--out", out]).code, 0);
  const html = readFileSync(out, "utf8");
  assert.match(html, /src="data:image\/webp;base64,/);
  assert.match(html, /alt="a &lt;b&gt;"/);
  assert.doesNotMatch(html, /<a |<figcaption>/);
});

test("figure warns on stderr above 1 MB and still writes the page", () => {
  const img = join(dir, "big.jpg");
  writeFileSync(img, Buffer.alloc(FIGURE_WARN_BYTES + 1));
  const out = join(dir, "big.html");
  const result = figure(["--img", img, "--out", out]);
  assert.equal(result.code, 0);
  assert.match(result.err, /^kit: warning: .*big\.jpg is .*below 1 MB/);
  assert.match(readFileSync(out, "utf8"), /data:image\/jpeg;base64,/);
});

test("figure refuses another image type, a script link and a bad width", () => {
  const img = join(dir, "shot.png");
  writeFileSync(img, PNG);
  const out = join(dir, "x.html");
  const gif = join(dir, "a.gif");
  writeFileSync(gif, PNG);
  for (const [args, reason] of [
    [["--img", gif, "--out", out], /use a \.png, \.jpg or \.webp/],
    [["--img", img, "--href", "javascript:alert(1)", "--out", out], /--href/],
    [["--img", img, "--width", "wide", "--out", out], /--width wide/],
    [["--img", img], /needs --out/],
    [["--out", out], /needs --img/],
  ]) {
    const result = figure(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.err, reason);
  }
});
