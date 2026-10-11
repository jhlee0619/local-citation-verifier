/*
 * lcv resolve: looks a work up with the same providers as the verifier and
 * lists only authoritative records (Crossref, PubMed, arXiv, DBLP,
 * OpenReview). Semantic Scholar records are listed apart as discovery only.
 * --bibtex prints one record as canonical BibTeX: its own fields only (never
 * merged with another record), LaTeX-safe through the core writer.
 */
import "./network.mjs"; // defines window.location before providers.js loads
import * as Bib from "../../docs/core/bibtex.js";
import * as Formats from "../../docs/core/formats.js";
import * as Net from "../../docs/core/net.js";
import * as Rec from "../../docs/core/records.js";
import * as D from "../../docs/core/verify.js";
import {
  arxivIdInText, normalizeArxivId, normalizeDoi, normalizePmcid, normalizePmid, parseYear, pmcidInText, pmidInText,
  stripLatex, TITLE_MATCH_THRESHOLD, titleSimilarity,
} from "../../docs/core/text.js";
import { noticeSummary, recordSummary, RUN_SETTINGS } from "./check.mjs";

const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
// A period that ends a sentence, not an initial ("K. He", "J.-P. Smith").
const SENTENCE_BREAK = /(?<!(?:^|[\s.\-])\p{Lu})\.\s+/u;
const INITIALS = /^(?:\p{Lu}\.?\s*-?\s*)+$/u;
// A Vancouver author list ("He K, Zhang X, Sun J." or "Smith AB, et al.")
// and the rest of the reference.
const VANCOUVER_AUTHORS = /^((?:[^,.]+?\s\p{Lu}{1,3},\s+)*[^,.]+?\s\p{Lu}{1,3}(?:,?\s+et al)?)\.\s+(.+)$/u;

// "He K, Zhang X" (Vancouver), "He, K., Zhang, X." (APA), "K. He, X. Zhang
// and J. Sun" (IEEE) → "He, K and Zhang, X and …" (at most 10 names).
export function authorsToBibtex(text) {
  const list = String(text ?? "").replace(/\bet\s+al\.?/gi, "").replace(/\s*&\s*/g, ", ")
    .replace(/,?\s+and\s+/gi, ", ");
  const names = [];
  for (const token of list.split(/[;,]/).map(part => part.trim()).filter(Boolean)) {
    if (INITIALS.test(token) && names.length && !names.at(-1).given) {
      names.at(-1).given = token;
      continue;
    }
    const vancouver = /^(.+?)\s+(\p{Lu}{1,3})$/u.exec(token);
    if (vancouver) names.push({ family: vancouver[1], given: vancouver[2] });
    else if (/\s/.test(token)) {
      const words = token.split(/\s+/);
      names.push({ family: words.pop(), given: words.join(" ") });
    } else names.push({ family: token, given: "" });
  }
  return names.slice(0, 10).map(name => (name.given ? `${name.family}, ${name.given}` : name.family)).join(" and ");
}

// An --author value: a BibTeX author list as it is, other forms converted.
function authorOption(value) {
  const text = String(value ?? "").trim();
  const parts = text.split(",");
  if (/\sand\s/.test(text) || (parts.length === 2 && !/\s/.test(parts[0].trim()))) return text;
  return authorsToBibtex(text);
}

