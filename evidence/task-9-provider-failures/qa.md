# Task 9 provider failure QA

Date: 2026-07-13 (Asia/Seoul)

## Claims verified

- Provider rows are relevant only through an exact original DOI/arXiv link or the existing title threshold with correction/retraction parity.
- Title, author, and year remain one atomic provider record. Provider failure handling does not reintroduce cross-source core-field merging.
- All-success/zero-relevant is `not_found`; any enabled primary failure with zero relevant records is `lookup_failed`.
- A relevant record survives partial primary failure and carries sanitized per-source warnings.
- Incomplete, conflicting, fuzzy-only, and local-curation records remain `needs_review`; only a complete directly linked atomic record is auto-eligible.
- Exact DOI/arXiv review candidates remain visible even when their provider title falls below the fuzzy-title ranking threshold; they cannot collapse into `not_found`.
- DBLP JSONP abort/timeout removes the timer, script, and global callback, and a late callback cannot publish.
- CrossRef DOI and arXiv failures skip enrichment without poisoning the stable cache.
- vLLM and WebGPU failures keep the heuristic result; citation inference failure returns a conservative `insufficient_evidence` result.
- Caller cancellation propagates through metadata, citation, vLLM, and WebGPU work and does not become a result status.
- Transport failures, timeouts, caller aborts, and invalid LLM output are not promoted into stable caches.
- DBLP title+author/title fallback shares one 12-second provider deadline; citation DOI/title fallback shares one 41-second evidence deadline.
- HTTP 204 is treated as a valid empty response without attempting JSON parsing.
- Enrichment failures remain visible even when the final primary classification is `not_found`.

## Timeout matrix

| Path | Attempt | Attempts | Total | Backoff cap |
| --- | ---: | ---: | ---: | ---: |
| Semantic Scholar, CrossRef, OpenReview | 12 s | 3 | 41 s | 5 s |
| Citation evidence | 12 s | 3 | 41 s | 5 s |
| CrossRef direct DOI | 12 s | 3 | 41 s | 5 s |
| DBLP (fetch or JSONP) | 12 s | 1 | 12 s | 0 |
| Local arXiv | 10 s | 1 | 10 s | 0 |
| Browser vLLM | 95 s | 1 | 95 s | 0 |
| vLLM health | 0.9 s | 1 | 0.9 s | 0 |
| WebGPU load | 120 s | 1 | 120 s | 0 |
| WebGPU completion | 120 s | 1 | 120 s | 0 |

## Automated evidence

Command:

```text
NODE_PATH=<bundled workspace node_modules> npm test
```

Result: PASS.

- JavaScript core library: 192 passed, 0 failed.
- Request/JSONP, run ownership, provider runtime, WebGPU, atomic candidates, decision policy, vLLM, citation audit, fixtures, and static application contracts: PASS.
- Citation audit: 25 passed, 0 failed.
- Python discovery: 30 passed, 0 failed.
- Syntax checks for all changed browser modules: PASS.
- `git diff --check`: PASS (only Git line-ending notices).

Focused commands also passed:

```text
node tests/test_provider_runtime.js
node tests/test_request.js
node tests/test_gemma_reranker.js
node tests/test_vllm_reranker.js
node tests/test_citation_audit.js
node tests/test_atomic_app_contract.js
```

The provider scenario assertions cover both requested branches at the deterministic policy boundary: CrossRef-relevant candidate plus Semantic Scholar failure retains the atomic candidate and a sanitized warning; zero relevant candidates plus primary failures yields `lookup_failed`. They also reproduce an exact-DOI candidate with an unrelated provider title, prove that title ranking returns no choice, and then prove the atomic candidate remains available for `needs_review`. Separate request/vLLM/WebGPU tests provide the never-resolving timeout, late JSONP callback cleanup, failed-cache eviction, and heuristic/conservative fallback evidence.

## Served-asset smoke test

A local `python -m http.server` served `docs/`. The HTML and every changed Task 9 browser asset returned HTTP 200. The HTML referenced the same cache-busting version `20260712-provider-failures` for:

- `provider-runtime.js`
- `webgpu-engine.js`
- `gemma-reranker.js`
- `vllm-reranker.js`
- `citation-audit.js`
- `app.js`

## Browser limitation

The Codex in-app Browser was selected according to the browser skill, but its webview did not attach and exposed no usable tab. No alternate browser-control surface was used. The deterministic module/contract tests and served-asset HTTP smoke test above are the available Task 9 evidence; full deterministic browser behavior remains an explicit Task 11 deliverable.
