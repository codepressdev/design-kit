---
name: design-kit-setup
description: "Set a design kit up in a repository that has none, as one reviewable pull request: run `npx @codepress/design-kit init`, fill in the pages it captures, decide with the person whether to add Storybook stories or capture real pages, wire sign-in through repository secrets, build the kit once locally, and report what it captured. Use when asked to set up a design kit, add design-kit to a repository, or make mockups use the app's real components."
---

# Set up a design kit

A design kit is the app's real markup for mockups: every Storybook story and
the app's main pages, captured as static HTML with their CSS and fonts by
`@codepress/design-kit`. Agents compose mockups from it, so the frame and the
existing components are real and only the new parts are drawn by hand.

Your job is **one reviewable pull request** that sets a kit up: a config, a
daily GitHub Actions build that uploads the kit, and a `design-kit` skill (plus
one line in `AGENTS.md` or `CLAUDE.md`) so the repository's agents use it. You
never merge it.

## 1. Run `init`

From the repository root (or with `--root <subpackage>` when the app lives in
one package of a monorepo):

```bash
npx --yes @codepress/design-kit init --dry-run   # what it found and would write
npx --yes @codepress/design-kit init
```

It detects Storybook and its version, the framework, the package manager, the
dev script, Playwright and the dark-theme mechanism, then writes:

- `design-kit.config.json`: the `watch` list (the UI folders, the workspace
  packages the app uses, the lockfile and the workflow), the stories (when
  Storybook is found), a `pages` skeleton with `TODO` selectors, and the
  theme;
- `.github/workflows/design-kit.yml`: a daily check (and manual dispatch) that
  builds only when a `watch` path changed since the last kit or that kit is 75
  days old, uploads the `design-kit` artifact for 90 days and deletes the
  older ones. Check the `watch` list covers every folder the UI renders from;
- `.claude/skills/design-kit/SKILL.md` and `.agents/skills/design-kit`: how
  agents fetch the kit, compose mockups and caption them;
- one line in `AGENTS.md` (or `CLAUDE.md`) pointing at that skill.

It never overwrites a file: a repository that already has
`design-kit.config.json` exits 1 with "already set up". Stop there and tell the
person a kit is already configured; replace it with `--force` only when they ask.

Read the summary it prints. Its **Still to decide** list is your checklist for
the rest of this skill.

## 2. Storybook or pages: the judgment calls

**Storybook present.** Keep the `stories` section `init` wrote and capture
every story. Then add pages when the app has a dev server that can be reached
locally (step 3); a kit with pages has frames that new content can go into.

**No Storybook.** Propose one of these to the person, through the Orchestrator
when you work for one, in a short message with your recommendation:

- (a) **add Storybook** with stories for the components, covering their
  default, empty, loading, error and long-content states: follow
  `npx --yes @codepress/design-kit storybook-guide`, which installs a pinned
  Storybook, writes a stories file next to each component, and adds the
  `stories` section to the config `init` wrote;
- (b) **capture real pages** from the dev server (step 3);
- (c) **both**.

When nobody answers, do (b), plus (a) for components that are clearly reusable
(buttons, inputs, cards, dialogs, tables that several screens share). Say in the
pull request which you did and why.

**Supported first:** Storybook 7, 8 and 9 static builds of any renderer, page
capture of any URL, and new stories for React only. For another stack (Vue,
Svelte, Angular, an older Storybook), capture pages and say honestly in the
pull request that new stories were not written, and why.

## 3. Fill in the pages

Replace the `TODO`s in `pages`:

- `startCommand` and `waitUrl`: the command that serves the app and a URL that
  answers once it is up. `init` guessed them from the dev script, a Playwright
  `baseURL` or the framework's default port; check them.
- `pages[]`: the app's main screens, usually three to eight (home or
  dashboard, a list, a detail, settings). For each, `name` (lowercase, the
  kit's `route:<name>` id), `path`, `ready` (a selector that shows once the
  page has its real content, not a spinner) and `slots.main` (the selector of
  the main content region that mockups replace, such as `main`). Add other
  slots, such as `list` for a side list, where a screen has them.
- `shellReady`: a selector the app's frame shows before any page content,
  when it has one.
- `forbidStrings`: values that must never reach the kit, such as a test
  account's token or real customer data the pages might render. A page whose
  markup carries one fails the whole capture, and nothing is uploaded.

The workflow skips page capture while any `TODO` is left.

## 4. Signing in

When the pages need a signed-in user:

- Use a **seeded test user** or the app's **mock mode** (a mock API, fixture
  data, a demo flag), never a real person's account.
- Sign in with a Playwright `storageState`, produced in CI: write a small
  module named in `pages.auth.setup` whose default export signs in
  (`async ({ browser, baseUrl }) => state`) with credentials it reads from the
  environment. The workflow passes `DESIGN_KIT_USERNAME` and
  `DESIGN_KIT_PASSWORD` from repository secrets to the page capture.
- **Never commit a credential**, a token or a saved storage state. Say in the
  pull request exactly which secrets the person must add (Settings → Secrets
  and variables → Actions) and what they are for.

## 5. Build once locally

Before opening the pull request, build the kit once with the commands in the
new `.claude/skills/design-kit/SKILL.md` ("When there is no kit"), into a
scratch folder outside the repository, and check it:

```bash
node "$KIT/kit.mjs" info                 # counts: stories, pages, failures
cat "$KIT/gaps.json"                     # what failed, and why
node "$KIT/kit.mjs" compose --frame route:<page>@1280 --out "$TMPDIR/frame.html"
```

Open one composed frame in a browser and take a screenshot. Fix what you can
(a wrong `ready` selector, a page that needs data) and run it again. Never
commit the kit itself.

## 6. Open the pull request

The description says:

- what `init` found (Storybook and version, framework, package manager);
- what the kit captured: the number of stories and pages, and every gap with
  its reason;
- the screenshot of one composed frame;
- the secrets to add, if any, and the choice made in step 2;
- anything unsupported on this stack, said plainly.

After it merges, the workflow's first scheduled or manual run uploads the
kit, and the repository's agents start composing mockups from it.
