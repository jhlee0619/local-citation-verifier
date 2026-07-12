# Task 2 parser verification

## Red evidence

Before the scanner change, the new fixtures produced four failures:

- quoted values lost the backslashes from `\LaTeX`, `\"`, `\{`, and `\\`;
- serialized output no longer contained the accepted source escape spelling;
- strict document parsing was unavailable, so malformed input could not fail closed.

The pre-fix test process exited 1. A separate literal-quote fixture then reproduced a false positive for `title={A 5" Disk Study}` before quote recognition was limited to quoted-value delimiters.

## Automated verification

- `npm run test`: passed.
- Library suite: 192 passed, 0 failed.
- Python discovery: 20 passed.
- `git diff --check`: passed.
- Fail-closed ordering check: preview state clears before `parseBibDocument`, and `runVerification` occurs only after strict parsing succeeds.
- Exact diagnostics use zero-based JavaScript string offsets. A trailing escape takes precedence over an unterminated quote when the final character is `\`.

## Browser QA

A local browser run used a `QZX999` fixture so the happy path did not contact academic metadata providers.

- Valid quoted escapes remained exact in the input and appeared in the live preview as `\LaTeX`, `H{\"a}ni`, and `\\`; download became enabled only after completion.
- A two-entry batch with an unterminated quote raised the structured parse alert, retained the exact textarea text, kept results hidden, kept preview empty, and left download disabled and hidden.
- Local server logs showed only static assets and the existing startup vLLM health probe; malformed verification did not issue academic provider routes.
- Starting any new input clears `currentPreviewBib`; malformed input therefore cannot reuse a prior preview through download or Copy.

## Adversarial QA matrix

- Malformed input: probed for unterminated quote, brace, trailing escape, assignment-like text inside braced values, unexpected quote context, and partial-valid-then-invalid batches.
- Prompt injection: N/A; no model prompt is processed before strict parsing.
- Cancel/resume: N/A for the synchronous preflight; run cancellation is Task 8.
- Stale state: preview/export state clears before each parse, and a strict-parse validity gate blocks late preview, Copy, download, and completion callbacks after malformed input. Full cross-run result isolation remains Task 8.
- Dirty worktree: reviewed; only Task 2 source, tests, and evidence are present after the Task 1 commit.
- Hung/long commands: parser and preflight are bounded linear scans; full suite completed normally.
- Flaky tests: targeted tests and the full suite both passed on rerun.
- Misleading success: malformed batches return zero entries and never reach `runVerification`.
- Repeated interruptions: N/A for the synchronous parser boundary.

## Cleanup receipt

- No runtime or development dependency was added.
- The legacy lenient `parseBib` API remains for already-covered provider snippets and malformed-brace recovery.
- The strict all-or-nothing contract is isolated in `parseBibDocument`.
- `docs/lib.js`, `docs/app.js`, and `tests/test_lib.js` were already well above 250 lines; this task added only the approved narrow scanner/wiring and did not broaden scope into the later module-split tasks.
- The temporary local HTTP server was stopped after browser QA.
