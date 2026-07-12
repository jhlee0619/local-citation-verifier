(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BibRequest = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BUDGETS = Object.freeze({
    metadata: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 3, totalTimeoutMs: 41000, baseDelayMs: 1500, maxDelayMs: 5000 }),
    search: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 3, totalTimeoutMs: 41000, baseDelayMs: 1500, maxDelayMs: 5000 }),
    evidence: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 3, totalTimeoutMs: 41000, baseDelayMs: 1500, maxDelayMs: 5000 }),
    arxiv: Object.freeze({ attemptTimeoutMs: 10000, maxAttempts: 1, totalTimeoutMs: 10000, baseDelayMs: 0, maxDelayMs: 0 }),
    dblp: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 1, totalTimeoutMs: 12000, baseDelayMs: 0, maxDelayMs: 0 }),
    vllm: Object.freeze({ attemptTimeoutMs: 95000, maxAttempts: 1, totalTimeoutMs: 95000, baseDelayMs: 0, maxDelayMs: 0 }),
    health: Object.freeze({ attemptTimeoutMs: 900, maxAttempts: 1, totalTimeoutMs: 900, baseDelayMs: 0, maxDelayMs: 0 }),
  });

  class RequestError extends Error {
    constructor(kind, message, details = {}) {
      super(message);
      this.name = "RequestError";
      this.kind = kind;
      Object.assign(this, details);
    }
  }

  function cancelled(reason) {
    return new RequestError("cancelled", "request cancelled by caller", { reason });
  }

  function timedOut(scope, attempts) {
    return new RequestError("deadline_timeout", `${scope} deadline exceeded`, { scope, attempts });
  }

  function retryExhausted(attempts, details = {}) {
    return new RequestError("retry_exhausted", "request attempts exhausted", { attempts, ...details });
  }

  function timerApi(options = {}) {
    return {
      set: options.setTimer || setTimeout,
      clear: options.clearTimer || clearTimeout,
      now: options.now || Date.now,
    };
  }

  function sleep(ms, options = {}) {
    const timers = timerApi(options);
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(cancelled(signal.reason));
    const started = timers.now();
    const delay = Math.max(0, Number(ms) || 0);
    const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity;
    const hitsDeadline = deadlineAt <= started + delay;
    const wait = Math.max(0, Math.min(delay, deadlineAt - started));
    if (wait === 0) return hitsDeadline ? Promise.reject(timedOut("total", 0)) : Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (timer !== undefined) timers.clear(timer);
        signal?.removeEventListener?.("abort", onAbort);
      };
      const finish = (fn, value) => { cleanup(); fn(value); };
      const onAbort = () => finish(reject, cancelled(signal.reason));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      timer = timers.set(() => finish(
        hitsDeadline ? reject : resolve,
        hitsDeadline ? timedOut("total", 0) : undefined,
      ), wait);
    });
  }

  function retryAfterMs(response, fallbackMs, maxDelayMs, now = Date.now()) {
    const cap = Math.max(0, Number(maxDelayMs) || 0);
    const fallback = Math.min(cap, Math.max(0, Number(fallbackMs) || 0));
    const raw = response?.headers?.get?.("Retry-After");
    if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
    const seconds = Number(raw);
    if (Number.isFinite(seconds))
      return seconds < 0 ? 0 : Math.min(cap, seconds * 1000);
    const date = Date.parse(raw);
    const parsed = Number.isFinite(date) ? Math.max(0, date - now) : NaN;
    return Number.isFinite(parsed) ? Math.min(cap, Math.max(0, parsed)) : fallback;
  }

  function isRetryableStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  function classifyResponse(value) {
    if (value === null || value === undefined) return { kind: "empty", value: null };
    if (typeof value.status !== "number" || typeof value.ok !== "boolean")
      return { kind: "success", value };
    if (value.status === 204) return { kind: "empty", value: null, response: value };
    if (value.ok) return { kind: "success", value, response: value };
    if (value.status === 404) return { kind: "not_found", value: null, response: value };
    return {
      kind: "http_error",
      response: value,
      status: value.status,
      retryable: isRetryableStatus(value.status),
    };
  }

  function runAttempt(execute, options) {
    const timers = timerApi(options);
    const callerSignal = options.signal;
    if (callerSignal?.aborted) return Promise.reject(cancelled(callerSignal.reason));
    const started = timers.now();
    const remaining = options.deadlineAt - started;
    if (remaining <= 0) return Promise.reject(timedOut("total", options.attempt));
    const scope = remaining <= options.attemptTimeoutMs ? "total" : "attempt";
    const delay = Math.min(remaining, options.attemptTimeoutMs);
    const attemptDeadlineAt = started + delay;
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const cleanup = () => {
        if (timer !== undefined) timers.clear(timer);
        callerSignal?.removeEventListener?.("abort", onCallerAbort);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onCallerAbort = () => {
        const error = cancelled(callerSignal.reason);
        controller.abort(error);
        finish(reject, error);
      };
      const finishOperation = (fn, value) => {
        const completedAt = timers.now();
        const expiredScope = completedAt >= options.deadlineAt
          ? "total"
          : completedAt >= attemptDeadlineAt ? "attempt" : "";
        if (!expiredScope) return finish(fn, value);
        const error = timedOut(expiredScope, options.attempt);
        controller.abort(error);
        finish(reject, error);
      };
      callerSignal?.addEventListener?.("abort", onCallerAbort, { once: true });
      timer = timers.set(() => {
        const error = timedOut(scope, options.attempt);
        controller.abort(error);
        finish(reject, error);
      }, delay);
      Promise.resolve()
        .then(() => execute({ signal: controller.signal, attempt: options.attempt }))
        .then(
          value => finishOperation(resolve, value),
          error => finishOperation(reject, error),
        );
    });
  }

  async function request(execute, options = {}) {
    if (typeof execute !== "function") throw new TypeError("execute must be a function");
    const timers = timerApi(options);
    const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts || 1));
    const attemptTimeoutMs = Math.max(1, Number(options.attemptTimeoutMs) || 1);
    const totalTimeoutMs = Math.max(1, Number(options.totalTimeoutMs) || attemptTimeoutMs);
    const baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 0);
    const maxDelayMs = Math.max(0, Number(options.maxDelayMs) || 0);
    const deadlineAt = timers.now() + totalTimeoutMs;
    const classify = options.classify || classifyResponse;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let outcome;
      try {
        const value = await runAttempt(execute, {
          ...options, attempt, attemptTimeoutMs, deadlineAt,
        });
        outcome = classify(value);
      } catch (error) {
        if (error?.kind === "cancelled") throw error;
        if (error?.kind === "deadline_timeout" && (error.scope === "total" || attempt === maxAttempts))
          throw timedOut(error.scope, attempt);
        if (error?.kind !== "deadline_timeout" && attempt === maxAttempts)
          throw retryExhausted(attempt, { reason: "transport", cause: error });
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        await sleep(delay, { ...options, deadlineAt });
        continue;
      }

      if (outcome.kind !== "http_error") return { ...outcome, attempts: attempt };
      if (!outcome.retryable || attempt === maxAttempts)
        throw retryExhausted(attempt, { reason: "http", status: outcome.status, response: outcome.response });
      const fallback = baseDelayMs * Math.pow(2, attempt - 1);
      const delay = retryAfterMs(outcome.response, fallback, maxDelayMs, timers.now());
      await sleep(delay, { ...options, deadlineAt });
    }
    throw retryExhausted(maxAttempts);
  }

  return {
    BUDGETS,
    RequestError,
    sleep,
    request,
    retryAfterMs,
    isRetryableStatus,
    classifyResponse,
  };
});
