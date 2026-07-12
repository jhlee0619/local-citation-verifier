# Task 7 vLLM bind-policy QA evidence

Date: 2026-07-12

## Policy contract

`server/bind_policy.py` parses bind configuration before server construction.

- `127.0.0.1`, `::1`, and `localhost` are allowed without `ALLOW_REMOTE`.
- `0.0.0.0`, `::`, a representative LAN address, and a hostname are rejected unless the environment value is exactly `ALLOW_REMOTE=1`.
- Empty, `true`, `TRUE`, `yes`, `01`, and `1 ` all fail closed.
- Explicit remote access emits a warning naming the static app, metadata proxy, rerank API, and the absence of authentication and TLS.
- The warning recommends an authenticated HTTPS reverse proxy and firewall allowlist.

## Unit and entrypoint QA

`python -m unittest tests.test_bind_policy tests.test_vllm_proxy` passed 30 tests.

The focused suite proves:

- every loopback spelling reaches server construction without the flag;
- `::1` selects an IPv6 server class and completes a real temporary loopback bind;
- disallowed remote configuration returns exit code 2 before `ThreadingHTTPServer` is called;
- explicitly allowed remote configuration reaches server construction and writes the exposure warning to stderr;
- a real subprocess invocation with `HOST=192.168.1.20` and no flag exits 2 within three seconds, prints actionable stderr, and never prints the serving banner;
- the package entrypoint `python -m server.vllm_proxy_server` resolves imports before returning the same policy-denial exit code;
- README defaults and commands match the executable policy.

No public socket was opened during the allowed-remote test because server construction was replaced at the narrow socket boundary.

## Safe module split

The pre-existing server module exceeded the repository's Python file-size rule. Cache, validation, upstream I/O, and rerank DTO behavior moved without semantic changes to `server/proxy_core.py`; `server/vllm_proxy_server.py` remains the explicit compatibility facade plus HTTP handler and entrypoint.

Pure LOC after extraction:

- `server/bind_policy.py`: 29
- `server/proxy_core.py`: 204
- `server/vllm_proxy_server.py`: 243
- `tests/test_bind_policy.py`: 122
- `tests/test_vllm_proxy.py`: 127

The modules have one-way dependencies and no circular import. Existing public imports from `vllm_proxy_server` remain available. The upstream test patches `urlopen` in its new owner module.

## Full regression

`npm test` passed, including 192 JavaScript tests and 30 discovered Python tests. `python -m py_compile` passed for all three server modules and both focused test modules. The strict Python no-excuse checker reported no violations across the five changed Python files. `git diff --check` passed.

No CORS policy or browser token storage was added.
