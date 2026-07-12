(function (root, factory) {
  const requestApi = typeof module !== "undefined" && module.exports
    ? require("./request.js")
    : root.BibRequest;
  const api = factory(requestApi);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BibWebGpuEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (requestApi) {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 120000;

  class WebGpuEngineError extends Error {
    constructor(kind, message, details = {}) {
      super(message);
      this.name = "WebGpuEngineError";
      this.kind = kind;
      Object.assign(this, details);
    }
  }

  function createEngine(options = {}) {
    if (!requestApi?.request && !options.request) throw new Error("BibRequest is required.");
    if (typeof options.load !== "function") throw new TypeError("load must be a function");
    const request = options.request || requestApi.request;
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const requestOptions = options.requestOptions || {};
    let enabled = !!options.enabled;
    let loadAttempted = false;
    let loadPromise = null;
    let quarantined = false;
    let quarantineCause = null;
    let queueTail = Promise.resolve();

    function state() {
      return Object.freeze({ enabled, loadAttempted, quarantined, quarantineCause });
    }

    function setEnabled(value) {
      enabled = !!value;
      return state();
    }

    function unavailable(kind, message, cause) {
      return new WebGpuEngineError(kind, message, cause ? { cause } : {});
    }

    function ensureUsable(onStatus) {
      if (!enabled) throw unavailable("disabled", "Experimental WebGPU is not enabled.");
      if (!quarantined) return;
      onStatus?.("WebGPU quarantined until page reload · using safe fallback");
      throw unavailable("quarantined", "WebGPU is quarantined until page reload.", quarantineCause);
    }

    function quarantine(scope, error, onStatus) {
      quarantined = true;
      quarantineCause ||= error;
      onStatus?.("WebGPU quarantined until page reload · using safe fallback");
      const kind = error?.kind === "deadline_timeout" ? `${scope}_timeout` : `${scope}_failed`;
      return unavailable(kind, `WebGPU ${scope} failed; page reload is required.`, error);
    }

    async function bounded(scope, operation, onStatus) {
      try {
        const outcome = await request(({ signal }) => operation(signal), {
          ...requestOptions,
          attemptTimeoutMs: timeoutMs,
          totalTimeoutMs: timeoutMs,
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        });
        return outcome.value;
      } catch (error) {
        throw quarantine(scope, error, onStatus);
      }
    }

    function load(onStatus) {
      ensureUsable(onStatus);
      if (!loadAttempted) {
        loadAttempted = true;
        const safeStatus = message => { if (!quarantined) onStatus?.(message); };
        loadPromise = bounded(
          "load",
          signal => options.load({ signal, onStatus: safeStatus }),
          onStatus,
        );
      }
      return loadPromise;
    }

    function complete(messages, completeOptions = {}) {
      const onStatus = completeOptions.onStatus;
      const modelOptions = { ...completeOptions };
      delete modelOptions.onStatus;
      const job = queueTail.then(async () => {
        ensureUsable(onStatus);
        const model = await load(onStatus);
        ensureUsable(onStatus);
        return bounded(
          "complete",
          () => model.complete(messages, modelOptions),
          onStatus,
        );
      });
      queueTail = job.catch(() => undefined);
      return job;
    }

    return Object.freeze({ setEnabled, state, load, complete });
  }

  return { DEFAULT_TIMEOUT_MS, WebGpuEngineError, createEngine };
});
