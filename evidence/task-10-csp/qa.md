# Task 10 vendoring and CSP QA

Date: 2026-07-13 (Asia/Seoul)

## Claims verified

- `fuzzball` is declared exactly as `2.2.3` in both `package.json` and the lock root. The resolved package remains `2.2.3` with its existing npm integrity.
- `docs/vendor/fuzzball-2.2.3.umd.min.js` and `docs/vendor/fuzzball.LICENSE` are byte-identical to the installed locked package.
- `.gitattributes` marks both vendor artifacts `-text`, preventing Windows line-ending conversion from invalidating the recorded hashes.
- Every production `<script src>` is local. The local fuzzball UMD loads before `BibLib`.
- A VM contract loads the committed UMD, replaces its `token_sort_ratio` with a sentinel, loads production `lib.js`, and proves `BibLib.titleSimilarity` executes the fuzzball-backed branch rather than the fallback.
- Meta and Python response CSP share every directive except the response-only `frame-ancestors 'none'` defense.
- `script-src` is limited to `'self'`, the existing inline/wasm allowances, and the exact `https://huggingface.co` loader origin. unpkg, DBLP, and OpenReview are not executable origins.
- `connect-src` contains only the browser's direct CrossRef, Semantic Scholar, and opt-in pinned Hugging Face/Xet paths. Unused direct arXiv, DBLP, and OpenReview origins are absent; their local-server paths are same-origin.
- The browser no longer injects DBLP JSONP. DBLP and OpenReview remain available through same-origin routes when the local proxy is active; static GitHub Pages mode omits those two providers instead of granting remote script execution.
- User-facing not-found and onboarding copy is built from the providers active in the current deployment and never claims that a disabled provider answered.
- Synthetic malicious fixtures prove the static contract detects double-quoted, single-quoted, whitespace-varied, and unquoted external script tags; `data-src` prefix confusion; quoted `>` boundaries; entity-obscured URLs; duplicate or malformed `src`; mixed-case duplicate CSP directives; and a mutable `/resolve/main/` Hugging Face revision. The revision scan includes nested runtime assets.

## Locked provenance

| Artifact | Value |
| --- | --- |
| npm package | `fuzzball@2.2.3` |
| npm integrity | `sha512-sQDb3kjI7auA4YyE1YgEW85MTparcSgRgcCweUK06Cn0niY5lN+uhFiRUZKN4MQVGGiHxlbrYCA4nL1QjOXBLQ==` |
| UMD source | `node_modules/fuzzball/dist/fuzzball.umd.min.js` |
| UMD bytes | 47,451 |
| UMD SHA-256 | `9a37a5c3f40af42aa7ea2daabcdbaaba7bc3458790b41abaf0f6825817201da1` |
| License source | `node_modules/fuzzball/LICENSE.md` |
| License | MIT |
| License bytes | 1,055 |
| License SHA-256 | `28d0000d8857280206c926237c256ae8fe190e121415f1f17991586b7fb7d9e7` |

## DBLP transport decision

The official DBLP search API documents JSON and JSONP result formats: <https://dblp.org/faq/How%2Bto%2Buse%2Bthe%2Bdblp%2Bsearch%2BAPI.html>. A direct response-header check against the documented JSON endpoint returned `200 application/json` without `Access-Control-Allow-Origin`, so a GitHub Pages browser cannot replace JSONP with a readable cross-origin fetch. Keeping JSONP would require DBLP in `script-src`, directly contradicting Task 10. The implementation therefore keeps DBLP behind the existing same-origin local proxy and does not register it in static mode. OpenReview was already proxy-only.

## Automated evidence

Red phase:

- `node tests/test_security_contract.js` failed because the vendored bundle did not exist.
- The focused Python CSP test failed because DBLP remained in `script-src`.
- The app asset contract failed until the DBLP transport change received a new cache-busting version.

Green phase:

```text
NODE_PATH=<bundled workspace node_modules> npm test
```

Result: PASS.

- JavaScript core library: 192 passed, 0 failed.
- Request, run ownership, provider, WebGPU, atomic, decision, vLLM, citation, fixture, application, and security contracts: PASS.
- Citation audit: 25 passed, 0 failed.
- Python discovery: 30 passed, 0 failed.
- Syntax checks: PASS.
- Python no-excuse audit on both changed Python files: PASS.

## Served-response evidence

A GitHub-Pages-like static server returned HTTP 200 for `/` and the vendored UMD. Hashing the served UMD stream produced:

```text
9a37a5c3f40af42aa7ea2daabcdbaaba7bc3458790b41abaf0f6825817201da1
```

The local Python proxy returned HTTP 200 for the same asset and emitted the expected response CSP. Its `script-src` contained only self, the retained inline/wasm allowances, and `https://huggingface.co`; no unpkg, DBLP, or OpenReview executable origin was present.

Both temporary servers were stopped after the smoke checks. Full deterministic Chromium E2E remains assigned to Task 11.
