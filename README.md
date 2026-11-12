# @codepress/design-kit

> **This repository is a mirror.** `@codepress/design-kit` is developed in
> CodePress's monorepo and synced here, one commit per change. Issues and pull
> requests are welcome: a maintainer lands an accepted pull request upstream,
> and the next sync brings it here. See [CONTRIBUTING.md](./CONTRIBUTING.md).

Your app's real markup for mockups. `design-kit` renders every Storybook story
and the pages of your running app to static HTML, with the CSS and fonts they
loaded. The result is a design kit: a folder of snippets and a small,
dependency-free tool that finds them and composes self-contained pages from
them. A mockup built from a kit uses the app's own frame and components, so
you draw only what is new.

```bash
npm install --save-dev @codepress/design-kit @playwright/test
npx playwright install chromium
npx design-kit capture stories      # every story → ./design-kit (or "out")
npx design-kit capture pages        # the configured pages of the running app
node design-kit/kit.mjs find button # the kit's own tool, no install needed
```

It runs on Node 20 or later. Playwright is a peer dependency, so the capture
drives the Playwright and Chromium your project already has. The `kit`
commands need neither.

## Set it up with your agent

The quickest way in is to let your coding agent do the whole setup. Paste this
into Claude Code, Codex, Cursor or any agent that can run commands in your
repository:

```text
Set up a design kit in this repository. Run
`npx --yes @codepress/design-kit setup-guide` and follow what it prints.
Open one pull request and don't merge it.
```

`setup-guide` prints the setup skill that ships in this package, so the agent
needs nothing installed beforehand. Following it, the agent:

