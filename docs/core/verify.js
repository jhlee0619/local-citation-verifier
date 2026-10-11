/*
 * Per-entry decisions (field edits, candidate resolution, review
 * requirement), the run controller that owns verification and citation-audit
 * runs, and the verification pipeline: candidate lookup, the status policy
 * (decide), the additive DOI round trip, the AI judge, per-entry results,
 * duplicate marking and the bounded run loop. DOM-free; the page passes
 * callbacks for everything it renders.
 */
import {
  entryDoi, entryPmcid, entryPmid, extractArxivId, present, stripLatex, TITLE_MATCH_THRESHOLD, titleSimilarity,
} from "./text.js?v=20261012-s15";
import { candidateFingerprint as recordFingerprint, CORE_FIELDS } from "./records.js?v=20261012-s15";
import * as Rec from "./records.js?v=20261012-s15";
import * as Ver from "./versions.js?v=20261012-s15";
import * as Net from "./net.js?v=20261012-s15";
import { runBoundedQueue } from "./net.js?v=20261012-s15";
import * as Judge from "./judge.js?v=20261012-s15";

  // ─── Decisions ─────────────────────────────────────────────────────
  const ORIGINAL_DEFAULT_STATUSES = new Set([
    "verified", "needs_review", "not_found", "lookup_failed", "cancelled", "parse_failed",
  ]);

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
    const candidateFingerprint = recordFingerprint(candidate);
    return Object.freeze({
      action: "candidate",
      candidateIndex,
      source,
      candidateId,
      candidateFingerprint,
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
    if (decision.source || decision.candidateId || decision.candidateFingerprint) {
      if (!present(decision.source) || !present(decision.candidateId) || !present(decision.candidateFingerprint))
        return null;
      return candidates.find(candidate =>
        candidate?._recordSource === decision.source && candidate?._recordId === decision.candidateId &&
        recordFingerprint(candidate) === decision.candidateFingerprint
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

  function withReviewRequirement(result = {}, reviewRequired = false) {
    const out = { ...result };
    Object.defineProperty(out, "review_required", {
      value: reviewRequired === true,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    return out;
  }

  function sourceVariantIdentity(value = {}) {
    const source = value?._recordSource || value?._source || value?.source || "";
    const candidateId = value?._recordId || value?.candidateId || "";
    return JSON.stringify([String(source), String(candidateId)]);
  }

  // "" when the result needs no further decision before export. A required
  // review resolves only by an explicit (touched) candidate, original or
  // exclude decision; a system-chosen candidate never resolves it.
  function reviewIssueCode(result) {
    if (typeof result?.review_required !== "boolean") return "invalid_review_requirement";
    const decision = result.decision;
    if (decision?.action === "candidate") {
      if (!present(decision.source) || !present(decision.candidateId) ||
          !resolveCandidate(Array.isArray(result.candidates) ? result.candidates : [], decision))
        return "stale_candidate_decision";
      return result.review_required && decision.touched !== true ? "review_decision_required" : "";
    }
    if (!result.review_required) return "";
    if (decision?.action === "exclude" && decision.touched === true) return "";
    if (decision?.action === "original" && decision.touched === true) return "";
    return "review_decision_required";
  }

  function isReviewResolved(result) {
    return reviewIssueCode(result) === "";
  }

  function createStore() {
    return { decisions: {}, fieldEdits: {} };
  }

  // ─── Run controller ────────────────────────────────────────────────
  function cloneFrozen(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
    if (value && typeof value === "object") {
      const copy = {};
      for (const [key, child] of Object.entries(value)) copy[key] = cloneFrozen(child);
      return Object.freeze(copy);
    }
    return value;
  }

  function abortError(reason) {
    const message = typeof reason === "string" && reason ? reason : "run cancelled";
    const error = new Error(message);
    error.name = "AbortError";
    error.kind = "cancelled";
    error.reason = reason;
    return error;
  }

  function createRunController() {
    let nextVerificationId = 1;
    let nextAuditId = 1;
    let activeVerification = null;
    let activeAudit = null;

    function abort(context, reason) {
      if (!context || context.signal.aborted) return context || null;
      context.cancelReason = reason;
      context.controller.abort(abortError(reason));
      return context;
    }

    function isActive(context) {
      if (!context || context.signal.aborted) return false;
      if (context.kind === "verification") return activeVerification?.id === context.id;
      if (context.kind === "citation-audit") return activeAudit?.id === context.id;
      return false;
    }

    // Verifications and audits have separate lifecycles: starting or
    // cancelling one never aborts the other.
    function startVerification({ entries = [], settings = {} } = {}) {
      abort(activeVerification, "superseded by a newer verification");
      const controller = new AbortController();
      const frozenEntries = cloneFrozen(entries);
      const context = {
        kind: "verification",
        id: nextVerificationId++,
        controller,
        signal: controller.signal,
        entries: frozenEntries,
        originals: frozenEntries,
        settings: cloneFrozen(settings),
        results: new Array(frozenEntries.length),
        decisions: [],
        fieldEdits: [],
        cancelReason: null,
      };
      activeVerification = context;
      return context;
    }

    function startAudit({ inputs = {}, settings = {} } = {}) {
      abort(activeAudit, "superseded by a newer citation audit");
      const controller = new AbortController();
      const context = {
        kind: "citation-audit",
        id: nextAuditId++,
        controller,
        signal: controller.signal,
        inputs: cloneFrozen(inputs),
        settings: cloneFrozen(settings),
        results: [],
        cancelReason: null,
      };
      activeAudit = context;
      return context;
    }

    function cancelVerification(reason = "cancelled by user") {
      return abort(activeVerification, reason);
    }

    function cancelAudit(reason = "cancelled by user") {
      return abort(activeAudit, reason);
    }

    function ifActive(context, writer) {
      if (!isActive(context)) return false;
      writer();
      return true;
    }

    return {
      startVerification,
      startAudit,
      cancelVerification,
      cancelAudit,
      isActive,
      ifActive,
      activeVerification: () => activeVerification,
      activeAudit: () => activeAudit,
    };
  }

  const defaultController = createRunController();

  // ─── Verification pipeline ─────────────────────────────────────────
  // Candidate lookup, the status policy (decide), per-entry results and the
  // run loop. Every function takes the run context (`run`, from
  // createRunController().startVerification: entries, originals, settings,
  // signal, results, plus the state initRunState attaches) and a `ctx`:
  //   providers       createProviderAdapters(...) result (searchCandidatePool,
  //                   searchCrossrefDoi for the additive DOI round trip)
  //   controller      the run's controller (default: defaultController)
  //   judge           { rerank({ engine, ... }) } (default: core/judge.js)
  //   onRerankStatus  (message) => void   AI rerank status line
  //   onProgress      (completed, total, result) => void   before a first result is published
  //   onResult        (index, result) => void   after run.results[index] is set
  //                   (first result, then again when an AI judge answer patches it)
  //   onFinalizing    (pendingCount) => void   before waiting for AI reranks
  // Every published result has its default field edits (defaultFieldEdits)
  // in run.fieldEdits before onResult runs; rendering only reads them.
  const MAX_CANDIDATE_CHOICES = 3;

  const DEFAULT_JUDGE = Object.freeze({
    rerank: Judge.rerank,
  });

  // Preference among equally valid records: the by-DOI Crossref record first.
  const SOURCE_PREFERENCE = ["crossref_doi", "crossref_search", "pubmed", "dblp", "openreview", "semantic_scholar_match", "semantic_scholar_search", "local_arxiv"];

  function runControllerOf(ctx) {
    return ctx?.controller || defaultController;
  }

  function verificationConcurrency(speedMode) {
    if (speedMode === "fast") return 4;
    if (speedMode === "thorough") return 2;
    return 3;
  }

  // Attaches a fresh decision store and duplicate map to a new run.
  function initRunState(run) {
    const store = createStore();
    run.decisions = store.decisions;
    run.fieldEdits = store.fieldEdits;
    run.duplicateOfByIndex = new Array(run.entries.length);
    return store;
  }

  // What a retry of failed lookups keeps from the finished run. Results and
  // per-entry edit maps are shared, not copied: they are replaced, never
  // changed in place (applyChoice, editField, seedFieldEdits), so a cancelled
  // retry can restore this snapshot with seedRetryRun(run, retained, []).
  function retainForRetry(previousRun, results, decisions, fieldEdits) {
    return {
      results: results.slice(),
      decisions: { ...decisions },
      fieldEdits: { ...fieldEdits },
      duplicates: previousRun?.duplicateOfByIndex?.slice?.() ||
        results.map(result => result?.duplicate_of || null),
    };
  }

  // Gives a retry run a fresh store that holds the retained results,
  // decisions and field edits of every entry it does not retry.
  function seedRetryRun(run, retained, indices) {
    const store = createStore();
    for (let i = 0; i < run.entries.length; i++) {
      if (indices.includes(i)) continue;
      if (retained.results[i]) run.results[i] = retained.results[i];
      if (retained.decisions[i] != null) store.decisions[i] = retained.decisions[i];
      if (retained.fieldEdits[i] != null) store.fieldEdits[i] = retained.fieldEdits[i];
    }
    run.decisions = store.decisions;
    run.fieldEdits = store.fieldEdits;
    run.duplicateOfByIndex = retained.duplicates.slice(0, run.entries.length);
    while (run.duplicateOfByIndex.length < run.entries.length) run.duplicateOfByIndex.push(null);
    return store;
  }

  // Drops every published result, decision and field edit of a cancelled run.
  function clearRunResults(run) {
    run.results.fill(undefined);
    Object.keys(run.decisions).forEach(key => { delete run.decisions[key]; });
    Object.keys(run.fieldEdits).forEach(key => { delete run.fieldEdits[key]; });
  }

  // ─── Field edits ───────────────────────────────────────────────────
  // The fields an entry card lists besides its diff rows (plus every field
  // of the suggested record).
  const OTHER_FIELDS = ["title", ...Rec.COMPARED_FIELDS, "url", "eprint", "archiveprefix", "archivePrefix", "primaryclass", "primaryClass"];

  // An inproceedings journal is redundant next to a booktitle.
  function redundantJournal(entry, candidate, field) {
    return field === "journal" && (entry?.ENTRYTYPE || "").toLowerCase() === "inproceedings" &&
      !!(entry.booktitle || candidate?.booktitle);
  }

  function candidateFieldValue(candidate, field) {
    if (field === "ENTRYTYPE")
      return candidate?.ENTRYTYPE || (candidate?.booktitle ? "inproceedings" : candidate?.journal ? "article" : "");
    return candidate?.[field] || "";
  }

  // The record a card's suggestions come from: the chosen candidate, else the
  // first choice.
  function suggestedCandidate(result, decision) {
    const choices = result?.candidate_choices || [];
    return resolveCandidate(choices, decision || originalDecision(false)) || choices[0] || null;
  }

  // The rows an entry card shows: field diffs (without a redundant journal)
  // and the other non-empty fields of the entry or the suggested record.
  function cardFields(result, entry, decision) {
    const candidate = suggestedCandidate(result, decision);
    const diffs = (result.field_diffs || []).filter(diff => !redundantJournal(entry, candidate, diff.field));
    const diffFields = new Set(diffs.map(diff => diff.field));
    const candidateFields = candidate ? Object.keys(candidate).filter(field => !field.startsWith("_") && field !== "ID") : [];
    const others = [...new Set([...OTHER_FIELDS, ...candidateFields])].filter(field =>
      !diffFields.has(field) && !redundantJournal(entry, candidate, field) &&
      !!(entry[field] || candidate?.[field] || "").trim());
    return { candidate, diffs, others };
  }

  // The untouched field edits a result implies: with a chosen candidate, its
  // values (a field it lacks is removed); otherwise the original values.
  // Computed when a result or decision changes, never while rendering.
  function defaultFieldEdits(result, entry, decision) {
    const { candidate, diffs, others } = cardFields(result, entry, decision);
    const chosen = result.selected_choice === "candidate";
    const fromCandidate = candidate ? provenance("system", candidate._recordSource, candidate._recordId) : null;
    const fromOriginal = provenance("system", "original");
    const edits = {};
    for (const diff of diffs) edits[diff.field] = {
      action: chosen ? "found" : "original",
      value: diff.found || "",
      touched: false,
      provenance: chosen && candidate ? fromCandidate : fromOriginal,
    };
    for (const field of others) {
      const value = candidateFieldValue(candidate, field);
      const use = chosen && !!value.trim();
      const remove = chosen && !value.trim() && !!(entry[field] || "").trim();
      edits[field] = {
        action: use ? "found" : remove ? "remove" : "original",
        value: use ? value : remove ? "" : entry[field] || "",
        touched: false,
        provenance: (use || remove) && candidate ? fromCandidate : fromOriginal,
      };
    }
    return edits;
  }

  // Adds the default edits of run.results[index] for fields without an edit.
  function seedFieldEdits(run, index) {
    const decision = run.decisions[index] || originalDecision(false);
    run.fieldEdits[index] = {
      ...defaultFieldEdits(run.results[index], run.entries[index], decision),
      ...run.fieldEdits[index],
    };
  }

  // An explicit candidate / original / exclude decision on entry `index`.
  // The result is replaced by a new object (a retained snapshot keeps the
  // old one) and the field edits restart from the decision's defaults. A
  // chosen record keeps "updated" only if it is the identifier auto-update
  // record; any other record is a reviewed replacement.
  function applyChoice(run, index, choice) {
    const result = run.results[index];
    const entry = run.entries[index];
    if (!result || !entry) return null;
    let decision;
    let changes;
    if (choice.action === "candidate") {
      const candidate = result.candidate_choices?.[choice.candidateIndex];
      if (!candidate) return null;
      const cmp = Rec.compareEntry(entry, candidate);
      const status = candidate._autoEligible === true ? "updated" : "needs_review";
      decision = candidateDecision(candidate, choice.candidateIndex);
      changes = {
        status,
        title_score: cmp.title_score,
        field_diffs: status === "needs_review" && !cmp.field_diffs.length
          ? Rec.fieldDiffsForNeedsReview(entry, candidate)
          : cmp.field_diffs,
        suggested: cmp.suggested,
        found_title: candidate.title || "",
        paper_url: Rec.paperUrlForEntry(candidate),
        selected_candidate_index: choice.candidateIndex,
        selected_choice: "candidate",
      };
    } else if (choice.action === "original" || choice.action === "exclude") {
      decision = choice.action === "exclude" ? excludeDecision() : originalDecision(true);
      changes = { selected_choice: choice.action };
    } else return null;
    const next = withReviewRequirement({ ...result, ...changes, auto_select_source: "" }, result.review_required);
    run.results[index] = next;
    run.decisions[index] = decision;
    run.fieldEdits[index] = defaultFieldEdits(next, entry, decision);
    return next;
  }

  // A user's edit of one field (action found | original | custom | remove).
  function editField(run, index, field, action, value, extra) {
    const candidate = suggestedCandidate(run.results[index], run.decisions[index]);
    run.fieldEdits[index] = { ...run.fieldEdits[index], [field]: fieldEdit(action, value, { candidate, extra }) };
  }

  function sameRecord(left, right) {
    return !!left && !!right && left._recordSource === right._recordSource && left._recordId === right._recordId;
  }

  function sourcePreference(record) {
    const index = SOURCE_PREFERENCE.indexOf(record?._recordSource || record?._source || "");
    return index < 0 ? SOURCE_PREFERENCE.length : index;
  }

  function byPreference(left, right) {
    return sourcePreference(left) - sourcePreference(right) ||
      String(left._recordId || "").localeCompare(String(right._recordId || ""));
  }

  function annotateCandidateChoices(candidates, selection) {
    return (candidates || []).map(choice => ({
      ...choice,
      _paperUrl: Rec.paperUrlForEntry(choice),
      _autoEligible: selection.status === "auto_apply" && sameRecord(choice, selection.canonical) &&
        Rec.isAuthoritative(choice),
    }));
  }

  function includeCanonicalChoice(choices, selection, { preferPublished = false } = {}) {
    if (selection.status !== "auto_apply" || choices.some(choice => sameRecord(choice, selection.canonical)))
      return choices;
    const merged = [selection.canonical, ...choices];
    if (merged.length <= MAX_CANDIDATE_CHOICES) return merged;
    const sliced = merged.slice(0, MAX_CANDIDATE_CHOICES);
    // Published-slot guarantee: prepending the canonical record must not
    // evict the only clean venue-published manifestation from the visible
    // choices.
    if (preferPublished && !sliced.some(choice => Rec.isCleanPublishedManifestation(choice))) {
      const droppedPublished = merged.slice(MAX_CANDIDATE_CHOICES)
        .find(choice => Rec.isCleanPublishedManifestation(choice));
      if (droppedPublished) sliced.push(droppedPublished);
    }
    return sliced;
  }

  // ─── Status policy ─────────────────────────────────────────────────
  //   Verified      the entry's own DOI/arXiv ID links a record, or a record
  //                 strongly matches, and the core fields (title, author,
  //                 year, venue, entry type) agree, and every identifier the
  //                 entry carries (DOI, arXiv ID, PMID, PMCID) exists
  //                 (Rec.identifierStates). Fields the entry lacks are
  //                 non-blocking suggestions.
  //   Auto-updated  (a) "identifier": the record the entry's DOI/arXiv ID
  //                 links (selectCanonical: complete, atomic, unique core,
  //                 no regression), the same work, passing validatePick, with
  //                 no integrity issue on either side; applied whole.
  //                 (b) "additive": one strongly matching record adds fields
  //                 the entry lacks, never overwriting a value, and its DOI
  //                 round-trips through Crossref to a strong match.
  //   Needs Review  any other change to a same-work entry, integrity issues,
  //                 id_title_mismatch, id_conflict, core_conflict,
  //                 doi_unconfirmed, arxiv_unconfirmed, pmid_unconfirmed (an
  //                 identifier of the entry definitively absent: never
  //                 removed automatically), doi_conflict, pmid_conflict,
  //                 metadata_conflict, a failed DOI round trip,
  //                 or a risk the judge reports; also, without a same-work
  //                 record, a record with the entry's exact title by other
  //                 authors (wrong_authors) or of another year (wrong_year),
  //                 shown as an explicit choice. Export waits for an explicit
  //                 candidate / original / exclude decision.
  //   Not Found     no same-work record (no_matching_record); plausible
  //                 records stay visible for an explicit choice only.
  //   Lookup failed a same-work record exists but an identifier lookup
  //                 failed (identifier_lookup_failed): retry.
  // Only authoritative records (Rec.isAuthoritative: not Semantic Scholar)
  // confirm, auto-update, round-trip or show a title-only mismatch. Same-work
  // records from Semantic Scholar alone make the entry Needs Review
  // (unconfirmed_source), with those records as explicit choices.
  // The judge (LLM) only recommends one of the shown choices or raises risk;
  // it never upgrades a status.

  function blockingIntegrityIssues(entry) {
    return Rec.entryIntegrityIssues(entry).filter(issue => issue.blocking !== false && issue.severity !== "warning");
  }

  // Records the entry's own DOI or arXiv ID links.
  function directRecords(entry, pool) {
    return pool.filter(record => Rec.directLinkKinds(entry, record).length);
  }

  // The entry's DOI/arXiv ID resolves to a record with another title (a
  // pooled record it links, or the record an identifier check found).
  function idTitleMismatch(entry, direct) {
    return direct.some(record => titleSimilarity(entry.title, record.title) < TITLE_MATCH_THRESHOLD);
  }

  // The review reason for an identifier that does not exist.
  const UNCONFIRMED_REASONS = Object.freeze({ doi: "doi_unconfirmed", arxiv: "arxiv_unconfirmed", pmid: "pmid_unconfirmed", pmcid: "pmid_unconfirmed" });

  // The entry's DOI and its arXiv ID resolve to different works.
  function idConflict(entry, direct) {
    if (!entryDoi(entry) || !extractArxivId(entry)) return false;
    const linked = direct.map(record => ({ record, kinds: Rec.directLinkKinds(entry, record) }));
    const byDoi = linked.filter(item => item.kinds.includes("doi") && !item.kinds.includes("arxiv")).map(item => item.record);
    const byArxiv = linked.filter(item => item.kinds.includes("arxiv") && !item.kinds.includes("doi")).map(item => item.record);
    return byDoi.some(doiRecord => byArxiv.some(arxivRecord => !Rec.sameWork(doiRecord, arxivRecord)));
  }

  // The entry's PMID or PMCID is carried by no authoritative record, while a
  // same-work authoritative record carries another one: a fabricated or
  // mistyped PubMed identifier on a real work (it would otherwise survive an
  // additive update, which never overwrites a value).
  function pubmedIdConflict(entry, pool, sameWorkRecords) {
    const authoritative = pool.filter(Rec.isAuthoritative);
    return [entryPmid, entryPmcid].some(idOf => {
      const id = idOf(entry);
      return !!id && !authoritative.some(record => idOf(record) === id) &&
        sameWorkRecords.some(record => Rec.isAuthoritative(record) && idOf(record) && idOf(record) !== id);
    });
  }

  // Records one identifier links disagree on the core of one version (a
  // record may answer with its online year: Rec.sameCoreSignature).
  function coreConflict(direct) {
    const recordsByClass = new Map();
    for (const record of direct) {
      const versionClass = Rec.versionClass(record);
      if (!recordsByClass.has(versionClass)) recordsByClass.set(versionClass, []);
      recordsByClass.get(versionClass).push(record);
    }
    return [...recordsByClass.values()].some(records => !Rec.sameCoreSignature(records));
  }

  function versionInput(entry, lookup) {
    return {
      original: entry,
      clusters: lookup.clustered,
      representatives: lookup.choices,
      preferPublished: lookup.preferPublished,
    };
  }

  // An authoritative record whose core fields agree with the entry: linked by
  // the entry's DOI/arXiv ID first, else a strong match.
  function confirmingRecord(entry, lookup) {
    const pool = lookup.candidates;
    const agrees = record => Rec.isAuthoritative(record) && Rec.coreComparison(entry, record).equal;
    const direct = directRecords(entry, pool).filter(agrees).sort(byPreference);
    if (direct.length) return direct[0];
    return pool.filter(record => Rec.strongMatch(entry, record, pool) && agrees(record)).sort(byPreference)[0] || null;
  }

  function addsIntegrityIssue(entry, fields) {
    const before = new Set(blockingIntegrityIssues(entry).map(issue => issue.code));
    return blockingIntegrityIssues({ ...entry, ...fields }).some(issue => !before.has(issue.code));
  }

  // The additive-only update: one authoritative, strongly matching record
  // with a DOI, core fields equal, adding at least one field the entry lacks,
  // with no conflicting locator and no new integrity issue.
  function additiveCandidate(entry, lookup) {
    const pool = lookup.candidates;
    return pool
      .filter(record => Rec.isAuthoritative(record) && entryDoi(record) && Rec.strongMatch(entry, record, pool) &&
        Rec.coreComparison(entry, record).equal)
      .map(record => ({ record, ...Rec.additiveFields(entry, record) }))
      .filter(option => Object.keys(option.fields).length && !option.conflicts.length &&
        !addsIntegrityIssue(entry, option.fields))
      .sort((left, right) => byPreference(left.record, right.record))[0] || null;
  }

  // The identifier auto-update record (a), or null.
  function identifierRecord(entry, lookup) {
    const { selection, choices } = lookup;
    if (selection.status !== "auto_apply") return null;
    const pick = choices.find(choice => sameRecord(choice, selection.canonical)) || null;
    if (!pick || !Rec.isAuthoritative(pick)) return null;
    if (!Rec.completeCore(pick) || !Rec.sameWork(entry, pick)) return null;
    if (blockingIntegrityIssues(pick).length) return null;
    if (Ver.pickViolations(versionInput(entry, lookup), pick).length) return null;
    return pick;
  }

  // An authoritative record with the entry's exact title but other authors
  // or another year (Rec.titleOnlyMatch): wrong_year when one shares the
  // first author, else wrong_authors; the record to show, preferably one of
  // the choices.
  function titleOnlyMismatch(entry, pool, choices) {
    const matches = pool.filter(Rec.isAuthoritative)
      .map(record => ({ record, reason: Rec.titleOnlyMatch(entry, record) })).filter(item => item.reason);
    if (!matches.length) return null;
    const reason = matches.some(item => item.reason === "wrong_year") ? "wrong_year" : "wrong_authors";
    const shown = (choices || []).find(choice => Rec.isAuthoritative(choice) && Rec.titleOnlyMatch(entry, choice) === reason) ||
      matches.find(item => item.reason === reason).record;
    return { reason, record: shown };
  }

  // The deterministic facts decide() and the DOI round trip need.
  function assess(entry, lookup) {
    const pool = lookup?.candidates || [];
    const reasons = blockingIntegrityIssues(entry).length ? ["integrity"] : [];
    const sameWorkRecords = pool.filter(record => Rec.sameWork(entry, record));
    if (!sameWorkRecords.length) {
      const mismatch = titleOnlyMismatch(entry, pool, lookup?.choices);
      if (mismatch) reasons.push(mismatch.reason);
      return { reasons, sameWorkRecords, direct: [], confirming: null, additive: null, titleMatch: mismatch?.record || null };
    }
    // Only Semantic Scholar lists the work: nothing can confirm the entry.
    if (!sameWorkRecords.some(Rec.isAuthoritative)) reasons.push("unconfirmed_source");
    const direct = directRecords(entry, pool);
    // Every identifier the entry carries must exist, independently of the
    // work match (Rec.identifierStates): one that is definitively absent is
    // a review reason, a failed lookup leaves the entry unconfirmed.
    const identifiers = Rec.identifierStates(entry, pool, lookup?.identifiers);
    const checked = identifiers.map(item => item.record).filter(record => record && !direct.includes(record));
    if (idTitleMismatch(entry, [...direct, ...checked])) reasons.push("id_title_mismatch");
    if (idConflict(entry, direct)) reasons.push("id_conflict");
    if (coreConflict(direct)) reasons.push("core_conflict");
    for (const { kind, state } of identifiers) {
      if (state !== "absent") continue;
      const reason = (kind === "pmid" || kind === "pmcid") && pubmedIdConflict(entry, pool, sameWorkRecords)
        ? "pmid_conflict" : UNCONFIRMED_REASONS[kind];
      if (!reasons.includes(reason)) reasons.push(reason);
    }
    const identifierFailed = identifiers.some(item => item.state === "failed");
    const confirming = reasons.length || identifierFailed ? null : confirmingRecord(entry, lookup);
    if (confirming) {
      if (entryDoi(entry) && entryDoi(confirming) && entryDoi(entry) !== entryDoi(confirming)) reasons.push("doi_conflict");
      if (pubmedIdConflict(entry, pool, sameWorkRecords)) reasons.push("pmid_conflict");
      if (Rec.hasCriticalMetadataConflict(entry, confirming)) reasons.push("metadata_conflict");
    }
    const additive = confirming && !reasons.length ? additiveCandidate(entry, lookup) : null;
    return { reasons, sameWorkRecords, direct, confirming, additive, identifierFailed };
  }

  function normalizedJudgeStatus(value) {
    return String(value || "").toLowerCase().replace(/[-\s]+/g, "_");
  }

  // What the judge's answer may do: raise risk (not_found, needs_review or a
  // material risk flag) and recommend one of the shown choices.
  function judgeVerdict(entry, lookup, answer) {
    if (!answer) return { risk: false, pick: null, answer: null };
    const choices = lookup.choices;
    let pick = answer.candidate ? choices.find(choice => sameRecord(choice, answer.candidate)) || null : null;
    if (!pick && Number.isInteger(answer.index)) pick = choices[answer.index] || null;
    const status = normalizedJudgeStatus(answer.status);
    const flags = Ver.materialRiskFlags(answer.riskFlags || answer.risk_flags || [], entry, pick || {});
    const confidence = Number(answer.confidence);
    const recommends = status !== "not_found" && Number.isFinite(confidence) && confidence >= Ver.LLM_MIN_CONFIDENCE;
    return {
      risk: status === "not_found" || status === "needs_review" || flags.length > 0,
      pick: recommends ? pick : null,
      answer,
    };
  }

  // The choice to recommend for an explicit decision: the judge's pick, the
  // version rules' pick, else the first choice; only a same-work record that
  // passes the rule table, and none when the rules keep the original. Only
  // the judge may recommend a Semantic Scholar record.
  function recommendedIndex(entry, lookup, verdict) {
    const choices = lookup.choices;
    const input = versionInput(entry, lookup);
    const valid = choice => !!choice && Rec.sameWork(entry, choice) && !Ver.pickViolations(input, choice).length;
    const confirmed = choice => valid(choice) && Rec.isAuthoritative(choice);
    const indexOf = choice => choices.findIndex(item => sameRecord(item, choice));
    if (valid(verdict.pick)) return indexOf(verdict.pick);
    const versionDecision = lookup.versionDecision;
    if (versionDecision?.representative && confirmed(versionDecision.representative)) {
      const index = indexOf(versionDecision.representative);
      if (index >= 0) return index;
    }
    if (versionDecision?.originalStands) return -1;
    return choices.findIndex(confirmed);
  }

  function fieldEditsFor(record, fields) {
    return Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, {
      action: "found",
      value,
      touched: false,
      provenance: provenance("system", record._recordSource || "unknown", record._recordId || ""),
    }]));
  }

  // The review reason when same-work records exist but none confirms the
  // entry and no auto-update applies.
  function changeReason(entry, assessment, record) {
    const entryClass = Rec.versionClass(entry);
    if (assessment.direct.length) return "identifier_record_not_auto_applicable";
    if (record && entryClass !== "unknown" && Rec.versionClass(record) !== entryClass) return "version_change_without_id";
    return "core_change_without_id";
  }

  // The notices (retraction, correction, …) on the work the entry itself
  // names: those Crossref or PubMed list for the entry's DOI (or PMID), and
  // those of the record that confirms it or adds fields to it. A chosen
  // candidate brings its own (output.noticesFor). They never change the status.
  function entryNotices(entry, lookup, assessment) {
    const pmid = entryPmid(entry);
    return Rec.mergeNotices(
      lookup?.noticesByDoi?.get?.(entryDoi(entry)) || [],
      (pmid && lookup?.noticesByDoi?.get?.(`pmid:${pmid}`)) || [],
      assessment.confirming?._notices || [],
      assessment.additive?.record?._notices || [],
    );
  }

  // Status, reasons, initial decision, recommended choice and default field
  // edits for one entry. Pure: the DOI round trip and the judge answer are
  // inputs (lookup.roundTrip, answer).
  function decide(entry, lookup, answer = null) {
    const choices = lookup?.choices || [];
    const verdict = judgeVerdict(entry, lookup || { choices }, answer);
    const assessment = assess(entry, lookup);
    const base = {
      choices,
      decision: originalDecision(false),
      autoSelectSource: "",
      recommendedIndex: -1,
      record: null,
      fieldEdits: null,
      verdict,
      notices: entryNotices(entry, lookup, assessment),
    };
    if (!assessment.sameWorkRecords.length) {
      // A same-title record by other authors (or of another year) is shown as
      // an explicit choice, never recommended or applied.
      if (assessment.reasons.length)
        return { ...base, status: "needs_review", reason: assessment.reasons[0], reasons: assessment.reasons, record: assessment.titleMatch };
      return { ...base, status: "not_found", reason: "no_matching_record", reasons: ["no_matching_record"] };
    }
    const reasons = assessment.reasons.slice();
    if (verdict.risk) reasons.push("judge_risk");
    const review = (reasonList, record = null) => {
      const recommended = recommendedIndex(entry, lookup, verdict);
      const shown = choices[recommended] || record ||
        choices.find(choice => Rec.sameWork(entry, choice)) || choices[0] || null;
      return { ...base, status: "needs_review", reason: reasonList[0], reasons: reasonList, recommendedIndex: recommended, record: shown };
    };
    if (reasons.length) return review(reasons);
    // An identifier lookup failed: nothing is confirmed until a retry.
    if (assessment.identifierFailed) {
      return {
        ...base,
        status: "lookup_failed",
        reason: "identifier_lookup_failed",
        reasons: ["identifier_lookup_failed"],
        record: choices.find(choice => Rec.sameWork(entry, choice)) || null,
        lookupError: "identifier lookup failed",
      };
    }

    if (assessment.confirming) {
      const additive = assessment.additive;
      if (additive) {
        if (!lookup.roundTrip?.ok) return review(["doi_round_trip_failed"], additive.record);
        return {
          ...base,
          status: "updated",
          reason: "additive_only",
          reasons: ["additive_only"],
          autoSelectSource: "additive",
          record: additive.record,
          fieldEdits: fieldEditsFor(additive.record, additive.fields),
        };
      }
      return { ...base, status: "verified", reason: "core_fields_match", reasons: ["core_fields_match"], record: assessment.confirming };
    }

    const auto = lookup.autoRecord;
    if (auto) {
      const index = choices.findIndex(choice => sameRecord(choice, auto));
      return {
        ...base,
        status: "updated",
        reason: "identifier_record",
        reasons: ["identifier_record"],
        autoSelectSource: "identifier",
        record: choices[index],
        decision: candidateDecision(choices[index], index, false),
      };
    }
    const recommended = recommendedIndex(entry, lookup, verdict);
    const target = choices[recommended] || choices.find(choice => Rec.sameWork(entry, choice)) || null;
    return review([changeReason(entry, assessment, target)]);
  }

  // Fetches the additive record's DOI from Crossref (unless this lookup
  // already did) and checks that the answer strongly matches the entry.
  async function doiRoundTrip(entry, lookup, run, ctx) {
    const record = lookup.additive.record;
    const doi = entryDoi(record);
    // arXiv DOIs (10.48550/arXiv.*) are DataCite DOIs that Crossref does not
    // hold: confirm them through another authoritative pooled record of the
    // same arXiv ID (never a Semantic Scholar one).
    const arxivId = extractArxivId({ doi });
    if (arxivId) {
      const twin = lookup.candidates.find(candidate => candidate !== record && Rec.isAuthoritative(candidate) &&
        extractArxivId(candidate) === arxivId && Rec.strongMatch(entry, candidate, lookup.candidates));
      return { doi, record: twin || null, ok: !!twin, via: "arxiv" };
    }
    let fetched = null;
    if (record._recordSource === "crossref_doi") fetched = record;
    else if (lookup.doiRecords.has(doi)) fetched = lookup.doiRecords.get(doi);
    else {
      try {
        fetched = await ctx.providers.searchCrossrefDoi(doi, run);
      } catch (error) {
        if (Net.isCancelled(error)) throw error;
        return { doi, record: null, ok: false, error: "doi_lookup_failed" };
      }
    }
    const ok = !!fetched && Rec.isAuthoritative(fetched) && entryDoi(fetched) === doi &&
      Rec.strongMatch(entry, fetched, lookup.candidates);
    return { doi, record: fetched || null, ok };
  }

  // Looks one entry up: the provider pool, version clusters and the shown
  // choices, the identifier auto-update record, the additive candidate and
  // its DOI round trip. Returns the lookup, { absence: "not_found" } or null
  // (the run stopped owning the work). When the AI judge applies,
  // lookup.pendingJudge is a promise of its answer (null when inactive,
  // unavailable or failed).
  // The lookup for a provider pool, without network: canonical selection,
  // version clusters, the shown choices (at most MAX_CANDIDATE_CHOICES plus
  // the published-slot exception), the version decision, the identifier
  // auto-update record and the additive candidate. The DOI round trip
  // (lookup.roundTrip) and the judge answer are added by lookupPaper.
  function buildLookup(original, candidates, options = {}) {
    const preferPublished = options.preferPublished;
    const selection = Rec.selectCanonical(Rec.createOriginal(original), candidates, { preferPublished });
    const clustered = Rec.clusterRecords(original, selection.candidates);
    const representatives = Rec.limitRepresentatives(clustered, {
      original,
      preferPublished,
      limit: MAX_CANDIDATE_CHOICES,
    });
    const choices = annotateCandidateChoices(Rec.orderRepresentatives(
      includeCanonicalChoice(representatives, selection, { preferPublished }), original, { preferPublished }), selection);
    const lookup = {
      original,
      candidates: selection.candidates,
      selection,
      clustered,
      choices,
      preferPublished,
      versionDecision: Ver.decide({ original, clusters: clustered, representatives: choices, preferPublished }),
      sourceWarnings: options.sourceWarnings || [],
      doiRecords: options.doiRecords || new Map(),
      noticesByDoi: options.noticesByDoi || new Map(),
      identifiers: options.identifiers || {},
      roundTrip: null,
      pendingJudge: null,
    };
    lookup.autoRecord = identifierRecord(original, lookup);
    lookup.additive = assess(original, lookup).additive;
    return lookup;
  }

  async function lookupPaper(title, lookupEntry, run, originalSnapshot = lookupEntry, ctx = {}) {
    const controller = runControllerOf(ctx);
    const judge = ctx.judge || DEFAULT_JUDGE;
    const pool = await ctx.providers.searchCandidatePool(title, lookupEntry, run);
    if (!controller.isActive(run)) return null;
    if (!pool.candidates.length) return { absence: "not_found", sourceWarnings: pool.sourceWarnings };
    const original = originalSnapshot;
    const preferPublished = run.settings.preferPublished;
    const lookup = buildLookup(original, pool.candidates, {
      preferPublished,
      sourceWarnings: pool.sourceWarnings,
      doiRecords: pool.doiRecords,
      noticesByDoi: pool.noticesByDoi,
      identifiers: pool.identifiers,
    });
    const { clustered, choices } = lookup;
    if (lookup.additive) {
      lookup.roundTrip = await doiRoundTrip(original, lookup, run, ctx);
      if (!controller.isActive(run)) return null;
    }

    const provider = run.settings.rerankProvider;
    const shouldUseLlm = provider !== "off" && choices.length > 1 && Ver.needsLlm({
      original,
      clusters: clustered,
      representatives: choices,
      preferPublished,
      speedMode: run.settings.speedMode,
    });
    if (shouldUseLlm) {
      lookup.pendingJudge = (async () => {
        try {
          const answer = await judge.rerank({
            engine: provider,
            original,
            candidates: choices,
            preferPublished,
            language: run.settings.evidenceLanguage,
            signal: run.signal,
            onStatus: message => controller.ifActive(run, () => ctx.onRerankStatus?.(message)),
          });
          if (!controller.isActive(run)) return null;
          return answer;
        } catch {
          // The rerank failed; the heuristic candidate stands.
          if (!controller.isActive(run)) return null;
          ctx.onRerankStatus?.("vLLM unavailable · using heuristic rerank");
          return null;
        }
      })();
    }
    return lookup;
  }

  // An outcome without a provider lookup (no title, nothing found, lookup
  // failed): blocking integrity issues still require review.
  function bareOutcome(entry, status, reason) {
    const issues = blockingIntegrityIssues(entry).length;
    return {
      status: issues ? "needs_review" : status,
      reason: issues ? "integrity" : reason,
      reasons: issues ? ["integrity"] : [reason],
      choices: [],
      decision: originalDecision(false),
      autoSelectSource: "",
      recommendedIndex: -1,
      record: null,
      fieldEdits: null,
      verdict: { risk: false, pick: null, answer: null },
      notices: [],
    };
  }

  // The lookup each published result came from (for the judge patch).
  const RESULT_LOOKUPS = new WeakMap();

  // The result object for one entry. Writes the initial decision and the
  // default field edits to the run unless options.preserve (a later judge
  // answer must not replace the user's decision).
  function buildResult(run, entry, index, outcome, options = {}) {
    const choices = outcome.choices || [];
    const decision = outcome.decision || originalDecision(false);
    if (!options.preserve) {
      run.decisions[index] = decision;
      if (outcome.fieldEdits) run.fieldEdits[index] = { ...outcome.fieldEdits };
    }
    const status = outcome.status;
    const found = outcome.record || null;
    let comparison = { title_score: 0, field_diffs: [], suggested: {} };
    if (found) {
      const cmp = Rec.compareEntry(entry, found);
      const fieldDiffs = status === "needs_review" && !cmp.field_diffs.length
        ? Rec.fieldDiffsForNeedsReview(entry, found)
        : cmp.field_diffs;
      comparison = { title_score: cmp.title_score, field_diffs: fieldDiffs, suggested: cmp.suggested };
    }
    const resolved = resolveCandidate(choices, decision);
    const selectedIndex = resolved ? choices.indexOf(resolved) : -1;
    const selectedChoice = selectedIndex >= 0 ? "candidate" : status === "needs_review" ? "pending" : "original";
    const answer = outcome.verdict?.answer || null;
    return withReviewRequirement({
      index,
      entry_id: entry.ID || "",
      entry_type: entry.ENTRYTYPE || "",
      title: entry.title || "",
      status,
      reason: outcome.reason || "",
      review_reasons: outcome.reasons || [],
      title_score: comparison.title_score,
      field_diffs: comparison.field_diffs,
      suggested: comparison.suggested,
      found_title: found ? (found.title || "") : "",
      ai_status: answer?.status || "",
      ai_reason: answer?.reason || "",
      ai_risk_flags: answer?.riskFlags || [],
      candidate_choices: choices,
      selected_candidate_index: selectedIndex,
      recommended_candidate_index: selectedChoice === "pending" ? outcome.recommendedIndex : -1,
      selected_choice: selectedChoice,
      auto_select_source: outcome.autoSelectSource || "",
      additive_fields: Object.keys(outcome.fieldEdits || {}),
      paper_url: found ? Rec.paperUrlForEntry(found) : Rec.paperUrlForEntry(entry),
      pending_rerank: null,
      duplicate_of: run.duplicateOfByIndex[index] || null,
      lookup_error: null,
      source_warnings: [],
      integrity_issues: Rec.entryIntegrityIssues(entry),
      notices: outcome.notices || [],
      run_snapshot: run.settings,
      ...(outcome.lookupError ? { lookup_error: outcome.lookupError } : {}),
    }, status === "needs_review" || status === "lookup_failed");
  }

  // Verifies run.entries[index]; null when the run stopped owning the work.
  async function verifyEntry(run, index, ctx = {}) {
    const controller = runControllerOf(ctx);
    if (!controller.isActive(run)) return null;
    const entry = run.entries[index];
    const title = entry.title || "";
    const cleanTitle = stripLatex(title);
    const lookupEntry = Rec.normalizeEntryForLookup(entry);
    let lookup = null;
    let lookupError = null;
    try {
      lookup = await lookupPaper(cleanTitle, lookupEntry, run, run.originals[index], ctx);
    } catch (err) {
      if (!controller.isActive(run)) return null;
      lookupError = err;
    }

    if (!controller.isActive(run)) return null;
    if (lookupError) {
      // proxy_missing: the origin's /api/health failed, so nothing was asked.
      const proxyMissing = lookupError.reason === "proxy_missing";
      const r = buildResult(run, entry, index, bareOutcome(entry, "lookup_failed", proxyMissing ? "proxy_missing" : "lookup_failed"));
      r.lookup_error = proxyMissing ? "metadata proxy missing" : "metadata providers unavailable";
      r.source_warnings = lookupError.sourceWarnings || [];
      return r;
    }
    if (!lookup || lookup.absence) {
      const r = buildResult(run, entry, index, bareOutcome(entry, "not_found", "no_matching_record"));
      r.source_warnings = lookup?.sourceWarnings || [];
      return r;
    }
    const r = buildResult(run, entry, index, decide(entry, lookup));
    r.source_warnings = lookup.sourceWarnings || [];
    r.pending_rerank = lookup.pendingJudge || null;
    RESULT_LOOKUPS.set(r, lookup);
    return r;
  }

  // Verifies run.entries (or only options.indices, for a retry) through a
  // bounded queue and publishes each result via ctx.onProgress/onResult; an
  // AI judge answer that arrives later re-decides the result unless the user
  // already decided. Resolves to { state: "completed" | "inactive" } or
  // { state: "rerank_failed", error } once every pending rerank settled.
  async function runVerification(run, ctx = {}, options = {}) {
    const controller = runControllerOf(ctx);
    const indexFilter = Array.isArray(options.indices) ? new Set(options.indices) : null;
    const workItems = run.entries
      .map((entry, index) => ({ entry, index }))
      .filter(item => !indexFilter || indexFilter.has(item.index));
    const total = workItems.length || run.entries.length;
    const pendingReranks = [];
    let completed = 0;

    if (!indexFilter) {
      const seenDuplicateKeys = new Map();
      run.entries.forEach((entry, i) => {
        const entryId = entry.ID || `entry_${i}`;
        const duplicateOf = Rec.findDuplicateEntryId(entry, seenDuplicateKeys);
        if (duplicateOf) run.duplicateOfByIndex[i] = duplicateOf;
        Rec.registerDuplicateKeys(entryId, entry, seenDuplicateKeys);
      });
    }

    await runBoundedQueue(workItems, async (item) => {
      const { entry, index: i } = item;
      const title = entry.title || "";
      if (!title.trim())
        return { index: i, result: buildResult(run, entry, i, bareOutcome(entry, "not_found", "no_title")) };
      const result = await verifyEntry(run, i, ctx);
      return { index: i, result };
    }, {
      concurrency: run.settings.concurrency,
      signal: run.signal,
      onResult: (payload) => {
        if (!controller.isActive(run) || !payload?.result) return;
        const i = payload.index;
        const r = payload.result;
        completed++;
        run.results[i] = r;
        seedFieldEdits(run, i);
        ctx.onProgress?.(completed, total, r);
        ctx.onResult?.(i, r);
        if (r.pending_rerank) {
          const pending = r.pending_rerank;
          const lookup = RESULT_LOOKUPS.get(r);
          const patchRerank = pending.then(answer => {
            if (!controller.isActive(run) || !answer || run.results[i]?.pending_rerank !== pending) return;
            const currentDecision = run.decisions[i];
            const preserveDecision = currentDecision && !canApplySuggestion(currentDecision, run.fieldEdits[i] || {});
            // Untouched: drop the heuristic's default field edits so the
            // re-decided result seeds its own.
            if (!preserveDecision) run.fieldEdits[i] = {};
            const entry = run.entries[i];
            const patched = buildResult(run, entry, i, decide(entry, lookup, answer), { preserve: preserveDecision });
            patched.source_warnings = r.source_warnings;
            if (preserveDecision) {
              const preservedCandidate = resolveCandidate(patched.candidate_choices, currentDecision);
              patched.selected_choice = currentDecision.action === "exclude"
                ? "exclude"
                : preservedCandidate ? "candidate" : "original";
              patched.selected_candidate_index = preservedCandidate
                ? patched.candidate_choices.indexOf(preservedCandidate)
                : -1;
            }
            run.results[i] = patched;
            seedFieldEdits(run, i);
            ctx.onResult?.(i, patched);
          });
          pendingReranks.push(patchRerank);
        }
      },
    });

    if (!controller.isActive(run)) return { state: "inactive" };
    if (pendingReranks.length) {
      ctx.onFinalizing?.(pendingReranks.length);
      const rerankSettlements = await Promise.allSettled(pendingReranks);
      const failedRerank = rerankSettlements.find(settlement => settlement.status === "rejected");
      if (failedRerank) return { state: "rerank_failed", error: failedRerank.reason };
    }
    if (!controller.isActive(run)) return { state: "inactive" };
    return { state: "completed" };
  }

export {
  ORIGINAL_DEFAULT_STATUSES,
  provenance,
  originalDecision,
  candidateDecision,
  excludeDecision,
  fieldEdit,
  isTouched,
  canApplySuggestion,
  resolveCandidate,
  applyDecision,
  withReviewRequirement,
  sourceVariantIdentity,
  reviewIssueCode,
  isReviewResolved,
  createStore,
  abortError,
  createRunController,
  defaultController,
  MAX_CANDIDATE_CHOICES,
  verificationConcurrency,
  initRunState,
  retainForRetry,
  seedRetryRun,
  clearRunResults,
  redundantJournal,
  suggestedCandidate,
  cardFields,
  defaultFieldEdits,
  applyChoice,
  editField,
  decide,
  buildLookup,
  doiRoundTrip,
  lookupPaper,
  buildResult,
  verifyEntry,
  runVerification,
};
