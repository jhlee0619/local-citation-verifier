"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("../docs/request.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function response(status, retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name === "Retry-After" ? retryAfter ?? null : null },
  };
}

function timerTracker() {
  const active = new Set();
  return {
    setTimer(fn, ms) {
      const id = setTimeout(() => { active.delete(id); fn(); }, ms);
      active.add(id);
      return id;
    },
    clearTimer(id) { active.delete(id); clearTimeout(id); },
    count: () => active.size,
  };
}

function listenerTracker(signal) {
  let active = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { active++; return add(...args); };
  signal.removeEventListener = (...args) => { active--; return remove(...args); };
  return () => active;
}

test("publishes the product request budgets", () => {
  assert.deepStrictEqual(R.BUDGETS.metadata, {
    attemptTimeoutMs: 12000, maxAttempts: 3, totalTimeoutMs: 41000, baseDelayMs: 1500, maxDelayMs: 5000,
  });
  assert.deepStrictEqual(R.BUDGETS.evidence, R.BUDGETS.metadata);
  assert.deepStrictEqual(R.BUDGETS.arxiv, {
    attemptTimeoutMs: 10000, maxAttempts: 1, totalTimeoutMs: 10000, baseDelayMs: 0, maxDelayMs: 0,
  });
  assert.strictEqual(R.BUDGETS.dblp.totalTimeoutMs, 12000);
  assert.strictEqual(R.BUDGETS.vllm.totalTimeoutMs, 95000);
  assert.strictEqual(R.BUDGETS.health.totalTimeoutMs, 900);
  assert.ok(Object.isFrozen(R.BUDGETS));
  assert.ok(Object.values(R.BUDGETS).every(Object.isFrozen));
});

test("retries only the declared transient HTTP statuses", () => {
  for (const status of [429, 502, 503, 504]) assert.strictEqual(R.isRetryableStatus(status), true, status);
  for (const status of [400, 404, 408, 500, 501, 505]) assert.strictEqual(R.isRetryableStatus(status), false, status);
});

test("distinguishes success, empty, and not-found results", async () => {
  assert.strictEqual((await R.request(async () => ({ value: 1 }), R.BUDGETS.metadata)).kind, "success");
  assert.strictEqual((await R.request(async () => null, R.BUDGETS.metadata)).kind, "empty");
  assert.strictEqual((await R.request(async () => response(204), R.BUDGETS.metadata)).kind, "empty");
  assert.strictEqual((await R.request(async () => response(404), R.BUDGETS.metadata)).kind, "not_found");
});

test("makes backoff sleep abortable and deadline-bound", async () => {
  await R.sleep(0);
  const controller = new AbortController();
  const pending = R.sleep(100, { signal: controller.signal });
  setTimeout(() => controller.abort("stop waiting"), 2);
  await assert.rejects(pending, error => error.kind === "cancelled" && error.reason === "stop waiting");
  await assert.rejects(
    R.sleep(100, { deadlineAt: Date.now() + 5 }),
    error => error.kind === "deadline_timeout" && error.scope === "total",
  );
});

test("retries transient HTTP responses and caps Retry-After", async () => {
  let attempts = 0;
  const started = Date.now();
  const result = await R.request(async () => {
    attempts++;
    return attempts === 1 ? response(429, "999999") : response(200);
  }, { attemptTimeoutMs: 100, totalTimeoutMs: 150, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 12 });
  assert.strictEqual(result.kind, "success");
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(attempts, 2);
  assert.ok(Date.now() - started < 100);
});

test("clamps invalid, negative, dated, and extreme Retry-After values", () => {
  assert.strictEqual(R.retryAfterMs(response(429, "bad"), 300, 5000, 0), 300);
  assert.strictEqual(R.retryAfterMs(response(429, "Infinity"), 300, 5000, 0), 300);
  assert.strictEqual(R.retryAfterMs(response(429, "-2"), 300, 5000, 0), 0);
  assert.strictEqual(R.retryAfterMs(response(429, "999"), 300, 5000, 0), 5000);
  assert.strictEqual(R.retryAfterMs(response(429, "Thu, 01 Jan 1970 00:00:02 GMT"), 300, 5000, 0), 2000);
});

test("bounds a never-resolving attempt with a typed deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    R.request(() => new Promise(() => {}), {
      attemptTimeoutMs: 15, totalTimeoutMs: 80, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1,
    }),
    error => error.kind === "deadline_timeout" && error.attempts === 2,
  );
  assert.ok(Date.now() - started < 100);
});

test("caller cancellation is immediate, terminal, and never retried", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = R.request(() => {
    attempts++;
    return new Promise(() => {});
  }, { ...R.BUDGETS.metadata, signal: controller.signal });
  setTimeout(() => controller.abort("new run"), 5);
  await assert.rejects(pending, error => error.kind === "cancelled" && error.reason === "new run");
  assert.strictEqual(attempts, 1);
});