1. Runs `init`, which detects your stack and writes the config, the daily
   workflow and the agent skill (see [Set up in your repository](#set-up-in-your-repository)).
2. Fills in the pages to capture: the command that starts your app, and three
   to eight main screens, each with a selector that shows when it has loaded.
3. Decides between Storybook stories and real pages. With Storybook, it
   captures every story. Without it, it asks you whether to add Storybook,
   capture your real pages, or both. When nobody answers, it captures pages and
   writes stories for the components several screens share.
4. Wires sign-in, when your pages need one, through a seeded test user and the
   repository secrets `DESIGN_KIT_USERNAME` and `DESIGN_KIT_PASSWORD`. It never
   writes a credential; the pull request says which secrets to add.
5. Builds the kit once, checks what it captured, and opens the pull request
   with the counts, any gaps and a screenshot of one composed screen.

No Storybook yet and you want one? Ask for it on its own, before or after the
kit:

```text
Set up Storybook in this repository, with stories for our components. Run
`npx --yes @codepress/design-kit storybook-guide` and follow what it prints.
Open one pull request and don't merge it.
```

`storybook-guide` prints a second skill. The agent installs Storybook 9 (8 for
older apps) without changing your React, Next.js or TypeScript versions,
writes a stories file next to each component covering every variant and the
empty, loading, error and long-text states, adds a tokens story, and lists
anything it skipped, with the reason. React with Vite or Next.js is supported
first; on another stack the agent says plainly what it did not try.

Once the pull request merges, the daily workflow uploads the kit, and the
`design-kit` skill it installed tells your agents to use it. Ask for a mockup
the way you would ask a designer:

```text
Mock up a Billing tab on our settings page, using the design kit.
```

The agent fetches the newest kit, composes the screen from your real frame and
components, and draws only what is new.

## Keeping the kit in sync

Nothing needs re-running after setup.

- **It rebuilds itself, only when the UI changed.** The workflow `init`
  wrote (`.github/workflows/design-kit.yml`) checks every day, and on demand
  from "Run workflow" in the Actions tab or with
  `gh workflow run design-kit.yml`. It builds only when a path in the
  config's `watch` list changed since the newest kit's commit, and at least
  every 75 days (`DESIGN_KIT_MAX_AGE_DAYS` in the workflow) so the kit never
  expires. Any other day it stops after a few seconds, and the run's summary
  says why it built or skipped. "Run workflow" with `force` builds anyway.
- **Kits are kept 90 days, and older ones deleted.** 90 days is the most a
  public repository allows; a private one may raise `retention-days` in the
  workflow to 400 (raise `DESIGN_KIT_MAX_AGE_DAYS` with it). After each
  upload the workflow deletes the branch's older kits, so only the newest is
  stored. A failed delete is a warning, never a failed run.
- **It captures what exists at that commit.** Every build captures the
  stories and pages that exist at the commit it runs on. It never writes
  stories, so a new component shows up in the kit once it has a story. With
  `gaps.componentGlob` set, every component without one is listed in the
  kit's `gaps.json`. The `design-kit` skill and `storybook-guide` ask agents
  to add or update a component's story in the same pull request as the
  component.
- **Agents always use the newest kit.** The installed `design-kit` skill
  fetches the newest kit each time. When UI commits have landed since that
  kit was built, the mockup's caption says so.
- **Re-run `init` only to start over** (`--force`). To pick up a new release
  of this package, update the pinned version in the workflow
  (`DESIGN_KIT_PACKAGE`); the "Run workflow" form's `package` input tries
  another version for one run (and always builds).

### What makes it rebuild: `watch`

`watch` in `design-kit.config.json` lists the folders and files, relative to
the repository root, whose change rebuilds the kit. `init` writes:

- the Storybook folder and the app's folder (when either is the repository
  root, its UI folders such as `src`, `app` and `.storybook` and files such
  as `package.json` and `tailwind.config.ts`, since watching the whole root
  would rebuild on every commit);
- the workspace packages they depend on, directly or through each other,
  since shared UI usually lives there in a monorepo;
- global styles and tokens at the root (`styles`, `tokens`, `theme`, a
  Tailwind or PostCSS config);
- `design-kit.config.json` itself, the lockfile and the workflow.

A pages-only repository (no Storybook) gets the app's folder and its
workspace dependencies. Edit the list freely: add a folder the UI reads from
(fixtures, a shared assets package), or drop one that changes often without
changing what renders. Paths only, no globs. Without `watch`, any commit
rebuilds. The installed `design-kit` skill reads the same list when it counts
the UI commits since a kit, so its caption matches what triggers a rebuild.

### Updating a setup made by an older version

An older workflow keeps working as it is. To switch to the one above, run:

```bash
npx @codepress/design-kit@latest init --workflow-only --force
```

It rewrites only `.github/workflows/design-kit.yml`, at the new pinned
version, and leaves the config, the skill and `AGENTS.md` alone. When the
config has no `watch` list, it prints the one `init` would write; paste it
into `design-kit.config.json`, or the kit rebuilds after any commit. If you
edited the old workflow, copy the new `check` and `cleanup` jobs, the `id:
upload` and `retention-days: 90` on the upload step, the build job's
`artifact-id` output and `DESIGN_KIT_MAX_AGE_DAYS` into it instead. To
refresh the skill as well, run `init --force`, which rewrites the config too.

## Set up in your repository

`design-kit init` sets a kit up as one reviewable change. Run it in the
repository's root, or in a monorepo with `--root <package>` (the config goes
there; the workflow, skill and instructions line go at the repository root):

```bash
npx @codepress/design-kit init --dry-run   # what it found and would write
npx @codepress/design-kit init
```

It looks for Storybook (a `storybook` or `@storybook/*` dependency, or a
`.storybook` folder, in the project or its workspace packages) and its
version, the framework (Next.js, Vite, Remix, Create React App, Astro or
other), the package manager and lockfile, the dev or start script and the
app's local URL, an existing Playwright, and whether the app switches to dark
with a class or a `data-theme` attribute. Then it writes:

- `design-kit.config.json`: the `watch` list, the `stories` section when
  Storybook is found, a `pages` section with `TODO` selectors to fill in, and
  the `theme`.
- `.github/workflows/design-kit.yml`: a daily check (and `workflow_dispatch`)
  on `ubuntu-latest`. A `check` job runs `design-kit ci-check`, which skips
  when no `watch` path changed since the newest `design-kit` artifact's
  commit and that kit is under 75 days old; otherwise the build installs
  dependencies, this package at a pinned version and Chromium, builds
  Storybook and captures the stories, captures the pages once no `TODO` is
  left in the config, and uploads the `design-kit` artifact for 90 days. A
  `cleanup` job, the only one allowed to delete artifacts, then runs
  `design-kit ci-cleanup` to delete the branch's older kits. A run with nothing to
  capture yet (no stories, pages still `TODO`) ends with a warning and
  uploads nothing. The page capture gets
  `DESIGN_KIT_USERNAME` and `DESIGN_KIT_PASSWORD` from repository secrets for
  a sign-in module (`pages.auth.setup`).
