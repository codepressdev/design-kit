# @codepress/design-kit

## 0.2.1

### Patch Changes

- 03dea05: A page's `path` may carry a query string, such as `/apps/my-app?tab=settings`. `capture pages` now compares only the pathname when it checks for a redirect, so the query no longer turns the page into a gap. A page that does redirect to another pathname is still recorded as a gap.
