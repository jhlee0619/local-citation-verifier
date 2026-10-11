/*
 * lcv check and lcv fix: the web app's verification pipeline
 * (core/verify.js runVerification with core/providers.js adapters) run in
 * Node over one bibliography file, each result projected to a compact
 * report entry, and the strict verdict: Verified or a valid human approval
 * passes, everything else blocks.
 */
import "./network.mjs"; // defines window.location before providers.js loads
import * as Bib from "../../docs/core/bibtex.js";
import * as Formats from "../../docs/core/formats.js";
import * as Net from "../../docs/core/net.js";
import * as Prov from "../../docs/core/providers.js";
import * as Rec from "../../docs/core/records.js";
import * as D from "../../docs/core/verify.js";
import * as Out from "../../docs/core/output.js";
import { entryDoi, entryPmcid, entryPmid, entryVenue, extractArxivId } from "../../docs/core/text.js";
import { approvalFor, entryFingerprint } from "./allowlist.mjs";

// The page defaults (docs/index.html), with the AI judge off.
export const RUN_SETTINGS = Object.freeze({
  removeDuplicates: false,
  dedupBy: "title",
  removeNotFound: false,
  maxAuthors: 0,
  preferPublished: true,
  latexEscape: false,
  speedMode: "balanced",
  rerankProvider: "off",
  evidenceLanguage: "en",
  concurrency: D.verificationConcurrency("balanced"),
});

// Provider adapters as docs/main.js builds them on a proxy origin (the
// /api/* paths; network.mjs answers them).
export function createCliProviders() {
  return Prov.createProviderAdapters({
    metadataCache: Net.createTtlCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 4096 }),
    arxivCache: Net.createTtlCache({ ttlMs: 7 * 24 * 60 * 60 * 1000, maxEntries: 1024 }),
    endpoints: Prov.endpointsFor(globalThis.window.location),
  });
}

// File text → { format: "bibtex" | "ris" | "medline", converted, document }.
// RIS and MEDLINE are converted to BibTeX first, as the page does.
export function loadBibliography(text) {
  const converted = Formats.convertToBibtex(text);
  return {
    format: converted ? converted.format : "bibtex",
    converted: converted ? converted.count : 0,
    document: Bib.parseBibDocument(converted ? converted.text : text),
  };
}

// Runs the verification of every entry. Also records each entry's provider
// pool, so the report can name the record the status policy decided on.
export async function verifyDocument(document, providers, { onResult } = {}) {
  const pools = new Map();
  const recording = {
    ...providers,
    async searchCandidatePool(title, lookupEntry, run) {
      const pool = await providers.searchCandidatePool(title, lookupEntry, run);
      pools.set(JSON.stringify(lookupEntry), pool);
      return pool;
    },
  };
  const controller = D.createRunController();
  const run = controller.startVerification({ entries: document.entries, settings: RUN_SETTINGS });
  D.initRunState(run);
  const outcome = await D.runVerification(run, { providers: recording, controller, onResult });
  if (outcome.state !== "completed") throw new Error(`verification stopped (${outcome.state})`);
  const poolFor = index => pools.get(JSON.stringify(Rec.normalizeEntryForLookup(run.entries[index]))) || null;
  return { run, poolFor };
}

// The record decide() based the result on (the confirming record, the
// additive or identifier record, or the record shown for review), re-derived
// with the same pure policy from the entry's pool; null if there is none.
function decidedRecord(entry, result, pool) {
  if (!pool?.candidates?.length) return null;
  const lookup = D.buildLookup(entry, pool.candidates, {
    preferPublished: RUN_SETTINGS.preferPublished,
    sourceWarnings: pool.sourceWarnings,
    doiRecords: pool.doiRecords,
    noticesByDoi: pool.noticesByDoi,
    identifiers: pool.identifiers,
    unavailableProviders: pool.unavailableProviders,
    blockedProviders: pool.blockedProviders,
  });
  if (lookup.additive) lookup.roundTrip = { ok: (result.suggested_fields || []).length > 0 };
  const outcome = D.decide(entry, lookup);
  return outcome.status === result.status ? outcome.record : null;
}

export function recordSummary(record) {
  if (!record) return null;
  return {
    source: String(record._recordSource || record._source || ""),
    id: String(record._recordId || ""),
    authoritative: Rec.isAuthoritative(record),
    type: String(record.ENTRYTYPE || ""),
    title: String(record.title || ""),
    authors: String(record.author || ""),
    year: String(record.year || ""),
    venue: entryVenue(record) || "",
    doi: entryDoi(record),
    pmid: entryPmid(record),
    pmcid: entryPmcid(record),
    arxiv: extractArxivId(record),
    url: Rec.paperUrlForEntry(record) || "",
  };
}

