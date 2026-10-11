/*
 * Local LLM judge: one engine-agnostic interface (rerank, complete, health)
 * over an engines map, the rerank prompt, and the strict JSON / rerank-choice
 * parsers. Engines are "off" (no model, deterministic) and "vllm" (the
 * operator's local vLLM server behind the proxy). DOM-free.
 * To add an engine, add one entry to ENGINES.
 */
import * as Net from "./net.js?v=20261012-s18";
import { normalizeEvidenceLanguage } from "./text.js?v=20261012-s18";
import { promptInstructions } from "./versions.js?v=20261012-s18";

  // ─── Rerank prompt and parsing ─────────────────────────────────────
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

  function candidateSummary(candidate, index) {
    return [
      `${index + 1}.`,
      `version=${JSON.stringify(candidate._versionClusterKey || "")}`,
      `family=${JSON.stringify(candidate._versionFamily || "")}`,
      `title=${JSON.stringify(candidate.title || "")}`,
      `authors=${JSON.stringify(candidate.author || "")}`,
      `year=${JSON.stringify(candidate.year || "")}`,
      `venue=${JSON.stringify(candidate.journal || candidate.booktitle || "")}`,
      `doi=${JSON.stringify(candidate.doi || "")}`,
      `source=${JSON.stringify(candidate._source || "")}`,
    ].join(" ");
  }

  function reasonLanguageInstruction(language) {
    return normalizeEvidenceLanguage(language) === "ko"
      ? "Write the reason in Korean."
      : "Write the reason in English.";
  }

  function buildRerankPrompt(original, candidates, options = {}) {
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
      `Prefer the exact same paper. Title and authors must match; a one-year preprint-to-published gap is expected. ${versionRule}`,
      promptInstructions(options),
      "Example: same title/authors with CoRR/arXiv and journal candidates -> choose the journal candidate with status updated and empty risk_flags.",
      "Example: same short title but different first author or unrelated venue -> choose the closest candidate with status needs_review and risk_flags such as author_mismatch or venue_conflict.",
      "Example: BibTeX is already a clean ICLR record and only arXiv is listed -> keep the ICLR meaning; do not pick the preprint.",
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

  // The 0-based choice of one parsed answer object, or null.
  function choiceIndex(parsed, candidateCount) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || candidateCount < 1) return null;
    const n = Number(parsed.best ?? parsed.choice ?? parsed.index ?? parsed.candidate);
    return Number.isInteger(n) && n >= 1 && n <= candidateCount ? n - 1 : null;
  }

  // The 0-based candidate index from the model's JSON object (fenced or
  // bare). Free text is not searched for numbers.
  function parseRerankChoice(text, candidateCount) {
    return choiceIndex(parseJsonObject(text), candidateCount);
  }

  // index, status, confidence, risk flags and reason all come from the same
  // JSON object; without one valid object there is no decision.
  function parseDecision(text, candidateCount) {
    const parsed = parseJsonObject(text);
    const index = choiceIndex(parsed, candidateCount);
    if (index === null) return null;
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

  // ─── vLLM server ───────────────────────────────────────────────────
  const VLLM_ENDPOINT = "/api/rerank/vllm";
  const RERANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const RERANK_CACHE_MAX_ENTRIES = 128;

  const rerankCache = Net.createTtlCache({
    ttlMs: RERANK_CACHE_TTL_MS,
    maxEntries: RERANK_CACHE_MAX_ENTRIES,
  });

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
    return rerankCache.get(key) || null;
  }

  function setCachedDecision(key, value) {
    return rerankCache.set(key, value);
  }

  function clearVllmCache() {
    rerankCache.clear();
  }

  async function rerankVllm({
    original, candidates, preferPublished, language, onStatus, endpoint, signal,
    requestApi: requestOverride, fetch: fetchOverride,
  }) {
    if (!candidates || candidates.length < 2) return null;

    const url = endpoint || VLLM_ENDPOINT;
    const prompt = buildRerankPrompt(original, candidates, { preferPublished, language });
    const key = cacheKey(url, prompt, candidates);
    const cached = getCachedDecision(key);
    if (cached) return cached;
    onStatus?.("Reranking candidates with local vLLM server...");
    const requestApi = requestOverride || Net;
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
    Net.throwIfAborted(signal);
    const output = String(data.output || "");
    const decision = parseDecision(output, candidates.length);
    if (!decision) return null;
    return setCachedDecision(key, { ...decision, candidate: candidates[decision.index], output });
  }

  async function vllmHealth(endpoint, options = {}) {
    const url = endpoint || `${VLLM_ENDPOINT}/health`;
    const requestApi = options.requestApi || Net;
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

  async function completeVllm(prompt, onStatus, signal, requestOverride, fetchOverride) {
    onStatus?.("Judging citation support with local vLLM server...");
    const requestApi = requestOverride || Net;
    const fetchFn = fetchOverride || fetch;
    const outcome = await requestApi.request(async ({ signal: attemptSignal }) => {
      const response = await fetchFn(VLLM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, candidate_count: 1, max_tokens: 220 }),
        signal: attemptSignal,
      });
      return response.ok ? response.json() : response;
    }, { ...requestApi.BUDGETS.vllm, signal });
    const data = outcome.value || {};
    return String(data.output || "");
  }

  // ─── Engines ───────────────────────────────────────────────────────
  // Each engine: { rerank(args), complete(prompt, opts), health(opts) }.
  // Unknown or "off" engines never reach a model. GitHub Pages has no local
  // proxy, so the vLLM engine never requests /api/* there: it is not ready,
  // reranks nothing and refuses to complete.
  const onGithubPages = () => typeof window !== "undefined" && !!window.location?.hostname?.endsWith(".github.io");

  const ENGINES = Object.freeze({
    vllm: Object.freeze({
      rerank: args => (onGithubPages() ? Promise.resolve(null) : rerankVllm(args)),
      complete: (prompt, { onStatus, signal, requestApi, fetch: fetchFn } = {}) => {
        if (onGithubPages()) return Promise.reject(new Error("The vLLM server is not available on GitHub Pages."));
        return completeVllm(prompt, onStatus, signal, requestApi, fetchFn);
      },
      health: options => (onGithubPages() ? Promise.resolve({ ready: false }) : vllmHealth(undefined, options)),
    }),
  });

  const ENGINE_NAMES = Object.freeze(["off", ...Object.keys(ENGINES)]);

  const normalizeEngine = value => (Object.hasOwn(ENGINES, value) ? value : "off");

  const rerank = ({ engine, ...args }) => {
    const impl = ENGINES[normalizeEngine(engine)];
    return impl ? impl.rerank(args) : Promise.resolve(null);
  };

  const complete = (engine, prompt, options) => {
    const impl = ENGINES[normalizeEngine(engine)];
    if (!impl) throw new Error("No AI engine is selected.");
    return impl.complete(prompt, options);
  };

  const health = (engine, options) => {
    const impl = ENGINES[normalizeEngine(engine)];
    return impl ? impl.health(options) : Promise.resolve({ ready: false });
  };

export {
  ENGINE_NAMES,
  normalizeEngine,
  rerank,
  complete,
  health,
  ALLOWED_RISK_FLAGS,
  buildRerankPrompt,
  parseJsonObject,
  parseRerankChoice,
  parseDecision,
  VLLM_ENDPOINT,
  rerankVllm,
  clearVllmCache,
  vllmHealth,
  completeVllm,
};