- `.claude/skills/design-kit/SKILL.md`: how agents fetch the newest kit,
  compose mockups from it and caption them, and `.agents/skills/design-kit` as
  a symlink to it (a copy when the repository keeps real folders there).
- One line in `AGENTS.md`, or `CLAUDE.md` when only that exists (a new
  `AGENTS.md` when neither does), pointing at the skill.

It prints what it found and what is still to decide: the page selectors, the
start command, sign-in, a missing Storybook. It never overwrites an existing
file without `--force` (a repository with a `design-kit.config.json` exits 1,
"already set up") and never writes a secret.

## Configuration

The commands read `design-kit.config.json` from the working directory or the
nearest folder above it; `--config <file>` names another. Paths are relative
to the config's folder. The shipped JSON schema
([`schema/design-kit.config.schema.json`](./schema/design-kit.config.schema.json),
also `@codepress/design-kit/schema.json`) documents every field, and
`design-kit validate` checks a config against it. A config error, such as an
unknown key or a page without `slots.main`, names the field and exits 2.

```json
{
  "$schema": "./node_modules/@codepress/design-kit/schema/design-kit.config.schema.json",
  "version": 1,
  "out": "design-kit",
  "theme": { "attribute": "data-theme", "dark": "dark", "light": "light" },
  "stories": {
    "root": ".",
    "buildCommand": "npx storybook build --quiet -o storybook-static",
    "staticDir": "storybook-static",
    "widths": [{ "titles": "^(Pages|Layout)/", "width": 390, "height": 844 }],
    "gaps": { "componentGlob": "src/components/**/[A-Z]*.tsx" }
  },
  "pages": {
    "startCommand": "npm run preview -- --port 4173",
    "waitUrl": "http://localhost:4173/",
    "auth": { "storageState": "e2e/.auth/user.json" },
    "shellReady": "#app-header",
    "forbidStrings": ["the test account's API token"],
    "pages": [
      {
        "name": "dashboard",
        "title": "Dashboard",
        "path": "/dashboard",
        "ready": "[data-testid=dashboard-chart]",
        "sourceFile": "src/routes/dashboard.tsx",
        "slots": { "main": ["main"], "list": ["aside nav"] }
      }
    ]
  }
}
```

### `theme`

How the app switches to dark: a class (`"attribute": "class"`, the default,
`dark` on `<html>` and `<body>`) or an attribute such as `data-theme` on
`<html>`. Leave `light` out when light is simply the dark value's absence. The
captures record the theme in the kit's manifest, so `kit compose --theme dark`
needs no config.

### `stories`

Captures every story of a Storybook 7, 8 or 9 static build (any renderer). The
build comes from `--storybook-dir`, `storybookDir`, or `buildCommand`, which
writes `staticDir`; without `staticDir`, `{out}` in the command names a
temporary folder that is removed afterwards.

- `viewport`: each story's first capture, unless the story sets
  `parameters.viewport.defaultViewport` (default 1280×800).
- `widths`: more captures for stories whose title matches the `titles`
  regular expression.
- `fonts`: `{dir, faces: [{family, file, weight?, style?, variable?,
fallback?}]}` gives every story these faces (`file` is a name glob in `dir`;
  `variable` sets a CSS variable on `:root` for apps that read their font from
  one). Without it, the @font-face files the build itself serves are copied
  into the kit.
- `fixedTime`: the instant `Date` returns (default `2026-01-01T12:00:00.000Z`).
- `gaps`: lists the component files no story covers in `gaps.json`.
  `componentGlob` is relative to `root`; stories, tests and specs never count.

### `pages`

Captures real pages of the running app at `baseUrl`, or starts it with
`startCommand` (stopped afterwards) once `waitUrl` answers. Each page gets a
fresh browser context, signed in from `auth.storageState` (a Playwright
storage state file) or from the state the `auth.setup` module's default
export returns (`async ({ browser, baseUrl, config }) => state`).

- `pages[]`: `{name, title?, path, ready, sourceFile?, slots, layoutSlots?}`.
  `ready` is a Playwright selector that shows once the page has its content.
  `slots` names the regions a mockup replaces: the first selector that matches
  a visible, non-empty element gets `data-kit-slot="<name>"`, and `main` is
  required. A page without a `main` slot is a gap, not a frame.
