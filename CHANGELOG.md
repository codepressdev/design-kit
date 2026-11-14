# @codepress/design-kit

## 0.10.0

### Minor Changes

- 8c590f6: Composed mockups can be clickable. `kit.mjs compose` keeps the inline `<script>` elements in your `--slot` fragment files (only `type` and `id` stay on the tag), while everything from the kit's captured markup is sanitized as before; a fragment's `<script src>` and every `on…=` handler are still removed. A page that uses `data-kit-toggle="<id>"` (show or hide an element; outside click and Esc close it), `data-kit-tabs` with `data-kit-tab`/`data-kit-panel`, or `data-kit-state="<group>:<name>"` with `data-kit-set` triggers gets a small dependency-free behaviour script inlined once, which needs no network and runs in a `sandbox="allow-scripts"` frame. Behaviour attributes and `hidden` on a `<kit-snippet>` carry onto the elements it expands to, so two captured story states become one switchable group. `--show-new` also outlines behaviour triggers. The sanitizer now checks the first of two same-named attributes, the one the browser uses. It also ends a comment where the browser does (`--!>`, `<!-->` and `<!--->`), and drops a `<style>`, `<title>` or `<textarea>` whose content holds markup, which SVG and MathML would parse as elements; before, captured markup could run script through either. A page with no behaviour attributes and no author scripts composes byte for byte as before.

## 0.9.0

### Minor Changes

- 674255c: Choose where your design kit is stored. A new `storage` key in `design-kit.config.json` picks `github` (the default, unchanged: a GitHub Actions artifact), `codepress` (CodePress keeps the newest kit of each branch, and the workflow signs in with its GitHub OIDC token, so you add no secret), or your own bucket: `s3` for AWS S3, or `r2` for Cloudflare R2, which needs only your account id and bucket name. New commands work the same with every store: `design-kit upload --dir <kit>`, `design-kit fetch` (downloads the newest kit once per commit and prints `path=`, `sha=` and `branch=`) and `design-kit latest` (prints `sha=` and `created=`). `ci-check` finds the newest kit through the same lookup. `init --storage <type>` writes the matching config key and workflow, and `init --workflow-only --force --storage <type>` switches a repository that is already set up. The skill that `init` installs now fetches kits with `design-kit fetch`. Configs without `storage` generate exactly the same workflow as before. If you add `storage` by hand, also bump the pinned package version, because older versions reject the key.

## 0.8.0

### Minor Changes

- 65340b5: `compose` records what a page used, in the page only: each expanded `<kit-snippet>`'s top-level elements carry `data-kit-snippet="<id>"`, and a `<meta name="design-kit-usage">` in the head holds the kit sha, the frame, the snippet ids and the number of `data-kit-new` elements. Nothing else changes, and `kit.mjs` still makes no network call.

## 0.7.0

### Minor Changes

