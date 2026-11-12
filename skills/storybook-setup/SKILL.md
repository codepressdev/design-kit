---
name: storybook-setup
description: "Add Storybook to a repository, or extend the one it has, with a stories file for every existing component and a tokens story, as one reviewable pull request: survey the components and tokens, install a pinned Storybook that matches the repo's React, Next and TypeScript, fix the usual first-build failures, write stories for every variant and state, typecheck, build, and check the stories capture in a design kit. Use when asked to set up Storybook, add Storybook, add stories for our components, backfill missing stories, or build a component catalog."
---

# Set up Storybook with stories for your components

Your job is **one reviewable pull request** that gives this repository a
working Storybook with a stories file for every component it already has,
plus a tokens story, so people can browse the library and a design kit
(`@codepress/design-kit`) can capture it. You never merge it.

Run the steps in order. The survey comes first because the most common
failure is a Storybook that ignores what the repository already has: the wrong
folders, no styles, a second Storybook next to the first.

Supported first: **React with Vite or Next.js.** On another renderer (Vue,
Svelte, Angular, web components) you may still install Storybook and write
stories under the same rules, but say plainly in the pull request that this
guide has not been tried on that stack.

## 1. Survey the repository

A bounded read, so you extend what exists instead of competing with it:

- **Stack and versions.** Read `react`, `react-dom`, `next`, `typescript`,
  `vite` and the Node version (`engines`, `.nvmrc`, `.node-version`; when
  none is recorded, the version its CI workflows use) from `package.json` and
  the lockfile. In a monorepo, find the package that holds
  the components; Storybook goes there.
- **Package manager.** Use the one the repository uses: the `packageManager`
  field, or the lockfile (`pnpm-lock.yaml` pnpm, `yarn.lock` yarn,
  `bun.lock`/`bun.lockb` bun, `package-lock.json` npm). Never add a second
  lockfile.
- **The component library: every folder, not just `ui/`.** Components live in
  `components/`, `ui/`, `features/*/components/`, `app/**/_components/`,
  `src/shared/`, workspace packages and more. List every file that exports a
  component that renders something, and note the conventions: file naming,
  default or named exports, how props are typed.
- **The token layer.** CSS custom properties (`:root { --… }`), a Tailwind
  theme (`tailwind.config.*`, or `@theme` in CSS for Tailwind 4), a theme
  object for a CSS-in-JS `ThemeProvider`, or a design-tokens file.
- **The global stylesheet and providers.** What the app's entry imports
  (`main.tsx`, `app/layout.tsx`, `pages/_app.tsx`): global CSS, fonts, and
  providers components need to render (theme, router, i18n, data clients).
- **An existing Storybook.** `.storybook/`, `*.stories.*` files, `storybook`
  or `@storybook/*` dependencies, a `storybook` script. **If Storybook already
  exists, extend it: never run `storybook init` again** and never upgrade it
  in this pull request (one older than Storybook 7 cannot be captured into a
  design kit; say so). Match its story format exactly (CSF version, typing,
  decorators, titles), keep its stories, and add stories only where they are
  missing. A component with a stories file that lacks states gets those
  states added to that file, never a second file.
- **A design kit.** A `design-kit.config.json` means stories will be captured
  into a kit; step 6 checks they are.

Write the survey as one short paragraph (it goes in the pull request) before
you change anything.

## 2. Install Storybook (only when there is none)

**Pick the version.** Use **Storybook 9** (`storybook@9`): it is the newest
major that `design-kit capture stories` is checked against, and it supports
Next.js 14.1 through 16. Never use `storybook@latest`. Use **Storybook 8**
(`storybook@8`) instead when the app is below Storybook 9's floors: Node 20,
Vite 5, Next.js 14.1 or TypeScript 4.9. Check a framework's peer ranges with
`npm view @storybook/<framework>@9 peerDependencies`.

**Pick the builder deliberately, and record the choice for the pull request.**

- Vite app: `@storybook/react-vite`.
- Next.js app: `@storybook/nextjs` (webpack) is the default and handles
  `next/font`, `next/image`, `next/navigation` and the app's PostCSS and
  Tailwind setup. `@storybook/nextjs-vite` is faster and fits when the app
  has no custom `webpack()` in `next.config.*` that its components depend on
  (SVGR, raw loaders, aliases). When unsure, take `@storybook/nextjs`.

**Run init with the repository's package manager**, in the package that holds
the components:

```bash
pnpm dlx storybook@9 init --yes --no-dev --disable-telemetry --features docs
# npm: npx --yes storybook@9 init ...   yarn: yarn dlx storybook@9 init ...
# bun: bunx storybook@9 init ...
# add --type nextjs, or --builder vite, when init detects the wrong one
```