export function noticeSummary(notice) {
  return {
    type: notice.type,
    label: notice.label || "",
    doi: notice.doi || "",
    pmid: notice.pmid || "",
    source: notice.source || "",
    date: notice.date || "",
    serious: Rec.isSeriousNotice(notice),
  };
}

// Field-level changes between two entries ({ field, from, to }; null for a
// missing field). ID and internal (_) fields are not compared.
export function fieldChanges(before, after) {
  const value = (entry, field) => {
    const raw = entry?.[field];
    return raw === undefined || raw === null || String(raw) === "" ? null : String(raw);
  };
  const fields = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(field => field !== "ID" && !field.startsWith("_"));
  return fields.map(field => ({ field, from: value(before, field), to: value(after, field) }))
    .filter(change => change.from !== change.to);
}

// ─── Strict verdict ──────────────────────────────────────────────────
// pass: Verified without a serious notice, or a human approval whose
// fingerprint still matches. block: the codes that stop it (invalid,
// stale_approval, updated, needs_review, not_found, lookup_failed,
// serious_notice). network: only a failed lookup blocks it.
export function strictVerdict(item) {
  if (item.status === "invalid") return { pass: false, network: false, block: ["invalid"] };
  if (item.approval?.state === "approved") return { pass: true, network: false, block: [] };
  const block = [];
  if (item.approval?.state === "stale") block.push("stale_approval");
  if (item.status !== "verified") block.push(item.status);
  if ((item.notices || []).some(notice => notice.serious)) block.push("serious_notice");
  return { pass: block.length === 0, network: block.length > 0 && block.every(code => code === "lookup_failed"), block };
}

// 0: nothing blocks (non-strict: always, unless a lookup failed); 1: a
// finding blocks; 3: only failed lookups block.
export function exitCodeFor(items, { strict = true } = {}) {
  const blocking = items.filter(item => item.blocking);
  if (!strict) return blocking.some(item => item.network_only || item.status === "lookup_failed") ? 3 : 0;
  if (!blocking.length) return 0;
  return blocking.every(item => item.network_only) ? 3 : 1;
}

// ─── Advice ──────────────────────────────────────────────────────────
const shellQuote = value => (/^[\w./:@+-]+$/.test(value) ? value : `"${String(value).replace(/(["$`])/g, "\\$1")}"`);

export function recordRef(record) {
  if (!record) return "";
  const ids = [
    record.doi && `doi:${record.doi}`, record.pmid && `pmid:${record.pmid}`, record.arxiv && `arXiv:${record.arxiv}`,
  ].filter(id => id && id.split(":").slice(1).join(":") !== record.id);
  return [`${record.source}:${record.id}`, ...ids].join(" ");
}

function resolveCommand(record, key) {
  const flag = record?.doi ? `--doi ${record.doi}` : record?.pmid ? `--pmid ${record.pmid}`
    : record?.arxiv ? `--arxiv ${record.arxiv}` : "";
  return flag ? `lcv resolve ${flag} --bibtex --key ${shellQuote(key)}` : "";
}

const REVIEW_ADVICE = {
  unconfirmed_source: "only Semantic Scholar lists this work, which does not prove it exists: find it with lcv resolve (DOI, PMID or arXiv ID) and replace the entry, or delete it",
  wrong_authors: "a record with this exact title has other authors: replace the entry with that record",
  wrong_year: "a record with this title and first author has another year: replace the entry with that record",
  id_title_mismatch: "the entry's DOI or arXiv ID belongs to another title: correct the identifier, or replace the entry with the record it names",
  id_conflict: "the DOI and the arXiv ID identify different works: keep only the right one",
  core_conflict: "authoritative records of the entry's identifier disagree: keep the entry if it matches the version you cite, or replace it with the right record",
  identifier_record_changes_type_or_venue: "the record the entry's DOI names would change the entry type or replace the venue with a series or shorter name, so it was not applied: keep the entry if it is right, or replace it with the whole record",
  doi_unconfirmed: "the work matches the listed record, but the entry's DOI could not be found (Crossref, DataCite): fix or remove the DOI",
  arxiv_unconfirmed: "the work matches the listed record, but the entry's arXiv ID could not be found (arXiv, DataCite): fix or remove it",
  pmid_unconfirmed: "the work matches the listed record, but the entry's PMID or PMCID could not be found in PubMed: fix or remove it",
};

