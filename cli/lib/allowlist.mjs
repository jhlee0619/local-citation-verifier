/*
 * Human approvals for references outside database coverage (books, reports,
 * guidelines, national journals). The allowlist is a TSV file, by default
 * `references.allow` next to the .bib file:
 *
 *   key<TAB>fingerprint<TAB>reason<TAB>date
 *
 * The fingerprint is the first 16 hex digits of the SHA-256 of the entry's
 * normalised core fields, so editing the entry invalidates its approval.
 * Lines starting with "#" and blank lines are ignored.
 */
import crypto from "node:crypto";
import path from "node:path";
import {
  authorNames, entryDoi, entryPmcid, entryPmid, entryVenue, extractArxivId, parseYear, titleKey,
} from "../../docs/core/text.js";

export const ALLOWLIST_NAME = "references.allow";
const FINGERPRINT = /^[0-9a-f]{16}$/;

export function defaultAllowlistPath(bibPath) {
  return path.join(path.dirname(path.resolve(bibPath)), ALLOWLIST_NAME);
}

// The fields the fingerprint covers, normalised: entry type (lower case),
// title (titleKey: LaTeX folded, punctuation and case ignored), authors
// (family and given names, titleKey each, in order), year (the first
// four-digit year), venue (journal or booktitle, else publisher,
// institution, school, organization or howpublished; titleKey) and the
// identifiers DOI, arXiv ID, PMID, PMCID and ISBN (digits and X).
export function fingerprintFields(entry) {
  const year = parseYear(entry?.year);
  const venue = entryVenue(entry) || entry?.publisher || entry?.institution || entry?.school ||
    entry?.organization || entry?.howpublished || "";
  return {
    type: String(entry?.ENTRYTYPE || "").trim().toLowerCase(),
    title: titleKey(entry?.title),
    authors: authorNames(entry?.author).map(name => (name.others ? "others" : `${titleKey(name.family)},${titleKey(name.given)}`)),
    year: Number.isInteger(year) ? String(year) : "",
    venue: titleKey(venue),
    doi: entryDoi(entry),
    arxiv: extractArxivId(entry),
    pmid: entryPmid(entry),
    pmcid: entryPmcid(entry),
    isbn: String(entry?.isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase(),
  };
}

export function entryFingerprint(entry) {
  return crypto.createHash("sha256").update(JSON.stringify(fingerprintFields(entry))).digest("hex").slice(0, 16);
}

// Map key → { key, fingerprint, reason, date, line } (the last line for a
// key wins); malformed lines are counted, not used.
export function parseAllowlist(text) {
  const approvals = new Map();
  let malformed = 0;
  String(text ?? "").replace(/^﻿/, "").split(/\r\n?|\n/).forEach((raw, index) => {
    if (!raw.trim() || raw.trimStart().startsWith("#")) return;
    const [key = "", fingerprint = "", reason = "", date = ""] = raw.split("\t");
    if (!key.trim() || !FINGERPRINT.test(fingerprint.trim())) {
      malformed++;
      return;
    }
    approvals.set(key.trim(), { key: key.trim(), fingerprint: fingerprint.trim(), reason: reason.trim(), date: date.trim(), line: index + 1 });
  });
  return { approvals, malformed };
}

const oneLine = value => String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();

export function formatAllowLine({ key, fingerprint, reason, date }) {
  return [oneLine(key), fingerprint, oneLine(reason), oneLine(date)].join("\t");
}

// The allowlist text with the approval for `approval.key` added or replaced
// (other lines, comments included, are kept).
export function upsertAllowlist(text, approval) {
  const line = formatAllowLine(approval);
  const source = String(text ?? "");
  const eol = /\r\n/.test(source) ? "\r\n" : "\n";
  const lines = source ? source.split(/\r\n?|\n/) : [];
  if (lines.length && lines.at(-1) === "") lines.pop();
  let replaced = false;
  const out = lines.map(raw => {
    if (raw.trimStart().startsWith("#") || raw.split("\t")[0].trim() !== approval.key) return raw;
    if (replaced) return null;
    replaced = true;
    return line;
  }).filter(raw => raw !== null);
  if (!replaced) {
    if (!out.length) out.push("# lcv allowlist: key<TAB>fingerprint<TAB>reason<TAB>date. Human approvals only (lcv allow).");
    out.push(line);
  }
  return `${out.join(eol)}${eol}`;
}

// The approval state of an entry: null (none), or { state: "approved" |
// "stale", fingerprint, approved_fingerprint, reason, date }.
export function approvalFor(entry, approvals) {
  const approval = approvals?.get?.(String(entry?.ID ?? ""));
  if (!approval) return null;
  const fingerprint = entryFingerprint(entry);
  return {
    state: approval.fingerprint === fingerprint ? "approved" : "stale",
    fingerprint,
    approved_fingerprint: approval.fingerprint,
    reason: approval.reason,
    date: approval.date,
  };
}
