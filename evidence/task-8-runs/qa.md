# Task 8 run-ownership QA evidence

Date: 2026-07-12

## Ownership contract

`docs/run-controller.js` provides one shared controller for bibliography verification and citation audit lifecycles.

- Verification and audit IDs are monotonic within their own domains.
- Every context owns deeply copied, frozen inputs and settings plus run-local results and decision state.
- Starting verification B aborts A and an audit bound to A. Starting audit B aborts audit A without cancelling the verification.
- An audit started without a verification remains independent when the first verification starts.
- UI publication goes through active-context checks; superseded callbacks cannot publish.

The new controller is 115 pure LOC, below the 250-LOC target. The shared request primitive remains below its target at 233 pure LOC.

## Deterministic race tests

`node tests/test_run_controller.js` proves:

- immutable snapshots and isolated mutable result state;
- A-to-B verification and audit cancellation rules;
- active-owner publication guards;
- explicit user cancellation;
- cancellation of the QZX999 onboarding delay settles without publication or an unhandled rejection;
- late A completion cannot replace B cards, counts, decisions, preview, or download ownership;
- script order loads the controller before both consumers.

`node tests/test_speed_primitives.js` proves:

- only fulfilled values are promoted to the stable TTL key;
- pending values are scoped by run ID;
- an aborted A resolve or reject cannot replace or poison B's stable value;
- a fulfilled stable value is reused;
- abort stops the bounded queue from scheduling or publishing further work.

`node tests/test_request.js` proves DBLP JSONP abort synchronously removes its timer, script, abort listener, and global callback; a captured late callback is inert.

`node tests/test_citation_audit.js` includes 21 passing tests. Its controlled A/B races prove a late audit cannot publish after B and replacing verification A aborts its bound audit while leaving verification B active. Caller abort also stops evidence retries and is never converted to a lookup failure.

`node tests/test_vllm_reranker.js` proves the bibliography reranker passes the owner signal to fetch and does not cache an aborted request.

## Browser QA

The app was served from `http://127.0.0.1:8765/` and exercised in the in-app Chromium browser.

- A 300-entry delayed verification was cancelled while 86 partial not-found cards had arrived.
- The terminal message became `Cancelled — no pending lookup result was published`.
- Cards, all five summary counts, decisions-backed preview text, and download availability were cleared: 0 cards, `[0,0,0,0,0]`, empty preview, download disabled.
- A subsequent single-entry run B completed with exactly one B card, one not-found count, B-only preview, and enabled download; no late A content appeared.
- Citation audit completed twice consecutively with one result and one insufficient-evidence count. The run button remained available to supersede an earlier audit.
- After the final cache-busted asset load, a 100-entry delayed run was cancelled before completion. After 800 ms it still had 0 cards, `[0,0,0,0,0]`, empty preview, disabled download, and the cancelled terminal message.
- Browser warning/error log count for the final asset version was zero.
- All run-ownership consumers use the same cache-busting asset version, preventing a fresh app from loading an older controller or request primitive.

## Full regression

Fresh verification after all ownership, provider-abort, timer, and asset-version guards passed: `npm test` completed 192 JavaScript library tests, all focused run-controller/cache/request/audit suites (including 21 citation-audit tests), and 30 Python tests. The package syntax checks and `git diff --check` also passed. Independent Task 8 code review returned PASS with no remaining blocker.

No dependency was added. The local QA server and browser tab are removed after review.
