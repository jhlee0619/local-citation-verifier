(function (exports) {
  "use strict";

  const DEFAULT_ENDPOINT = "/api/rerank/vllm";

  async function rerank({ original, candidates, parseChoice, preferPublished, onStatus, endpoint }) {
    if (!candidates || candidates.length < 2) return null;
    const root = typeof window !== "undefined" ? window : globalThis;
    if (!root.BibGemmaReranker?.buildPrompt)
      throw new Error("Prompt builder is unavailable.");

    const url = endpoint || DEFAULT_ENDPOINT;
    const prompt = root.BibGemmaReranker.buildPrompt(original, candidates, { preferPublished });
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
    const index = parseChoice(output, candidates.length);
    if (index === null) return null;
    return { index, candidate: candidates[index], output };
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
  exports.health = health;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibVllmReranker = {}));
