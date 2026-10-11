/*
 * Candidate records: atomic provider records with field provenance, canonical
 * selection, record integrity, field comparison and diffs, ranking, duplicate
 * keys and same-work version clusters. DOM-free.
 */
import {
  abbreviateVenue, arxivIdInText, authorCountsCompatible, authorIntegrityIssues, authorKeys,
  authorListsEquivalent, compareAuthors, coreSignature, entryDoi, entryPmcid, entryPmid, entryVenue,
  extractArxivId, extractOpenReviewForumId, firstAuthorsCompatible, firstAuthorSurname, foldText,
  hasTruncatedAuthorMarker, isConferenceVenueName, isCorrectionTitle, isPlaceholderPages, isPreprintVenue, isSeriesVenue,
  keySimilarity, MIN_TITLE_SIM, normalizeArxivId, normalizeDoi, normalizePages, normalizePmcid, normalizePmid,
  noticeClass, parseYear, present, safeExternalUrl, sameCanonicalPaperUrl, shouldSuppressAuthorSuggestion,
  TITLE_MATCH_THRESHOLD, titleIsSpecific, titleKey, titleSimilarity, tokenSortRatio, venueEquivalent, venueKey,
} from "./text.js?v=20261012-s18";
import { entryPage } from "./pages.js?v=20261012-s18";

  // ─── Fields ────────────────────────────────────────────────────────
  const COMPARED_FIELDS = [
    "ENTRYTYPE", "author", "year", "journal", "booktitle",
    "volume", "number", "pages", "doi", "publisher", "pmid", "pmcid",
  ];

  const CORE_FIELDS = ["title", "author", "year"];
  // Semantic Scholar is discovery-only, so it comes after every authoritative
  // source when an identifier links several records.
  const DOI_PRIORITY = ["crossref_doi", "crossref_search", "pubmed", "proceedings", "dblp", "openreview", "local_arxiv", "semantic_scholar_match", "semantic_scholar_search"];
  const ARXIV_PRIORITY = ["local_arxiv", "openreview", "dblp", "crossref_doi", "crossref_search", "pubmed", "semantic_scholar_match", "semantic_scholar_search"];

  // ─── Source authority ──────────────────────────────────────────────
  // Semantic Scholar records (semantic_scholar_match / _search) may be built
  // from other papers' reference lists, so they are discovery-only: they find
  // candidates, hand off identifiers (their DOI / arXiv / DBLP ids fetch the
  // authoritative records) and stay explicit choices, but never verify,
  // auto-update or round-trip an entry. Crossref, PubMed, arXiv, DBLP and
  // OpenReview are authoritative.
  function sourceAuthority(record) {
    return String(record?._recordSource || record?._source || "").startsWith("semantic_scholar")
      ? "discovery" : "authoritative";
  }

  function isAuthoritative(record) {
    return !!record && sourceAuthority(record) === "authoritative";
  }
  // ─── Atomic records and provenance ─────────────────────────────────
  const CANDIDATE_IDENTITY_FIELDS = new Set([
    "_source",
    "_recordSource",
    "_acquisitionSource",
    "_recordId",
    "_versionClass",
  ]);

  function stableJson(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (typeof value === "object") {
      const fields = Object.keys(value).filter(key => value[key] !== undefined).sort();
      return `{${fields.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? JSON.stringify(String(value)) : encoded;
  }

  function candidateFingerprint(candidate = {}) {
    const identity = Object.fromEntries(Object.entries(candidate).filter(([field, value]) =>
      value !== undefined && typeof value !== "function" &&
      (!field.startsWith("_") || CANDIDATE_IDENTITY_FIELDS.has(field))
    ));
    return stableJson(identity);
  }

  function versionClass(entry) {
    const doi = entryDoi(entry);
    const venue = entryVenue(entry);
    const publishedDoi = doi && !/^10\.48550\/arxiv\./.test(doi);
    if (publishedDoi || (present(venue) && !isPreprintVenue(venue))) return "published";
    if (extractArxivId(entry) || isPreprintVenue(venue)) return "preprint";
    return "unknown";
  }

  function stableRecordText(entry) {
    return Object.keys(entry || {}).filter(key => !key.startsWith("_")).sort()
      .map(key => {
        const name = key.toLowerCase();
        const value = name === "doi" ? normalizeDoi(entry[key])
          : name === "eprint" ? normalizeArxivId(entry[key]) || titleKey(entry[key]) : titleKey(entry[key]);
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
    const doi = entryDoi(entry);
    const arxiv = extractArxivId(entry);
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

  // The core signatures a record answers to: its own, and the one with its
  // online year (_onlineYear: PubMed's epubdate year next to the print year).
  function coreSignatures(record) {
    const own = coreSignature(record);
    const online = parseYear(record?._onlineYear);
    if (!Number.isInteger(online) || online === parseYear(record?.year)) return [own];
    return [own, coreSignature({ ...record, year: String(online) })];
  }

  // Whether the records agree on one core signature (each may answer with
  // its online year).
  function sameCoreSignature(records) {
    let shared = null;
    for (const record of records || []) {
      const signatures = coreSignatures(record);
      shared = shared ? shared.filter(signature => signatures.includes(signature)) : signatures;
      if (!shared.length) return false;
    }
    return true;
  }

  function coreTuple(entry) {
    return { title: entry?.title || "", author: entry?.author || "", year: entry?.year || "" };
  }

  function completeCore(entry) {
    return present(entry?.title) && present(entry?.author) && Number.isInteger(parseYear(entry?.year));
  }

  // How the entry's own identifiers link a record: a shared DOI, arXiv ID,
  // PMID and/or PMCID, the official proceedings page its url names
  // ("page", pages.js) or its OpenReview forum ("openreview").
  function directLinkKinds(original, candidate) {
    const kinds = [];
    const originalDoi = entryDoi(original);
    if (originalDoi && entryDoi(candidate) === originalDoi) kinds.push("doi");
    const originalArxiv = extractArxivId(original);
    if (originalArxiv && extractArxivId(candidate) === originalArxiv) kinds.push("arxiv");
    const originalPmid = entryPmid(original);
    if (originalPmid && entryPmid(candidate) === originalPmid) kinds.push("pmid");
    const originalPmcid = entryPmcid(original);
    if (originalPmcid && entryPmcid(candidate) === originalPmcid) kinds.push("pmcid");
    const originalPage = entryPage(original)?.key;
    if (originalPage && entryPage(candidate)?.key === originalPage) kinds.push("page");
    const originalForum = extractOpenReviewForumId(original?.url || "");
    if (originalForum && extractOpenReviewForumId(candidate?.url || "") === originalForum) kinds.push("openreview");
    return kinds;
  }

  // ─── Identifier confirmation ───────────────────────────────────────
  // Every identifier the entry carries must exist, whichever record confirms
  // the work: a DOI at its registration agency (a Crossref record by DOI or
  // search, a PubMed record, or DataCite), an arXiv ID in arXiv's own record
  // (the arXiv BibTeX through the proxy) or as its DataCite DOI
  // 10.48550/arXiv.<id>, a PMID or PMCID in PubMed.
  const IDENTIFIER_SOURCES = Object.freeze({
    doi: new Set(["crossref_doi", "crossref_search", "pubmed", "datacite"]),
    arxiv: new Set(["local_arxiv", "datacite"]),
    pmid: new Set(["pubmed"]),
    pmcid: new Set(["pubmed"]),
  });
  const IDENTIFIER_OF = Object.freeze({ doi: entryDoi, arxiv: extractArxivId, pmid: entryPmid, pmcid: entryPmcid });

  function confirmsIdentifier(record, kind, id) {
    const source = record?._recordSource || "";
    if (IDENTIFIER_SOURCES[kind].has(source) && IDENTIFIER_OF[kind](record) === id) return true;
    // arXiv's own record of an arXiv ID confirms that ID's DOI.
    const arxiv = kind === "doi" ? arxivIdInText(id) : "";
    return !!arxiv && source === "local_arxiv" && extractArxivId(record) === arxiv;
  }

  // One state per identifier the entry carries, [{ kind, id, state, record }]:
  // "confirmed" when a pooled record (`records`) or a provider check confirms
  // it, else the check's "absent" (definitively not there) or "failed" (the
  // lookup failed), else "unchecked". `checks` maps kind → { id, state,
  // record } (providers.searchCandidatePool: identifiers); record is the one
  // the check found (DataCite, PubMed), if any.
  function identifierStates(entry, records = [], checks = {}) {
    return Object.entries(IDENTIFIER_OF).map(([kind, idOf]) => ({ kind, id: idOf(entry) })).filter(item => item.id)
      .map(({ kind, id }) => {
        const check = checks?.[kind]?.id === id ? checks[kind] : null;
        const confirmed = (records || []).some(record => confirmsIdentifier(record, kind, id)) || check?.state === "confirmed";
        return { kind, id, state: confirmed ? "confirmed" : check?.state || "unchecked", record: check?.record || null };
      });
  }

  function sourcePriority(source, kind) {
    const order = kind === "arxiv" ? ARXIV_PRIORITY : DOI_PRIORITY;
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
    const hasStableId = !!(entryDoi(original) || extractArxivId(original) || entryPmid(original) || entryPmcid(original));
    const direct = records.filter(candidate => directLinkKinds(original, candidate).length);
    const selectedClass = options.preferPublished ? "published" : original._versionClass;
    const eligible = direct.filter(candidate => candidate._versionClass === selectedClass && completeCore(candidate) &&
      !metadataRegressionFields(original, candidate).length);
    const ordered = orderEligible(original, eligible);
    if (!hasStableId || !ordered.length) {
      const hasRegressiveDirect = direct.some(candidate => candidate._versionClass === selectedClass &&
        completeCore(candidate) && metadataRegressionFields(original, candidate).length);
      const reason = hasRegressiveDirect ? "metadata_regression"
        : hasStableId ? "no_complete_direct_record" : "original_has_no_stable_id";
      return { status: "needs_review", canonical: original, candidates: records, selectedVersionClass: selectedClass, reason, linkKind: "" };
    }
    // Only authoritative records can disagree: a Semantic Scholar record of
    // the same DOI may carry the arXiv year (S17).
    const authoritative = ordered.filter(isAuthoritative);
    if (!sameCoreSignature(authoritative.length ? authoritative : ordered)) {
      return { status: "needs_review", canonical: original, candidates: records, selectedVersionClass: selectedClass, reason: "core_conflict", linkKind: "" };
    }
    const canonical = ordered[0];
    return { status: "auto_apply", canonical, candidates: records, selectedVersionClass: selectedClass, reason: "direct_complete_atomic_record", linkKind: selectedLinkKind(original, canonical) };
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

  // ─── Record integrity ──────────────────────────────────────────────
  function entryIntegrityIssues(entry) {
    if (!entry) return [];
    const issues = [...authorIntegrityIssues(entry.author || "")];
    // Duplicate fields / citation keys found by the BibTeX parser.
    issues.push(...(entry._bibIssues || []));
    const doi = entryDoi(entry);
    const arxivId = extractArxivId(entry);
    const arxivDoiMatch = /^10\.48550\/arxiv\.(\S+)$/i.exec(doi);
    const venue = entry.journal || entry.booktitle || "";
    const entryType = String(entry.ENTRYTYPE || "").toLowerCase();
    const hasArxivMarker = !!(arxivId || arxivDoiMatch || isPreprintVenue(venue) || /^arxiv$/i.test(String(entry.archiveprefix || entry.archivePrefix || "")));
    const hasArxivArtifactLink = !!(arxivDoiMatch || arxivIdInText(entry.url || ""));
    const isPreprintRecord = isPreprintVenue(venue) || (!venue && hasArxivMarker);

    if (arxivId && arxivDoiMatch && normalizeArxivId(arxivDoiMatch[1]) !== arxivId)
      issues.push({ code: "arxiv_identifier_mismatch", field: "doi", message: `The arXiv DOI and eprint identify different records (${arxivDoiMatch[1]} vs ${arxivId}).` });
    if (doi && !arxivDoiMatch && isPreprintRecord)
      issues.push({ code: "identifier_artifact_conflict", field: "doi", message: "A non-arXiv DOI is combined with an arXiv preprint record and may identify a different artifact." });
    if (venue && !isPreprintVenue(venue) && hasArxivArtifactLink)
      issues.push({ code: "mixed_manifestation", field: "doi", message: "Published venue metadata is mixed with arXiv preprint identifiers; choose one record version atomically." });

    if (isConferenceVenueName(venue) && entryType && entryType !== "inproceedings")
      issues.push({ code: "entrytype_venue_mismatch", field: "ENTRYTYPE", message: "A conference proceedings venue should use an inproceedings record with booktitle." });
    else if (entryType === "techreport" && (isPreprintVenue(venue) || hasArxivMarker))
      issues.push({ code: "entrytype_venue_mismatch", field: "ENTRYTYPE", message: "This arXiv record mixes a techreport entry type with preprint fields." });
    return issues;
  }

  /**
   * Normalize heterogeneous BibTeX shapes before lookup/compare so source-specific
   * conventions (arXiv-in-journal, NeurIPS-as-journal, placeholder pages) compare fairly.
   */
  function normalizeEntryForLookup(entry) {
    const out = { ...entry };
    const journal = String(out.journal || "").trim();
    const arxivInJournal = arxivIdInText(journal);
    if (arxivInJournal) {
      if (!out.eprint) out.eprint = arxivInJournal;
      if (!out.archiveprefix) out.archiveprefix = "arXiv";
    }
    if (/^arxiv\s*e-?prints?$/i.test(journal)) out.journal = "";

    if (!out.eprint) {
      const fromUrl = arxivIdInText(out.url || "");
      if (fromUrl) out.eprint = fromUrl;
    }

    const pages = String(out.pages || "").trim();
    if (isPlaceholderPages(pages)) delete out.pages;

    const entryType = (out.ENTRYTYPE || "").toLowerCase();
    if (entryType === "article" && journal && !out.booktitle && isConferenceVenueName(journal)) {
      out.booktitle = out.journal;
      delete out.journal;
    }
    return out;
  }

  // ─── Comparison ────────────────────────────────────────────────────
  function metadataRegressionFields(original, candidate) {
    const regressions = [];
    const authorCount = value => String(value || "").split(/\s+and\s+/i).filter(Boolean).length;
    const originalAuthors = authorCount(original?.author);
    const candidateAuthors = authorCount(candidate?.author);
    if (originalAuthors > 0 && candidateAuthors < originalAuthors)
      regressions.push("author");

    const originalPages = normalizePages(String(original?.pages || ""));
    const candidatePages = normalizePages(String(candidate?.pages || ""));
    const pageDetail = value => value.replace(/[^a-z0-9]/gi, "").length + (value.includes("-") ? 2 : 0);
    if (originalPages && !isPlaceholderPages(originalPages) && (!candidatePages ||
        (originalPages !== candidatePages && pageDetail(candidatePages) + 2 < pageDetail(originalPages))))
      regressions.push("pages");
    return regressions;
  }

  function compareField(field, a, b) {
    if (field === "ENTRYTYPE") return foldText(a) === foldText(b) ? 100 : 0;
    if (field === "journal" || field === "booktitle") {
      const na = venueKey(a), nb = venueKey(b);
      if (!na && !nb) return 100;
      if (!na || !nb) return 0;
      if (venueEquivalent(a, b)) return 100;
      return Math.min(99, tokenSortRatio(na, nb));
    }
    const na = foldText(a), nb = foldText(b);
    if (!na && !nb) return 100;
    if (!na || !nb) return 0;
    if (field === "year") return Number.isInteger(parseYear(a)) && parseYear(a) === parseYear(b) ? 100 : 0;
    if (field === "doi") return normalizeDoi(a) === normalizeDoi(b) ? 100 : 0;
    if (field === "pmid") return normalizePmid(a) && normalizePmid(a) === normalizePmid(b) ? 100 : 0;
    if (field === "pmcid") return normalizePmcid(a) && normalizePmcid(a) === normalizePmcid(b) ? 100 : 0;
    if (field === "author") return compareAuthors(a, b);
    if (field === "pages") return normalizePages(na) === normalizePages(nb) ? 100 : tokenSortRatio(na, nb);
    return tokenSortRatio(na, nb);
  }

  function manifestationClass(entry) {
    if (entry?._versionClass === "published" || entry?._versionClass === "preprint")
      return entry._versionClass;
    const doi = entryDoi(entry);
    const venue = entry?.journal || entry?.booktitle || "";
    const publishedDoi = doi && !/^10\.48550\/arxiv\./i.test(doi);
    if (publishedDoi || (venue && !isPreprintVenue(venue))) return "published";
    if (extractArxivId(entry) || isPreprintVenue(venue)) return "preprint";
    return "unknown";
  }

  /**
   * A record is a clean published manifestation when it claims a venue-published
   * version AND its identifiers agree (no arXiv DOI/URL grafted onto the venue
   * record). Provider records that merge a preprint identity with a published
   * venue — e.g. Semantic Scholar dating an ICLR paper by its arXiv posting —
   * are "published" by venue but not clean, and must not satisfy a caller that
   * needs the genuine venue-published version.
   */
  function isCleanPublishedManifestation(entry) {
    if (!entry) return false;
    if (manifestationClass(entry) !== "published") return false;
    return !entryIntegrityIssues(entry).some(issue =>
      issue.code === "mixed_manifestation" || issue.code === "identifier_artifact_conflict");
  }

  function isCrossVersionAlternative(original, found) {
    const originalClass = manifestationClass(original);
    const foundClass = manifestationClass(found);
    return originalClass !== "unknown" && foundClass !== "unknown" && originalClass !== foundClass;
  }

  // The field comparison shown on a card: the title score, per-field
  // differences and enrichments, and the suggested values. Another version
  // or a dissimilar title offers no field diffs. The result status is decided
  // by core/verify.js decide().
  function compareEntry(original, found) {
    const comparableFound = { ...(found || {}) };
    const origTitle = original.title || "";
    const foundTitle = comparableFound.title || "";
    const titleScore = titleSimilarity(origTitle, foundTitle);

    if (isCrossVersionAlternative(original, comparableFound))
      return { title_score: Math.round(titleScore * 10) / 10, field_diffs: [], suggested: {} };

    if (titleScore < TITLE_MATCH_THRESHOLD)
      return { title_score: titleScore, field_diffs: [], suggested: comparableFound };

    const foundJournal = comparableFound.journal || "";
    if (original.booktitle && !original.journal && foundJournal) {
      comparableFound.booktitle = foundJournal;
      delete comparableFound.journal;
    }

    const fieldDiffs = [], enrichments = [];

    for (const field of COMPARED_FIELDS) {
      const origVal = original[field] || "";
      const foundVal = comparableFound[field] || "";
      if (!origVal && !foundVal) continue;

      if (!origVal.trim() && foundVal.trim()) {
        enrichments.push({ field, original: origVal, found: foundVal, score: 0 });
        continue;
      }
      if (origVal.trim() && !foundVal.trim()) continue;

      const score = compareField(field, origVal, foundVal);
      if (score < 100) {
        if (field === "author" && shouldSuppressAuthorSuggestion(origVal, foundVal))
          continue;
        fieldDiffs.push({ field, original: origVal, found: foundVal, score: Math.round(score * 10) / 10 });
      }
    }

    const allDiffs = fieldDiffs.concat(enrichments);
    const suggested = {};
    for (const d of allDiffs) if (d.found) suggested[d.field] = d.found;

    return { title_score: Math.round(titleScore * 10) / 10, field_diffs: allDiffs, suggested };
  }

  /**
   * When compareEntry returns needs_review (title below threshold), field_diffs is empty.
   * Build a full diff against the closest `found` record so the UI can show suggestions
   * and per-field accept / revert actions.
   */
  function fieldDiffsForNeedsReview(original, found) {
    if (!found) return [];
    if (isCrossVersionAlternative(original, found)) return [];
    const merged = { ...found };
    const foundJournal = merged.journal || "";
    if (original.booktitle && !original.journal && foundJournal)
      merged.booktitle = foundJournal;

    const origTitle = original.title || "";
    const foundTitle = merged.title || "";
    const titleScore = titleSimilarity(origTitle, foundTitle);
    const fieldDiffs = [];
    const enrichments = [];

    if ((origTitle.trim() || foundTitle.trim()) && titleScore < 100) {
      fieldDiffs.push({
        field: "title",
        original: origTitle,
        found: foundTitle,
        score: Math.round(titleScore * 10) / 10,
      });
    }

    for (const field of COMPARED_FIELDS) {
      const origVal = original[field] || "";
      const foundVal = merged[field] || "";
      if (!origVal && !foundVal) continue;

      if (!origVal.trim() && foundVal.trim()) {
        enrichments.push({ field, original: origVal, found: foundVal, score: 0 });
        continue;
      }
      if (origVal.trim() && !foundVal.trim()) continue;

      const score = compareField(field, origVal, foundVal);
      if (score < 100) {
        if (field === "author" && shouldSuppressAuthorSuggestion(origVal, foundVal))
          continue;
        fieldDiffs.push({
          field,
          original: origVal,
          found: foundVal,
          score: Math.round(score * 10) / 10,
        });
      }
    }

    return fieldDiffs.concat(enrichments);
  }

  function hasCriticalMetadataConflict(original, found) {
    if (!found) return false;
    const titleTokenCount = titleKey(original.title).split(/\s+/).filter(Boolean).length;
    const hasGenericTitle = titleTokenCount > 0 && titleTokenCount <= 5;

    const originalArxivId = extractArxivId(original);
    const foundArxivId = extractArxivId(found);
    if (originalArxivId && foundArxivId && originalArxivId !== foundArxivId)
      return true;

    const originalYear = parseYear(original.year);
    const foundYear = parseYear(found.year);
    if (Number.isInteger(originalYear) && Number.isInteger(foundYear) && Math.abs(originalYear - foundYear) > 1)
      return true;

    if ((original.author || "").trim() && (found.author || "").trim() && compareAuthors(original.author, found.author) < 50) {
      if (!shouldSuppressAuthorSuggestion(original.author, found.author)) return true;
    }

    const originalVenue = original.journal || original.booktitle || "";
    const foundVenue = found.journal || found.booktitle || "";
    const venueConflict = originalVenue.trim() && foundVenue.trim() &&
      !isPreprintVenue(originalVenue) && !isPreprintVenue(foundVenue) &&
      compareField("journal", originalVenue, foundVenue) < 65;

    const pageConflict = (original.pages || "").trim() && (found.pages || "").trim() &&
      !isPlaceholderPages(original.pages) && !isPlaceholderPages(found.pages) &&
      compareField("pages", original.pages, found.pages) < 100;
    const volumeConflict = (original.volume || "").trim() && (found.volume || "").trim() &&
      compareField("volume", original.volume, found.volume) < 100;
    const issueConflict = (original.number || "").trim() && (found.number || "").trim() &&
      compareField("number", original.number, found.number) < 100;

    if (venueConflict && hasGenericTitle) return true;
    if (pageConflict && (volumeConflict || issueConflict)) return true;
    if (venueConflict && (pageConflict || volumeConflict || issueConflict)) return true;
    return false;
  }

  // ─── Applying a candidate ──────────────────────────────────────────
  // Fields that describe the work (BibTeX and biblatex): a chosen record
  // brings its own, the entry's are dropped, never mixed in. Every other
  // field is the user's annotation (note, annote, keywords, abstract, file,
  // groups, owner, timestamp, x-*, custom fields …) and stays unless the
  // record defines it.
  const BIBLIOGRAPHIC_FIELDS = new Set([
    "title", "author", "editor", "year", "month", "journal", "booktitle", "volume", "number", "pages",
    "publisher", "address", "edition", "series", "chapter", "institution", "school", "organization",
    "howpublished", "type", "doi", "url", "eprint", "archiveprefix", "primaryclass", "eprinttype", "pmid",
    "pmcid", "isbn", "issn", "language", "urldate",
    // biblatex names for the same data, and cross-references that pull it in
    "date", "journaltitle", "issuetitle", "subtitle", "titleaddon", "maintitle", "booksubtitle", "eventtitle",
    "eventdate", "venue", "location", "issue", "part", "eid", "pubstate", "version", "eprintclass", "origdate",
    "shorttitle", "shortjournal", "bookauthor", "translator", "pagetotal", "crossref", "xref",
  ]);

  function applyCandidateToEntry(original, candidate) {
    const candidateType = candidate?.ENTRYTYPE || (candidate?.booktitle
      ? "inproceedings"
      : candidate?.journal ? "article" : "misc");
    const out = {
      ENTRYTYPE: candidateType,
      ID: original?.ID || candidate?.ID || "entry",
    };
    for (const [field, value] of Object.entries(candidate || {})) {
      if (field.startsWith("_") || field === "ID") continue;
      if (!value) continue;
      out[field] = value;
    }
    const defined = new Set(Object.keys(out).map(field => field.toLowerCase()));
    for (const [field, value] of Object.entries(original || {})) {
      const name = field.toLowerCase();
      if (field.startsWith("_") || field === "ID" || field === "ENTRYTYPE" || BIBLIOGRAPHIC_FIELDS.has(name) || defined.has(name)) continue;
      if (present(value)) out[field] = value;
    }
    if ((out.ENTRYTYPE || "").toLowerCase() === "inproceedings" && out.booktitle)
      delete out.journal;
    // The citation key stays the original's, and so does a duplicate-key issue.
    const keyIssues = (original?._bibIssues || []).filter(issue => issue.field === "ID");
    if (keyIssues.length) out._bibIssues = keyIssues;
    return out;
  }

  function paperUrlForEntry(entry) {
    const doi = (entry?.doi || "").trim();
    if (doi) return `https://doi.org/${doi}`;
    const arxivId = extractArxivId(entry);
    const archive = (entry?.archiveprefix || entry?.archivePrefix || "").trim().toLowerCase();
    if (arxivId && (archive === "arxiv" || entry?._arxivId))
      return `https://arxiv.org/abs/${arxivId}`;
    const pmid = entryPmid(entry);
    return safeExternalUrl(entry?.url) || (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "");
  }

  function sourceNames(candidate) {
    const raw = String(candidate?._source || "");
    const names = [];
    if (raw.includes("crossref")) names.push("CrossRef");
    if (raw.includes("pubmed")) names.push("PubMed");
    if (raw.includes("semantic_scholar")) names.push("Semantic Scholar");
    if (raw.includes("arxiv")) names.push("arXiv");
    if (raw.includes("dblp")) names.push("DBLP");
    if (raw.includes("openreview")) names.push("OpenReview");
    if (raw.includes("proceedings")) names.push("Proceedings page");
    return names.length ? Array.from(new Set(names)) : ["candidate"];
  }

  function candidateProvenance(original, candidate) {
    const badges = [];
    const diagnostics = [];
    const warnings = [];

    sourceNames(candidate).forEach(name => badges.push({ label: name, tone: "source" }));
    if (candidate?.doi)
      badges.push({ label: "DOI", tone: "strong" });
    const candidatePmid = entryPmid(candidate);
    if (candidatePmid)
      badges.push({ label: "PMID", tone: "strong" });

    const originalArxivId = extractArxivId(original);
    const candidateArxivId = extractArxivId(candidate);
    if (originalArxivId && candidateArxivId && originalArxivId === candidateArxivId) {
      badges.push({ label: "arXiv exact", tone: "strong" });
      diagnostics.push(`arXiv ID matches ${originalArxivId}.`);
    } else if (originalArxivId && candidateArxivId && originalArxivId !== candidateArxivId) {
      badges.push({ label: "arXiv mismatch", tone: "warn" });
      warnings.push(`Candidate arXiv ID ${candidateArxivId} differs from original ${originalArxivId}.`);
    }

    if (isCorrectionTitle(candidate?.title)) {
      badges.push({ label: "correction notice", tone: "warn" });
      warnings.push("Candidate appears to be a correction, erratum, retraction, or withdrawal notice.");
    }

    if (candidate?._manifestationWarning) {
      badges.push({ label: "version boundary", tone: "warn" });
      warnings.push(candidate._manifestationWarning);
    }

    const originalVenue = original?.journal || original?.booktitle || "";
    const candidateVenueValue = candidate?.journal || candidate?.booktitle || "";
    if (originalVenue && candidateVenueValue && !isPreprintVenue(originalVenue) && isPreprintVenue(candidateVenueValue)) {
      badges.push({ label: "preprint venue", tone: "warn" });
      warnings.push(`Published venue "${originalVenue}" and preprint venue "${candidateVenueValue}" remain separate record alternatives.`);
    }

    if (hasCriticalMetadataConflict(original || {}, candidate || {})) {
      badges.push({ label: "metadata conflict", tone: "warn" });
      warnings.push("Volume, issue, page, venue, year, or author metadata requires review.");
    }

    const integrityIssues = entryIntegrityIssues(candidate || {});
    if (integrityIssues.length) {
      badges.push({ label: "record integrity", tone: "warn" });
      warnings.push(...integrityIssues.map(issue => issue.message));
    }

    let confidence = "Medium";
    if (warnings.length) confidence = "Review";
    else if (candidate?.doi || candidatePmid || (originalArxivId && candidateArxivId === originalArxivId)) confidence = "High";
    else if (!candidate?.doi && !candidateArxivId) confidence = "Low";

    return { confidence, badges, diagnostics, warnings };
  }

  // ─── Duplicate keys ────────────────────────────────────────────────
  function duplicateKeysForEntry(entry) {
    if (!entry) return [];
    const keys = [];
    const doi = entryDoi(entry);
    if (doi) keys.push(`doi:${doi}`);
    const arxivId = extractArxivId(entry);
    if (arxivId) keys.push(`arxiv:${arxivId}`);
    const pmid = entryPmid(entry);
    if (pmid) keys.push(`pmid:${pmid}`);
    // A title is a duplicate key only when it is specific (titleIsSpecific).
    const title = titleIsSpecific(entry.title) ? titleKey(entry.title) : "";
    const firstAuthor = firstAuthorSurname(entry.author);
    if (title && firstAuthor) keys.push(`title:${title}|author:${firstAuthor}`);
    return keys;
  }

  function findDuplicateEntryId(entry, seenKeyToId) {
    if (!entry || !seenKeyToId) return null;
    for (const key of duplicateKeysForEntry(entry)) {
      const existing = seenKeyToId.get(key);
      if (existing) return existing;
    }
    return null;
  }

  function registerDuplicateKeys(entryId, entry, seenKeyToId) {
    if (!entryId || !entry || !seenKeyToId) return;
    for (const key of duplicateKeysForEntry(entry)) {
      if (!seenKeyToId.has(key)) seenKeyToId.set(key, entryId);
    }
  }

  // ─── Ranking ───────────────────────────────────────────────────────
  function dedupeCandidates(candidates) {
    const byRecord = new Map();
    for (const candidate of candidates || []) {
      if (!candidate) continue;
      const source = candidate._recordSource || candidate._source || "unknown";
      const payload = Object.keys(candidate).filter(key => !key.startsWith("_")).sort()
        .map(key => `${key}:${String(candidate[key] ?? "").trim()}`).join("\u001f");
      const recordId = candidate._recordId || `fp:${payload}`;
      const key = `${source}\u001f${recordId}`;
      const existing = byRecord.get(key);
      if (!existing || payload < existing.payload)
        byRecord.set(key, { candidate, payload, key });
    }
    return [...byRecord.values()].sort((a, b) => a.key.localeCompare(b.key) || a.payload.localeCompare(b.payload))
      .map(item => item.candidate);
  }

  function candidateScore(candidate, original, options = {}) {
    const titleScore = titleSimilarity(original.title || "", candidate.title || "");
    if (titleScore < MIN_TITLE_SIM) return -Infinity;

    let score = titleScore;
    const authorScore = compareAuthors(original.author || "", candidate.author || "");
    if ((original.author || "").trim() && (candidate.author || "").trim())
      score += authorScore * 0.25;

    const originalYear = parseYear(original.year);
    const candidateYear = parseYear(candidate.year);
    if (Number.isInteger(originalYear) && Number.isInteger(candidateYear))
      score += originalYear === candidateYear ? 8 : -12;
    if (candidate.doi) score += 4;
    const originalVenue = original.journal || original.booktitle || "";
    if (!isCorrectionTitle(original.title) && isCorrectionTitle(candidate.title))
      score -= 80;
    if ((candidate._source || "").includes("arxiv") && (!originalVenue || isPreprintVenue(originalVenue)))
      score += 35;
    if (candidate.pages) score += 2;
    if (candidate.volume) score += 2;

    const venue = entryVenue(candidate);
    if (options.preferPublished && venue)
      score += isPreprintVenue(venue) ? -10 : 10;
    if (sameCanonicalPaperUrl(original.url, candidate.url))
      score += 20;
    const source = candidate._recordSource || candidate._source || "";
    if (source === "dblp" && originalVenue && !isPreprintVenue(originalVenue) && venue && !isPreprintVenue(venue))
      score += 6;

    return score;
  }

  function sortCandidatesByScore(candidates, original, options = {}) {
    return dedupeCandidates(candidates)
      .map(candidate => ({
        candidate,
        score: candidateScore(candidate, original, options),
      }))
      .filter(item => item.score !== -Infinity)
      .sort((a, b) => b.score - a.score || candidateStableKey(a.candidate).localeCompare(candidateStableKey(b.candidate)))
      .map(item => item.candidate);
  }

  function rerankCandidates(candidates, original, options = {}) {
    const unique = dedupeCandidates(candidates);
    let best = null;
    let bestIndex = -1;
    let bestScore = -Infinity;
    unique.forEach((candidate, index) => {
      const score = candidateScore(candidate, original, options);
      if (score > bestScore || (score === bestScore && best && candidateStableKey(candidate) < candidateStableKey(best))) {
        best = candidate;
        bestIndex = index;
        bestScore = score;
      }
    });
    return {
      best: bestScore === -Infinity ? null : best,
      bestIndex: bestScore === -Infinity ? -1 : bestIndex,
      candidates: unique,
      score: bestScore,
    };
  }

  function candidateStableKey(candidate) {
    return `${candidate?._recordSource || candidate?._source || "unknown"}\u001f${candidate?._recordId || ""}\u001f${titleKey(candidate?.title)}\u001f${candidate?.year || ""}`;
  }

  // ─── Version clusters ──────────────────────────────────────────────
  // Group same-work provider records by publication version (arXiv / ICLR /
  // journal / …) and pick one representative per cluster.

  const CONFERENCE_ALIASES = Object.freeze([
    { key: "iclr", patterns: [/\biclr\b/i, /conference on learning representations/i, /conf\/iclr\//i, /iclr\.cc\//i] },
    { key: "colm", patterns: [/\bcolm\b/i, /conference on language modeling/i, /conf\/colm\//i] },
    { key: "neurips", patterns: [/\bneurips\b/i, /\bnips\b/i, /neural information processing systems/i, /conf\/nips\//i, /conf\/neurips\//i] },
    { key: "icml", patterns: [/\bicml\b/i, /conference on machine learning/i, /conf\/icml\//i] },
    { key: "acl", patterns: [/\bacl\b/i, /association for computational linguistics/i, /conf\/acl\//i, /anthology/i] },
    { key: "emnlp", patterns: [/\bemnlp\b/i, /empirical methods in natural language processing/i, /conf\/emnlp\//i] },
    { key: "naacl", patterns: [/\bnaacl\b/i, /north american chapter/i, /conf\/naacl\//i] },
    { key: "cvpr", patterns: [/\bcvpr\b/i, /computer vision and pattern recognition/i, /conf\/cvpr\//i] },
    { key: "iccv", patterns: [/\biccv\b/i, /international conference on computer vision/i, /conf\/iccv\//i] },
    { key: "eccv", patterns: [/\beccv\b/i, /european conference on computer vision/i, /conf\/eccv\//i] },
    { key: "aaai", patterns: [/\baaai\b/i, /conf\/aaai\//i] },
    { key: "ijcai", patterns: [/\bijcai\b/i, /conf\/ijcai\//i] },
    { key: "kdd", patterns: [/\bkdd\b/i, /knowledge discovery and data mining/i, /conf\/kdd\//i] },
    { key: "chi", patterns: [/\bchi\b/i, /human factors in computing systems/i, /conf\/chi\//i] },
    { key: "www", patterns: [/\bwww\b/i, /world wide web conference/i, /the web conference/i, /conf\/www\//i] },
  ]);

  // PubMed ranks with Crossref's search records (ties break on the source name).
  const PREPRINT_SOURCE_RANK = Object.freeze({
    local_arxiv: 0, openreview: 2, semantic_scholar_match: 3,
    semantic_scholar_search: 4, crossref_doi: 5, crossref_search: 6, pubmed: 6, dblp: 7, proceedings: 7,
  });

  const OPENREVIEW_NATIVE_VENUES = Object.freeze(["iclr", "colm"]);

  const CONFERENCE_SOURCE_RANK = Object.freeze({
    openreview: 1, dblp: 2, proceedings: 2, semantic_scholar_match: 3,
    crossref_doi: 4, crossref_search: 5, pubmed: 5, semantic_scholar_search: 6, local_arxiv: 9,
  });

  const DBLP_FIRST_CONFERENCE_SOURCE_RANK = Object.freeze({
    dblp: 1, proceedings: 1, crossref_doi: 2, semantic_scholar_match: 3,
    openreview: 4, crossref_search: 5, pubmed: 5, semantic_scholar_search: 6, local_arxiv: 9,
  });

  const JOURNAL_SOURCE_RANK = Object.freeze({
    crossref_doi: 0, crossref_search: 2, pubmed: 2, dblp: 3, proceedings: 3,
    semantic_scholar_match: 4, semantic_scholar_search: 5, openreview: 6, local_arxiv: 9,
  });

  function sourceOf(entry) {
    return String(entry?._recordSource || entry?._source || "unknown");
  }

  // Year as cluster-key text ("" when absent).
  function yearOf(entry) {
    const year = parseYear(entry?.year);
    return Number.isInteger(year) ? String(year) : "";
  }

  function dblpKey(entry) {
    return String(entry?._dblpKey || entry?._recordId || "").toLowerCase();
  }

  function hintText(entry) {
    return [
      entryVenue(entry),
      dblpKey(entry),
      entry?._openreviewId || "",
      entry?.url || "",
    ].join(" ");
  }

  function conferenceKey(entry) {
    const hint = hintText(entry);
    for (const alias of CONFERENCE_ALIASES) {
      if (alias.patterns.some(pattern => pattern.test(hint))) return alias.key;
    }
    if (isConferenceVenueName(entryVenue(entry))) {
      const abbreviated = String(abbreviateVenue(entryVenue(entry)) || "").toLowerCase();
      const compact = abbreviated.replace(/[^a-z0-9]+/g, "");
      return compact || "conference";
    }
    return "";
  }

  function isCorrRecord(entry) {
    const key = dblpKey(entry);
    return /journals\/corr\b/.test(key) || isPreprintVenue(entryVenue(entry));
  }

  function hasArxivIdentity(entry) {
    return !!extractArxivId(entry);
  }

  function isMixedManifestation(entry) {
    if (!entry) return false;
    if (entry._manifestationWarning) return true;
    return (entryIntegrityIssues(entry) || []).some(issue =>
      issue.code === "mixed_manifestation" || issue.code === "identifier_artifact_conflict");
  }

  function journalKey(entry) {
    const venue = entryVenue(entry);
    if (!venue) return "journal";
    const abbreviated = String(abbreviateVenue(venue) || venue);
    const compact = venueKey(abbreviated).replace(/\s+/g, "");
    return compact || "journal";
  }

  function versionIdentity(entry) {
    const mixed = isMixedManifestation(entry);
    const preprint = isPreprintVenue(entryVenue(entry)) ||
      isCorrRecord(entry) ||
      (hasArxivIdentity(entry) && !isCleanPublishedManifestation(entry));

    if (mixed && !isCleanPublishedManifestation(entry) && (preprint || hasArxivIdentity(entry))) {
      const declaredConference = conferenceKey(entry);
      if (declaredConference) {
        return Object.freeze({
          family: "conference",
          venueKey: declaredConference,
          year: yearOf(entry),
          clean: false,
          mixed: true,
        });
      }
    }

    if (conferenceKey(entry)) {
      const venueKey = conferenceKey(entry);
      const clean = isCleanPublishedManifestation(entry) && !mixed;
      return Object.freeze({
        family: "conference",
        venueKey,
        year: yearOf(entry),
        clean,
        mixed,
      });
    }

    if (preprint) {
      return Object.freeze({
        family: "preprint",
        venueKey: "arxiv",
        year: yearOf(entry),
        clean: true,
        mixed,
      });
    }

    if (entryVenue(entry) && !isPreprintVenue(entryVenue(entry))) {
      return Object.freeze({
        family: "journal",
        venueKey: journalKey(entry),
        year: yearOf(entry),
        clean: isCleanPublishedManifestation(entry) && !mixed,
        mixed,
      });
    }

    return Object.freeze({
      family: "unknown",
      venueKey: "unknown",
      year: yearOf(entry),
      clean: false,
      mixed,
    });
  }

  function publishedDoi(entry) {
    const doi = entryDoi(entry);
    if (!doi || /^10\.48550\/arxiv\./i.test(doi)) return "";
    return doi;
  }

  function clusterKey(identity, entry) {
    if (!identity) return "unknown:unknown";
    const doi = publishedDoi(entry);
    if (doi && isPublishedFamily(identity.family)) return `${identity.family}:doi:${doi}`;
    if (identity.family === "preprint") return "preprint:arxiv";
    if (identity.family === "unknown") return "unknown:unknown";
    const year = identity.year ? `:${identity.year}` : "";
    return `${identity.family}:${identity.venueKey}${year}`;
  }

  function sameVenueCluster(left, right) {
    return left?.family === right?.family && left?.venueKey === right?.venueKey;
  }

  function isPublishedFamily(family) {
    return family === "conference" || family === "journal";
  }

  function authorsCompatible(left, right) {
    const a = new Set(authorKeys(left?.author));
    const b = new Set(authorKeys(right?.author));
    if (!a.size || !b.size) return true;
    let inter = 0;
    for (const name of a) if (b.has(name)) inter++;
    if (inter / Math.max(a.size, b.size) >= 0.3) return true;
    return inter >= 1 && inter === Math.min(a.size, b.size);
  }

  function yearDistance(left, right) {
    const a = parseYear(left?.year);
    const b = parseYear(right?.year);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return 0;
    return Math.abs(a - b);
  }

  // ─── Notices (retractions, corrections) ────────────────────────────
  // Update types Crossref attaches to a work (updated-by) or that a notice
  // record declares (update-to). Serious notices flag the entry and need an
  // acknowledgement before export; the others are informational.
  const SERIOUS_NOTICE_TYPES = new Set(["retraction", "partial_retraction", "withdrawal", "removal", "expression_of_concern"]);
  const INFO_NOTICE_TYPES = new Set(["correction", "erratum", "corrigendum", "addendum", "clarification", "new_version", "new_edition"]);

  // The known update type ("expression-of-concern" → "expression_of_concern"), else "".
  function noticeType(value) {
    const type = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    return SERIOUS_NOTICE_TYPES.has(type) || INFO_NOTICE_TYPES.has(type) ? type : "";
  }

  function isSeriousNotice(notice) {
    return SERIOUS_NOTICE_TYPES.has(notice?.type);
  }

  // One notice list: { type, label, doi, source, date } (PubMed's may also
  // carry the notice's pmid) deduplicated by notice DOI (else PMID) + type
  // (Crossref repeats a notice per source), ordered by date, type and DOI.
  function mergeNotices(...lists) {
    const byKey = new Map();
    for (const notice of lists.flat()) {
      if (!notice?.type) continue;
      const key = `${notice.doi || (notice.pmid ? `pmid:${notice.pmid}` : "")}\u001f${notice.type}`;
      if (!byKey.has(key)) byKey.set(key, notice);
    }
    return [...byKey.values()].sort((a, b) =>
      String(a.date || "").localeCompare(String(b.date || "")) || a.type.localeCompare(b.type) ||
      String(a.doi || "").localeCompare(String(b.doi || "")));
  }

  // A record Crossref marks as a notice about another work (_noticeType,
  // from update-to) is a notice whatever its title says; otherwise the title
  // decides (text.noticeClass).
  function recordNoticeClass(record) {
    const type = record?._noticeType;
    if (type) return SERIOUS_NOTICE_TYPES.has(type) ? "retraction" : "correction";
    return noticeClass(record?.title);
  }

  // ─── Matching predicates ───────────────────────────────────────────
  // A record's online year (_onlineYear, PubMed's epubdate year) is the
  // other side's year: a work published online in December and in print in
  // January is cited by either year.
  function onlineYearMatches(left, right) {
    const year = side => parseYear(side?.year);
    const online = side => parseYear(side?._onlineYear);
    return (Number.isInteger(online(left)) && online(left) === year(right)) ||
      (Number.isInteger(online(right)) && online(right) === year(left));
  }

  // R7: years may differ by one when either side is a preprint, of unknown
  // version, mixed or carries an arXiv ID (an arXiv posting year next to the
  // venue year); otherwise they must agree. A missing year never conflicts;
  // a year equal to the other side's online year agrees (print vs online).
  function yearDriftOk(original, candidate) {
    const a = parseYear(original?.year);
    const b = parseYear(candidate?.year);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return true;
    if (a === b || onlineYearMatches(original, candidate)) return true;
    if (Math.abs(a - b) !== 1) return false;
    const originalId = versionIdentity(original);
    const candidateId = versionIdentity(candidate);
    return originalId.family === "preprint" || candidateId.family === "preprint" ||
      originalId.family === "unknown" || candidateId.family === "unknown" ||
      originalId.mixed === true || candidateId.mixed === true ||
      !!extractArxivId(original) || !!extractArxivId(candidate);
  }

  // Same work: a shared DOI, PMID or PMCID, a shared arXiv ID (R20), a shared
  // proceedings page or OpenReview forum, or a
  // specific title (titleIsSpecific) at least TITLE_MATCH_THRESHOLD similar
  // with the same first-author surname and a year within R7. A correction or
  // retraction notice (by its title, Crossref's update-to or PubMed's
  // publication type) is never the same work as the article it concerns.
  function sameWork(a, b) {
    if (!a || !b) return false;
    if (recordNoticeClass(a) !== recordNoticeClass(b)) return false;
    const doi = entryDoi(a);
    if (doi && doi === entryDoi(b)) return true;
    const pmid = entryPmid(a);
    if (pmid && pmid === entryPmid(b)) return true;
    const pmcid = entryPmcid(a);
    if (pmcid && pmcid === entryPmcid(b)) return true;
    const page = entryPage(a)?.key;
    if (page && page === entryPage(b)?.key) return true;
    const forum = extractOpenReviewForumId(a?.url || "");
    if (forum && forum === extractOpenReviewForumId(b?.url || "")) return true;
    const arxiv = extractArxivId(a);
    if (arxiv && arxiv === extractArxivId(b)) return true;
    if (!titleIsSpecific(a.title) || !titleIsSpecific(b.title)) return false;
    if (titleSimilarity(a.title, b.title) < TITLE_MATCH_THRESHOLD) return false;
    const first = firstAuthorSurname(a.author);
    if (!first || first !== firstAuthorSurname(b.author)) return false;
    return yearDriftOk(a, b);
  }

  const STRONG_TITLE_SIMILARITY = 97;

  // A record with several container titles (Crossref, _containerTitles: a
  // proceedings volume's full and short names, a series) matches any of
  // them, or a longer entry venue that contains one of them as words.
  function containerTitleMatches(entryVenueText, record) {
    const titles = Array.isArray(record?._containerTitles) ? record._containerTitles : [];
    if (titles.length < 2) return false;
    const key = venueKey(entryVenueText);
    return titles.some(title => {
      const other = venueKey(title);
      return venueEquivalent(entryVenueText, title) ||
        (!!other && key.length > other.length && ` ${key} `.includes(` ${other} `));
    });
  }

  // A workshop named with its host conference ("Machine Learning for Health
  // NeurIPS Workshop") is the workshop the record names without it
  // ("Machine Learning for Health Workshop"): the entry's venue words are the
  // record's plus host-conference acronyms.
  const HOST_CONFERENCES = new Set(["neurips", "nips", "icml", "iclr", "acl", "emnlp", "naacl", "eacl", "coling", "cvpr",
    "iccv", "eccv", "aaai", "ijcai", "kdd", "miccai", "colm", "aistats", "uai", "colt", "sigir", "www", "at"]);

  function workshopAtHost(entryVenueText, recordVenueText) {
    const words = text => venueKey(text).split(" ").filter(Boolean);
    const extra = words(entryVenueText);
    const recordWords = words(recordVenueText);
    if (recordWords.length < 3 || !recordWords.includes("workshop")) return false;
    for (const word of recordWords) {
      const index = extra.indexOf(word);
      if (index < 0) return false;
      extra.splice(index, 1);
    }
    return extra.length > 0 && extra.every(word => HOST_CONFERENCES.has(word)) && extra.some(word => word !== "at");
  }

  // The entry's venue names the record's venue (or, for PubMed, its
  // journal abbreviation, _journalAbbrev: "Nat Methods" for "Nature methods";
  // for Crossref, one of its container titles; a workshop with its host).
  function venueMatches(entryVenueText, record) {
    return venueEquivalent(entryVenueText, entryVenue(record)) ||
      (present(record?._journalAbbrev) && venueEquivalent(entryVenueText, record._journalAbbrev)) ||
      containerTitleMatches(entryVenueText, record) || workshopAtHost(entryVenueText, entryVenue(record));
  }

  function venueConflict(entry, record) {
    const a = entryVenue(entry);
    const b = entryVenue(record);
    return present(a) && present(b) && !venueMatches(a, record);
  }

  // Same year (or the record's online year); a preprint and its published
  // version may be one year apart (R7).
  function strongYearMatch(entry, record) {
    const a = parseYear(entry?.year);
    const b = parseYear(record?.year);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a === b || onlineYearMatches(entry, record)) return true;
    if (Math.abs(a - b) !== 1) return false;
    const families = [versionIdentity(entry).family, versionIdentity(record).family];
    return families.includes("preprint") && families.some(isPublishedFamily);
  }

  // Versions of one work legitimately differ in year and venue, so the
  // same-work core signatures are compared within the record's version class,
  // among authoritative records only (S17: a Semantic Scholar record may
  // carry the arXiv year).
  function uniqueCoreSignature(entry, record, candidates) {
    const recordClass = versionClass(record);
    const records = [record];
    for (const other of candidates || []) {
      if (!other || other === record || versionClass(other) !== recordClass || !isAuthoritative(other)) continue;
      if (sameWork(entry, other)) records.push(other);
    }
    return sameCoreSignature(records);
  }

  // The same specific title (titleIsSpecific) after normalisation (or
  // token-sort ≥ 97), same notice class.
  function sameTitle(entry, record) {
    const a = titleKey(entry?.title);
    const b = titleKey(record?.title);
    if (!a || !b || recordNoticeClass(entry) !== recordNoticeClass(record)) return false;
    if (!titleIsSpecific(entry?.title)) return false;
    return a === b || keySimilarity(a, b) >= STRONG_TITLE_SIMILARITY;
  }

  // Strong match: the title is equal after normalisation (or token-sort ≥ 97),
  // the first author is the same person (surname and compatible given
  // names), the author counts are compatible, the year is the same (R7 for
  // preprint → published), the venues do not conflict, and the record's
  // same-work core signature is the only one among the candidates of its
  // version class.
  function strongMatch(entry, record, candidates = []) {
    if (!entry || !record || !sameTitle(entry, record)) return false;
    const first = firstAuthorSurname(entry.author);
    if (!first || first !== firstAuthorSurname(record.author)) return false;
    if (!firstAuthorsCompatible(entry.author, record.author)) return false;
    if (!authorCountsCompatible(entry.author, record.author)) return false;
    if (!strongYearMatch(entry, record)) return false;
    if (venueConflict(entry, record)) return false;
    return uniqueCoreSignature(entry, record, candidates);
  }

  function titleTokenCount(title) {
    return titleKey(title).split(/\s+/).filter(Boolean).length;
  }

  // A record with the entry's exact, specific title (sameTitle, ≥ 3 tokens)
  // that is still not the same work: "wrong_authors" when the first authors
  // differ (surname, or incompatible given names), "wrong_year" when the
  // first author agrees but the years fail R7 (in practice more than one
  // year apart); "" otherwise. Such a record is a reason to review the
  // citation, never a match.
  function titleOnlyMatch(entry, record) {
    if (!entry || !record || !sameTitle(entry, record) || titleTokenCount(entry.title) < 3) return "";
    if (sameWork(entry, record)) return "";
    const a = firstAuthorSurname(entry.author);
    const b = firstAuthorSurname(record.author);
    if (!a || !b) return "";
    if (a !== b || !firstAuthorsCompatible(entry.author, record.author)) return "wrong_authors";
    return yearDriftOk(entry, record) ? "" : "wrong_year";
  }

  // Records worth showing for an explicit choice or for judge ranking: the
  // same work, or a similar specific title (≥ 3 tokens)
  // whose authors overlap within PLAUSIBLE_YEAR_GAP years, or whose title is
  // at least TITLE_MATCH_THRESHOLD similar within one year. Never auto-applied.
  const PLAUSIBLE_YEAR_GAP = 3;

  function plausible(entry, record) {
    if (!record) return false;
    if (!entry) return true;
    if (sameWork(entry, record)) return true;
    const titleScore = titleSimilarity(entry.title, record.title) || 0;
    if (titleScore < MIN_TITLE_SIM) return false;
    if (titleTokenCount(entry.title) < 3) return false;
    const years = yearDistance(entry, record);
    if (authorsCompatible(entry, record)) return years <= PLAUSIBLE_YEAR_GAP;
    return titleScore >= TITLE_MATCH_THRESHOLD && years <= 1;
  }

  const PREPRINT_ENTRY_TYPES = new Set(["article", "misc", "unpublished", "online", "preprint"]);

  function canonicalEntryType(value) {
    const type = String(value || "").trim().toLowerCase();
    return type === "conference" ? "inproceedings" : type;
  }

  // A record without a venue makes no entry-type claim; preprints may be
  // typed article, misc or unpublished alike; a paper of a conference's
  // proceedings may be typed article or inproceedings alike (Crossref
  // registers AAAI's as journal articles, Google Scholar exports NeurIPS
  // papers as @article) when both name that conference.
  const PROCEEDINGS_PAPER_TYPES = new Set(["article", "inproceedings"]);

  function entryTypesEquivalent(entry, record) {
    const a = canonicalEntryType(entry?.ENTRYTYPE);
    const b = canonicalEntryType(record?.ENTRYTYPE);
    if (!a || !b || !present(entryVenue(record)) || a === b) return true;
    if (PROCEEDINGS_PAPER_TYPES.has(a) && PROCEEDINGS_PAPER_TYPES.has(b) && isConferenceVenueName(entryVenue(record)) &&
        present(entryVenue(entry)) && venueMatches(entryVenue(entry), record)) return true;
    return versionClass(entry) !== "published" && versionClass(record) === "preprint" &&
      PREPRINT_ENTRY_TYPES.has(a) && PREPRINT_ENTRY_TYPES.has(b);
  }

  // The entry's main title: the part before its first colon ("BOLD" of
  // "BOLD: Dataset and Metrics …"), else "".
  function mainTitle(title) {
    const text = String(title || "");
    const colon = text.indexOf(":");
    return colon > 0 ? text.slice(0, colon) : "";
  }

  // A record the entry's own identifier links whose title is the entry's
  // main title: Crossref keeps a subtitle apart (10.1145/3442188.3445924 is
  // titled "BOLD"), so by identifier this is the same title (S17). Matching
  // without an identifier stays strict.
  function sameTitleByIdentifier(entry, record) {
    if (!directLinkKinds(entry, record).length) return false;
    const main = titleKey(mainTitle(entry?.title));
    return !!main && main === titleKey(record?.title);
  }

  // Core fields (title, author, year, venue, entry type) of an entry against
  // a record after normalisation. A venue the entry lacks is "missing" (a
  // suggestion), never a conflict; a value the record lacks only conflicts
  // for title, author and year, which the record must confirm.
  function coreComparison(entry, record) {
    const conflicts = [];
    const missing = [];
    if (!present(record?.title) || !titleKey(entry?.title) ||
        (titleKey(entry?.title) !== titleKey(record.title) && !sameTitleByIdentifier(entry, record))) conflicts.push("title");
    if (!present(record?.author) || !authorListsEquivalent(entry?.author, record.author)) conflicts.push("author");
    const year = parseYear(entry?.year);
    if (!Number.isInteger(year) || (year !== parseYear(record?.year) && year !== parseYear(record?._onlineYear)))
      conflicts.push("year");
    const entryVenueText = entryVenue(entry);
    const recordVenueText = entryVenue(record);
    if (present(entryVenueText) && present(recordVenueText)) {
      if (!venueMatches(entryVenueText, record)) conflicts.push("venue");
    } else if (present(recordVenueText)) missing.push("venue");
    if (!entryTypesEquivalent(entry, record)) conflicts.push("ENTRYTYPE");
    return { equal: !conflicts.length, conflicts, missing };
  }

  // The entry type a record would give the entry (applyCandidateToEntry).
  function recordEntryType(record) {
    return canonicalEntryType(record?.ENTRYTYPE || (record?.booktitle ? "inproceedings" : record?.journal ? "article" : "misc"));
  }

  const venueWords = text => titleKey(text).split(" ").filter(Boolean).length;

  // What applying an identifier record whole would degrade (S17): "type"
  // (another entry type; preprint types are alike for a preprint record),
  // "series" (a series name such as Lecture Notes in Computer Science for
  // the entry's venue) or "venue" (a shorter venue: two words fewer or
  // more, or fewer and another venue, or none).
  function identifierUpdateRisks(entry, record) {
    const risks = [];
    const before = canonicalEntryType(entry?.ENTRYTYPE);
    const after = recordEntryType(record);
    if (before && after !== before &&
        !(PREPRINT_ENTRY_TYPES.has(before) && PREPRINT_ENTRY_TYPES.has(after) && versionClass(record) === "preprint"))
      risks.push("type");
    const entryVenueText = entryVenue(entry);
    const recordVenueText = entryVenue(record);
    if (present(recordVenueText) && isSeriesVenue(recordVenueText) && !isSeriesVenue(entryVenueText)) risks.push("series");
    else if (present(entryVenueText)) {
      const lost = venueWords(entryVenueText) - venueWords(recordVenueText);
      if (lost >= 2 || (lost > 0 && !venueMatches(entryVenueText, record))) risks.push("venue");
    }
    return risks;
  }

  // ─── Additive-only fields ──────────────────────────────────────────
  const ADDITIVE_FIELDS = ["volume", "number", "pages", "publisher", "doi", "pmid", "pmcid", "url", "eprint", "archiveprefix", "primaryclass"];
  const LOCATOR_FIELDS = ["volume", "number", "pages", "publisher", "doi", "pmid", "pmcid"];
  const ARXIV_FIELDS = new Set(["eprint", "archiveprefix", "primaryclass"]);

  function hasField(entry, field) {
    return Object.keys(entry || {}).some(name => name.toLowerCase() === field && present(entry[name]));
  }

  function fieldValue(entry, field) {
    const name = Object.keys(entry || {}).find(key => key.toLowerCase() === field && present(entry[key]));
    return name ? entry[name] : "";
  }

  // What one record could add to an entry without overwriting anything: the
  // record's venue when the entry has none, and bibliographic fields the
  // entry lacks (arXiv identifiers only from a preprint record; a doi.org URL
  // and placeholder pages are never added). `conflicts` lists locator fields
  // (volume, number, pages, publisher, doi) present on both sides that differ.
  function additiveFields(entry, record) {
    const fields = {};
    const conflicts = [];
    if (!present(entryVenue(entry)) && present(entryVenue(record))) {
      const venueField = present(record.booktitle) && entryVenue(record) === String(record.booktitle).trim() ? "booktitle" : "journal";
      if (!hasField(entry, venueField)) fields[venueField] = record[venueField];
    }
    const preprintRecord = versionClass(record) === "preprint";
    for (const field of ADDITIVE_FIELDS) {
      const value = fieldValue(record, field);
      if (!present(value)) continue;
      if (hasField(entry, field)) {
        if (LOCATOR_FIELDS.includes(field) && compareField(field, fieldValue(entry, field), value) < 100) conflicts.push(field);
        continue;
      }
      if (ARXIV_FIELDS.has(field) && !preprintRecord) continue;
      if (field === "url" && /^https?:\/\/(?:dx\.)?doi\.org\//i.test(String(value))) continue;
      if (field === "pages" && isPlaceholderPages(value)) continue;
      fields[field] = value;
    }
    return { fields, conflicts };
  }

  // ─── Lint notes ────────────────────────────────────────────────────
  // Non-blocking notes on an entry's own fields, shown on its card. They
  // never change a status (blocking integrity issues do: entryIntegrityIssues).
  //   key_year_mismatch          a four-digit year in the citation key is not the year field
  //   inproceedings_arxiv_venue  @inproceedings / @conference whose booktitle or journal is a preprint server
  //   author_placeholder         "and others" / "et al." in author (hasTruncatedAuthorMarker, or "et al." inside a name)
  //   missing_identifier         @article / @inproceedings / @conference without DOI, PMID, PMCID or arXiv ID
  //   missing_venue              @article without journal, @inproceedings / @conference without booktitle
  const KEY_YEAR = /(?:^|[^0-9])(1[5-9]\d{2}|20\d{2}|21\d{2})(?![0-9])/;
  const IDENTIFIED_TYPES = new Set(["article", "inproceedings", "conference"]);

  function lintNotes(entry) {
    if (!entry) return [];
    const notes = [];
    const type = String(entry.ENTRYTYPE || "").toLowerCase();
    const proceedings = type === "inproceedings" || type === "conference";
    const keyYear = KEY_YEAR.exec(String(entry.ID || ""))?.[1];
    const year = parseYear(entry.year);
    if (keyYear && Number.isInteger(year) && Number(keyYear) !== year)
      notes.push({ code: "key_year_mismatch", keyYear, year: String(year) });
    if (proceedings && [entry.booktitle, entry.journal].some(venue => present(venue) && isPreprintVenue(venue)))
      notes.push({ code: "inproceedings_arxiv_venue" });
    if (present(entry.author) && (hasTruncatedAuthorMarker(entry.author) || /\bet\s+al\b/.test(foldText(entry.author))))
      notes.push({ code: "author_placeholder" });
    if (IDENTIFIED_TYPES.has(type) && !entryDoi(entry) && !entryPmid(entry) && !entryPmcid(entry) && !extractArxivId(entry))
      notes.push({ code: "missing_identifier" });
    if (type === "article" && !present(entry.journal)) notes.push({ code: "missing_venue", field: "journal" });
    else if (proceedings && !present(entry.booktitle)) notes.push({ code: "missing_venue", field: "booktitle" });
    return notes;
  }

  function sourceRank(family, source, venueKey) {
    const table = family === "journal" ? JOURNAL_SOURCE_RANK
      : family === "conference"
        ? (OPENREVIEW_NATIVE_VENUES.includes(venueKey) ? CONFERENCE_SOURCE_RANK : DBLP_FIRST_CONFERENCE_SOURCE_RANK)
      : PREPRINT_SOURCE_RANK;
    return table[source] ?? 8;
  }

  function representativeScore(candidate, identity, original) {
    let score = 0;
    if (identity.clean) score += 20;
    if (present(candidate?.title) && present(candidate?.author) && yearOf(candidate)) score += 10;
    score -= sourceRank(identity.family, sourceOf(candidate), identity.venueKey);
    if (original) {
      score += Math.round((titleSimilarity(original.title || "", candidate.title || "") || 0) / 5);
      if (yearOf(original) && yearOf(original) === yearOf(candidate)) score += 12;
      if (sameCanonicalPaperUrl(original.url, candidate.url))
        score += 25;
      const wanted = extractOpenReviewForumId(original);
      const got = extractOpenReviewForumId(candidate) || String(candidate._openreviewId || "");
      if (wanted && got === wanted) score += 20;
    }
    return score;
  }

  function annotate(candidate, identity, key) {
    return {
      ...candidate,
      _versionFamily: identity.family,
      _versionVenueKey: identity.venueKey,
      _versionYear: identity.year,
      _versionClean: identity.clean,
      _versionMixed: identity.mixed,
      _versionClusterKey: key,
    };
  }

  function mergeYearlessKeys(groups) {
    const byVenue = new Map();
    for (const [key, group] of groups) {
      const identity = group.identity;
      const venueId = `${identity.family}:${identity.venueKey}`;
      if (!byVenue.has(venueId)) byVenue.set(venueId, []);
      byVenue.get(venueId).push({ key, group });
    }
    const merged = new Map();
    for (const items of byVenue.values()) {
      const dated = items.filter(item => item.group.identity.year);
      const undated = items.filter(item => !item.group.identity.year);
      if (dated.length === 1 && undated.length) {
        const target = dated[0];
        for (const extra of undated) target.group.members.push(...extra.group.members);
        merged.set(target.key, target.group);
        continue;
      }
      for (const item of items) merged.set(item.key, item.group);
    }
    return merged;
  }

  // Plausible records grouped by version. When no candidate is the same
  // work, a title-only match (titleOnlyMatch) joins them: it is the explicit
  // choice of a wrong_authors / wrong_year review.
  function clusterRecords(original, candidates) {
    const groups = new Map();
    const titleOnlyShown = !!original && !(candidates || []).some(candidate => candidate && sameWork(original, candidate));
    for (const candidate of candidates || []) {
      if (!candidate) continue;
      if (original && !plausible(original, candidate) && !(titleOnlyShown && titleOnlyMatch(original, candidate)))
        continue;
      const identity = versionIdentity(candidate);
      const key = clusterKey(identity, candidate);
      const existing = groups.get(key);
      if (existing) {
        existing.members.push(candidate);
        if (identity.clean && !existing.identity.clean)
          existing.identity = identity;
        continue;
      }
      groups.set(key, { key, identity, members: [candidate] });
    }
    const merged = mergeYearlessKeys(groups);
    return [...merged.values()].map(group => {
      const ranked = group.members.slice().sort((left, right) => {
        const li = versionIdentity(left);
        const ri = versionIdentity(right);
        return representativeScore(right, ri, original) - representativeScore(left, li, original)
          || sourceOf(left).localeCompare(sourceOf(right));
      });
      // A Semantic Scholar record never represents a work that an
      // authoritative member of the same cluster also describes.
      if (!isAuthoritative(ranked[0])) {
        const twin = ranked.findIndex(member => isAuthoritative(member) && sameWork(ranked[0], member));
        if (twin > 0) ranked.unshift(...ranked.splice(twin, 1));
      }
      const representative = annotate(ranked[0], group.identity, group.key);
      return Object.freeze({
        key: group.key,
        identity: group.identity,
        members: Object.freeze(ranked),
        representative,
      });
    }).sort((left, right) => left.key.localeCompare(right.key));
  }

  function originalIdentity(original) {
    return versionIdentity(original || {});
  }

  // The cluster of the original's own version: the same published DOI, else
  // the same cluster key. A venue alone never matches.
  function matchingCluster(clusters, original) {
    const identity = originalIdentity(original);
    const doi = publishedDoi(original);
    if (doi) {
      const byDoi = (clusters || []).find(cluster => cluster.key.endsWith(`:doi:${doi}`));
      if (byDoi) return byDoi;
    }
    if (identity.family === "unknown") return null;
    return (clusters || []).find(cluster => cluster.key === clusterKey(identity, original)) || null;
  }

  function publishedClusters(clusters) {
    return (clusters || []).filter(cluster =>
      isPublishedFamily(cluster.identity.family) && cluster.identity.clean !== false &&
      cluster.representative && !cluster.representative._versionMixed);
  }

  function limitRepresentatives(clusters, options = {}) {
    const limit = Math.max(1, Math.floor(Number(options.limit) || 3));
    const original = options.original;
    const preferPublished = options.preferPublished === true;
    const ordered = [];
    const seen = new Set();
    function pushRecord(record, clusterKeyValue) {
      if (!record) return;
      const id = `${sourceOf(record)}\u001f${record._recordId || ""}`;
      if (seen.has(id)) return;
      seen.add(id);
      ordered.push(record);
    }
    function push(cluster) {
      if (!cluster) return;
      pushRecord(cluster.representative, cluster.key);
    }
    function pushConferenceSourceAlternatives(cluster) {
      if (!cluster || cluster.identity?.family !== "conference") return;
      const bySource = new Map();
      for (const member of cluster.members || []) {
        const source = sourceOf(member);
        if (source !== "openreview" && source !== "dblp") continue;
        if (!bySource.has(source)) bySource.set(source, member);
      }
      if (!bySource.has("openreview") || !bySource.has("dblp")) return;
      for (const member of bySource.values())
        pushRecord(annotate(member, cluster.identity, cluster.key), cluster.key);
    }
    const matched = matchingCluster(clusters, original);
    push(matched);
    pushConferenceSourceAlternatives(matched);
    if (preferPublished) publishedClusters(clusters).forEach(cluster => {
      push(cluster);
      pushConferenceSourceAlternatives(cluster);
    });
    (clusters || []).forEach(cluster => {
      push(cluster);
      pushConferenceSourceAlternatives(cluster);
    });
    for (const cluster of clusters || []) {
      const cores = new Map();
      for (const member of cluster.members || []) {
        const key = coreSignature(member);
        if (!cores.has(key)) cores.set(key, member);
      }
      if (cores.size < 2) continue;
      for (const member of cores.values())
        pushRecord(annotate(member, cluster.identity, cluster.key), cluster.key);
    }
    return ordered.slice(0, limit);
  }

  function orderRepresentatives(candidates, original, options = {}) {
    const identity = originalIdentity(original);
    const preferPublished = options.preferPublished === true;
    const matched = matchingCluster((candidates || []).map(candidate => {
      const itemIdentity = versionIdentity(candidate);
      const key = clusterKey(itemIdentity, candidate);
      return { key, identity: itemIdentity, representative: candidate, members: [candidate] };
    }), original);
    const matchedKey = matched?.key || "";
    return (candidates || []).slice().sort((left, right) => {
      const li = versionIdentity(left);
      const ri = versionIdentity(right);
      const leftKey = left._versionClusterKey || clusterKey(li, left);
      const rightKey = right._versionClusterKey || clusterKey(ri, right);
      const leftMatch = (matchedKey && leftKey === matchedKey) || sameVenueCluster(li, identity) ? 0 : 1;
      const rightMatch = (matchedKey && rightKey === matchedKey) || sameVenueCluster(ri, identity) ? 0 : 1;
      if (leftMatch !== rightMatch) return leftMatch - rightMatch;
      if (preferPublished) {
        const leftPub = isPublishedFamily(li.family) && !li.mixed ? 0 : 1;
        const rightPub = isPublishedFamily(ri.family) && !ri.mixed ? 0 : 1;
        if (leftPub !== rightPub) return leftPub - rightPub;
      }
      const authority = Number(!isAuthoritative(left)) - Number(!isAuthoritative(right));
      if (authority) return authority;
      return clusterKey(li, left).localeCompare(clusterKey(ri, right));
    });
  }

export {
  COMPARED_FIELDS,
  CORE_FIELDS,
  sourceAuthority,
  isAuthoritative,
  candidateFingerprint,
  versionClass,
  fingerprint,
  createRecord,
  createOriginal,
  dedupeRecords,
  coreTuple,
  completeCore,
  coreSignatures,
  sameCoreSignature,
  directLinkKinds,
  identifierStates,
  selectCanonical,
  userProvenance,
  manualProvenance,
  mixedCoreProvenance,
  entryIntegrityIssues,
  identifierUpdateRisks,
  sameTitleByIdentifier,
  canonicalEntryType,
  recordEntryType,
  normalizeEntryForLookup,
  metadataRegressionFields,
  compareField,
  manifestationClass,
  isCleanPublishedManifestation,
  compareEntry,
  fieldDiffsForNeedsReview,
  hasCriticalMetadataConflict,
  applyCandidateToEntry,
  paperUrlForEntry,
  candidateProvenance,
  duplicateKeysForEntry,
  findDuplicateEntryId,
  registerDuplicateKeys,
  dedupeCandidates,
  candidateScore,
  sortCandidatesByScore,
  rerankCandidates,
  CONFERENCE_ALIASES,
  OPENREVIEW_NATIVE_VENUES,
  versionIdentity,
  clusterKey,
  SERIOUS_NOTICE_TYPES,
  INFO_NOTICE_TYPES,
  noticeType,
  isSeriousNotice,
  mergeNotices,
  recordNoticeClass,
  yearDriftOk,
  sameWork,
  strongMatch,
  plausible,
  titleOnlyMatch,
  coreComparison,
  additiveFields,
  lintNotes,
  isPublishedFamily,
  isMixedManifestation,
  clusterRecords,
  originalIdentity,
  matchingCluster,
  publishedClusters,
  limitRepresentatives,
  orderRepresentatives,
};