`--features docs` keeps init from adding its test-runner setup; step 3
removes docs (and the onboarding addon init adds anyway) unless the person
asked for docs pages. Ignore init's banner telling you to cancel and use
`@latest`: the pin is deliberate.

**Then check what init changed: `git diff package.json`.**

- Only Storybook packages may be added (`storybook`, `@storybook/*`, and
  `eslint-plugin-storybook` when the repository uses ESLint). All of
  them must be on the **same exact version**; write it without a `^` or `~`
  range.
- `react`, `react-dom`, `next`, `typescript`, `vite` and every other existing
  dependency must be unchanged. **Never downgrade or upgrade the app** to fit
  Storybook; choose the Storybook version that fits the app.
- A `storybook` and a `build-storybook` script are fine, and so are the
  `storybook-static` and `*storybook.log` lines init adds to `.gitignore`.

## 3. Configure it

Keep the configuration small and make it render the components as the app
does. When Storybook already existed, change its configuration only where the
stories need it to render and build (styles, providers, env placeholders,
loaders, `staticDirs`), and keep its addons as they are.

- **Addons.** Keep only what init added for the framework itself. Remove the
  onboarding addon (`@storybook/addon-onboarding`) and its package, and
  delete init's example stories folder (`stories/` or `src/stories/`, with
  its Button, Header and Page examples). Remove `@storybook/addon-docs` (from
  `addons` and `package.json`), any `tags: ["autodocs"]` and the `*.mdx`
  glob unless the person asked for docs pages. Add no other addons. Set
  `core: { disableTelemetry: true }` in `main.*` so builds stay quiet (for
  builds you run against an existing Storybook, set
  `STORYBOOK_DISABLE_TELEMETRY=1` instead).
- **Story globs.** Point `stories` in `.storybook/main.*` at the real
  component folders from the survey, for example
  `["../src/**/*.stories.@(ts|tsx)"]`, or one entry per folder or package.
- **Styles and tokens.** Import the global stylesheet or token layer in
  `.storybook/preview.*` (`import "../src/styles/globals.css";`). With
  Tailwind 3, make sure its `content` globs cover the stories files too. If
  the app sets fonts or a theme class in its layout, reproduce that with a
  decorator in `preview.*` (rename init's `preview.ts` to `preview.tsx` for
  JSX). Wrap stories in the providers components need, the same way the app
  does. **An unstyled Storybook is worse than none**: check one built story
  actually looks like the app.
- **Landing page.** Land the sidebar on a real story, not a docs page. The
  tokens story from step 4 works well: in `preview.*`, set
  `parameters.options.storySort` to `{ order: ["Foundations", "*"] }`.

**Fix the first build's failures yourself.** These four hit almost every
fresh Storybook; fix them rather than report them:

1. **Peer-dependency conflicts.** Put every Storybook package on one exact
   version, and pick the Storybook major whose peer ranges include the app's
   React, Next and TypeScript (step 2). If init's own install fails, re-run
   it with `--skip-install` and install with the repository's package manager.
   Drop an addon that conflicts rather than force it. Never use `--force`,
   and never change the app's versions. If a conflict is only in a transitive
   Storybook dependency, an `overrides` (npm), `resolutions` (yarn) or
   `pnpm.overrides` entry for that one package is acceptable; say so in the
   pull request.
2. **Modules that throw at import on a missing environment variable**, for
   example a config module that throws when `NEXT_PUBLIC_API_URL` or
   `VITE_API_URL` is unset. Give Storybook placeholder values. **Never edit
   the app's own validation.** Bundlers inline these variables at build time,
   so pass them through Storybook's `env` option in `.storybook/main.*`, which
   reaches `process.env` and `import.meta.env` in both the webpack and Vite
   builders. Setting `process.env` at the top of `main.*` does not: the
   webpack builder replaces `process.env` in the bundle.

   ```ts
   // Storybook only: placeholders so modules that validate env at import
   // time load. Never real values.
   env: (config = {}) => ({
     ...config,
     NEXT_PUBLIC_API_URL: config.NEXT_PUBLIC_API_URL ?? "https://api.example.invalid",
   }),
   ```

   Never commit a real key, and never copy the app's `.env` files.

