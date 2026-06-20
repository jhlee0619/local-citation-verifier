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
      "Choose the single best metadata record for the BibTeX entry and classify whether it is safe to apply automatically.",
      "Return only JSON like {\"best\": 1, \"status\": \"updated\", \"confidence\": 0.82, \"risk_flags\": [], \"reason\": \"same paper with DOI enrichment\"}.",
      "Allowed status values: verified, updated, needs_review, not_found.",
      "Use verified only when the BibTeX entry already matches the selected record and no material change is needed.",
      "Use updated only when the selected record is clearly the same paper and changes are safe enrichments, venue normalizations, DOI additions, or same-paper preprint to published-version upgrades.",
      "Use needs_review when the title is generic or ambiguous, the first author differs, the year differs by more than one, the venue changes to an unrelated journal/conference, or volume/pages contradict.",
      "Use not_found when no candidate is the same paper.",
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

  function normalizedStatus(value) {
    const status = String(value || "").toLowerCase().replace(/[-\s]+/g, "_");
    if (status === "auto_updated") return "updated";
    if (["verified", "updated", "needs_review", "not_found"].includes(status)) return status;
    return null;
  }

  function parseJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try {
      return JSON.parse(candidate);
    } catch (_) {
      const match = candidate.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        return null;
      }
    }
  }

  function parseDecision(text, candidateCount, parseChoice) {
    const index = parseChoice(text, candidateCount);
    if (index === null) return null;
    const parsed = parseJsonObject(text);
    const status = normalizedStatus(parsed?.status);
    const confidence = Number(parsed?.confidence);
    const riskFlags = Array.isArray(parsed?.risk_flags)
      ? parsed.risk_flags.filter(flag => typeof flag === "string")
      : [];
    return {
      index,
      status,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "",
      riskFlags,
    };
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
    const output = await model.complete([{ role: "user", content: prompt }], { maxNewTokens: 160 });
    const decision = parseDecision(output, candidates.length, parseChoice);
    if (!decision) return null;
    return { ...decision, candidate: candidates[decision.index], output };
  }

  exports.GEMMA_MODULE_URL = GEMMA_MODULE_URL;
  exports.canUseWebGPU = canUseWebGPU;
  exports.buildPrompt = buildPrompt;
  exports.parseDecision = parseDecision;
  exports.rerank = rerank;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibGemmaReranker = {}));