- `widths`: the sizes every page is captured at (default 1280×800 and 390×844).
- `shellReady`: a selector the app's frame shows before any page content.
- `layout`: `{selector, attribute, default?}` reads the layout the app chose,
  for apps that render a different frame at phone width; `layoutSlots[<that
value>]` then replaces `slots`.
- `forbidStrings`: values that must never reach the kit, such as a test
  account's token. When any page's output contains one, as written, escaped
  for HTML or JSON, or (for a token) any long segment of it, the capture
  fails (exit 1) and writes no page, so a CI job uploads nothing.
- `fontsPath`, `copyFonts`: the fonts the pages load are copied into the
  kit's `fonts/` folder (`copyFonts: false` keeps them out); `fontsPath` says
  which URL path holds them when not every font file is one.
- `hooks`: a module exporting `context(context, info)` (may return a cleanup)
  and `page(page, info)` (may return `{readyFailed, beforeSerialize}`), for
  routing mock data or adding checks.
- `timeoutMs`, `startTimeoutMs`, `fixedTime`.

## Commands

```bash
design-kit init            [--root dir] [--dry-run] [--force] [--workflow-only]
design-kit capture stories [--config f] [--out dir] [--storybook-dir dir]
                           [--only id,... | --only-file f] [--base previous-kit]
design-kit capture pages   [--config f] [--out dir] [--base-url url] [--only name,...]
                           [--ready name=selector] [--screenshots dir] [--timeout ms]
design-kit kit info|find|show|compose ...   [--kit dir]
design-kit validate        [--config f]
design-kit ci-check        [--config f] [--since sha --kit-created iso | --no-kit]
                           [--force] [--package spec] [--max-age-days n]
design-kit ci-cleanup      --keep artifact-id
design-kit setup-guide
design-kit storybook-guide
```

`ci-check` and `ci-cleanup` are the workflow's steps. `ci-check` finds the
newest unexpired `design-kit` artifact on the branch (through `gh`, from
`GITHUB_REPOSITORY` and `GITHUB_REF_NAME`, or `--repo` and `--branch`), or
takes it from `--since` and `--kit-created`. It fetches that commit (shallow,
no file contents) and compares the git tree or blob id of each `watch` path
there and at `HEAD`; a missing path is a value of its own, so a deleted path
counts as changed. It prints `build=true` or `build=false` and the reason
(`changed: src`, `watched files unchanged since 3f2a9c1`, `refresh before
expiry: …`, `no kit yet on this branch`, `forced …`, `an explicit package was
given …`) and writes them to `$GITHUB_OUTPUT` and the step summary. A kit
that cannot be looked up or fetched builds. `ci-cleanup` deletes the
branch's kits older than `--keep` and warns about any it could not delete;
both always exit 0 unless the config is invalid.

`setup-guide` prints the agent skill for setting a kit up in a repository
that has none, as one reviewable pull request: run `init`, decide between
Storybook stories and page capture, wire sign-in through repository secrets,
build the kit once and report what it captured. An agent without the skill
installed can run `npx --yes @codepress/design-kit setup-guide` and
follow what it prints.

`storybook-guide` prints the agent skill for a repository with no Storybook,
or one with components that have no stories, as one reviewable pull request.
The agent surveys the components and tokens, installs Storybook 9 (8 for
older apps) pinned to the repository's React, Next.js and TypeScript, and fixes
the usual first-build failures: peer-dependency conflicts, modules that throw
on a missing environment variable, `next/font`, `next/image` and SVG imports,
and `public/` assets. It writes one stories file per component, covering
every variant and the empty, loading, error and long-text states, adds a
tokens story, and lists anything it skipped, with the reason. It typechecks,
builds Storybook and checks that `capture stories` captures it. An existing
Storybook is extended, never re-initialised. React with Vite or Next.js is
supported first. Run `npx --yes @codepress/design-kit storybook-guide`.

`--only` re-captures just those stories (Storybook ids, with or without the
`story:` prefix and width) and copies every other row from `--base`, byte for
byte. The two captures share one kit folder and keep each other's files: run
both with the same `--out`.

Exit codes: 0 done, 1 a capture could not run (no Storybook build, the app
did not start, a forbidden string) or `init` found the repository already set
up, 2 a config or usage error. A story or page that fails is a
`gaps.json` row and does not fail the run.

