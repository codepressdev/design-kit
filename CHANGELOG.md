# @codepress/design-kit

## 0.19.2

### Patch Changes

- 6a0a630: Spaces typed in an annotation note stay in the note again while the Plans canvas is on screen. Before, the canvas took each space as "Space + drag to pan", so "fix the button" was saved as "fixthebutton". Space pressed on the canvas itself still pans.

## 0.19.1

### Patch Changes

- 8add835: Improve mobile and touch UX for `@codepress/design-kit/annotate`: add a red Annotate-mode perimeter ring and 1-tap `Annotating · Tap to Browse` exit pill, allow vertical touch scrolling in Pin mode (`touch-action: pan-y` and ignore touch drags >12px), condense the mobile dock into a thumb-friendly 2-row bar (collapsing to 1 row in Browse mode) with 28px touch markers, and render the note input as a `visualViewport`-aware mobile sheet with a 16px textarea font and `focus({ preventScroll: true })` to avoid iOS Safari auto-zoom and keyboard overlap.

## 0.19.0

### Minor Changes

- df1e471: Screen annotator: "Open run ↗" after Send to Fix now opens the run. The link is always an absolute address (a relative run URL resolves against the host page, or the new `runUrlBase` option, never a popped-out toolbar's blank window), and the new `onOpenRun(url)` option lets a host route it itself; without one it opens in a new tab from the host page. In CodePress Terminal the link opens the Orchestrator project or chat inside Terminal, also from the native pop-out toolbar, which now shows an "Open run ↗" button. The toolbar also gains Undo and Redo buttons, with Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Ctrl+Y while the annotator is open (left alone in text fields, terminals and code editors). History covers adding, removing, editing notes and clearing, keeps 100 steps for the page session, and ends when Send to Fix succeeds. The controller adds `undo()`, `redo()`, `canUndo()`, `canRedo()` and `openRun()`, and its state adds `toastUrl`, `canUndo` and `canRedo`.

## 0.18.0

### Minor Changes

- e7e9f3a: Add Vite dev plugin (`@codepress/design-kit/vite`), Next.js route/script helper (`@codepress/design-kit/next`), and zero-code `design-kit annotate` CLI proxy for live in-app annotation and local agent auto-fix.
  - Injects `<design-kit-annotator>` in dev mode only (zero bytes in production `vite build` output unless both `enabled` and a remote `endpoint` are explicitly configured).
  - Mounts a loopback `/__design-kit/fix` receiver guarded by a per-server random `X-Design-Kit-Token`, `Origin` verification, 8 MB body cap, and path-traversal checks.
  - Writes `.design-kit/redlines/<timestamp>/packet.md`, `packet.json`, and `step-*.png`, updates `.design-kit/redlines/latest.md`, ensures `/.design-kit/redlines/` is in `.gitignore`, and optionally spawns `claude`, `codex`, `agy`, or a custom argv command asynchronously without shell interpolation.
  - Documents live annotation and multi-step `.design-kit/redlines/` fixing in `README.md`, the installed `design-kit` skill, and `design-kit-setup`.

## 0.17.0

### Minor Changes

- aed63e5: Add `@codepress/design-kit/annotate`, a zero-dependency closed Shadow-DOM live-app annotation overlay (`<design-kit-annotator>`) and Redline Context Packet contract:
  - **Browse ↔ Annotate workflow**: zero capture-phase pointer or keyboard interception in `Browse` or collapsed states so native clicks, modals, forms, and client routing work uninterrupted while queued redlines persist in `sessionStorage` across same-origin reloads.
  - **Annotation tools & immediate per-step snapshots**: Pin, Region Box (with pairwise overlap px calculation), Move Arrow (`from` → `to`), and Freehand stroke with per-item notes, composited viewport callout PNGs (`<= 1 MiB` with cross-origin image placeholders), sanitized routes, viewport/theme metadata, framework source hints (React `_debugSource` / `_debugStack` with 250 ms same-origin `.map` resolution, Vue `__file`, Svelte `__svelte_meta`, `codepress-data-fp`), component owner chains, CSS selectors, trimmed `outerHTML`, and computed layout styles.
  - **Pluggable Send to Fix transports**: HTTP POST, origin/source/channel-pinned iframe `postMessage` (`DK_ANNOTATE_*`), custom `onSubmit` callbacks, and Copy Packet fallback with inline non-blocking status toasts.
  - **Embeddable runtime & formatters**: export `mountAnnotator`, `getAnnotatorRuntimeScript`, `sanitizeRedlinePacket`, `formatRedlineMarkdown`, and `formatRedlineXml` with TypeScript definitions.

## 0.16.0

### Minor Changes

- 0683832: Add declarative timed state transitions (`data-kit-after="<ms>:<state>"` and `data-kit-after="<ms>:<group>:<state>"`) to the built-in behaviour layer so composed mockups can model click → loading → next state and reset flows with zero custom JavaScript.

## 0.15.1

### Patch Changes

- 87759c8: `kit compose` no longer fails with `RangeError: Maximum call stack size exceeded` on a kit whose CSS has an escaped quote in a selector (Tailwind's `[stroke=\'#ccc\']`) megabytes before the next quote. The CSS sanitizer is now one linear scan that reads strings, comments and escapes as the browser does, so the escaped quote no longer opens a string, and a `url()` after an apostrophe in a comment or after a string cut off by a newline is checked too. `@import` is still removed, a `url()` outside the allowlist still becomes `none`, and a string naming a remote URL still becomes `""`.

## 0.15.0

### Minor Changes

- 148dfe0: `@codepress/blog`: posts can carry an optional `hero` (an https or site-relative image URL) and `heroAlt` in their metadata, published in `_schema.json`; a post's share image is now `ogImage`, else `hero`, else the site default. `readingTime(html)` counts the sanitized body at 230 words a minute (rounded up, at least 1), and the HTTP content source returns it on each post and, from the backend's `reading_minutes`, on list summaries. `@codepress/blog/react` adds three opt-in pieces: `PostHero` (the post's hero as an eager, high-priority image in a fixed 2:1 box, or a `GeneratedCover`), `GeneratedCover` (an inline SVG drawn from the post's slug, title and tags, animated by `blog.css` and still under `prefers-reduced-motion`), and `ReadingProgress` (a 3 px bar pinned under the site header). Sites that do not render them, including `createAppBlog` and `createPagesBlog`, render exactly the markup they did before.

  `@codepress/design-kit`: a page in `pages.pages` may set its own `shellReady`, or `false` for a page drawn outside the app's frame, such as a public blog page.

## 0.14.0

### Minor Changes

- d721926: New `kit.mjs figure --page <composed.html> [--href] [--caption] [--alt] [--width] [--fit] [--height] --out <file>` turns a composed page into a plan-page figure in one step, with no screenshot and no browser. The fragment holds the page's own markup and CSS in a declarative shadow root (no iframe), so neither page's CSS reaches the other: `<html>`/`<body>` become `<cp-page-html class="cp-page-root">`/`<cp-page-body>` carrying their classes and `data-*` (the theme), `:root`/`html`/`body` selectors follow them at the same specificity, `@font-face` is hoisted outside the shadow root, `@property` initial values are applied inside it, viewport units and width/height `@media` queries resolve against the design box, and rules a static, inert figure can never use (hover/focus/active states, classes the markup lacks) are dropped. The page is laid out at `--width` (default: the frame width `compose` recorded, else 1280) by `--height` (default `width × 0.625`) and scaled to `--fit` pixels wide (default 640). Scripts, `<meta>`, `<link>`, frames and remote URLs are removed, with one stderr warning when scripts were dropped. `--page` and `--img` are mutually exclusive; `--img` is unchanged. `pageFigureHtml`, `pageSelector`, `mediaMatches`, `viewportToPixels` and `figureSelectorCanMatch` are exported from `@codepress/design-kit/kit`.

## 0.13.1

### Patch Changes

- 7cf6b99: `design-kit fetch --url` and the `codepress` store's requests now go through `HTTPS_PROXY`/`HTTP_PROXY` (lowercase names first) and honour `NO_PROXY`, so they work in a network sandbox that only lets traffic out through a proxy. https goes through a `CONNECT` tunnel with Basic proxy auth when the proxy URL has credentials. A proxy that refuses the tunnel fails with `kit_storage_unavailable: could not reach <host> through the proxy (<status>)`, never printing the proxy's credentials or the URL's query. With no proxy variables nothing changes.

## 0.13.0

### Minor Changes

- e019828: `design-kit fetch --url <download_url> --sha <commit>` installs a kit from a download URL with no key or config, into the same `$TMPDIR/design-kit-<sha>` cache (reused without downloading), checking the manifest's sha and renaming into place atomically. `fetch` now prints the kit's summary line after `path=`, `sha=` and `branch=`. New `kit.mjs figure --img <file> [--href] [--caption] [--alt] [--width] --out <file>` writes a self-contained `<figure>` with the image as a data URI; `kitSummaryLine` is exported from `@codepress/design-kit/kit`.

## 0.12.0

### Minor Changes

- a386bed: `kit find`, `show` and `info` print far less for the same information. `find` prints one line per frame with its widths grouped (`route:orchestrator@{1280,390}  131/136 KB  Orchestrator project`), drops the kind and width columns and any title that only restates the id; the tail still counts every row not shown. `show` collapses runs of identical siblings to one `×N` line and leaves generated ids out of the outline. `info` prints one line (`sha7 built <iso> · stories N · routes N · failed N`, with the failed ids when five or fewer); `info --json` prints the manifest as before. The find formatter is exported as `findMatchLines`.

## 0.11.0

### Minor Changes

- d118c2b: `kit compose` inlines only the CSS a page can use: style rules whose every selector needs a class or id the page lacks are dropped (inside `@media`, `@supports`, `@layer`, `@container` and `@scope` too), and a rule repeated in the same context is written once. A composed screen drops from megabytes to a few hundred KB with identical pixels. `--css full` (option `css: "full"`) keeps every rule.

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