3. **`next/font`, `next/image` and SVGR imports.** Keep a Next.js framework
   (`@storybook/nextjs` or `@storybook/nextjs-vite`), which handles
   `next/font` and `next/image`. Components that use `next/navigation` need
   `parameters: { nextjs: { appDirectory: true } }` in `preview.*`. A font
   the app's layout applies (`className={inter.variable}` on `<html>`) needs
   the same class in a `preview.*` decorator. With `next/font/google` the
   font files load from Google when a story is viewed, so a captured kit
   falls back to the system font; say so in the pull request
   (`next/font/local` fonts are served by Storybook and captured). Storybook
   does not run the app's custom `webpack()` from `next.config.*`, so an SVG
   imported as a component (`import Logo from "./logo.svg"`) needs the loader
   added in `webpackFinal`, the app's own `@svgr/webpack`:

   ```ts
   webpackFinal: async (config) => {
     const rules = config.module?.rules ?? [];
     for (const rule of rules)
       if (rule && typeof rule === "object" && rule.test instanceof RegExp && rule.test.test(".svg"))
         rule.exclude = /\.svg$/i;
     rules.push({ test: /\.svg$/i, use: ["@svgr/webpack"] });
     return config;
   },
   ```

   With a Vite builder, the app's `vite.config.*` plugins (such as
   `vite-plugin-svgr`) are merged in; add the plugin or alias in `viteFinal`
   only when the app configures it somewhere Storybook does not read.

4. **`public/` assets.** Images and fonts the components load by absolute
   path (`/logo.svg`) 404 until `.storybook/main.*` has
   `staticDirs: ["../public"]` (the path to the app's public folder).

## 4. Write the stories

**One stories file per component, next to the component**, named the way
the repository names files (`Button.tsx` and `Button.stories.tsx`). Use CSF 3
in the repository's typing style, for example:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite"; // or @storybook/nextjs, @storybook/nextjs-vite; @storybook/react on Storybook 8
import { Button } from "./Button";

const meta = {
  component: Button,
  args: { children: "Save" },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: "secondary" } };
