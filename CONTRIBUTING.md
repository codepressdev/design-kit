# Contributing to @codepress/design-kit

Thanks for helping. Issues and pull requests are welcome here.

## How changes land

`@codepress/design-kit` is developed in CodePress's monorepo, and this
repository is a one-way mirror of it. Every change made upstream arrives here
as a commit of its own, with the upstream commit's subject and a
`Source-Commit:` trailer. Each version is tagged `v<version>` and has a GitHub
Release with its changelog. Nothing is merged on this repository directly, so
a sync never overwrites your work:

1. Open a pull request here as usual. CI runs the unit tests on Node 20 and 22.
2. A maintainer reviews it here. Once it is accepted, they port the change
   into the monorepo with you credited as co-author there.
3. The next sync brings the change here. The maintainer then closes your pull
   request with a link to the mirror commit that carries your change.

Bug reports and feature requests go in issues.

## Developing

```bash
npm install
npm test                         # unit tests (node --test)
npx playwright install chromium
npm run test:browser             # captures a Storybook build and a static app
npm run lint
npm run format:check
```

The package runs on Node 20 or later and has no runtime dependencies;
Playwright is an optional peer for the capture commands.

## License

By contributing you agree that your contribution is licensed under the MIT
License in [LICENSE](./LICENSE).
