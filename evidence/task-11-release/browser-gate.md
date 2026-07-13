# Task 11 deterministic browser gate

Date: 2026-07-13 (Asia/Seoul)

## Baseline failure

Before installing the planned test dependency, `npm run test:browser` exited 1 because the `playwright` executable was absent. After the browser fixtures were added, Chromium reproduced two production defects: candidate rendering stopped before completion because it evaluated an out-of-scope `run`, and result-card favicons leaked external requests. The minimal application fixes removed that evaluation and replaced remote favicons with inline SVG.

## Automated and browser QA

Exact local invocation:

```text
NODE_PATH=<external-workspace-deps> node <external-workspace-deps>/@playwright/test/cli.js test --project=chromium
```

Result: 11 passed in one deterministic Chromium project. The suite exercised actual page interactions and Blob downloads against `http://127.0.0.1:4173/`; all academic metadata responses were explicit Playwright fixtures and all other external requests failed the test.

Covered observables:

- quoted BibTeX escapes were present in downloaded `verified_refs.bib` bytes;
- a Semantic Scholar/arXiv/CrossRef conflict defaulted to original bytes, then adopted one complete CrossRef title/author/year tuple only after an explicit click with matching field provenance;
- generic-title fuzzy matching remained review-only;
- provider permutations produced the same ordered candidate identities;
- the vLLM-selected record exported one atomic tuple;
- late run A could not alter run B cards, counts, preview, decisions, or downloaded bytes;
- all-empty, all-failed, and partial-success provider outcomes produced `Not Found`, `Lookup Failed`, and review-with-source-warning behavior respectively;
- cancellation cleared results and disabled export;
- browser-clock advancement terminated hung production requests and removed a timed-out JSONP script/global callback;
- initial load and default verification issued zero Hugging Face requests;
- explicit WebGPU opt-in requested only the exact pinned loader, passed the pinned model revision, quarantined after the production 120-second logical deadline, rejected a second inference, and retained heuristic/original output.

Full regression result after the browser fixes:

- core JavaScript: 192 passed;
- atomic candidates: 14 passed;
- decision policy: 11 passed;
- citation audit: 25 passed;
- Python discovery: 30 passed;
- deterministic Chromium: 11 passed.

## Adversarial coverage and cleanup

- malformed input: strict parser behavior remains covered by Node regression; browser download proves the accepted quoted-escape case.
- prompt injection: not applicable to metadata fixture transport; vLLM output is fixed strict JSON and cannot add fields.
- cancel/resume: pending provider requests were cancelled and a new run completed independently.
- stale state: a deliberately non-cancellable late response resolved after run B without publishing.
- dirty worktree: tests ran with only the scoped Task 11 changes present; `git diff --check` passed.
- hung or long commands: browser clock advanced real production deadlines; no production timeout override was added.
- flaky tests: one Chromium worker, isolated pages, fixed responses, and no non-local network produced repeatable green runs.
- misleading success output: assertions inspected downloaded bytes, DOM status, provenance, request logs, callback/script cleanup, and engine state rather than only exit code.
- repeated interruptions: superseding verification and explicit cancellation both left the newest/terminal UI state intact.

The Playwright web server terminated after the suite, held `/__hang/` sockets were destroyed on shutdown, browser contexts closed, and no QA process or port remained running.