```

Each file covers, where it applies:

- **the default**, and **every variant and every size** the props allow;
- **hover, focus and disabled** for anything interactive. Disabled is a prop.
  Focus is a `play` function that focuses the element
  (`play: async ({ canvasElement }) => canvasElement.querySelector("button")?.focus()`).
  Hover that the component drives itself (a tooltip, a menu) is a `play`
  function too. A pure CSS `:hover` cannot be shown without a pseudo-state
  addon, so say so in the coverage note instead of adding one;
- **empty, loading and error** states for anything that shows data or
  results;
- **long text or overflow** for anything that holds text: a long label, a
  long unbroken word or address, many items.

Name state stories so they do not shadow globals: `ErrorState` with
`name: "Error"`, never `export const Error`. A captured kit is static HTML, so
focus rings and other live states show in Storybook but not in the kit.

Use made-up fixture data (`example.com` addresses, invented names), never
real customer data. Write stories through the component's props; do not
refactor the app to make a state reachable. A state no prop can reach is
skipped for cause and listed.

**Add a tokens (foundations) story**, for example
`src/foundations/Tokens.stories.tsx` with the title `Foundations/Tokens`.
It renders the design language from the token layer the survey found: the
palette as labelled swatches (`background: var(--color-primary)`, or Tailwind
classes), the type scale (each size with its name), and the spacing ramp
(bars of each width). Radii and shadows can go in too. List the token names
from the token source, so a new token is one line.

**"Every component" means the whole catalog**: the shared primitives and
the composites and feature components (lists, panels, cards, headers,
forms). Skip a component **only for cause**: it cannot render apart from
live data (it fetches on its own and has no way to pass data in), it is
deprecated, or it is an internal detail of another component that is
already covered. Route files (`page.tsx`, `layout.tsx`) and the app root are
screens, not catalog components: give one a story when it renders from props
alone, and otherwise list it as skipped. List every skip, with its reason, in
the pull request. A large backfill may be split into several pull requests by
component family; say which family each covers and what is left. Silently
leaving components out is not allowed.

While you read the screens, note **inline UI that should become shared
components**: the same markup repeated across pages. Name each one under
"Recommended next" in the pull request. Do not extract it in this pull
request.

## 5. Typecheck, then build

1. **Typecheck first.** It is cheaper than a build, and it catches story type
   errors that `storybook build` lets through. Run the repository's own
   typecheck (`pnpm typecheck`, `pnpm exec tsc --noEmit`, `tsc -b`). Check
   that its `include` covers the stories files and `.storybook/`. TypeScript
   skips dot-folders in wildcards, so name the files: add
   `".storybook/*.ts", ".storybook/*.tsx"` to the `include` the typecheck
   uses. Fix every error.
2. **Build.** Run `storybook build` with the repository's package manager
   (`pnpm exec storybook build --quiet`, `npx storybook build --quiet`). Fix
   every error and warning that points at a story or the config. Then check
   `storybook-static/index.json`: its story entries should match what you
   wrote, and none of init's examples should be left.
3. Run the repository's lint and its other pull request checks that the
   change touches (ESLint on the stories, a format check), and fix what this
   change broke.

## 6. Check the design kit captures it

`design-kit capture stories` renders every story in a headless browser, so it
also proves each story renders without throwing. Write the kit to a scratch
folder **outside the repository**, never into it.

- **With a `design-kit.config.json`:** give it a `stories` section if it has
  none:

  ```json
  "stories": {
    "root": ".",
    "buildCommand": "pnpm exec storybook build --quiet -o storybook-static",
    "staticDir": "storybook-static",
    "gaps": { "componentGlob": "src/**/[A-Z]*.{tsx,jsx}" }
  }
  ```

  (`root` is the folder holding `.storybook/`, relative to the config; use
  the repository's package manager in `buildCommand`.) If the repository's
  `.github/workflows/design-kit.yml` and `.claude/skills/design-kit/SKILL.md`
  were written before Storybook existed, they skip stories too. To update
  them, copy the repository (without `node_modules`) to a scratch folder,
  run `npx --yes @codepress/design-kit init --force` there, and port only
  the Storybook parts of those two files back: the "Build Storybook and
  capture stories" step and the stories capture line. Then run, from the
  folder that holds `design-kit.config.json`:

  ```bash
  npx --yes @codepress/design-kit capture stories --out "$TMPDIR/design-kit-check"
  ```

- **Without one:** check anyway with a scratch config outside the repository:

  ```bash
  cat > "$TMPDIR/design-kit-check.json" <<EOF
  {"version": 1, "stories": {"root": "$PWD", "storybookDir": "$PWD/storybook-static",
   "gaps": {"componentGlob": "src/**/[A-Z]*.{tsx,jsx}"}}}
  EOF
  npx --yes @codepress/design-kit capture stories --config "$TMPDIR/design-kit-check.json" --out "$TMPDIR/design-kit-check"
  ```

  Capture needs Playwright and Chromium. When the repository has neither,
  run `npx --yes -p @playwright/test playwright install chromium`, then
  `npx --yes -p @codepress/design-kit -p @playwright/test design-kit capture stories ...`;
  install nothing into the repository for it.

Capture what you just built: the `buildCommand` rebuilds Storybook, and with
a `storybookDir` rebuild first, because a stale build hides missing stories.
Read what it printed (`stories N, ... failed M`) and
`$TMPDIR/design-kit-check/gaps.json`:

- a **failed story** (it threw, or never rendered) is a bug in the story or
  the config: fix it and capture again;
- a **`no story`** row names a component file with no stories file: write
  one, or make sure it is in your skip list with its reason. Its path is
  relative to the config file's folder.

Aim for zero failures and every `no story` row explained. The files in
`html/` are bare markup without CSS; to look at one story styled, find its id
and compose it into a page, then open that page in a browser:

```bash
KIT="$TMPDIR/design-kit-check"
node "$KIT/kit.mjs" --kit "$KIT" find <component name>   # ids like story:<storybook-id>@1280
node "$KIT/kit.mjs" --kit "$KIT" compose --frame <id> --out "$TMPDIR/story.html"
```

Check it looks like the app, and take a screenshot for the pull request.

## 7. Open the pull request

One pull request; never merge it. When the survey and the checks found
nothing missing (Storybook builds, every component has its stories, the
capture has no failures and no unexplained `no story` rows), open no pull
request: report that proof instead. Otherwise the description says:

- **The survey**: where the components and tokens live, and whether
  Storybook existed (extended, not re-initialised).
- **Versions and builder**: the Storybook version and why (9, or 8 because of
  which floor), the framework package and why, and that React, Next and
  TypeScript are unchanged.
- **First-build fixes**: each one you made (env placeholders, loaders,
  `staticDirs`, overrides) and why.
- **Coverage**: the components covered, counted per folder ("14 of 15 in
  `src/components`"), with the states each covers, and the tokens story.
- **Skipped**: every component or state left out, each with its reason.
- **Proof**: the typecheck and `storybook build` results, the capture's
  story count, failures and `gaps.json` rows, and the screenshot.
- **Recommended next**: inline UI that should become shared components, and,
  when the repository has no design kit yet, that
  `npx --yes @codepress/design-kit setup-guide` sets one up.
- **Not tried**: anything this guide does not cover on this stack, said
  plainly.

Never commit `storybook-static/`, a captured kit, or a real secret.

## Keeping stories current

After this pull request, when you add a component or change what one
renders, add or update its story in the same pull request, covering the
states in step 4, so the next design kit captures it. Say in the pull request
which stories you added or changed.
