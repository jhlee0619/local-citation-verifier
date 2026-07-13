# Task 11 release gate evidence

Date: 2026-07-13

## Result

The local release gate passes. No GitHub Pages setting was changed and no public deployment or rollback was dispatched.

The repository currently uses legacy `main:/docs` Pages publishing. The new deploy preflight requires the Pages API to report `build_type: workflow`, so a release fails closed until an authorized operator changes the Pages source to GitHub Actions and disables legacy publishing.

## Verification

- Complete non-browser suite: passed.
  - Core JavaScript: 192 passed, 0 failed.
  - Atomic candidates: 14 passed, 0 failed.
  - Decision policy: 11 passed, 0 failed.
  - Citation audit: 25 passed, 0 failed.
  - Python proxy: 30 passed, 0 failed.
  - Release manifest, public smoke, and workflow contracts: passed.
- Deterministic Chromium gate: 11 passed in 42.1 seconds.
- Former provider-failure timing edge: passed in 4.2 seconds with Playwright clock control.
- `actionlint` 1.7.12: all workflows passed.
- `git diff --check`: passed; only Windows line-ending notices were emitted.
- Local exact-artifact rehearsal: 17 files verified, browser initial load passed, external/failed requests and console/page errors were empty, WebGPU was disabled, and both model revisions were immutable.
- Local manifest digest: `8fbec2fe0f51730545a67e84cfc4fb1937de06bd80e4a6d7fe83055ead2b3bcc`.
- Tamper rehearsal: replacing published `app.js` caused the public smoke to fail with `public size mismatch for app.js` and persisted a failed evidence record.

The local test copy excluded the workspace's malformed Google Drive `node_modules` tree and used the locked external dependency installation. No live bibliography provider was called.

## Release controls

- CI and deploy call one reusable exact-SHA quality workflow.
- Node 18/20/22, Python 3.12, and Chromium must all pass before packaging.
- The Pages payload is copied once, canonicalized into a manifest, uploaded under a SHA-derived immutable artifact name, downloaded, and byte-verified before deployment.
- The deploy job alone has `pages: write` and `id-token: write`.
- Public smoke runs afterward in a separate read-only job and blocks off-origin HTTP requests before transmission.
- Manual deployment accepts only a full lowercase 40-character `deploy_sha` that is an ancestor of `main` and re-runs the complete gate.
- All external GitHub Actions references are pinned to full commit SHAs.

## Remaining authorized release step

Before the first public workflow release:

1. Change Settings → Pages → Build and deployment → Source to GitHub Actions.
2. Confirm the Pages API returns `build_type: workflow` and no legacy `pages-build-deployment` run is generated.
3. Push or dispatch the release and require `resolve`, `quality`, `verify_artifact`, `deploy`, and `smoke` to pass for one source SHA, `docs` tree ID, and manifest digest.
4. Preserve `deployment-evidence-<sha>` as the first gate-compatible known-good rollback point.
