(function (exports) {
  "use strict";

  const GEMMA_MODULE_URL =
    "https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/resolve/main/gemma-4-e2b.js";

  let modelPromise = null;

  function canUseWebGPU() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
  }

  function candidateSummary(candidate, index) {
    return [
      `${index + 1}.`,
      `title=${JSON.stringify(candidate.title || "")}`,
      `authors=${JSON.stringify(candidate.author || "")}`,
      `year=${JSON.stringify(candidate.year || "")}`,
      `venue=${JSON.stringify(candidate.journal || candidate.booktitle || "")}`,
      `doi=${JSON.stringify(candidate.doi || "")}`,
      `source=${JSON.stringify(candidate._source || "")}`,
    ].join(" ");
  }

  function buildPrompt(original, candidates, options = {}) {
    const versionRule = options.preferPublished
      ? "If a preprint and a published journal/conference version are the same paper, prefer the published version."
      : "Do not prefer a published version unless it better matches the BibTeX entry.";
    return [
      "Choose the single best metadata record for the BibTeX entry.",
      "Return only JSON like {\"best\": 1}.",
      `Prefer the exact same paper, matching title/authors/year. ${versionRule}`,
      "",
      `BibTeX title: ${original.title || ""}`,
      `BibTeX authors: ${original.author || ""}`,
      `BibTeX year: ${original.year || ""}`,
      `BibTeX venue: ${original.journal || original.booktitle || ""}`,
      "",
      "Candidates:",
      ...candidates.map(candidateSummary),
    ].join("\n");
  }

  async function loadModel(onStatus) {
    if (!canUseWebGPU()) throw new Error("WebGPU is not available in this browser.");
    if (!modelPromise) {
      modelPromise = import(GEMMA_MODULE_URL).then(({ Gemma4Mobile }) =>
        Gemma4Mobile.load(null, {
          onProgress: event => {
            const message = event.message || event.status || "Loading Gemma";
            onStatus?.(message);
          },
        }));
    }
    return modelPromise;
  }

  async function rerank({ original, candidates, parseChoice, preferPublished, onStatus }) {
    if (!candidates || candidates.length < 2) return null;
    onStatus?.("Loading Gemma WebGPU reranker...");
    const model = await loadModel(onStatus);
    onStatus?.("Reranking candidates on local GPU...");
    const prompt = buildPrompt(original, candidates, { preferPublished });
    const output = await model.complete([{ role: "user", content: prompt }], { maxNewTokens: 24 });
    const index = parseChoice(output, candidates.length);
    if (index === null) return null;
    return { index, candidate: candidates[index], output };
  }

  exports.GEMMA_MODULE_URL = GEMMA_MODULE_URL;
  exports.canUseWebGPU = canUseWebGPU;
  exports.buildPrompt = buildPrompt;
  exports.rerank = rerank;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibGemmaReranker = {}));
