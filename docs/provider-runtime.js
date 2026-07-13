(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BibProviderRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SOURCE_NAMES = Object.freeze({
    semantic_scholar_match: "Semantic Scholar",
    semantic_scholar_search: "Semantic Scholar",
    crossref_search: "CrossRef",
    crossref_doi: "CrossRef DOI enrichment",
    dblp: "DBLP",
    openreview: "OpenReview",
    local_arxiv: "arXiv enrichment",
    vllm: "local vLLM",
    citation_evidence: "citation evidence",
  });

  function normalizedTitle(value) {
    return String(value || "").toLowerCase()
      .replace(/\\[a-z]+/gi, " ")
      .replace(/[{}]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function noticeClass(title) {
    const normalized = normalizedTitle(title);
    if (/\b(retraction|withdrawn)\b/.test(normalized)) return "retraction";
    if (/\b(correction|corrigendum|erratum|errata)\b/.test(normalized)) return "correction";
    return "regular";
  }

  function isCancelled(error) {
    return error?.kind === "cancelled" || error?.name === "AbortError";
  }

  function isRelevantCandidate(original, candidate, options = {}) {
    if (!candidate) return false;
    if (candidate._recordSource === "local_curation") return true;
    if (options.directLinkKinds?.(original, candidate)?.length) return true;
    const score = options.titleSimilarity?.(original?.title || "", candidate.title || "") || 0;
    return score >= (options.minTitleSim || 0) && noticeClass(original?.title) === noticeClass(candidate.title);
  }

  function relevantCandidates(original, candidates, options = {}) {
    return (candidates || []).filter(candidate => isRelevantCandidate(original, candidate, options));
  }

  function candidateKey(candidate) {
    const source = candidate?._recordSource || candidate?._source || "";
    const id = candidate?._recordId || candidate?.doi || candidate?.eprint || "";
    if (source || id) return `${source}\u001f${id}`;
    return [candidate?.title, candidate?.author, candidate?.year].map(value => String(value || "")).join("\u001f");
  }

  function reviewCandidates(original, candidates, rankedCandidates, options = {}) {
    const available = candidates || [];
    const direct = available.filter(candidate => options.directLinkKinds?.(original, candidate)?.length);
    const ordered = [...direct, ...(rankedCandidates || [])];
    if (!ordered.length) ordered.push(...available);
    const seen = new Set();
    return ordered.filter(candidate => {
      const key = candidateKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, Math.max(1, Number(options.limit) || available.length || 1));
  }

  function failureOutcomes(outcomes) {
    return (outcomes || []).filter(outcome => outcome?.state === "failure");
  }

  function throwCancellation(outcomes) {
    const cancelled = failureOutcomes(outcomes).find(outcome => isCancelled(outcome.error));
    if (cancelled) throw cancelled.error;
  }

  function classifyAbsence(outcomes, candidates) {
    throwCancellation(outcomes);
    if ((candidates || []).length) return "candidate";
    return failureOutcomes(outcomes).some(outcome => outcome.role === "primary")
      ? "lookup_failed"
      : "not_found";
  }

  function warningText(outcome) {
    const name = SOURCE_NAMES[outcome.source] || "A metadata provider";
    const error = outcome.error || {};
    if (error.kind === "rate_limited" || error.status === 429)
      return `${name} was rate limited.`;
    if (error.kind === "deadline_timeout")
      return `${name} timed out or was unavailable.`;
    return `${name} was unavailable.`;
  }

  function sourceWarnings(outcomes) {
    throwCancellation(outcomes);
    const bySource = new Map();
    for (const outcome of failureOutcomes(outcomes)) {
      const group = outcome.source?.startsWith("semantic_scholar") ? "semantic_scholar" : outcome.source;
      const current = bySource.get(group);
      const warning = warningText(outcome);
      const rank = text => text?.includes("rate limited") ? 3 : text?.includes("timed out") ? 2 : 1;
      if (!current || rank(warning) > rank(current))
        bySource.set(group, warning);
    }
    return [...bySource.values()];
  }

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
      return { __providerJson: true, value: await response.json() };
    }, {
      ...(options.budget || {}),
      signal: options.signal,
      classify: value => responseClassifier(requestApi, value),
    });
    if (outcome.kind !== "success") return null;
    return outcome.value?.__providerJson === true ? outcome.value.value : outcome.value;
  }

  return {
    noticeClass,
    isCancelled,
    isRelevantCandidate,
    relevantCandidates,
    reviewCandidates,
    classifyAbsence,
    sourceWarnings,
    budgetDeadline,
    remainingBudget,
    requestJson,
  };
});
