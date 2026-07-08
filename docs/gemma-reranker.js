(function (exports) {
  "use strict";

  const GEMMA_MODULE_URL =
    "https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/resolve/main/gemma-4-e2b.js";

  let modelPromise = null;

  const ALLOWED_RISK_FLAGS = [
    "title_mismatch",
    "author_mismatch",
    "year_mismatch",
    "venue_conflict",
    "volume_pages_conflict",
    "generic_title",
    "uncertain_version",
    "no_same_paper",
  ];
  const ALLOWED_RISK_FLAG_SET = new Set(ALLOWED_RISK_FLAGS);

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

  function normalizeEvidenceLanguage(value) {
    const lang = String(value || "").toLowerCase();
    return lang === "ko" || lang === "kor" || lang === "korean" ? "ko" : "en";
  }

  function reasonLanguageInstruction(language) {
    return normalizeEvidenceLanguage(language) === "ko"
      ? "Write the reason in Korean."
      : "Write the reason in English.";
  }

  function buildPrompt(original, candidates, options = {}) {
    const versionRule = options.preferPublished
      ? "If a preprint and a published journal/conference version are the same paper, prefer the published version."
      : "Do not prefer a published version unless it better matches the BibTeX entry.";
    const candidateCount = candidates.length;
    return [
      "Choose the single best metadata record for the BibTeX entry and classify whether it is safe to apply automatically.",
      `Return only strict JSON: {"best": 1, "status": "updated", "confidence": 0.82, "risk_flags": [], "reason": "same paper with DOI enrichment"}.`,
      `The best must be an integer from 1 to ${candidateCount}; do not return 0, null, or a candidate title.`,
      "Allowed status values: verified, updated, needs_review, not_found.",
      `Allowed risk_flags: ${ALLOWED_RISK_FLAGS.join(", ")}. Use only these exact snake_case strings.`,
      "JSON keys, status values, and risk_flags must remain in English even when the reason uses another language.",
      reasonLanguageInstruction(options.language),
      "Use verified only when the BibTeX entry already matches the selected record and no material change is needed.",
      "Use updated only when the selected record is clearly the same paper and changes are safe enrichments, venue normalizations, DOI additions, or same-paper preprint to published-version upgrades.",
      "Use needs_review when the title is generic or ambiguous, the first author differs, the year differs by more than one, the venue changes to an unrelated journal/conference, or volume/pages contradict.",
      `If status is not_found, still set best to the closest candidate number, add risk_flags ["no_same_paper"], and explain that no candidate is the same paper.`,
      "If any risk_flags are present, prefer needs_review unless status is not_found.",
      `Prefer the exact same paper, matching title/authors/year. ${versionRule}`,
      "Example: same title/authors with CoRR/arXiv and journal candidates -> choose the journal candidate with status updated and empty risk_flags.",
      "Example: same short title but different first author or unrelated venue -> choose the closest candidate with status needs_review and risk_flags such as author_mismatch or venue_conflict.",
      "Do not invent metadata, DOI, authors, venues, or candidates. Reason must be 16 words or fewer.",
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

  function normalizeRiskFlag(value) {
    const flag = String(value || "").toLowerCase().replace(/[-\s]+/g, "_");
    return ALLOWED_RISK_FLAG_SET.has(flag) ? flag : null;
  }

  function normalizedRiskFlags(values) {
    if (!Array.isArray(values)) return [];
    const flags = [];
    const seen = new Set();
    for (const value of values) {
      const flag = normalizeRiskFlag(value);
      if (!flag || seen.has(flag)) continue;
      seen.add(flag);
      flags.push(flag);
    }
    return flags;
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
    const riskFlags = normalizedRiskFlags(parsed?.risk_flags);
    const safeStatus = riskFlags.length && status !== "not_found" ? "needs_review" : status;
    return {
      index,
      status: safeStatus,
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

  async function rerank({ original, candidates, parseChoice, preferPublished, language, onStatus }) {
    if (!candidates || candidates.length < 2) return null;
    onStatus?.("Loading Gemma WebGPU reranker...");
    const model = await loadModel(onStatus);
    onStatus?.("Reranking candidates on local GPU...");
    const prompt = buildPrompt(original, candidates, { preferPublished, language });
    const output = await model.complete([{ role: "user", content: prompt }], { maxNewTokens: 160 });
    const decision = parseDecision(output, candidates.length, parseChoice);
    if (!decision) return null;
    return { ...decision, candidate: candidates[decision.index], output };
  }

  async function completePrompt(prompt, { maxNewTokens = 220, onStatus } = {}) {
    if (!prompt || typeof prompt !== "string") throw new Error("Prompt is required.");
    onStatus?.("Loading Gemma WebGPU model...");
    const model = await loadModel(onStatus);
    onStatus?.("Running local WebGPU judgement...");
    return model.complete([{ role: "user", content: prompt }], { maxNewTokens });
  }

  exports.GEMMA_MODULE_URL = GEMMA_MODULE_URL;
  exports.ALLOWED_RISK_FLAGS = ALLOWED_RISK_FLAGS;
  exports.canUseWebGPU = canUseWebGPU;
  exports.buildPrompt = buildPrompt;
  exports.parseDecision = parseDecision;
  exports.rerank = rerank;
  exports.completePrompt = completePrompt;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibGemmaReranker = {}));
