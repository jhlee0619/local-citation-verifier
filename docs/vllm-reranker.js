(function (exports) {
  "use strict";

  const DEFAULT_ENDPOINT = "/api/rerank/vllm";
  const RERANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const rerankCache = new Map();

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

  async function rerank({ original, candidates, parseChoice, preferPublished, language, onStatus, endpoint }) {
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
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, candidate_count: candidates.length }),
    });

    if (!response.ok)
      throw new Error(`vLLM rerank failed with HTTP ${response.status}`);

    const data = await response.json();
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

  async function health(endpoint) {
    const url = endpoint || `${DEFAULT_ENDPOINT}/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return { ready: false };
      return response.json();
    } catch (_) {
      return { ready: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  exports.DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
  exports.rerank = rerank;
  exports.clearCache = clearCache;
  exports.health = health;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibVllmReranker = {}));
