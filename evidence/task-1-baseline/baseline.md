# Task 1 baseline

- Baseline commit: `a076bd8b3aff99451e7517537ac9f0706df8dd2f`
- Initial worktree status: clean
- Node: `v24.14.0`
- npm: `11.12.0`
- Python: `3.10.9`
- Baseline JavaScript: 186 library tests, 2 speed-primitive tests, vLLM reranker tests, 17 citation-audit tests, fixture harness, and fixture snapshot all passed once dependencies were installed on a local NTFS path.
- Baseline Python direct runner: passed, but its hand-maintained `__main__` block ran only 14 of the 20 module test functions.
- Baseline Python discovery: exited successfully after running 0 tests. A count gate reproduced the defect with `discovered=0 expected=20`, exit 1.
- Local environment note: `npm ci` against this Google Drive virtual filesystem emitted repeated `TAR_ENTRY_ERROR` writes and produced an invalid local `fuzzball/package.json`. A clean install under `%LOCALAPPDATA%` plus `NODE_PATH` isolated this host-filesystem issue; GitHub Actions' Ubuntu runners are unaffected.

## Baseline workflow runs

- [CI run 28983568446](https://github.com/jhlee0619/local-citation-verifier/actions/runs/28983568446) — success at the baseline SHA.
- [Deploy workflow run 28983568463](https://github.com/jhlee0619/local-citation-verifier/actions/runs/28983568463) — success at the baseline SHA.
- [Pages build run 28983567784](https://github.com/jhlee0619/local-citation-verifier/actions/runs/28983567784) — success at the baseline SHA.

## Baseline commands

```text
node --check docs/lib.js ... docs/citation-audit.js
node tests/test_lib.js ... tests/test_fixture_snapshot.js
python -m py_compile server/vllm_proxy_server.py
python tests/test_vllm_proxy.py
python -m unittest discover -s tests -p "test_*.py"
```

## Verification receipt

- `npm run test`: passed (syntax, 186 library tests, all auxiliary Node suites, and 20 Python tests).
- Discovery count gate: `discovered=20`.
- Temporary sentinel: a discovered `unittest.TestCase` failure produced exit code 1 after running 21 tests; the sentinel file was then removed.
- Runtime dependencies: unchanged; only package scripts were added.
- Modified Python test module: 151 lines.

## Adversarial QA matrix

- Malformed input: probed by the existing parser and proxy-path rejection suites; passed.
- Prompt injection: N/A for test-discovery and CI wiring.
- Cancel/resume: N/A; no persisted operation is introduced.
- Stale state: baseline SHA and clean initial status recorded explicitly.
- Dirty worktree: expected Task 1 files only; temporary sentinel absent after QA.
- Hung/long commands: commands are finite local checks; no background process introduced.
- Flaky tests: discovery and the complete suite were rerun after conversion; passed.
- Misleading success: probed twice—pre-change discovery ran 0 tests with exit 0, while the post-change failing sentinel propagated exit 1.
- Repeated interruptions: N/A; Task 1 has no resumable controller.