Operational knobs: `DESIGN_KIT_CONCURRENCY` (browser pages at once, default
4), `DESIGN_KIT_STORY_TIMEOUT_MS` (render and, separately, settle budget per
story, default 15000), `DESIGN_KIT_QUIET_MS` (how long the DOM must stay
unchanged, default 600), `DESIGN_KIT_TIMINGS_FILE` (per-phase capture times),
`DESIGN_KIT_STOP_TIMEOUT_MS` (how long stopping the app may take).

## Capture rules

- Time is frozen at `fixedTime`, the time zone is UTC, the locale en-US,
  `Math.random` and `crypto` random values are seeded, and animations,
  transitions and the caret are off.
- A story is captured after Storybook's `storyRendered` event (its `play`
  function has finished), fonts, frame and image loads, no request in flight,
  and six frames plus `DESIGN_KIT_QUIET_MS` with no DOM change. A story that
  throws, never renders or never stops changing is a gap.
- Attributes are serialized in sorted order, and React `useId` values are
  renumbered in pages, so the markup depends on the final state, not on timing.
- Story captures only reach the local Storybook server. Same-origin images
  become data URIs, canvases become images, iframes lose their documents, and
  form state is written into attributes.

## The kit (`kit_version: 1`)

```
design-kit/
  manifest.json   {kit_version, sha, built_at, counts, sources, theme?, css?}
  index.json      story rows, sorted by id
  routes.json     page rows
  html/story--<id>@<w>.html, html/route--<name>@<w>.html
  css/stories.css every rule the Storybook preview loaded, deduplicated
  css/routes.css  every rule the captured pages loaded, deduplicated
  fonts/          the fonts both use
  gaps.json       [{id|component|route, reason, detail?}]
  kit.mjs         the tool, copied into every kit so tool and data match
```

A row is `{id, kind: "story"|"route", title, component?, file, width, height,
bytes, slots?, source_file?, body_class?, html_attrs?, body_attrs?}`. Ids are
`story:<storybook-id>@<width>` and `route:<name>@<width>`; file names use `--`
instead of `:`, so the kit uploads as a CI artifact as it is. Always find a
row's markup through its `file`. `manifest.css` may name another stylesheet
per source (`{stories, routes}`).

## `kit.mjs`

The tool needs only Node: no install and no network.

```bash
node kit.mjs info                    # the manifest
node kit.mjs find button             # ≤ 30 lines: id, kind, width, bytes, title
node kit.mjs show <id> [--full]      # path, size and an outline (≤ 2 KB) or the markup
node kit.mjs compose --frame route:dashboard@1280 --slot main=new.html \
  [--theme light|dark] [--show-new] --out page.html
```

`compose` writes one self-contained page: the frame's markup with slots
filled and every `<kit-snippet id="…">` expanded, its CSS inlined, every
relative `url()` that names a file in the kit (fonts included) as a data URI,
and `data-kit-sha`/`data-kit-id` on `<html>`. Scripts, event handlers,
`<link>`s and SVG animation are removed, and URLs pass an allowlist: only
relative references, fragments and `data:` survive, read the way the browser
reads them. `--theme dark` applies the manifest's theme. Elements marked
`data-kit-new` get a visible outline with `--show-new`. An unknown frame, slot
or snippet id exits 2, naming near matches. `--kit <dir>` (or
`DESIGN_KIT_DIR`) points at a kit other than the tool's own folder.

## Programmatic use

```js
import {
  capturePages,
  captureStories,
  loadConfig,
} from "@codepress/design-kit";

const config = loadConfig("design-kit.config.json");
await captureStories(config, { out: "design-kit" });
await capturePages(config, {
  out: "design-kit",
  baseUrl: "http://localhost:4173",
  storageState: await signIn(),
  hooks: { context: (context) => context.route("**/api/**", mockApi) },
});
```

`capturePages` also takes `forbidStrings` and `stripOrigins` (more origins to
remove from markup, such as a mock API's) and a `session` object whose
`interrupted` flag stops it between pages.

## Contributing and license

The source is on GitHub at
[quantfive/design-kit](https://github.com/quantfive/design-kit), where issues
and pull requests are welcome; see its `CONTRIBUTING.md`. MIT licensed: see
[`LICENSE`](./LICENSE).
