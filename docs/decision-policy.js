(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BibDecisionPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CORE_FIELDS = ["title", "author", "year"];
  const ORIGINAL_DEFAULT_STATUSES = new Set([
    "verified", "needs_review", "not_found", "lookup_failed", "cancelled", "parse_failed",
  ]);

  function present(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  function provenance(actor, source, candidateId) {
    const out = { actor, source };
    if (candidateId) out.candidateId = candidateId;
    return Object.freeze(out);
  }

  function originalDecision(touched = false) {
    return Object.freeze({
      action: "original",
      source: "original",
      candidateId: "",
      touched: !!touched,
      provenance: provenance(touched ? "user" : "system", "original"),
    });
  }

  function candidateDecision(candidate, candidateIndex = 0, touched = true) {
    const source = candidate?._recordSource || "unknown";
    const candidateId = candidate?._recordId || "";
    return Object.freeze({
      action: "candidate",
      candidateIndex,
      source,
      candidateId,
      touched: !!touched,
      provenance: provenance(touched ? "user" : "system", source, candidateId),
    });
  }

  function excludeDecision() {
    return Object.freeze({
      action: "exclude",
      source: "manual",
      candidateId: "",
      touched: true,
      provenance: provenance("user", "manual"),
    });
  }

  function completeCore(candidate) {
    return present(candidate?.title) && present(candidate?.author) && /^\d{4}$/.test(String(candidate?.year || ""));
  }

  function autoEligible(status, candidate) {
    return status === "updated" &&
      candidate?._autoEligible === true &&
      candidate?._canonicalStatus === "auto_apply" &&
      candidate?._canonicalReason === "direct_complete_atomic_record" &&
      (candidate?._directLinkKind === "doi" || candidate?._directLinkKind === "arxiv") &&
      candidate?._recordSource !== "local_curation" &&
      candidate?._enrichmentNeedsReview !== true &&
      completeCore(candidate) &&
      candidate?._versionClass === candidate?._selectedVersionClass;
  }

  function initialDecision(status, candidate, candidateIndex = 0) {
    if (autoEligible(status, candidate)) return candidateDecision(candidate, candidateIndex, false);
    return originalDecision(false);
  }

  function initialOutcome(status, candidate, candidateIndex = 0) {
    const normalizedStatus = status === "updated" && !autoEligible(status, candidate)
      ? "needs_review"
      : status;
    return Object.freeze({
      status: normalizedStatus,
      decision: initialDecision(normalizedStatus, candidate, candidateIndex),
    });
  }

  function fieldEdit(action, value, options = {}) {
    const candidate = options.candidate;
    let fieldProvenance = provenance("user", "original");
    if (action === "found" && candidate)
      fieldProvenance = provenance("user", candidate._recordSource || "unknown", candidate._recordId || "");
    if (action === "custom" || action === "remove") fieldProvenance = provenance("user", "manual");
    return {
      action,
      value,
      touched: true,
      provenance: options.provenance || fieldProvenance,
      ...options.extra,
    };
  }

  function isTouched(decision, edits = {}) {
    return !!decision?.touched || Object.values(edits).some(edit => edit?.touched);
  }

  function canApplySuggestion(decision, edits = {}) {
    return !isTouched(decision, edits);
  }

  function resolveCandidate(candidates = [], decision = {}) {
    if (decision.action !== "candidate") return null;
    if (decision.source || decision.candidateId) {
      return candidates.find(candidate =>
        candidate?._recordSource === decision.source && candidate?._recordId === decision.candidateId
      ) || null;
    }
    return candidates[decision.candidateIndex] || null;
  }

  function applyDecision(options) {
    const original = options.original || {};
    const decision = options.decision || originalDecision(false);
    const selected = resolveCandidate(options.candidates, decision);
    const applyCandidate = options.applyCandidate || ((entry, candidate) => ({ ...entry, ...candidate }));
    const coreFields = options.coreFields || CORE_FIELDS;
    const entry = selected ? applyCandidate(original, selected) : { ...original };
    const originalId = original.ID || options.originalId || "original";
    const fieldProvenance = Object.fromEntries(coreFields.map(field => [field,
      provenance("system", "original", originalId),
    ]));

    if (selected) {
      for (const field of coreFields) {
        if (present(selected[field])) fieldProvenance[field] = provenance(
          decision.touched ? "user" : "system",
          selected._recordSource || decision.source || "unknown",
          selected._recordId || decision.candidateId || "",
        );
      }
    }

    const edits = selected || decision.action !== "candidate"
      ? options.fieldEdits || {}
      : Object.fromEntries(
        Object.entries(options.fieldEdits || {}).filter(([, edit]) => edit?.touched),
      );
    for (const [field, edit] of Object.entries(edits)) {
      if (!edit) continue;
      if (edit.action === "found" || edit.action === "custom") {
        if (present(edit.value)) entry[field] = edit.value;
      } else if (edit.action === "original") {
        if (present(original[field])) entry[field] = original[field];
        else delete entry[field];
      } else if (edit.action === "remove") {
        delete entry[field];
      }
      if (coreFields.includes(field) && edit.provenance) fieldProvenance[field] = edit.provenance;
    }

    const sources = new Set(Object.values(fieldProvenance).map(item => `${item.source}\u001f${item.candidateId || ""}`));
    return { entry, provenance: fieldProvenance, mixed: sources.size > 1, selectedCandidate: selected };
  }

  function createStore() {
    return { decisions: {}, fieldEdits: {} };
  }

  return {
    CORE_FIELDS,
    ORIGINAL_DEFAULT_STATUSES,
    provenance,
    originalDecision,
    candidateDecision,
    excludeDecision,
    autoEligible,
    initialDecision,
    initialOutcome,
    fieldEdit,
    isTouched,
    canApplySuggestion,
    resolveCandidate,
    applyDecision,
    createStore,
  };
});
