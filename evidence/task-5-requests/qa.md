# Task 5 request-contract QA

Date: 2026-07-12

## Scope

Task 5 adds the dependency-free `BibRequest` browser/CommonJS primitive and
locks its policy contract. Provider wiring remains intentionally deferred to
Task 9, after Task 8 supplies run ownership and caller cancellation signals.

## Policy evidence

- Metadata, search, and evidence: 12 seconds per attempt, 3 attempts total,
  41-second total deadline, 1.5/3-second exponential backoff, 5-second cap.
- arXiv: 10-second total, one attempt.
- DBLP JSONP: 12-second total, one attempt.
- vLLM POST: 95-second total, one attempt.
- Health probe: 900 ms, one attempt.
- The policy collection and every nested policy are frozen.

## Happy path

`tests/test_request.js` returned a mocked HTTP 429 with an extreme
`Retry-After: 999999`, observed the configured 12 ms test cap, retried once,
and returned the following HTTP 200 result on attempt 2.

## Failure paths

- A mock operation that never observes its abort signal terminated at the
  logical deadline. Two allowed attempts produced a typed
  `deadline_timeout`, proving the primitive does not depend on fetch honoring
  cancellation.
- An extreme `Retry-After` longer than the remaining total deadline terminated
  at the total deadline before another attempt.
- Operation fulfillment and rejection were both rechecked against absolute
  attempt and total deadlines, so a delayed JavaScript timer cannot admit a
  late result. A late first-attempt success was retried under the attempt
  policy; a late total-deadline success and failure were both rejected.
- Caller cancellation terminated immediately on attempt 1 and was not wrapped
  as a transport failure or retried.
- Resolve, reject, timeout, and abort paths all returned tracked internal timer
  and caller-listener counts to zero.
- Valid success, empty/204, and 404/not-found outcomes remained distinct from
  `retry_exhausted` transport and HTTP failures.

## Verification

- `node tests/test_request.js`: 13 passed.
- `npm test`: passed, including 192 library tests, 14 atomic-candidate tests,
  11 decision-policy tests, the request contract suite, and 20 Python tests.
- `node --check docs/request.js`: passed.
- `git diff --check`: passed.
- `docs/request.js`: 207 lines (250-line limit satisfied).

Result: PASS.