const trimTitle = value => String(value ?? "").replace(/^[\s"“”'‘’]+|[\s"“”'‘’,.;:]+$/g, "").trim();

// A free-text reference → { title, author, year, doi, pmid, pmcid, arxiv }.
// Identifiers come from the core extractors (and a DOI pattern); title,
// authors and year from simple heuristics: a quoted title, an APA "(year).
// Title.", else the sentence after the author list, else the whole text.
export function parseReference(text) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  const out = { title: "", author: "", year: "", doi: "", pmid: pmidInText(source), pmcid: pmcidInText(source), arxiv: arxivIdInText(source) };
  const doiMatch = DOI_IN_TEXT.exec(source);
  if (doiMatch) {
    const doi = normalizeDoi(doiMatch[1].replace(/[.,;:)\]}]+$/, ""));
    if (/^10\.48550\/arxiv\./.test(doi)) out.arxiv ||= arxivIdInText(doi);
    else out.doi = doi;
  }
  const rest = source.replace(/\bhttps?:\/\/\S+/gi, " ").replace(/\b(?:doi:?\s*)?10\.\d{4,9}\/\S+/gi, " ")
    .replace(/\barxiv:\s*\S+/gi, " ").replace(/\bPMC?ID:?\s*PMC?\d+/gi, " ").replace(/\s+/g, " ").trim();
  let author = "";
  let tail = rest;
  const quoted = /[“"]([^”"]{8,})[”"]/.exec(rest);
  const apa = /\((\d{4})[a-z]?\)\.?\s+(.+?[.?!])(?:\s|$)/.exec(rest);
  const vancouver = VANCOUVER_AUTHORS.exec(rest);
  if (vancouver && !quoted && !apa) {
    author = vancouver[1];
    const [title = "", ...after] = vancouver[2].split(SENTENCE_BREAK);
    out.title = trimTitle(title);
    tail = after.join(". ");
  } else if (quoted) {
    out.title = trimTitle(quoted[1]);
    author = rest.slice(0, quoted.index);
    tail = rest.slice(quoted.index + quoted[0].length);
  } else if (apa) {
    out.title = trimTitle(apa[2]);
    author = rest.slice(0, apa.index);
    tail = `${apa[1]} ${rest.slice(apa.index + apa[0].length)}`;
  } else {
    const segments = rest.split(SENTENCE_BREAK).map(segment => segment.trim()).filter(Boolean);
    const authorLike = segments.length > 1 && /,|\sand\s|&|\bet al\b/i.test(segments[0]);
    out.title = trimTitle(authorLike ? segments[1] : segments[0]);
    if (authorLike) {
      author = segments[0];
      tail = segments.slice(2).join(". ");
    } else tail = segments.slice(1).join(". ");
  }
  out.author = authorsToBibtex(author.replace(/[\s,.:;]+$/, ""));
  const year = parseYear(tail);
  if (Number.isInteger(year)) out.year = String(year);
  return out;
}

// The lookup query from resolve's options and free text (options win).
export function buildQuery(options, positionals) {
  const parsed = positionals.length ? parseReference(positionals.join(" ")) : {};
  const arxivOption = options.arxiv ? normalizeArxivId(options.arxiv) || arxivIdInText(options.arxiv) : "";
  const doiOption = options.doi ? normalizeDoi(options.doi) : "";
  const query = {
    title: options.title ? String(options.title).trim() : parsed.title || "",
    author: options.author ? authorOption(options.author) : parsed.author || "",
    year: options.year ? String(parseYear(options.year) || "") : parsed.year || "",
    doi: doiOption && !/^10\.48550\/arxiv\./.test(doiOption) ? doiOption : parsed.doi || "",
    pmid: options.pmid ? normalizePmid(options.pmid) : parsed.pmid || "",
    pmcid: options.pmcid ? normalizePmcid(options.pmcid) : parsed.pmcid || "",
    arxiv: arxivOption || (doiOption ? arxivIdInText(doiOption) : "") || parsed.arxiv || "",
  };
  return query;
}

function queryEntry(query) {
  const entry = { ENTRYTYPE: "misc", ID: "lcv_query" };
  for (const field of ["title", "author", "year", "doi", "pmid", "pmcid"]) if (query[field]) entry[field] = query[field];
  if (query.arxiv) Object.assign(entry, { eprint: query.arxiv, archiveprefix: "arXiv" });
  return entry;
}

function publicFields(record) {
  return Object.fromEntries(Object.entries(record || {}).filter(([field]) => !field.startsWith("_")));
}

// How sure a record is the queried work: named by one of the query's
// identifiers; the same work (title, first author, compatible year) or a
// strong match; the same title (similarity >= 97) when the query names no
// author; else weak. Only the first three may be printed as BibTeX without
// an explicit --pick.
const CONFIDENCE = ["identifier", "same_work", "title", "weak"];
const EXACT_TITLE = 97;

function matchConfidence(item, seed) {
  if (item.direct.length) return "identifier";
  if (item.same_work || item.strong) return "same_work";
  if (!seed.author && item.title_similarity >= EXACT_TITLE) return "title";
  return "weak";
}

const SOURCE_PREFERENCE = ["crossref_doi", "crossref_search", "pubmed", "dblp", "openreview", "local_arxiv", "semantic_scholar_match", "semantic_scholar_search"];
const preference = record => {
  const index = SOURCE_PREFERENCE.indexOf(record._recordSource);
  return index < 0 ? SOURCE_PREFERENCE.length : index;
};
// Crossref's by-DOI and search records of one DOI (and Semantic Scholar's
// match and search records of one paper) are one record.
const familyKey = record => `${String(record._recordSource || "").replace(/_(?:doi|search|match)$/, "")}\u001f${String(record._recordId || "").toLowerCase()}`;

/**
 * Looks the query up: the records its identifiers name (Crossref by DOI,
 * PubMed by PMID/PMCID, arXiv by ID), then the verifier's full provider
 * search seeded with the query's title (or the identifier record's).
 * Returns { records (authoritative, best first), discovery (Semantic
 * Scholar only), warnings, failures }.
 */
