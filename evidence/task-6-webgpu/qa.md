# Task 6 WebGPU QA evidence

Date: 2026-07-12

## Immutable upstream provenance

- Loader URL: `https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/resolve/158f16ae0f672943ca304d59c47c8e3a264e399e/gemma-4-e2b.js`
- Loader commit: `158f16ae0f672943ca304d59c47c8e3a264e399e`
- Fetched size: 551802 bytes
- Fetched SHA-256: `0234c0e866bfaa9623e938a7cfa7f5740cca22532cc1112dd4e8915b97f78d62`
- Source inspection: the pinned loader exposes `Gemma4Mobile.load(source, options)` and resolves model assets using `options.revision` (falling back to `main` only when the caller omits it).
- Model revision: `9fcec64df66cb1e4d972fc5cdc142afb25b2362c`
- Model verification: a HEAD request for pinned `config.json` returned HTTP 200 and `X-Repo-Commit: 9fcec64df66cb1e4d972fc5cdc142afb25b2362c` after redirect.
- The loader is not vendored because explicit redistribution licensing was not established.

## Deterministic contract tests

`node tests/test_gemma_reranker.js` covers:

- default-disabled state and zero third-party imports before consent;
- exact loader URL and exact model `revision` passed to `Gemma4Mobile.load`;
- one load attempt and serialized `complete` calls;
- independent load and inference deadlines;
- timeout quarantine, queued-work drain, late-result rejection, and no reset after re-enable;
- prevention of a late module import from starting model loading after quarantine;
- preserved conservative model-output validation;
- heuristic fallback contract instead of `not_found`.

The timing regression was run five consecutive times after increasing scheduler margin; all five runs passed.

`node tests/test_citation_audit.js` verifies that automatic citation judgement does not invoke WebGPU before explicit consent and returns typed insufficient evidence with `local_ai_disabled`.

## Browser QA

Served `docs/` on localhost and loaded it in Chromium through the in-app browser.

- `#opt-local-gpu-rerank` existed and `checked === false`.
- Initial resource observation contained zero `huggingface.co` URLs.
- The page produced no warning or error console messages.

The browser did not opt in, intentionally avoiding a live third-party model download. Stubbed unit tests prove the post-consent loader lifecycle without depending on GPU hardware or a live provider.

## Full regression

`npm test` passed:

- syntax checks for all browser modules;
- 192 core library tests;
- 13 request primitive tests;
- 10 focused WebGPU tests;
- atomic candidate, decision policy, vLLM, citation audit, fixture and snapshot suites;
- 20 Python tests.

`git diff --check` passed. `docs/webgpu-engine.js` is 115 lines and `docs/gemma-reranker.js` is 205 lines.

## Known limitation

CI and these tests prove consent, immutability, deadline, serialization, quarantine, and fallback control flow. They do not prove model quality, real WebGPU correctness, browser-driver compatibility, or performance across GPU hardware.
