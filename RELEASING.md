# Releasing

This package publishes from `main` through GitHub Actions.

## Branch Strategy

- `dev` is the integration branch.
- feature work should branch from `dev` and merge back into `dev`.
- `main` is the release branch.
- releases happen only when `dev` is merged into `main`.

Workflow placement:

- [`.github/workflows/pr-quality.yml`](./.github/workflows/pr-quality.yml) should exist on both `dev` and `main`
- [`.github/workflows/release.yml`](./.github/workflows/release.yml) must exist on `main`
- this release guide should also exist on `main`

## One-Time Setup

Configure these GitHub repository secrets:

- `NPM_TOKEN`: npm automation token with publish access to `@openbox-ai`

The release workflow uses:

- `GITHUB_TOKEN` to create the GitHub release and tag
- `id-token: write` to publish npm provenance

## Release Flow

1. Create a release PR from `dev` to `main`.
2. In that PR, update `version` in [package.json](./package.json).
3. Merge the PR into `main`.
3. GitHub Actions will:
   - install dependencies
   - run lint, typecheck, tests, and build
   - verify the package tarball with `npm pack --dry-run`
   - publish to npm only if the `package.json` version changed in that push
   - skip publish if that version is already on npm
   - create a GitHub release tagged `v<version>`

The workflow does nothing for ordinary pushes to `main` that do not change `package.json` version.

## Manual Recovery

The release workflow also supports manual dispatch from the GitHub Actions UI.

Use that when:

- the first `dev` -> `main` release failed before publish
- npm publish succeeded but the GitHub release was not created
- you need to retry the release logic without forcing another merge

The manual run still checks npm first, so it will not republish a version that already exists.

## What To Push Where

Normal development:

- push feature code, docs, and tests to a feature branch based on `dev`
- merge that branch into `dev`

Release infrastructure:

- keep [`.github/workflows/pr-quality.yml`](./.github/workflows/pr-quality.yml) in `dev` and `main`
- keep [`.github/workflows/release.yml`](./.github/workflows/release.yml) in `dev` so it is reviewed there, but it must be merged into `main` before automated releases can work
- keep [RELEASING.md](./RELEASING.md) in `dev` and `main`

Actual release:

- bump [package.json](./package.json) version on `dev` in the release PR or release commit
- merge `dev` into `main`
- do not bump version for normal `dev` merges unless that merge is intended to release

## Local Verification

```bash
npm ci
npm run ci:check
npm run pack:check
```