# @codepress/design-kit

## 0.2.2

### Patch Changes

- 8ba8871: The README has a new section, "Set it up with your agent": a prompt to paste into Claude Code, Codex or Cursor, what the agent does, how to ask for Storybook when the repository has none, and how to ask for a mockup once the kit exists. The `setup-guide` example no longer pins version 0.1.3.

## 0.2.1

### Patch Changes

- 03dea05: A page's `path` may carry a query string, such as `/apps/my-app?tab=settings`. `capture pages` now compares only the pathname when it checks for a redirect, so the query no longer turns the page into a gap. A page that does redirect to another pathname is still recorded as a gap.
