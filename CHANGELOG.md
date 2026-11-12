# @codepress/design-kit

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