export async function resolveWork(query, providers) {
  const controller = D.createRunController();
  const asked = queryEntry(query);
  const run = controller.startVerification({ entries: [asked], settings: RUN_SETTINGS });
  const direct = [];
  const warnings = [];
  const failures = [];
  const attempt = async (label, task) => {
    try {
      return await task();
    } catch (error) {
      if (Net.isCancelled(error)) throw error;
      failures.push(`${label} failed (${error?.kind || error?.message || "error"})`);
      return null;
    }
  };

  if (query.doi) {
    const record = await attempt("Crossref DOI lookup", () => providers.searchCrossrefDoi(query.doi, run));
    if (record) direct.push(record);
    else if (record === null && !failures.length) warnings.push(`Crossref has no record for DOI ${query.doi}`);
  }
  if (query.pmid || query.pmcid) {
    const records = await attempt("PubMed lookup", () => providers.searchPubMed("", { pmid: query.pmid, pmcid: query.pmcid }, run));
    direct.push(...(records || []));
  }
  if (query.arxiv) {
    const enrichment = await providers.addLocalArxivCandidates([], { eprint: query.arxiv, archiveprefix: "arXiv" }, run);
    direct.push(...enrichment.candidates);
    if (enrichment.outcomes.some(outcome => outcome.state === "failure")) failures.push("arXiv lookup failed");
  }

  // Without a title, the record an identifier names seeds the search.
  const seed = !query.title && direct[0] ? { ...publicFields(direct[0]), ID: asked.ID } : asked;
  let pool = [];
  if (seed.title) {
    const found = await attempt("Search", () => providers.searchCandidatePool(stripLatex(seed.title), Rec.normalizeEntryForLookup(seed), run));
    if (found) {
      pool = found.candidates;
      warnings.push(...found.sourceWarnings);
    }
  }

  const seen = new Set();
  const all = Rec.dedupeRecords([...direct, ...pool]).filter(record => Rec.recordNoticeClass(record) === "regular");
  const records = all
    .map(record => {
      const item = {
        record,
        direct: Rec.directLinkKinds(asked, record),
        same_work: Rec.sameWork(seed, record),
        strong: Rec.strongMatch(seed, record, all),
        title_similarity: seed.title ? Math.round(titleSimilarity(seed.title, record.title || "")) : 0,
        published: Rec.versionClass(record) === "published",
      };
      item.confidence = matchConfidence(item, seed);
      return item;
    })
    // Records that are neither the work nor a near-identical title are noise.
    .filter(item => item.confidence !== "weak" || item.title_similarity >= TITLE_MATCH_THRESHOLD)
    .sort((a, b) => CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence) || b.strong - a.strong ||
      b.title_similarity - a.title_similarity || b.published - a.published || preference(a.record) - preference(b.record))
    .filter(item => {
      const key = familyKey(item.record);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    query,
    records: records.filter(item => Rec.isAuthoritative(item.record)),
    discovery: records.filter(item => !Rec.isAuthoritative(item.record)),
    warnings: [...new Set(warnings)],
    failures,
  };
}

export function scoredSummary(item, rank) {
  return {
    ...(rank ? { rank } : {}),
    ...recordSummary(item.record),
    match: {
      confidence: item.confidence,
      identifiers: item.direct,
      same_work: item.same_work,
      strong: item.strong,
      title_similarity: item.title_similarity,
    },
    notices: (item.record._notices || []).map(noticeSummary),
  };
}

const BIBTEX_FIELDS = [
  "title", "author", "journal", "booktitle", "year", "volume", "number", "pages", "publisher",
  "doi", "pmid", "pmcid", "eprint", "archiveprefix", "primaryclass", "url",
];

// One record as BibTeX: its own fields (no other record's), plain text made
// LaTeX-safe by the core writer, the key from `key` or surname + year +
// first significant title word (core/formats.js, as for RIS imports).
export function recordToBibtex(record, key = "") {
  const type = record.ENTRYTYPE || (record.booktitle ? "inproceedings" : record.journal ? "article" : "misc");
  const entry = { ENTRYTYPE: type };
  for (const field of BIBTEX_FIELDS) {
    const value = String(record[field] ?? "").trim();
    if (value) entry[field] = value;
  }
  if (entry.url && entry.doi && /doi\.org\//i.test(entry.url)) delete entry.url;
  if (type.toLowerCase() === "inproceedings" && entry.booktitle) delete entry.journal;
  entry.ID = key || Formats.assignKeys([entry])[0].ID;
  return Bib.entriesToBib([entry], { original: {} });
}
