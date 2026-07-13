# Release and rollback operations

GitHub Pages is released only by `.github/workflows/deploy.yml`. A push to `main` releases that commit. A manual run revalidates and deploys the exact commit supplied as `deploy_sha`.

## One-time Pages prerequisite

Before the first release, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. The Pages API must report `build_type: workflow`; legacy branch publishing from `main:/docs` must be disabled. The deploy workflow checks this state and fails before packaging or deployment when legacy publishing is active. It never changes the repository setting itself.

Protect the `github-pages` environment with the repository's normal release approval policy. Protect `main` so release-control changes cannot bypass review and CI.

## Release gate

Every forward release and rollback passes through the same reusable quality workflow. It checks the exact source commit with Node 18, 20, and 22, Python 3.12, and the Chromium browser suite. Only after those jobs pass does it create a Pages artifact.

The artifact contains a canonical `_release/manifest.json` with the source commit, `docs` tree ID, byte size, and SHA-256 for every published file. A separate job downloads the artifact, rejects unsafe archive paths and links, extracts it without restoring archive ownership or permissions, and verifies every byte against the manifest. The deploy job consumes that verified artifact without checking out or rebuilding source.

After GitHub Pages reports deployment success, a separate read-only public smoke job downloads the published manifest and every listed asset, verifies their hashes, and opens the site in Chromium. It blocks off-origin HTTP requests before they leave the browser. The gate requires the expected HTTPS host, exact CSP, only same-origin script tags, no mutable `/resolve/main/` reference, no failed request or browser error, disabled WebGPU consent, and immutable model revisions. The resulting `deployment-evidence-<sha>` artifact is retained for 30 days.

## Rollback

1. Identify the last known-good, gate-compatible commit on `main`.
2. Copy its full 40-character lowercase commit SHA. Branch names, tags, abbreviated SHAs, uppercase hex, and commits outside `main` are rejected.
3. Open the `Deploy verified GitHub Pages artifact` workflow on the `main` branch and choose `Run workflow`.
4. Paste the SHA into `deploy_sha` and start the run.
5. Confirm `resolve`, `quality`, `verify_artifact`, `deploy`, and `smoke` all pass.
6. Confirm the `Pages public smoke` summary reports `passed`, the expected source SHA, `docs` tree ID, manifest digest, and production URL.
7. Download `deployment-evidence-<sha>` and retain it with the incident record.

A rollback is a fresh validation and deployment, not reuse of an expired historical artifact. If the target predates this release gate or cannot pass current checks, it fails closed and must not be bypassed. The first successful release establishes the initial gate-compatible known-good commit.

## Failure and recovery triggers

Stop or roll back when the root page or a local asset returns a non-200 response, published bytes differ from the manifest, CSP or model pins drift, WebGPU becomes enabled by default, any external request is attempted during initial load, or the public smoke fails for any other reason. Do not submit real bibliography data while diagnosing release propagation.

The deployment may already be visible when public smoke detects a propagation or runtime failure. Run the workflow immediately with the previous known-good `deploy_sha`. Do not rebuild or upload `docs` manually. Diagnose the failed commit on a separate branch and restore forward deployment only through a new green `main` run.

Success requires all quality jobs, artifact verification, Pages deployment, and public smoke to pass for the same source SHA, `docs` tree ID, and manifest digest.
