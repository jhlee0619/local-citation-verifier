# Release and rollback operations

GitHub Pages is released only by `.github/workflows/deploy.yml`. A push to `main` releases that commit. A manual run revalidates and deploys the exact commit supplied as `deploy_sha`.

## One-time Pages prerequisite

Before the first release, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. The Pages API must report `build_type: workflow`; legacy branch publishing from `main:/docs` must be disabled. The deploy workflow checks this state and fails before packaging or deployment when legacy publishing is active. It never changes the repository setting itself.

Protect the `github-pages` environment with the repository's normal release approval policy. Protect `main` so release-control changes cannot bypass review and CI.

## Before a release: the build token

`docs/` is native ES modules with no build step. Every local `import` specifier, plus the page's `<script>` and stylesheet tags, carries one cache-busting token (`?v=BUILD`). The maintainers bump it in the release commit whenever anything under `docs/` changes, so a browser that still has an old module cached never mixes it with new ones. A page whose modules fail to load shows "press Ctrl+Shift+R to reload" (`docs/boot.js`).

## Release gate

Every forward release and rollback passes through the same reusable workflow (`.github/workflows/quality.yml`). The larger test suites run before publishing, outside this repository; the workflow checks the exact source commit (a full SHA on `main`, no symbolic links under `docs/`), runs the public verdict regression suite (`regression/`) and then creates a Pages artifact.

The artifact contains a canonical `_release/manifest.json` with the source commit, `docs` tree ID, byte size, and SHA-256 for every published file. A separate job downloads the artifact, rejects unsafe archive paths and links, extracts it without restoring archive ownership or permissions, and verifies every byte against the manifest. The deploy job consumes that verified artifact without checking out or rebuilding source.

After GitHub Pages reports deployment success, a separate read-only public smoke job runs `scripts/post-deploy-smoke.js`. It downloads the published manifest and every listed asset and verifies their hashes. It then reads the CSP from the deployed, hash-verified `index.html` (there is no hard-coded copy) and requires:

- `script-src 'self'` and nothing else (no remote script origin, no inline or eval);
- `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and `img-src 'self' data:`;
- `connect-src` limited to `'self'` and `https://` origins.

It then opens the site in Chromium and blocks every off-origin HTTP request before it leaves the browser. The page must:

- load with that same CSP;
- load scripts from its own origin only;
- contain no mutable `/resolve/main/` reference;
- have AI rerank disabled;
- finish without failed requests or browser errors.

The resulting `deployment-evidence-<sha>` artifact is retained for 30 days.

The workflow steps and the release controls (`release-manifest.js`, `post-deploy-smoke.js`) always come from the current `main`. Only the tested and published source comes from the target commit.

## Rollback

1. Identify the last known-good, gate-compatible commit on `main` (see the limit below).
2. Copy its full 40-character lowercase commit SHA. Branch names, tags, abbreviated SHAs, uppercase hex, and commits outside `main` are rejected.
3. Open the `Deploy verified GitHub Pages artifact` workflow on the `main` branch and choose `Run workflow`.
4. Paste the SHA into `deploy_sha` and start the run.
5. Confirm `resolve`, `quality`, `verify_artifact`, `deploy`, and `smoke` all pass.
6. Confirm the `Pages public smoke` summary reports `passed`, the expected source SHA, `docs` tree ID, manifest digest, and production URL.
7. Download `deployment-evidence-<sha>` and retain it with the incident record.

A rollback is a fresh validation and deployment, not reuse of an expired historical artifact. If the target predates this release gate or cannot pass current checks, it fails closed and must not be bypassed. The first successful release establishes the initial gate-compatible known-good commit.

### Limit: only gate-compatible commits

The current smoke enforces the October 2026 CSP and module layout. Commits from before that release cannot pass it and must not be redeployed. Only choose a target whose `docs/main.js` exists and whose `index.html` CSP has `script-src 'self';` and `img-src 'self' data:;`:

```bash
sha=<candidate>
git show "$sha:docs/main.js" > /dev/null &&
  git show "$sha:docs/index.html" | grep -q "script-src 'self';" &&
  git show "$sha:docs/index.html" | grep -q "img-src 'self' data:;" && echo "gate-compatible"
```

If no such commit is good, do not roll back. Fix forward: revert or repair the faulty change in a new commit on `main`, which passes the full gate like any release.

## Failure and recovery triggers

Stop or roll back when any of these happens:

- the root page or a local asset returns a non-200 response;
- published bytes differ from the manifest;
- the deployed CSP breaks the rules above, or the loaded page's CSP differs from the deployed `index.html`;
- a remote script origin is allowed;
- AI rerank becomes enabled by default;
- any external request is attempted during initial load;
- the public smoke fails for any other reason.

Do not submit real bibliography data while diagnosing release propagation.

The deployment may already be visible when public smoke detects a propagation or runtime failure. Run the workflow immediately with the previous known-good `deploy_sha` (subject to the limit above). Do not rebuild or upload `docs` manually. Diagnose the failed commit on a separate branch and restore forward deployment only through a new green `main` run.

Success requires the preflight, artifact verification, Pages deployment, and public smoke to pass for the same source SHA, `docs` tree ID, and manifest digest.
