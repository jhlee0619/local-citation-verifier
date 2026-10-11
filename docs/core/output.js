/*
 * Output projection: the live preview state and its per-entry line diff,
 * status badges and counts, and export readiness with its confirmation
 * token. DOM-free and markup-free; it never changes the results it reads.
 */
import { entryVenue, present, titleIsSpecific, titleKey } from "./text.js?v=20261012-s18";
import { writeBib } from "./bibtex.js?v=20261012-s18";
import { applyCandidateToEntry, CORE_FIELDS, entryIntegrityIssues, isAuthoritative, isSeriousNotice } from "./records.js?v=20261012-s18";
import { applyDecision, originalDecision, resolveCandidate, reviewIssueCode } from "./verify.js?v=20261012-s18";

  // ─── Preview state ─────────────────────────────────────────────────
  function isBlockingIssue(issue) {
    return issue?.blocking !== false && issue?.severity !== "warning";
  }

  /**
   * A blocking input-integrity issue allows only whole-record choices (no
   * field-level mixing).
   */
  function requiresWholeRecordChoice(result) {
    return (result?.integrity_issues || []).some(isBlockingIssue);
  }

  // The "Max authors" setting: an export-time projection, never a field edit.
  function truncateAuthors(authorStr, max) {
    if (!authorStr || max <= 0) return authorStr;
    // BibTeX authors are separated by " and "
    const authors = authorStr.split(/\s+and\s+/i);
    if (authors.length <= max) return authorStr;
    return authors.slice(0, max).join(" and ") + " and others";
  }

  /**
   * Build preview state from current entries, results, decisions, and settings.
   * document is the parsed BibTeX document parsedEntries came from: the export
   * is written through it (bibtex.writeBib), so untouched entries, @string,
   * @preamble, @comment and free text keep their source bytes.
   */
  function buildPreviewState({
    document,
    parsedEntries,
    results, 
    decisions, 
    fieldEdits,
    settings,
  }) {
    const s = settings;
    const count = results.length;
    
    let projected = parsedEntries.slice(0, count).map((entry, i) => {
      const r = results[i];
      const decision = decisions[i] || originalDecision(false);
      if (!r) return { 
        ...applyDecision({
          original: entry,
          candidates: [],
          decision,
          fieldEdits: {},
          applyCandidate: applyCandidateToEntry,
          coreFields: CORE_FIELDS,
        }), 
        sourceIndex: i 
      };
      if (decision.action === "exclude") return null;
      if (s.removeNotFound && r.status === "not_found") return null;

      const state = applyDecision({
        original: entry,
        candidates: r.candidate_choices,
        decision,
        fieldEdits: fieldEdits[i] || {},
        applyCandidate: applyCandidateToEntry,
        coreFields: CORE_FIELDS,
      });
      const out = state.entry;
      const provenance = state.provenance;

      if (!requiresWholeRecordChoice(r) && s.maxAuthors > 0 && out.author && r.status !== "not_found") {
        const limitedAuthor = truncateAuthors(out.author, s.maxAuthors);
        if (limitedAuthor !== out.author) {
          out.author = limitedAuthor;
          provenance.author = { actor: "user", source: "setting:max_authors" };
        }
      }
      
      if ((out.ENTRYTYPE || "").toLowerCase() === "inproceedings" && out.booktitle)
        delete out.journal;
        
      const sources = new Set(Object.values(provenance).map(value => `${value.source}\u001f${value.candidateId || ""}`));
      state.mixed = sources.size > 1;
      return { ...state, sourceIndex: i };
    }).filter(Boolean);

    if (s.removeDuplicates) {
      const seen = new Set();
      projected = projected.filter(item => {
        const entry = item.entry;
        let key;
        if (s.dedupBy === "doi") key = (entry.doi || "").toLowerCase().trim();
        else if (s.dedupBy === "id") key = (entry.ID || "").toLowerCase().trim();
        // A title that is not specific ("Introduction", "2024") never removes an entry.
        else key = titleIsSpecific(entry.title) ? titleKey(entry.title) : "";
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    
    const entries = projected.map(item => item.entry);
    const written = writeBib(document, projected.map(item => ({ index: item.sourceIndex, entry: item.entry })),
      { latexEscape: s.latexEscape });
    return Object.freeze({
      entries,
      bib: written.text,
      parts: written.parts,
      latexEscape: s.latexEscape,
      sourceIndexes: projected.map(item => item.sourceIndex),
      provenanceByEntry: projected.map(item => item.provenance),
      mixedWarnings: projected.map(item => item.mixed),
    });
  }

  // The line diff between the source document and the export, one group per
  // document item (blank separators are skipped): { type: "add" | "del" |
  // "ctx", text }, plus entryIndex and entryId on the first exported line of
  // each entry.
  function previewLines(previewState) {
    const parts = previewState.parts.filter(part => part.kind !== "text" || part.original.trim());
    const lines = text => [...text.replace(/^(?:[ \t]*(?:\r\n?|\n))+|(?:(?:\r\n?|\n)[ \t]*)+$/g, "").split(/\r\n?|\n/), ""];
    const exported = parts.map((part, index) => ({ part, index })).filter(({ part }) => part.output !== null);
    const groups = diffEntryGroups(parts.map(part => lines(part.original)),
      exported.map(({ part }) => lines(part.output)), exported.map(({ index }) => index));

    return groups.flatMap(group => {
      const part = parts[group.sourceIndex];
      let marked = part.kind !== "entry";
      return group.operations.map(operation => {
        if (marked || operation.type === "del") return operation;
        marked = true;
        return { ...operation, entryIndex: part.index, entryId: part.id };
      });
    });
  }

  // ─── Line diff ─────────────────────────────────────────────────────
  const MAX_EXACT_DIFF_CELLS = 250_000;

  function exactDiff(oldLines, newLines) {
    const m = oldLines.length;
    const n = newLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);

    const result = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        result.push({ type: "ctx", text: newLines[j - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.push({ type: "add", text: newLines[j - 1] });
        j--;
      } else {
        result.push({ type: "del", text: oldLines[i - 1] });
        i--;
      }
    }
    return result.reverse();
  }

  function uniquePositions(lines) {
    const positions = new Map();
    lines.forEach((line, index) => {
      positions.set(line, positions.has(line) ? -1 : index);
    });
    return positions;
  }

  function orderedUniqueAnchors(oldLines, newLines) {
    const oldPositions = uniquePositions(oldLines);
    const newPositions = uniquePositions(newLines);
    const candidates = [];
    for (const [text, oldIndex] of oldPositions) {
      const newIndex = newPositions.get(text);
      if (oldIndex >= 0 && newIndex >= 0) candidates.push({ oldIndex, newIndex, text });
    }

    const tails = [];
    const predecessors = new Int32Array(candidates.length);
    predecessors.fill(-1);
    candidates.forEach((candidate, candidateIndex) => {
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (candidates[tails[middle]].newIndex < candidate.newIndex) low = middle + 1;
        else high = middle;
      }
      if (low > 0) predecessors[candidateIndex] = tails[low - 1];
      tails[low] = candidateIndex;
    });

    const anchors = [];
    let candidateIndex = tails.at(-1) ?? -1;
    while (candidateIndex >= 0) {
      anchors.push(candidates[candidateIndex]);
      candidateIndex = predecessors[candidateIndex];
    }
    return anchors.reverse();
  }

  function boundedDiff(oldLines, newLines, maxMatrixCells) {
    let prefixLength = 0;
    while (
      prefixLength < oldLines.length
      && prefixLength < newLines.length
      && oldLines[prefixLength] === newLines[prefixLength]
    ) prefixLength++;

    let suffixLength = 0;
    while (
      suffixLength < oldLines.length - prefixLength
      && suffixLength < newLines.length - prefixLength
      && oldLines[oldLines.length - suffixLength - 1] === newLines[newLines.length - suffixLength - 1]
    ) suffixLength++;

    const oldMiddle = oldLines.slice(prefixLength, oldLines.length - suffixLength);
    const newMiddle = newLines.slice(prefixLength, newLines.length - suffixLength);
    const leading = oldLines.slice(0, prefixLength).map(text => ({ type: "ctx", text }));
    const trailing = newLines.slice(newLines.length - suffixLength).map(text => ({ type: "ctx", text }));
    const anchors = orderedUniqueAnchors(oldMiddle, newMiddle);
    const middle = [];
    let oldStart = 0;
    let newStart = 0;
    let remainingMatrixCells = maxMatrixCells;

    for (const anchor of [...anchors, { oldIndex: oldMiddle.length, newIndex: newMiddle.length, text: null }]) {
      const oldGap = oldMiddle.slice(oldStart, anchor.oldIndex);
      const newGap = newMiddle.slice(newStart, anchor.newIndex);
      const matrixCells = oldGap.length * newGap.length;
      if (!oldGap.length) middle.push(...newGap.map(text => ({ type: "add", text })));
      else if (!newGap.length) middle.push(...oldGap.map(text => ({ type: "del", text })));
      else if (matrixCells <= remainingMatrixCells) {
        middle.push(...exactDiff(oldGap, newGap));
        remainingMatrixCells -= matrixCells;
      } else {
        middle.push(...oldGap.map(text => ({ type: "del", text })));
        middle.push(...newGap.map(text => ({ type: "add", text })));
      }
      if (anchor.text !== null) middle.push({ type: "ctx", text: anchor.text });
      oldStart = anchor.oldIndex + 1;
      newStart = anchor.newIndex + 1;
    }
    return [...leading, ...middle, ...trailing];
  }

  function diffLines(oldLines, newLines, options = {}) {
    const maxMatrixCells = Number.isFinite(options.maxMatrixCells)
      ? Math.max(0, Math.floor(options.maxMatrixCells))
      : MAX_EXACT_DIFF_CELLS;
    if (oldLines.length * newLines.length <= maxMatrixCells)
      return exactDiff(oldLines, newLines);
    return boundedDiff(oldLines, newLines, maxMatrixCells);
  }

  function diffEntryGroups(originalEntryLines, projectedEntryLines, sourceIndexes = []) {
    const projectedBySource = new Map();
    const unpairedProjected = [];
    projectedEntryLines.forEach((lines, projectedIndex) => {
      const configuredSourceIndex = sourceIndexes[projectedIndex];
      const sourceIndex = Number.isInteger(configuredSourceIndex) && configuredSourceIndex >= 0
        ? configuredSourceIndex
        : projectedIndex;
      const projected = { lines, sourceIndex };
      if (sourceIndex < originalEntryLines.length && !projectedBySource.has(sourceIndex))
        projectedBySource.set(sourceIndex, projected);
      else
        unpairedProjected.push(projected);
    });

    const groups = originalEntryLines.map((lines, sourceIndex) => {
      const projected = projectedBySource.get(sourceIndex);
      return {
        sourceIndex,
        operations: diffLines(lines, projected?.lines ?? []),
      };
    });
    for (const projected of unpairedProjected) {
      groups.push({
        sourceIndex: projected.sourceIndex,
        operations: diffLines([], projected.lines),
      });
    }
    return groups;
  }

  // ─── Status badges ─────────────────────────────────────────────────
  /**
   * Normalize status for summary display (collapse error states to needs_review)
   */
  function summaryStatus(status) {
    return ["lookup_failed", "cancelled", "parse_failed"].includes(status) ? "needs_review" : status;
  }

  /**
   * Badge / filter status: Needs Review means attention left.
   * Resolved keep-original / exclude → Verified (including an explicit
   * keep-original after an auto-update; an untouched original decision under
   * "updated" is the additive-only update and stays Auto-Updated).
   * Resolved candidate under needs_review → Auto-Updated (user pick on pending).
   */
  function badgeStatus(result, decision, options = {}) {
    if (!result) return "verified";
    const reviewDecision = decision || { action: "original", touched: false };

    if (result.status === "needs_review") {
      const resolved = typeof options.isReviewResolved === "function"
        ? options.isReviewResolved({
          review_required: result.review_required,
          decision: reviewDecision,
          candidates: result.candidate_choices || [],
        })
        : false;
      if (!resolved) return "needs_review";
      if (reviewDecision.action === "candidate") return "updated";
      return "verified";
    }

    if (result.status === "updated" &&
        ((reviewDecision.action === "original" && reviewDecision.touched === true) || reviewDecision.action === "exclude"))
      return "verified";

    return summaryStatus(result.status);
  }

  /** Card tag may keep distinct error labels while filters fold them into Needs Review. */
  function tagStatus(result, decision, options = {}) {
    if (!result) return "verified";
    if (["lookup_failed", "cancelled", "parse_failed"].includes(result.status))
      return result.status;
    return badgeStatus(result, decision, options);
  }

  /**
   * Count results by status category for summary badges
   */
  function summaryCounts(results, decisions = {}, options = {}) {
    const counts = { verified: 0, updated: 0, needs_review: 0, not_found: 0 };
    let duplicates = 0;
    results.forEach((r, index) => {
      if (!r) return;
      const decision = decisions[r.index] ?? decisions[index];
      const status = badgeStatus(r, decision, options);
      counts[status] = (counts[status] || 0) + 1;
      if (r.duplicate_of) duplicates++;
    });
    return { ...counts, duplicates };
  }

  // The card tag text. "Auto-Updated" names only a system auto-apply; a
  // record the user chose reads "Updated (your choice)" (data-status stays
  // "updated" for both).
  function statusLabel(status, decision) {
    if (status === "updated" && decision?.action === "candidate" && decision.touched === true)
      return "Updated (your choice)";
    return {
      verified: "Verified",
      updated: "Auto-Updated",
      needs_review: "Needs Review",
      lookup_failed: "Lookup Failed",
      cancelled: "Cancelled",
      parse_failed: "Parse Failed",
      not_found: "Not Found",
    }[status] || status;
  }

  // ─── Notices ───────────────────────────────────────────────────────
  // The notices on the work an entry exports under its decision: a chosen
  // candidate's own (_notices), otherwise those of the work the entry names
  // (result.notices); none when it is excluded.
  function noticesFor(result, decision) {
    if (!result || decision?.action === "exclude") return [];
    const selected = resolveCandidate(result.candidate_choices || [], decision || originalDecision(false));
    return (selected ? selected._notices : result.notices) || [];
  }

  // The serious notices (retraction, partial retraction, withdrawal,
  // removal, expression of concern): a flag and an export acknowledgement.
  function seriousNotices(notices) {
    return (Array.isArray(notices) ? notices : []).filter(isSeriousNotice);
  }

  // Who lists the notices: "PubMed" (source "pubmed"), "Crossref" (every
  // other source: publisher, retraction-watch, the title stamp) or both.
  function noticeListers(notices) {
    const names = new Set((notices || []).map(notice => (notice?.source === "pubmed" ? "PubMed" : "Crossref")));
    return ["Crossref", "PubMed"].filter(name => names.has(name)).join(" and ") || "Crossref";
  }

  // ─── Export readiness ──────────────────────────────────────────────
  function resultIndex(result, position) {
    return Number.isInteger(result?.index) ? result.index : position;
  }

  function citationKey(result, position) {
    return String(result?.citationKey ?? result?.key ?? result?.original?.ID ?? result?.entry?.ID ?? position);
  }

  function normalizeIssue(issue, results, position, fallbackCode) {
    const index = Number.isInteger(issue?.index) ? issue.index : position;
    const record = results.find((result, resultPosition) => resultIndex(result, resultPosition) === index);
    const out = {
      index,
      key: String(issue?.citationKey ?? issue?.key ?? citationKey(record, index)),
      code: present(issue?.code) ? String(issue.code) : fallbackCode,
    };
    if (Object.prototype.hasOwnProperty.call(issue || {}, "field")) out.field = String(issue.field);
    if (Object.prototype.hasOwnProperty.call(issue || {}, "message")) out.message = String(issue.message);
    return out;
  }

  function excludedIssue(issue, results) {
    const record = results.find((result, position) => resultIndex(result, position) === issue.index);
    return record?.decision?.action === "exclude" && record.decision.touched === true;
  }

  function decisionIdentity(result) {
    const decision = result?.decision || {};
    if (decision.action === "candidate") return JSON.stringify([
      "candidate", String(decision.source || ""), String(decision.candidateId || ""),
      String(decision.candidateFingerprint || ""),
    ]);
    return JSON.stringify([String(decision.action || ""), decision.touched === true]);
  }

  function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function issueList(issues, fallbackCode) {
    return (Array.isArray(issues) ? issues : []).map(issue => [
      String(issue?.key ?? issue?.citationKey ?? ""),
      present(issue?.code) ? String(issue.code) : fallbackCode,
    ]).sort((a, b) => compareText(a[0], b[0]) || compareText(a[1], b[1]));
  }

  // Flagged entries with the notices acknowledged for each (type and DOI).
  function noticeList(items) {
    return (Array.isArray(items) ? items : []).map(item => [
      String(item?.key ?? ""),
      (item?.notices || []).map(notice => `${notice.type}:${notice.doi || ""}`).sort().join(" "),
    ]).sort((a, b) => compareText(a[0], b[0]) || compareText(a[1], b[1]));
  }

  // The token a confirmation is bound to: run, revision, the exact output,
  // its unsafe issues, the Not Found entries, unparsed items, flagged
  // (retracted, …) works and Semantic Scholar-only choices acknowledged with
  // it and every decision.
  function confirmationToken(options = {}) {
    const results = Array.isArray(options.results) ? options.results : [];
    const unsafe = issueList(options.unsafe, "invalid_issue");
    const notFound = issueList(options.notFound, "not_found_ack");
    const invalid = issueList(options.invalid, "invalid_ack");
    const notices = noticeList(options.notices);
    const unconfirmed = issueList(options.unconfirmed, "unconfirmed_ack");
    const decisions = results.map((result, position) => ({
      index: resultIndex(result, position),
      key: citationKey(result, position),
      identity: decisionIdentity(result),
    })).sort((a, b) => a.index - b.index || compareText(a.key, b.key));
    return JSON.stringify({
      runId: String(options.runId ?? ""),
      revision: options.revision ?? null,
      bibtex: String(options.bibtex ?? ""),
      unsafe,
      notFound,
      invalid,
      ...(notices.length ? { notices } : {}),
      ...(unconfirmed.length ? { unconfirmed } : {}),
      decisions,
    });
  }

  // A Not Found entry that is exported unchanged needs the one batch
  // acknowledgement, unless its original was kept explicitly.
  function needsNotFoundAck(result) {
    if (result?.status !== "not_found" || result.included === false) return false;
    const decision = result.decision || {};
    if (decision.action === "exclude") return false;
    if (decision.action === "original" && decision.touched === true) return false;
    return decision.action !== "candidate";
  }

  // The Semantic Scholar (discovery-only) record an exported entry takes
  // values from, else null: a chosen whole record, or single field values
  // adopted from such a record (field edits with action "found").
  function unconfirmedChoice(result) {
    if (!result || result.included === false || result.decision?.action === "exclude") return null;
    if (result.decision?.action === "candidate") {
      const chosen = resolveCandidate(result.candidates || [], result.decision);
      if (chosen && !isAuthoritative(chosen)) return chosen;
    }
    for (const edit of Object.values(result.fieldEdits || {})) {
      const from = edit?.action === "found" ? edit.provenance : null;
      if (from && !isAuthoritative({ _recordSource: from.source || "unknown" }))
        return { _recordSource: from.source, _recordId: from.candidateId || "" };
    }
    return null;
  }

  // requirements: "decision" (pending reviews, never confirmable), "unsafe"
  // (final-output integrity issues), "not_found_ack" (Not Found entries),
  // "notice_ack" (exported works with a serious notice: result.notices, as
  // noticesFor gives them under the decision), "unconfirmed_ack" (a chosen
  // record only Semantic Scholar lists) and "invalid_ack" (options.invalid:
  // the document's unparsed items, exported verbatim); all but "decision"
  // are confirmed together with one token.
  function exportReadiness(options = {}) {
    const results = Array.isArray(options.results) ? options.results : [];
    const unresolved = [];
    for (let position = 0; position < results.length; position++) {
      const code = reviewIssueCode(results[position]);
      if (code) unresolved.push({
        index: resultIndex(results[position], position),
        key: citationKey(results[position], position),
        code,
      });
    }
    const unsafe = (Array.isArray(options.blockingIssues) ? options.blockingIssues : [])
      .map((issue, position) => normalizeIssue(issue, results, position, "invalid_issue"))
      .filter(issue => !excludedIssue(issue, results));
    const warnings = (Array.isArray(options.sourceWarnings) ? options.sourceWarnings : [])
      .map((issue, position) => normalizeIssue(issue, results, position, "invalid_warning"))
      .filter(issue => !excludedIssue(issue, results));
    const notFound = results
      .map((result, position) => ({ result, position }))
      .filter(({ result }) => needsNotFoundAck(result))
      .map(({ result, position }) => ({
        index: resultIndex(result, position),
        key: citationKey(result, position),
        code: "not_found_ack",
      }));
    const invalid = (Array.isArray(options.invalid) ? options.invalid : []).map(item => ({
      index: null,
      key: String(item?.key ?? ""),
      code: "invalid_ack",
      line: item?.error?.line,
      column: item?.error?.column,
      message: String(item?.error?.message || ""),
    }));
    const notices = results
      .map((result, position) => ({ result, position, flagged: seriousNotices(result?.notices) }))
      .filter(({ result, flagged }) => flagged.length && result.included !== false && result.decision?.action !== "exclude")
      .map(({ result, position, flagged }) => ({
        index: resultIndex(result, position),
        key: citationKey(result, position),
        code: "notice_ack",
        notices: flagged,
      }));
    const unconfirmed = results
      .map((result, position) => ({ result, position, chosen: unconfirmedChoice(result) }))
      .filter(({ chosen }) => chosen)
      .map(({ result, position, chosen }) => ({
        index: resultIndex(result, position),
        key: citationKey(result, position),
        code: "unconfirmed_ack",
        source: String(chosen._recordSource || chosen._source || ""),
        candidateId: String(chosen._recordId || ""),
      }));
    const requirements = [
      ...(unresolved.length ? ["decision"] : []),
      ...(unsafe.length ? ["unsafe"] : []),
      ...(notFound.length ? ["not_found_ack"] : []),
      ...(notices.length ? ["notice_ack"] : []),
      ...(unconfirmed.length ? ["unconfirmed_ack"] : []),
      ...(invalid.length ? ["invalid_ack"] : []),
    ];
    const fingerprint = confirmationToken({ ...options, results, unsafe, notFound, invalid, notices, unconfirmed });
    return {
      ready: requirements.length === 0,
      requirements,
      unresolved,
      unsafe,
      notFound,
      notices,
      unconfirmed,
      invalid,
      warnings,
      fingerprint,
      token: fingerprint,
    };
  }

  // The export of the current state: its preview state and its readiness
  // (decisions, final-output integrity, Not Found entries, flagged works,
  // unparsed items).
  function prepareExport({ document, entries, results, decisions, fieldEdits, settings, runId, revision }) {
    const state = buildPreviewState({ document, parsedEntries: entries, results, decisions, fieldEdits, settings });
    const included = new Set(state.sourceIndexes);
    const policyResults = results.map((result, index) => {
      const decision = decisions[index] || originalDecision(false);
      return {
        index,
        citationKey: entries[index]?.ID || result.entry_id || String(index),
        status: result.status,
        review_required: result.review_required,
        decision,
        candidates: result.candidate_choices || [],
        fieldEdits: fieldEdits?.[index] || {},
        notices: noticesFor(result, decision),
        included: included.has(index),
      };
    });
    const blockingIssues = [];
    const sourceWarnings = [];
    state.entries.forEach((entry, projected) => {
      const index = state.sourceIndexes[projected];
      // An entry-type/venue mismatch the entry's own DOI record settled
      // (result.integrity_waived) stays settled while the exported entry
      // keeps the entry's type and venue.
      const original = entries[index] || {};
      const waived = String(entry.ENTRYTYPE || "").toLowerCase() === String(original.ENTRYTYPE || "").toLowerCase() &&
        entryVenue(entry) === entryVenue(original) ? new Set(results[index]?.integrity_waived || []) : new Set();
      for (const issue of entryIntegrityIssues(entry).filter(item => !waived.has(item.code))) (isBlockingIssue(issue) ? blockingIssues : sourceWarnings).push({
        index,
        citationKey: entry.ID || results[index]?.entry_id || String(index),
        code: issue.code || "output_integrity_issue",
        field: issue.field || "",
        message: issue.message || issue.code || "Output integrity issue",
      });
    });
    const readiness = exportReadiness({
      results: policyResults,
      blockingIssues,
      sourceWarnings,
      invalid: (document?.items || []).filter(item => item.kind === "invalid"),
      runId,
      revision,
      bibtex: state.bib,
    });
    return { state, readiness };
  }

export {
  requiresWholeRecordChoice,
  truncateAuthors,
  buildPreviewState,
  previewLines,
  MAX_EXACT_DIFF_CELLS,
  diffEntryGroups,
  diffLines,
  summaryStatus,
  badgeStatus,
  tagStatus,
  summaryCounts,
  statusLabel,
  noticesFor,
  seriousNotices,
  noticeListers,
  confirmationToken,
  exportReadiness,
  prepareExport,
};
