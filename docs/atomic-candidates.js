(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BibAtomicCandidates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CORE_FIELDS = ["title", "author", "year"];
  const PUBLICATION_FIELDS = ["ENTRYTYPE", "journal", "booktitle", "volume", "number", "pages", "publisher"];
  const IDENTIFIER_FIELDS = ["doi", "eprint", "url", "archiveprefix", "archivePrefix", "primaryclass", "primaryClass"];
  const DOI_PRIORITY = ["crossref_doi", "crossref_search", "dblp", "openreview", "semantic_scholar_match", "semantic_scholar_search", "local_arxiv"];
  const ARXIV_PRIORITY = ["local_arxiv", "openreview", "semantic_scholar_match", "semantic_scholar_search", "dblp", "crossref_doi", "crossref_search"];
  const SURNAME_PARTICLES = new Set(["d", "da", "das", "de", "del", "della", "den", "der", "di", "dos", "du", "la", "le", "t", "te", "ten", "ter", "van", "von", "zu", "zum", "zur"]);

  function present(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  function normalizeDoi(value) {
    return String(value || "").trim().toLowerCase()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
  }

  function normalizeArxiv(value) {
    const match = String(value || "").trim().match(/(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/)?([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i);
    return match ? match[1].toLowerCase() : "";
  }

  function arxivId(entry) {
    return normalizeArxiv(entry?._arxivId || entry?.eprint || entry?.url || "");
  }

  function normalizedText(value) {
    return String(value || "").toLowerCase().replace(/\\[a-z]+/gi, " ")
      .replace(/[{}]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }

  function surnameSignature(author) {
    return String(author || "").split(/\s+and\s+/i).map(name => {
      const parts = normalizedText(name.includes(",") ? name.split(",")[0] : name).split(" ").filter(Boolean);
      if (name.includes(",")) return parts.join(" ");
      let start = parts.length - 1;
      while (start > 0 && SURNAME_PARTICLES.has(parts[start - 1])) start--;
      return parts.slice(start).join(" ");
    }).filter(Boolean).sort().join("|");
  }

  function correctionClass(title) {
    const normalized = normalizedText(title);
    if (/\b(retraction|withdrawn)\b/.test(normalized)) return "retraction";
    if (/\b(correction|corrigendum|erratum|errata)\b/.test(normalized)) return "correction";
    return "regular";
  }

  function isPreprintVenue(value) {
    return /\b(arxiv|biorxiv|medrxiv|openrxiv|ssrn|preprint|corr)\b/i.test(normalizedText(value));
  }

  function versionClass(entry) {
    const doi = normalizeDoi(entry?.doi || entry?.DOI);
    const venue = entry?.journal || entry?.booktitle || "";
    const publishedDoi = doi && !/^10\.48550\/arxiv\./.test(doi);
    if (publishedDoi || (present(venue) && !isPreprintVenue(venue))) return "published";
    if (arxivId(entry) || isPreprintVenue(venue)) return "preprint";
    return "unknown";
  }

  function stableRecordText(entry) {
    return Object.keys(entry || {}).filter(key => !key.startsWith("_")).sort()
      .map(key => {
        const name = key.toLowerCase();
        const value = name === "doi" ? normalizeDoi(entry[key])
          : name === "eprint" ? normalizeArxiv(entry[key]) : normalizedText(entry[key]);
        return `${name}:${value}`;
      }).join("\u001f");
  }

  function fingerprint(entry) {
    const text = stableRecordText(entry);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function createRecord(entry, options = {}) {
    const source = String(options.recordSource || entry?._recordSource || entry?._source || "unknown");
    const recordId = String(options.recordId || entry?._recordId || `fp:${fingerprint(entry)}`);
    const retrieval = options.retrieval || "provider";
    const out = { ...(entry || {}) };
    out._source = source;
    out._recordSource = source;
    out._recordId = recordId;
    out._versionClass = versionClass(out);
    out._coreSource = source;
    out._fieldProvenance = {};
    for (const [field, value] of Object.entries(out)) {
      if (field.startsWith("_") || !present(value)) continue;
      out._fieldProvenance[field] = Object.freeze({ source, candidateId: recordId, retrieval });
    }
    Object.freeze(out._fieldProvenance);
    return Object.freeze(out);
  }

  function createOriginal(entry) {
    const doi = normalizeDoi(entry?.doi || entry?.DOI);
    const arxiv = arxivId(entry);
    const recordId = doi ? `doi:${doi}` : arxiv ? `arxiv:${arxiv}` : entry?.ID || `fp:${fingerprint(entry)}`;
    return createRecord(entry, { recordSource: "original", recordId, retrieval: "input" });
  }

  function recordKey(entry) {
    return `${entry?._recordSource || entry?._source || "unknown"}\u001f${entry?._recordId || `fp:${fingerprint(entry)}`}`;
  }

  function dedupeRecords(records) {
    const byKey = new Map();
    for (const candidate of records || []) {
      if (!candidate) continue;
      const key = recordKey(candidate);
      const existing = byKey.get(key);
      if (!existing || stableRecordText(candidate) < stableRecordText(existing)) byKey.set(key, candidate);
    }
    return [...byKey.values()].sort((a, b) => recordKey(a).localeCompare(recordKey(b)) || fingerprint(a).localeCompare(fingerprint(b)));
  }

  function coreTuple(entry) {
    return { title: entry?.title || "", author: entry?.author || "", year: entry?.year || "" };
  }

  function completeCore(entry) {
    return present(entry?.title) && present(entry?.author) && /^\d{4}$/.test(String(entry?.year || ""));
  }

  function directLinkKinds(original, candidate) {
    const kinds = [];
    const originalDoi = normalizeDoi(original?.doi || original?.DOI);
    const candidateDoi = normalizeDoi(candidate?.doi || candidate?.DOI);
    if (originalDoi && candidateDoi === originalDoi) kinds.push("doi");
    const originalArxiv = arxivId(original);
    const candidateArxiv = arxivId(candidate);
    if (originalArxiv && candidateArxiv === originalArxiv) kinds.push("arxiv");
    return kinds;
  }

  function coreSignature(entry) {
    return [normalizedText(entry?.title), surnameSignature(entry?.author), String(entry?.year || ""), correctionClass(entry?.title)].join("\u001f");
  }

  function sourcePriority(source, kind) {
    const order = kind === "doi" ? DOI_PRIORITY : ARXIV_PRIORITY;
    const index = order.indexOf(source);
    return index < 0 ? order.length : index;
  }

  function selectedLinkKind(original, candidate) {
    const kinds = directLinkKinds(original, candidate);
    return kinds.includes("doi") ? "doi" : kinds[0] || "";
  }

  function orderEligible(original, records) {
    return records.slice().sort((a, b) => {
      const ak = selectedLinkKind(original, a);
      const bk = selectedLinkKind(original, b);
      return sourcePriority(a._recordSource, ak) - sourcePriority(b._recordSource, bk) || recordKey(a).localeCompare(recordKey(b)) || fingerprint(a).localeCompare(fingerprint(b));
    });
  }

  function selectCanonical(originalEntry, candidates, options = {}) {
    const original = originalEntry?._recordSource === "original" ? originalEntry : createOriginal(originalEntry);
    const records = dedupeRecords(candidates);
    const hasStableId = !!(normalizeDoi(original.doi || original.DOI) || arxivId(original));
    const direct = records.filter(candidate => candidate._recordSource !== "local_curation" && directLinkKinds(original, candidate).length);
    const selectedClass = options.preferPublished ? "published" : original._versionClass;
    const eligible = direct.filter(candidate => candidate._versionClass === selectedClass && completeCore(candidate));
    const ordered = orderEligible(original, eligible);
    if (!hasStableId || !ordered.length) {
      return { status: "needs_review", canonical: original, candidates: records, selectedVersionClass: selectedClass, reason: hasStableId ? "no_complete_direct_record" : "original_has_no_stable_id", linkKind: "" };
    }
    if (new Set(ordered.map(coreSignature)).size > 1) {
      return { status: "needs_review", canonical: original, candidates: records, selectedVersionClass: selectedClass, reason: "core_conflict", linkKind: "" };
    }
    const canonical = ordered[0];
    return { status: "auto_apply", canonical, candidates: records, selectedVersionClass: selectedClass, reason: "direct_complete_atomic_record", linkKind: selectedLinkKind(original, canonical) };
  }

  function enrichNonCore(canonical, sources, options = {}) {
    const linkKind = options.linkKind;
    if (!linkKind) return canonical;
    const linked = dedupeRecords(sources).filter(source => source !== canonical && directLinkKinds(canonical, source).includes(linkKind));
    const out = { ...canonical, _fieldProvenance: { ...(canonical._fieldProvenance || {}) } };
    for (const source of linked) {
      for (const field of IDENTIFIER_FIELDS) {
        if (!present(out[field]) && present(source[field])) {
          out[field] = source[field];
          out._fieldProvenance[field] = source._fieldProvenance?.[field];
        }
      }
    }
    const publicationCandidates = linked.filter(source =>
      source._versionClass === canonical._versionClass &&
      String(source.year || "") === String(canonical.year || "") &&
      PUBLICATION_FIELDS.some(field => present(source[field]))
    );
    const agreesWithCanonical = source => PUBLICATION_FIELDS.every(field =>
      !present(canonical[field]) || !present(source[field]) || normalizedText(canonical[field]) === normalizedText(source[field])
    );
    const coversCanonical = source => PUBLICATION_FIELDS.every(field =>
      !present(canonical[field]) || (present(source[field]) && normalizedText(canonical[field]) === normalizedText(source[field]))
    );
    const publicationSource = publicationCandidates.find(source => agreesWithCanonical(source) && coversCanonical(source));
    if (publicationSource) {
      for (const field of PUBLICATION_FIELDS) {
        if (!present(out[field]) && present(publicationSource[field])) {
          out[field] = publicationSource[field];
          out._fieldProvenance[field] = publicationSource._fieldProvenance?.[field];
        }
      }
    }
    out._enrichmentNeedsReview = publicationCandidates.some(source => !agreesWithCanonical(source) || !coversCanonical(source));
    Object.freeze(out._fieldProvenance);
    return Object.freeze(out);
  }

  function userProvenance(candidate) {
    return { actor: "user", source: candidate?._recordSource || candidate?._source || "unknown", candidateId: candidate?._recordId || "" };
  }

  function manualProvenance() {
    return { actor: "user", source: "manual" };
  }

  function mixedCoreProvenance(candidate, edits = {}) {
    const base = candidate ? userProvenance(candidate) : { actor: "system", source: "original", candidateId: "" };
    const fields = {};
    for (const field of CORE_FIELDS) {
      const edit = edits[field];
      if (edit?.action === "original") fields[field] = { actor: "user", source: "original" };
      else if (edit?.action === "custom") fields[field] = edit.provenance || manualProvenance();
      else if (edit?.action === "found") fields[field] = edit.provenance || base;
      else fields[field] = base;
    }
    const sources = new Set(Object.values(fields).map(value => `${value.source}\u001f${value.candidateId || ""}`));
    return { fields, mixed: sources.size > 1 };
  }

  return { CORE_FIELDS, PUBLICATION_FIELDS, IDENTIFIER_FIELDS, normalizeDoi, normalizeArxiv, versionClass, fingerprint, createRecord, createOriginal, dedupeRecords, coreTuple, completeCore, directLinkKinds, selectCanonical, enrichNonCore, userProvenance, manualProvenance, mixedCoreProvenance };
});
