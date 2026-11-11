#!/usr/bin/env bash
# Rebuilds ./build from this fixture in a scratch copy, so
# nothing is installed into the repository. Needs network for the install.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/design-kit-sb-fixture.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cp -R "$here/." "$work/"
cd "$work"
printf 'packages: []\nallowBuilds:\n  esbuild: true\n' > pnpm-workspace.yaml
pnpm install --silent
rm -rf "$here/build"
pnpm exec storybook build --quiet --disable-telemetry -o "$work/out"
# The capture reads index.json, iframe.html and what the preview loads; the
# manager UI is not needed.
mkdir -p "$here/build"
cd "$work/out"
cp -R index.json iframe.html assets fonts "$here/build/"
