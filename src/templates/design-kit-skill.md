---
name: design-kit
description: "Draw mockups of this app's screens from its design kit: real pages and Storybook stories captured every day as static HTML, composed into self-contained pages with only the new parts hand-drawn. Use for any mockup, design or screen page of this app. Covers fetching the newest kit with gh, kit find/show/compose, <kit-snippet> and data-kit-new, staleness, captions saying what is real and what is new, and what to do when no kit can be fetched."
---

# Design kit

Mockups of this app's screens start from its **design kit**: real pages of
the app and its Storybook stories, rendered to static HTML with the app's own
CSS and fonts, plus `kit.mjs`, a dependency-free tool that finds pieces and
composes self-contained pages. Draw only what is new; the frame and every
existing component come from the kit, so the mockup looks like the app it will
ship in.

The kit is configured in `{{CONFIG}}` and built by the `Design kit` workflow
(`.github/workflows/design-kit.yml`). The format and every command are in the
`{{PACKAGE}}` README.

When this repository has Storybook and you add a component or change what
one renders, add or update its story in the same pull request, covering its
default, every variant and size, and the empty, loading, error and long-text
states that apply, so the next kit captures it. A component without a story
is missing from every kit until it gets one.

## 1. Fetch the newest kit

The workflow runs once a day and on demand (`workflow_dispatch`), and uploads
the `design-kit` artifact (kept 90 days; older kits are deleted). A day when
none of the config's `watch` paths changed skips and uploads nothing, yet
still succeeds, so look up the newest artifact rather than the newest run,
then download it once per kit commit:

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
read -r RUN SHA < <(gh api "repos/$REPO/actions/artifacts?name=design-kit&per_page=100" \
  --jq "[.artifacts[] | select((.expired | not) and .workflow_run.head_branch == \"$BRANCH\")]
        | sort_by(.created_at) | last // empty | \"\(.workflow_run.id) \(.workflow_run.head_sha)\"")
echo "run=$RUN sha=$SHA"   # empty → go to "When there is no kit"
KIT="${TMPDIR:-/tmp}/design-kit-$SHA"
if [ -n "$RUN" ] && [ ! -f "$KIT/manifest.json" ]; then
  rm -rf "$KIT.partial" &&
    gh run download "$RUN" --repo "$REPO" -n design-kit -D "$KIT.partial" &&
    mv "$KIT.partial" "$KIT"
fi
node "$KIT/kit.mjs" info   # manifest: sha, built_at, counts, sources
```

Reuse `$KIT` while the newest kit's SHA is unchanged. Keep the kit and your
working files in a scratch folder, never in the repository.

## 2. Check staleness

The kit is a snapshot of `manifest.sha`, up to a day behind. Check whether UI
code changed since, over the same `watch` paths that make the workflow
rebuild (read from the config, so the two always agree):

```bash
KIT_SHA=$(node -p 'require(process.argv[1]).sha' "$KIT/manifest.json")
TOP=$(git rev-parse --show-toplevel)
git fetch -q origin "$BRANCH" &&
  node -e 'const w = require(process.argv[1]).watch; process.stdout.write((w?.length ? w : ["."]).map((p) => `:(top)${p}`).join("\0"))' "$TOP/{{CONFIG}}" |
  xargs -0 git log --oneline "$KIT_SHA..origin/$BRANCH" --
```

When the list is not empty, say so on the mockup: "Kit from `<sha7>`; N UI
commits since, so parts of the frame may be out of date". When one of those
commits touches a component the mockup shows, read it and say what the mockup
is missing.

## 3. Find what is real

```bash
node "$KIT/kit.mjs" find button          # ≤ 30 lines: id, kind, width, bytes, title
node "$KIT/kit.mjs" show route:home@1280 # path, size and an outline with slots
```

- **Frames** are whole screens: `route:<page>@<width>` rows, real pages of the
  app at 1280 and 390 wide, with replaceable regions marked `data-kit-slot`
  (`main` on every page). New content goes only into a slot, and only `route:`
  frames have slots. A story frame is still useful unchanged, as the "today"
  view or as real context beside a mockup.
- **Snippets** are stories: `story:<storybook-id>@<width>`, one per component
  state. Search by component and state (`find empty`, `find dialog`).
- `show` prints a short outline. Use `show --full` only on a small snippet
  whose structure you need, never on a frame.
- Anything not in the kit has no story or its capture failed (`gaps.json` in
  the kit lists the failures). Draw it as new and say it is approximated.

## 4. Write only the new content

Write one HTML fragment per slot you change, in your scratch folder:

```html
<!-- $WORK/after-main.html → fills the frame's `main` slot -->
<div class="page">
  <kit-snippet id="story:components-card--default@1280"></kit-snippet>
  <section data-kit-new class="card">…only what the change adds…</section>
</div>
```

- `<kit-snippet id="…">` places a real component; `compose` expands it with
  the captured markup.
- Mark every hand-drawn element with `data-kit-new` (the outermost new element
  is enough).
- Style new parts with the app's own classes and CSS variables. The kit's CSS
  holds only the rules the app actually loads, so check a class exists with
  `grep -c '\.<class>' "$KIT"/css/*.css`, or use an inline `style` with the
  app's variables.
- To show several states of the new part, stack them inside the fragment, each
  with a short label.

## 5. Compose

```bash
node "$KIT/kit.mjs" compose --frame route:home@1280 \
  --slot main="$WORK/after-main.html" --out "$WORK/after-desktop.html"
node "$KIT/kit.mjs" compose --frame route:home@1280 --out "$WORK/today.html"
```

The result is one self-contained page: CSS and fonts inlined, scripts and
remote URLs removed, and `data-kit-sha` and `data-kit-id` on `<html>`. Add
`--theme dark` for the dark theme and `--show-new` for a dashed outline on
every `data-kit-new` element. An unknown frame, slot or snippet id exits 2 and
names near matches.

Never paste snippet or frame markup through your own output, and do not read a
composed page back: it carries the whole CSS and fonts. Open it in a browser,
screenshot it, and share the screenshot or the file.

## 6. Caption: what is real, what is new

Under every mockup, say which parts are real and which are new, and where you
approximated:

> Real: the Home page (`route:home@1280`) and the card
> (`story:components-card--default@1280`), from kit `3f2a9c1` built
> 2026-11-03. New (dashed): the Pinned section. Approximated: the pin menu has
> no story yet.

Add the staleness line from step 2 when it applies. For other widths, compose
the capture on the same side of the breakpoint and say that layout decided in
script stays as captured.

## When there is no kit

1. **Build it locally** from an up-to-date checkout with dependencies
   installed (`{{INSTALL}}`):

   ```bash
   DK="{{CLI}}"
   CONFIG="$PWD/{{CONFIG}}"
   KIT="${TMPDIR:-/tmp}/design-kit-local-$(git rev-parse --short HEAD)"
   {{PLAYWRIGHT_INSTALL}}
   {{STORIES_LINE}}
   $DK capture pages --config "$CONFIG" --out "$KIT"     # starts the app itself
   ```

   Then follow steps 3–6 with this `$KIT` and caption it as "local build at
   `<sha7>`". A page capture that fails leaves a kit of stories only: compose
   story frames unchanged for real context, draw the new screen by hand and
   say so.

2. **No kit at all**: approximate from the app's styles and components, and say
   on every mockup "Approximated: the design kit was unavailable (<reason>)".

Either way the work goes ahead; the caption says what you could not use.