const clip = value => (String(value).length > 60 ? `${String(value).slice(0, 57)}…` : String(value));

function diffText(item) {
  const diffs = (item.diffs || []).filter(diff => diff.field !== "title").slice(0, 4)
    .map(diff => (diff.entry ? `${diff.field} ${clip(diff.entry)} → ${clip(diff.record)}` : `${diff.field} +${clip(diff.record)}`));
  return diffs.length ? ` (${diffs.join("; ")})` : "";
}

function changeText(changes) {
  return changes.slice(0, 5).map(change => (change.from === null ? `+${change.field}`
    : change.to === null ? `-${change.field}` : `${change.field}`)).join(", ") + (changes.length > 5 ? ", …" : "");
}

export function adviceFor(item) {
  if (item.block.includes("invalid"))
    return `fix the BibTeX syntax at line ${item.line}:${item.column} (${item.message}); unparsed entries are never verified`;
  const parts = [];
  if (item.block.includes("stale_approval"))
    parts.push("the entry changed after its human approval: restore it, or a human re-approves it with lcv allow");
  const target = item.candidates?.find(candidate => candidate.recommended) || item.record;
  if (item.status === "updated")
    parts.push(`apply it with: lcv fix ${shellQuote(item.file)} --in-place (${changeText(item.fix?.changes || [])})`);
  else if (item.status === "needs_review") {
    const reason = item.reasons[0];
    // The records and fields behind a review the diffs do not show.
    const detail = item.detail ? ` (${item.detail})` : "";
    let text = reason === "integrity"
      ? `fix the entry's own fields: ${item.integrity.filter(issue => issue.blocking).map(issue => `${issue.code}${issue.message ? ` (${issue.message.replace(/\.$/, "")})` : ""}`).join("; ")}`
      : REVIEW_ADVICE[reason] ? `${REVIEW_ADVICE[reason]}${detail}`
        : `the entry disagrees with the record${diffText(item) || detail}: replace it with the whole record (no field mixing)`;
    const command = reason !== "unconfirmed_source" && target?.authoritative ? resolveCommand(target, item.key) : "";
    if (command) text += reason === "integrity" ? `, or replace it with the whole record: ${command}` : `: ${command}`;
    parts.push(text);
  } else if (item.status === "not_found")
    parts.push("no database lists this work: replace it with a record from lcv resolve, delete it, or (book, report, guideline) ask a human to approve it with lcv allow");
  else if (item.status === "lookup_failed" && (item.blocked_providers || []).length)
    parts.push(`${item.blocked_providers.join(", ")} answered with a bot check (it is blocking automated requests), so the entry could not be checked against every database; this is not evidence against it: rerun lcv check in a while, not right away`);
  else if (item.status === "lookup_failed" && (item.reasons.includes("provider_unavailable") || (item.unavailable_providers || []).length))
    parts.push(`${(item.unavailable_providers || []).join(", ") || "a database"} did not answer${(item.source_warnings || []).length ? ` (${item.source_warnings.join(" ")})` : ""}, so the entry could not be checked against every database; this is not evidence against it: rerun lcv check later`);
  else if (item.status === "lookup_failed")
    parts.push(`the lookup failed (${(item.source_warnings || []).join(" ") || item.lookup_error || "network"}): rerun lcv check`);
  if (item.block.includes("serious_notice")) {
    const types = [...new Set(item.notices.filter(notice => notice.serious).map(notice => notice.type.replace(/_/g, " ")))];
    parts.push(`the work has a ${types.join(" and ")} notice: remove the citation, or a human approves citing it with lcv allow`);
  }
  return parts.join("; ");
}

// ─── Report entries ──────────────────────────────────────────────────
export function finishItem(item) {
  const verdict = strictVerdict(item);
  item.blocking = !verdict.pass;
  item.network_only = verdict.network;
  item.block = verdict.block;
  item.action = verdict.pass ? "" : adviceFor(item);
  return item;
}

