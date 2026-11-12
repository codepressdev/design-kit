# @codepress/design-kit

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
