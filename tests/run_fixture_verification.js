#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const fuzzball = require("fuzzball");
global.fuzzball = fuzzball;
const lib = require("../docs/lib.js");

if (typeof global.fuzzball?.token_sort_ratio !== "function") {
  throw new Error("Fixture harness requires fuzzball.token_sort_ratio for production parity");
}

const CROSSREF_API = "https://api.crossref.org/works";
const SS_MATCH = "https://api.semanticscholar.org/graph/v1/paper/search/match";
const SS_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search";
const SS_FIELDS = "title,authors,year,venue,publicationVenue,externalIds";
const ARXIV_BIBTEX = "https://arxiv.org/bibtex/";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const MAX_CANDIDATE_CHOICES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rate = { ss: 500, cr: 100, lastSS: 0, lastCR: 0 };

function isTransientHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(resp, attempt) {
  const retryAfter = resp?.headers?.get?.("Retry-After");
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return RETRY_BASE_MS * Math.pow(2, attempt);
}

async function fetchJSON(url, params, { is404Ok = false, retries = MAX_RETRIES } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const isSS = url.includes("semanticscholar.org");
  const delay = isSS ? rate.ss : rate.cr;
  const lastKey = isSS ? "lastSS" : "lastCR";
  const elapsed = Date.now() - rate[lastKey];
  if (elapsed < delay) await sleep(delay - elapsed);
  rate[lastKey] = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(u.toString());
      if (resp.ok) return resp.json();
      if (resp.status === 404 && is404Ok) return null;
      if (isTransientHttpStatus(resp.status) && attempt < retries) {
        await sleep(retryDelayMs(resp, attempt));
        continue;
      }
      if (isTransientHttpStatus(resp.status))
        throw new Error(`transient upstream error ${resp.status}`);
      return null;
    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function searchSSMatch(title) {
  const data = await fetchJSON(SS_MATCH, { query: title, fields: SS_FIELDS }, { is404Ok: true });
  if (!data?.data?.[0]) return null;
  return lib.ssToStandard(data.data[0]);
}

async function searchCrossref(title) {
  const data = await fetchJSON(CROSSREF_API, {
    "query.title": title,
    rows: "5",
    select: "title,author,published-print,published-online,container-title,volume,issue,page,DOI,publisher,URL,type",
  });
  return (data?.message?.items || []).map(lib.crossrefToStandard);
}

async function searchSSSearch(title) {
  const data = await fetchJSON(SS_SEARCH, { query: title, limit: "5", fields: SS_FIELDS });
  return (data?.data || []).map(lib.ssToStandard);
}

function bibEntryToArxivCandidate(entry, arxivId) {
  return {
    title: entry.title || "",
    author: entry.author || "",
    year: entry.year || "",
    journal: entry.journal || entry.booktitle || "arXiv",
    volume: entry.volume || "",
    number: entry.number || "",
    pages: entry.pages || "",
    doi: entry.doi || "",
    publisher: entry.publisher || "",
    url: entry.url || `https://arxiv.org/abs/${arxivId}`,
    eprint: entry.eprint || arxivId,
    archiveprefix: entry.archiveprefix || "arXiv",
    _source: "arxiv",
    _arxivId: arxivId,
  };
}

async function fetchArxivCandidate(arxivId) {
  const id = lib.normalizeArxivId(arxivId);
  if (!id) return null;
  const resp = await fetch(`${ARXIV_BIBTEX}${encodeURIComponent(id)}`);
  if (!resp.ok) return null;
  const entry = lib.parseBib(await resp.text())[0];
  if (!entry?.title) return null;
  return bibEntryToArxivCandidate(entry, id);
}

async function addArxivCandidates(candidates, original) {
  const ids = new Set([lib.extractArxivId(original)]);
  candidates.forEach(candidate => ids.add(lib.extractArxivId(candidate)));
  const arxivIds = [...ids].filter(Boolean);
  if (!arxivIds.length) return candidates;
  const arxivCandidates = await Promise.all(arxivIds.map(fetchArxivCandidate));
  return lib.dedupeCandidates(arxivCandidates.filter(Boolean).concat(candidates));
}

function rememberLookupError(errors, err) {
  if (!err) return;
  errors.push(err);
}

function throwIfAllLookupsFailed(candidates, errors) {
  if (!candidates.length && errors.length) throw errors[0];
}

async function searchCandidatePool(title, original) {
  const candidates = [];
  const errors = [];
  const results = await Promise.allSettled([
    searchSSMatch(title),
    searchCrossref(title),
    searchSSSearch(title),
  ]);

  const [ssMatchResult, crResult, ssSearchResult] = results;
  if (ssMatchResult.status === "fulfilled" && ssMatchResult.value)
    candidates.push(ssMatchResult.value);
  else if (ssMatchResult.status === "rejected") rememberLookupError(errors, ssMatchResult.reason);

  if (crResult.status === "fulfilled") candidates.push(...crResult.value);
  else rememberLookupError(errors, crResult.reason);

  if (ssSearchResult.status === "fulfilled") candidates.push(...ssSearchResult.value);
  else rememberLookupError(errors, ssSearchResult.reason);

  const withArxiv = await addArxivCandidates(lib.dedupeCandidates(candidates), original);
  throwIfAllLookupsFailed(withArxiv, errors);
  return withArxiv;
}

async function verifyEntry(entry) {
  const normalized = lib.normalizeEntryForLookup(entry);
  const title = lib.stripLatex(entry.title || "");
  if (!title.trim()) {
    return { status: "not_found", titleScore: 0, diffs: [], reason: "missing title" };
  }

  const candidates = await searchCandidatePool(title, normalized);
  const top = lib.topCandidates(candidates, normalized, { preferPublished: true, limit: MAX_CANDIDATE_CHOICES });
  const ranked = lib.rerankCandidates(top.length ? top : candidates, normalized, { preferPublished: true });
  const found = ranked.best ? lib.preservePublishedVenue(normalized, ranked.best) : null;
  if (!found) {
    return { status: "not_found", titleScore: 0, diffs: [], reason: "no candidate" };
  }

  const cmp = lib.compareEntry(entry, found);
  let status = cmp.status;
  if (status !== "not_found" && lib.hasCriticalMetadataConflict(entry, found)) status = "needs_review";

  const diffFields = (cmp.field_diffs || []).map((d) => ({
    field: d.field,
    score: d.score,
    original: (d.original || "").slice(0, 80),
    found: (d.found || "").slice(0, 80),
  }));

  return {
    status,
    titleScore: cmp.title_score,
    foundTitle: found.title || "",
    foundSource: found._source || "",
    foundDoi: found.doi || "",
    diffs: diffFields,
    candidateCount: candidates.length,
  };
}

function formatStyle(entry) {
  const issues = [];
  const author = entry.author || "";
  if (/ and others\b/i.test(author)) issues.push("author:others");
  if (/\\['`"~^]|\\c\{|\\u\{|\\'/.test(JSON.stringify(entry))) issues.push("latex:accents");
  if ((entry.journal || "").toLowerCase().includes("arxiv preprint")) issues.push("venue:arxiv-preprint");
  if ((entry.journal || "").toLowerCase().includes("arxiv e-prints")) issues.push("venue:arxiv-eprints");
  if (entry.ENTRYTYPE === "inproceedings" && entry.journal) issues.push("type:journal-on-inproc");
  if (entry.ENTRYTYPE === "article" && entry.booktitle) issues.push("type:booktitle-on-article");
  if (!entry.author && !entry.title) issues.push("missing:core");
  if (/^\s*author\s*=/m.test(JSON.stringify(entry)) === false && entry.author) {
    const keys = Object.keys(entry).filter((k) => !k.startsWith("_") && k !== "ENTRYTYPE" && k !== "ID");
    if (keys[0] !== "author" && keys[0] !== "title") issues.push(`field-order:${keys[0]}-first`);
  }
  if (entry.pages && !entry.pages.includes("--") && entry.pages.includes("-")) issues.push("pages:single-dash");
  return issues;
}

async function main() {
  const fixture = process.argv[2] || path.join(__dirname, "fixtures/user-stroke-bib.bib");
  const bib = fs.readFileSync(fixture, "utf8");
  const entries = lib.parseBib(bib);

  console.log(`Parsed ${entries.length} entries from ${path.basename(fixture)}\n`);

  const seen = new Map();
  const summary = { verified: 0, updated: 0, needs_review: 0, not_found: 0 };
  const rows = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryId = entry.ID || `entry_${i}`;
    const duplicateOf = lib.findDuplicateEntryId(entry, seen);
    lib.registerDuplicateKeys(entryId, entry, seen);
    const styleIssues = formatStyle(entry);

    process.stdout.write(`[${i + 1}/${entries.length}] ${entryId} ... `);
    let result;
    try {
      result = await verifyEntry(entry);
    } catch (err) {
      result = { status: "error", titleScore: 0, diffs: [], reason: err.message };
    }
    summary[result.status] = (summary[result.status] || 0) + 1;
    console.log(result.status);

    rows.push({
      id: entryId,
      type: entry.ENTRYTYPE,
      status: result.status,
      titleScore: result.titleScore,
      duplicateOf: duplicateOf || "",
      styleIssues,
      diffCount: result.diffs?.length || 0,
      topDiffs: (result.diffs || []).slice(0, 4),
      foundSource: result.foundSource || "",
      foundDoi: result.foundDoi || "",
      reason: result.reason || "",
    });
  }

  console.log("\n=== Summary ===");
  for (const [k, v] of Object.entries(summary)) console.log(`${k}: ${v}`);

  console.log("\n=== Style / format signals ===");
  for (const row of rows) {
    if (!row.styleIssues.length) continue;
    console.log(`${row.id}: ${row.styleIssues.join(", ")}`);
  }

  console.log("\n=== Needs review / not found ===");
  for (const row of rows) {
    if (row.status !== "needs_review" && row.status !== "not_found" && row.status !== "error") continue;
    console.log(`\n${row.id} [${row.status}] score=${row.titleScore}`);
    if (row.reason) console.log(`  reason: ${row.reason}`);
    for (const d of row.topDiffs) {
      console.log(`  - ${d.field} (${d.score}): "${d.original}" -> "${d.found}"`);
    }
  }

  console.log("\n=== Updated entries (field diffs) ===");
  for (const row of rows) {
    if (row.status !== "updated") continue;
    console.log(`\n${row.id} (${row.diffCount} diffs, source=${row.foundSource})`);
    for (const d of row.topDiffs) {
      console.log(`  - ${d.field}: "${d.original}" -> "${d.found}"`);
    }
  }

  const outPath = path.join(__dirname, "fixtures/user-stroke-bib-results.live.json");
  fs.writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  addArxivCandidates,
  fetchJSON,
  hasProductionFuzzball: () => typeof global.fuzzball?.token_sort_ratio === "function",
  isTransientHttpStatus,
  verifyEntry,
};