// One report entry per verified entry and per unparsed item.
export function reportEntries({ file, document, run, poolFor, approvals }) {
  const preview = Out.buildPreviewState({
    document,
    parsedEntries: run.entries,
    results: run.results,
    decisions: run.decisions,
    fieldEdits: run.fieldEdits,
    settings: RUN_SETTINGS,
  });
  const projected = new Map(preview.sourceIndexes.map((index, position) => [index, preview.entries[position]]));
  const items = run.entries.map((entry, index) => {
    const result = run.results[index];
    const decision = run.decisions[index] || D.originalDecision(false);
    const choices = result.candidate_choices || [];
    const record = decidedRecord(entry, result, poolFor(index));
    let fix = null;
    if (result.status === "updated") {
      const kind = result.auto_select_source || "identifier";
      const fixRecord = kind === "identifier" ? choices[result.selected_candidate_index] || record : record;
      fix = { kind, record: recordSummary(fixRecord), changes: fieldChanges(document.entries[index], projected.get(index)) };
    }
    return finishItem({
      file,
      key: String(entry.ID || ""),
      index,
      type: String(entry.ENTRYTYPE || ""),
      title: String(entry.title || ""),
      status: result.status,
      reasons: [...(result.review_reasons || [])],
      record: recordSummary(record),
      fix,
      diffs: (result.field_diffs || []).map(diff => ({ field: diff.field, entry: diff.original || "", record: diff.found || "" })),
      detail: result.review_detail || "",
      candidates: choices.map((choice, position) => ({
        ...recordSummary(choice),
        same_work: Rec.sameWork(entry, choice),
        recommended: position === result.recommended_candidate_index,
      })),
      lint: Rec.lintNotes(entry),
      notices: Out.noticesFor(result, decision).map(noticeSummary),
      integrity: (result.integrity_issues || []).map(issue => ({
        code: issue.code,
        field: issue.field || "",
        message: issue.message || "",
        blocking: issue.blocking !== false && issue.severity !== "warning",
      })),
      duplicate_of: result.duplicate_of || null,
      source_warnings: [...(result.source_warnings || [])],
      lookup_error: result.lookup_error || null,
      unavailable_providers: [...(result.unavailable_providers || [])],
      suggested_fields: [...(result.suggested_fields || [])],
      blocked_providers: [...(result.blocked_providers || [])],
      fingerprint: entryFingerprint(entry),
      approval: approvalFor(entry, approvals),
    });
  });
  const invalid = document.items.filter(part => part.kind === "invalid").map(part => finishItem({
    file,
    key: String(part.key || part.error?.key || ""),
    index: null,
    status: "invalid",
    reasons: [part.error?.reason || "parse_error"],
    line: part.error?.line ?? null,
    column: part.error?.column ?? null,
    message: part.error?.message || "unparsable entry",
  }));
  return { items: [...items, ...invalid], projected };
}

// The file with only the system auto-updates applied (identifier record or
// additive fields), through the span-preserving writer: every other entry,
// @string, @comment and free text keeps its bytes.
export function fixedText(document, run, projected) {
  const outputs = document.entries.map((entry, index) => ({
    index,
    entry: run.results[index]?.status === "updated" && projected.has(index) ? projected.get(index) : entry,
  }));
  return Bib.writeBib(document, outputs, { latexEscape: false }).text;
}

// ─── Counts and text ─────────────────────────────────────────────────
export const STATUS_ORDER = ["verified", "updated", "needs_review", "not_found", "lookup_failed", "invalid"];

export function statusName(status) {
  return status === "invalid" ? "Invalid" : Out.statusLabel(status);
}

export function countByStatus(items) {
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

export function countsText(items) {
  const counts = countByStatus(items);
  return STATUS_ORDER.filter(status => counts[status]).map(status => `${counts[status]} ${statusName(status)}`).join(", ") || "no entries";
}

// One line per entry: KEY — STATUS (reasons) — what to do — record.
export function itemLine(item) {
  const reasons = item.status === "verified" || item.status === "updated" ? [] : item.reasons.filter(reason => reason !== "no_matching_record");
  const head = `${item.key || "(no key)"} — ${statusName(item.status)}${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
  const target = item.status === "updated" ? item.fix?.record
    : item.candidates?.find(candidate => candidate.recommended) || item.record;
  const notes = [
    ...(item.lint || []).map(note => note.code),
    ...(item.duplicate_of ? [`duplicate_of:${item.duplicate_of}`] : []),
    ...(item.approval ? [`approval:${item.approval.state}`] : []),
    ...(item.suggested_fields?.length ? [`could add ${item.suggested_fields.join(", ")} (lcv resolve)`] : []),
  ];
  return [head, item.action, recordRef(target), notes.length ? `[${notes.join(", ")}]` : ""].filter(Boolean).join(" — ");
}