test("reports exhausted transport and HTTP failures distinctly from not-found", async () => {
  let transportAttempts = 0;
  await assert.rejects(
    R.request(async () => { transportAttempts++; throw new Error("offline"); }, {
      attemptTimeoutMs: 50, totalTimeoutMs: 100, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1,
    }),
    error => error.kind === "retry_exhausted" && error.reason === "transport" && error.attempts === 3,
  );
  assert.strictEqual(transportAttempts, 3);
  await assert.rejects(
    R.request(async () => response(403), { attemptTimeoutMs: 50, totalTimeoutMs: 50, maxAttempts: 3 }),
    error => error.kind === "retry_exhausted" && error.reason === "http" && error.status === 403 && error.attempts === 1,
  );
});

test("lets the total deadline win over a longer backoff", async () => {
  const started = Date.now();
  await assert.rejects(
    R.request(async () => response(503, "999"), {
      attemptTimeoutMs: 50, totalTimeoutMs: 20, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 5000,
    }),
    error => error.kind === "deadline_timeout" && error.scope === "total",
  );
  assert.ok(Date.now() - started < 80);
});

test("rejects operation results that arrive after their absolute deadline", async () => {
  let now = 0;
  await assert.rejects(
    R.request(async () => {
      now = 25;
      return response(200);
    }, {
      attemptTimeoutMs: 50,
      totalTimeoutMs: 5,
      maxAttempts: 1,
      now: () => now,
    }),
    error => error.kind === "deadline_timeout" && error.scope === "total",
  );

  now = 0;
  let attempts = 0;
  const recovered = await R.request(async () => {
    attempts++;
    if (attempts === 1) now = 6;
    return response(200);
  }, {
    attemptTimeoutMs: 5,
    totalTimeoutMs: 50,
    maxAttempts: 2,
    now: () => now,
  });
  assert.strictEqual(recovered.attempts, 2);

  now = 0;
  await assert.rejects(
    R.request(async () => {
      now = 25;
      throw new Error("late transport failure");
    }, {
      attemptTimeoutMs: 50,
      totalTimeoutMs: 5,
      maxAttempts: 1,
      now: () => now,
    }),
    error => error.kind === "deadline_timeout" && error.scope === "total",
  );
});

test("cleans internal timers and caller listeners on every exit path", async () => {
  async function runCase(execute, action, expectedKind) {
    const controller = new AbortController();
    const listeners = listenerTracker(controller.signal);
    const timers = timerTracker();
    const pending = R.request(execute, {
      signal: controller.signal,
      attemptTimeoutMs: 12,
      totalTimeoutMs: 20,
      maxAttempts: 1,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    action?.(controller);
    if (expectedKind) await assert.rejects(pending, error => error.kind === expectedKind);
    else await pending;
    assert.strictEqual(timers.count(), 0);
    assert.strictEqual(listeners(), 0);
  }
  await runCase(async () => response(200));
  await runCase(async () => { throw new Error("offline"); }, null, "retry_exhausted");
  await runCase(() => new Promise(() => {}), null, "deadline_timeout");
  await runCase(() => new Promise(() => {}), controller => setTimeout(() => controller.abort(), 2), "cancelled");
});

test("JSONP caller abort synchronously removes every late-publication surface", async () => {
  const controller = new AbortController();
  const root = { location: { origin: "https://example.test" } };
  let appended = null;
  let removed = false;
  let cleared = 0;
  const document = {
    createElement: () => ({ remove: () => { removed = true; } }),
    head: { appendChild: script => { appended = script; } },
  };
  const pending = R.jsonp("https://dblp.test/search?q=x", {
    root, document, signal: controller.signal,
    callbackName: "__testDblp", timeoutMs: 12000,
    setTimer: () => 17,
    clearTimer: id => { assert.strictEqual(id, 17); cleared++; },
  });
  const lateCallback = root.__testDblp;
  assert.ok(appended.src.includes("callback=__testDblp"));
  controller.abort("run B started");
  await assert.rejects(pending, error => error.kind === "cancelled" && error.reason === "run B started");
  assert.strictEqual(removed, true);
  assert.strictEqual(cleared, 1);
  assert.strictEqual(root.__testDblp, undefined);
  lateCallback({ result: "late A" });
  appended.onerror?.();
});

test("loads the browser module before every future request consumer", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "docs", "index.html"), "utf8");
  const requestIndex = html.indexOf("request.js?v=");
  for (const script of ["vllm-reranker.js?v=", "citation-audit.js?v=", "app.js?v="])
    assert.ok(requestIndex >= 0 && html.indexOf(script) > requestIndex, script);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }
  if (failed) process.exit(1);
})();
