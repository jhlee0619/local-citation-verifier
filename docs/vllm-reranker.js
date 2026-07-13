(function (exports) {
  "use strict";

  const DEFAULT_ENDPOINT = "/api/rerank/vllm";
  const RERANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const rerankCache = new Map();
  const NODE_REQUEST = typeof module !== "undefined" && module.exports ? require("./request.js") : null;

  function cacheKey(endpoint, prompt, candidates) {
    const ids = (candidates || []).map(candidate => [
      candidate.doi || "",
      candidate.eprint || candidate._arxivId || "",
      candidate.title || "",
      candidate.year || "",
    ].join("|"));
    return JSON.stringify([endpoint, prompt, ids]);
  }

  function getCachedDecision(key) {
    const cached = rerankCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      rerankCache.delete(key);
      return null;
    }
    return cached.value;
  }

  function setCachedDecision(key, value) {
    rerankCache.set(key, { value, expiresAt: Date.now() + RERANK_CACHE_TTL_MS });
    return value;
  }

  function clearCache() {
    rerankCache.clear();
  }

  function throwIfAborted(signal, error) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : error;
  }

  async function rerank({
    original, candidates, parseChoice, preferPublished, language, onStatus, endpoint, signal,
    requestApi: requestOverride, fetch: fetchOverride,
  }) {
    if (!candidates || candidates.length < 2) return null;
    const root = typeof window !== "undefined" ? window : globalThis;
    if (!root.BibGemmaReranker?.buildPrompt)
      throw new Error("Prompt builder is unavailable.");

    const url = endpoint || DEFAULT_ENDPOINT;
    const prompt = root.BibGemmaReranker.buildPrompt(original, candidates, { preferPublished, language });
    const key = cacheKey(url, prompt, candidates);
    const cached = getCachedDecision(key);
    if (cached) return cached;
    onStatus?.("Reranking candidates with local vLLM server...");
    const requestApi = requestOverride || root.BibRequest || NODE_REQUEST;
    const fetchFn = fetchOverride || fetch;
    const outcome = await requestApi.request(async ({ signal: attemptSignal }) => {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, candidate_count: candidates.length }),
        signal: attemptSignal,
      });
      return response.ok ? response.json() : response;
    }, { ...requestApi.BUDGETS.vllm, signal });
    const data = outcome.value || {};
    throwIfAborted(signal);
    const output = String(data.output || "");
    const decision = root.BibGemmaReranker.parseDecision
      ? root.BibGemmaReranker.parseDecision(output, candidates.length, parseChoice)
      : null;
    const index = decision ? decision.index : parseChoice(output, candidates.length);
    if (index === null) return null;
    return setCachedDecision(key, {
      index,
      candidate: candidates[index],
      output,
      status: decision?.status || null,
      confidence: decision?.confidence ?? null,
      reason: decision?.reason || "",
      riskFlags: decision?.riskFlags || [],
    });
  }

  async function health(endpoint, options = {}) {
    const url = endpoint || `${DEFAULT_ENDPOINT}/health`;
    const root = typeof window !== "undefined" ? window : globalThis;
    const requestApi = options.requestApi || root.BibRequest || NODE_REQUEST;
    const fetchFn = options.fetch || fetch;
    try {
      const outcome = await requestApi.request(async ({ signal }) => {
        const response = await fetchFn(url, { signal });
        return response.ok ? response.json() : response;
      }, { ...requestApi.BUDGETS.health, signal: options.signal });
      return outcome.value || { ready: false };
    } catch (error) {
      if (error?.kind === "cancelled") throw error;
      return { ready: false };
    }
  }

  exports.DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
  exports.rerank = rerank;
  exports.clearCache = clearCache;
  exports.health = health;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibVllmReranker = {}));
