/*
 * Network primitives: bounded requests with deadlines, retries and caller
 * cancellation, a TTL cache with per-run pending entries, shared provider
 * budgets and a bounded work queue. DOM-free.
 */

  // ─── Requests ──────────────────────────────────────────────────────
  const BUDGETS = Object.freeze({
    metadata: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 3, totalTimeoutMs: 41000, baseDelayMs: 1500, maxDelayMs: 5000 }),
    search: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 3, totalTimeoutMs: 41000, baseDelayMs: 1500, maxDelayMs: 5000 }),
    evidence: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 3, totalTimeoutMs: 41000, baseDelayMs: 1500, maxDelayMs: 5000 }),
    arxiv: Object.freeze({ attemptTimeoutMs: 10000, maxAttempts: 1, totalTimeoutMs: 10000, baseDelayMs: 0, maxDelayMs: 0 }),
    dblp: Object.freeze({ attemptTimeoutMs: 12000, maxAttempts: 1, totalTimeoutMs: 12000, baseDelayMs: 0, maxDelayMs: 0 }),
    vllm: Object.freeze({ attemptTimeoutMs: 95000, maxAttempts: 1, totalTimeoutMs: 95000, baseDelayMs: 0, maxDelayMs: 0 }),
    health: Object.freeze({ attemptTimeoutMs: 900, maxAttempts: 1, totalTimeoutMs: 900, baseDelayMs: 0, maxDelayMs: 0 }),
    // The one-time GET /api/health probe: a second try absorbs a cold start.
    proxy: Object.freeze({ attemptTimeoutMs: 5000, maxAttempts: 2, totalTimeoutMs: 11000, baseDelayMs: 500, maxDelayMs: 500 }),
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
      set: options.setTimer || ((fn, ms) => setTimeout(fn, ms)),
      clear: options.clearTimer || (timer => clearTimeout(timer)),
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

  function isCancelled(error) {
    return error?.kind === "cancelled" || error?.name === "AbortError";
  }

  function throwIfAborted(signal, error) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : error;
  }

  // ─── Deadlines shared across several requests ──────────────────────
  function budgetDeadline(budget, now = Date.now()) {
    return now + Math.max(1, Number(budget?.totalTimeoutMs) || 1);
  }

  function remainingBudget(budget, deadlineAt, now = Date.now()) {
    const remaining = Math.floor(Number(deadlineAt) - now);
    if (remaining <= 0) return null;
    return {
      ...(budget || {}),
      attemptTimeoutMs: Math.min(Math.max(1, Number(budget?.attemptTimeoutMs) || 1), remaining),
      totalTimeoutMs: remaining,
    };
  }

  function responseClassifier(requestApi, value) {
    if (value?.__providerJson === true) return { kind: "success", value: value.value };
    return requestApi.classifyResponse(value);
  }

  async function requestJson(url, params, options = {}) {
    const requestApi = options.requestApi;
    if (!requestApi?.request) throw new TypeError("requestApi is required");
    const target = new URL(url, options.origin || "http://localhost");
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") target.searchParams.set(key, value);
    }
    const fetchFn = options.fetch || fetch;
    const outcome = await requestApi.request(async ({ signal, attempt }) => {
      await options.beforeAttempt?.({ signal, attempt });
      const response = await fetchFn(target.toString(), { ...(options.fetchOptions || {}), signal });
      options.onResponse?.(response);
      if (response.status === 204) return response;
      if (!response.ok) return response;
      // responseType "text": the body as text (NCBI ECitMatch answers text/plain).
      return { __providerJson: true, value: options.responseType === "text" ? await response.text() : await response.json() };
    }, {
      ...(options.budget || {}),
      signal: options.signal,
      classify: value => responseClassifier(requestApi, value),
    });
    if (outcome.kind !== "success") return null;
    return outcome.value?.__providerJson === true ? outcome.value.value : outcome.value;
  }

  // ─── Rate pacing ───────────────────────────────────────────────────
  // "1s", "500ms", "2m" (x-rate-limit-interval) → milliseconds, else NaN.
  function parseIntervalMs(value) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(String(value ?? ""));
    if (!match) return NaN;
    const unit = (match[2] || "s").toLowerCase();
    return Number(match[1]) * (unit === "ms" ? 1 : unit === "m" ? 60_000 : 1000);
  }

  // The limits a response announces: x-rate-limit-limit requests per
  // x-rate-limit-interval, x-concurrency-limit requests at a time (Crossref);
  // X-RateLimit-Limit requests per second (NCBI E-utilities, live
  // 2026-10-10: 3 without an API key, exposed to pages by CORS).
  function rateLimitHeaders(response) {
    const get = name => response?.headers?.get?.(name) ?? null;
    const limit = Number(get("x-rate-limit-limit"));
    const interval = parseIntervalMs(get("x-rate-limit-interval"));
    const perSecond = Number(get("x-ratelimit-limit"));
    const concurrency = Number(get("x-concurrency-limit"));
    return {
      intervalMs: limit > 0 && interval > 0 ? Math.ceil(interval / limit)
        : perSecond > 0 ? Math.ceil(1000 / perSecond) : null,
      concurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : null,
    };
  }

  // Paces the requests to one rate-limited service: at most `concurrency`
  // run at a time (FIFO), each starts at least intervalMs after the previous
  // start, and none starts before a 429 pause ends. observe(response) learns
  // the limits the service announces (rateLimitHeaders; concurrency is capped
  // at maxConcurrency) and pauses on 429 for Retry-After, else for a doubling
  // backoff. run(task, { signal }) waits its turn outside the task, so queue
  // time never counts against a request's own deadlines; spacing(signal) is
  // the same wait for a retry attempt inside a running task. options.now /
  // setTimer / clearTimer replace the clock (tests).
  function createRatePacer(options = {}) {
    const timers = timerApi(options);
    const maxConcurrency = Math.max(1, Math.floor(Number(options.maxConcurrency) || 1));
    const maxPauseMs = Math.max(0, Number(options.maxPauseMs ?? 60_000));
    let concurrency = Math.min(maxConcurrency, Math.max(1, Math.floor(Number(options.concurrency) || 1)));
    let intervalMs = Math.max(0, Number(options.intervalMs) || 0);
    let lastStart = -Infinity;
    let pausedUntil = -Infinity;
    let backoffs = 0;
    let active = 0;
    const waiting = [];

    function pump() {
      while (active < concurrency && waiting.length) {
        active++;
        waiting.shift().grant();
      }
    }

    async function spacing(signal) {
      for (;;) {
        const wait = Math.max(lastStart + intervalMs, pausedUntil) - timers.now();
        if (!(wait > 0)) break;
        await sleep(wait, { ...options, signal });
      }
      lastStart = timers.now();
    }

    async function acquire(signal) {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(cancelled(signal.reason));
          return;
        }
        const waiter = {
          grant: () => {
            signal?.removeEventListener?.("abort", onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const index = waiting.indexOf(waiter);
          if (index < 0) return;
          waiting.splice(index, 1);
          reject(cancelled(signal.reason));
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });
        waiting.push(waiter);
        pump();
      });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      try {
        await spacing(signal);
      } catch (error) {
        release();
        throw error;
      }
      return release;
    }

    async function run(task, { signal } = {}) {
      const release = await acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    }

    function observe(response) {
      const limits = rateLimitHeaders(response);
      if (limits.intervalMs !== null) intervalMs = limits.intervalMs;
      if (limits.concurrency !== null) {
        concurrency = Math.min(maxConcurrency, limits.concurrency);
        pump();
      }
      if (response?.status === 429) {
        backoffs++;
        const fallback = Math.max(1000, intervalMs) * 2 ** (backoffs - 1);
        const now = timers.now();
        pausedUntil = Math.max(pausedUntil, now + retryAfterMs(response, fallback, maxPauseMs, now));
      } else if (response?.ok) {
        backoffs = 0;
      }
    }

    return {
      run,
      spacing,
      observe,
      state: () => ({ intervalMs, concurrency, pausedUntil, active, waiting: waiting.length }),
    };
  }

  // ─── TTL cache ─────────────────────────────────────────────────────
  function cacheAbortError(reason) {
    const error = new Error(typeof reason === "string" ? reason : "cache lookup cancelled");
    error.name = "AbortError";
    error.kind = "cancelled";
    error.reason = reason;
    return error;
  }

  function createTtlCache(options = {}) {
    const ttlMs = Math.max(0, Number(options.ttlMs || 0));
    const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries || 512)));
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const entries = new Map();
    const pruneExpired = timestamp => {
      for (const [key, entry] of entries)
        if (entry.expiresAt <= timestamp) entries.delete(key);
    };
    const reserve = key => {
      pruneExpired(now());
      entries.delete(key);
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    };
    return {
      get(key) {
        const entry = entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= now()) {
          entries.delete(key);
          return undefined;
        }
        entries.delete(key);
        entries.set(key, entry);
        return entry.value;
      },
      set(key, value) {
        if (ttlMs <= 0) return value;
        reserve(key);
        entries.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      },
      async getOrSet(key, producer, pendingOptions = {}) {
        const cached = this.get(key);
        if (cached !== undefined) return cached;
        const runId = pendingOptions.runId ?? "shared";
        const pendingKey = `${key}::pending:${runId}`;
        const pendingEntry = entries.get(pendingKey);
        if (pendingEntry && pendingEntry.expiresAt > now()) {
          entries.delete(pendingKey);
          entries.set(pendingKey, pendingEntry);
          return pendingEntry.value;
        }
        if (pendingEntry) entries.delete(pendingKey);
        const signal = pendingOptions.signal;
        let removeAbortListener = () => {};
        const produced = Promise.resolve().then(() => {
          if (signal?.aborted) throw cacheAbortError(signal.reason);
          return producer();
        });
        const abortable = signal ? new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            callback(value);
          };
          const onAbort = () => finish(reject, cacheAbortError(signal.reason));
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          produced.then(value => finish(resolve, value), error => finish(reject, error));
        }) : produced;
        const promise = abortable.then(value => {
          entries.delete(pendingKey);
          removeAbortListener();
          if (!signal?.aborted) this.set(key, value);
          return value;
        }, err => {
          entries.delete(pendingKey);
          removeAbortListener();
          throw err;
        });
        reserve(pendingKey);
        entries.set(pendingKey, { value: promise, expiresAt: now() + ttlMs });
        return promise;
      },
      clear() { entries.clear(); },
      size() { return entries.size; },
    };
  }

  // ─── Bounded work queue ────────────────────────────────────────────
  async function runBoundedQueue(items, worker, options = {}) {
    const list = Array.from(items || []);
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency || 1)));
    const results = new Array(list.length);
    let nextIndex = 0;
    async function runWorker() {
      while (!options.signal?.aborted && nextIndex < list.length) {
        const index = nextIndex++;
        const result = await worker(list[index], index);
        if (options.signal?.aborted) continue;
        results[index] = result;
        if (typeof options.onResult === "function") options.onResult(result, index);
      }
    }
    const workerCount = Math.min(concurrency, list.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
  }

export {
  BUDGETS,
  RequestError,
  sleep,
  request,
  retryAfterMs,
  isRetryableStatus,
  classifyResponse,
  isCancelled,
  throwIfAborted,
  budgetDeadline,
  remainingBudget,
  requestJson,
  parseIntervalMs,
  rateLimitHeaders,
  createRatePacer,
  createTtlCache,
  runBoundedQueue,
};