- 464a85c: `kit find` searches the words on screen: every kit write builds `text.json` (each row's visible text, first 600 characters, slot text first), and a row found only by its text prints an excerpt. Kits without `text.json` find as before.

## 0.6.0

### Minor Changes

- 5999430: Stories can list their own capture widths with `parameters.designKit.widths`, so a phone-only story is captured at phone width and left out at desktop width instead of failing there. A `// design-kit: no-story <reason>` comment marks a component file with nothing to show: its gap row has reason `exempt` and the reason as `detail`, instead of `no story`. Both are additive; `kit_version` stays 1. A story that holds the page's main thread, before or after it renders, is now a `timeout` gap instead of stalling the capture (a story that holds it only at a width it does not list is still captured at its own widths), and a second capture in the same process no longer reuses pages from the first one's closed browser.

## 0.5.0

### Minor Changes

- 2691fe7: Design kit: page sources. A `pages.source` name lets two configs capture pages into one kit without erasing each other: a capture rewrites only its own source's frames, rows and gap rows, writes its stylesheet to `css/routes--<source>.css`, and fails with exit 2 naming both sources when a page name is already captured by another. Page hooks can return `beforeReady`, which runs once the shell shows and before the page's ready selector. Terminal's own windows (workspace, Settings, an Orchestrator project) are now captured into CodePress's kit with `pnpm design-kit:pages`; nothing in Terminal's app changes.

## 0.4.2

### Patch Changes

- 9a7fc21: `capture stories` holds each stylesheet's rules once instead of once per kept capture, so a full single-process capture of a large Storybook no longer runs out of heap. The kit output is unchanged.

## 0.4.1

### Patch Changes

- 7d2037e: The package's repository, homepage and issue links now point at `codepressdev/design-kit`, where the source is mirrored with one commit per upstream change and a tag and GitHub Release for every version. `design-kit init` now ends with one line about CodePress after it writes its files. It makes no network call, and the line is not printed on `--dry-run` or when the repository is already set up.

## 0.4.0

### Minor Changes

- 2c07aa2: The workflow `design-kit init` writes now rebuilds the kit only when your UI changed, and keeps kits three times longer.
  - **Rebuilds only when the UI changed.** `design-kit.config.json` has a new, optional `watch` list: the folders and files, relative to the repository root, whose change rebuilds the kit. `init` fills it in with your Storybook and app folders, the workspace packages they depend on (where shared UI usually lives in a monorepo), global styles and tokens, the config, the lockfile and the workflow. A pages-only repository gets the app folder and its workspace dependencies. The daily run compares the git ids of those paths at the newest kit's commit and now, and stops after a few seconds when none changed, without installing dependencies, Chromium or Storybook. The run's summary says why it built or skipped.
  - **Kits last 90 days and never expire unreplaced.** Kits are kept 90 days, the most a public repository allows (a private one may raise `retention-days` to 400). The kit is rebuilt at least every 75 days (`DESIGN_KIT_MAX_AGE_DAYS`), and after each upload the older kits on the branch are deleted. A failed delete is a warning, never a failed run.
  - **New commands** behind the workflow: `design-kit ci-check` prints `build=true|false` and the reason, and `design-kit ci-cleanup --keep <artifact id>` deletes older kits.
  - **Update an existing setup** with `npx @codepress/design-kit@latest init --workflow-only --force`. It rewrites only the workflow and prints the `watch` list to add to your config. Workflows you already have keep running unchanged until you do.
  - The installed `design-kit` skill now reads `watch` from the config when it counts the UI commits since a kit, so its caption matches what triggers a rebuild.

## 0.3.0

### Minor Changes

- ebfe0f8: New command: `design-kit storybook-guide`. It prints an agent skill for adding Storybook to a repository that has none, or extending the one it has, with stories for the components it already has, as one pull request. Tell Claude Code, Codex or Cursor to run `npx --yes @codepress/design-kit storybook-guide` and follow it. The agent surveys your components and tokens. It installs Storybook 9 (8 for older apps), pinned so your React, Next.js and TypeScript versions stay as they are. It fixes the usual first-build failures: peer-dependency conflicts, modules that throw on a missing `NEXT_PUBLIC_*` variable, `next/font`, `next/image` and SVG imports, and `public/` assets. It then writes one stories file per component, covering every variant plus the empty, loading, error and long-text states, and adds a tokens story. It typechecks, builds Storybook, checks that `capture stories` captures the result, and lists anything it skipped with the reason.

  `capture stories` is now checked against Storybook 9 static builds as well as 7 and 8, so `init` no longer warns about Storybook 9. `init`'s "No Storybook" note and the `setup-guide` skill now point at `storybook-guide`.

  The README has a new section, "Keeping the kit in sync". Nothing needs re-running after setup: the workflow `init` wrote rebuilds the kit every day and on demand, and captures whatever stories and pages exist at that commit. Agents always fetch the newest kit. Re-run `init` only to start over, and update the pinned version in the workflow to pick up a new release. The `design-kit` skill that `init` installs, and `storybook-guide`, now ask agents to add or update a component's story in the same pull request as the component, so the next kit captures it.

## 0.2.2

### Patch Changes

- 8ba8871: The README has a new section, "Set it up with your agent": a prompt to paste into Claude Code, Codex or Cursor, what the agent does, how to ask for Storybook when the repository has none, and how to ask for a mockup once the kit exists. The `setup-guide` example no longer pins version 0.1.3.

## 0.2.1

### Patch Changes

- 03dea05: A page's `path` may carry a query string, such as `/apps/my-app?tab=settings`. `capture pages` now compares only the pathname when it checks for a redirect, so the query no longer turns the page into a gap. A page that does redirect to another pathname is still recorded as a gap.
