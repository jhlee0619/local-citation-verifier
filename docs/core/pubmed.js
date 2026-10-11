/*
 * PubMed through NCBI E-utilities: the query builders (identifier, strict
 * and relaxed title terms, ECitMatch), the ESearch / ECitMatch / ESummary
 * client and the ESummary → record converter with PubMed's retraction and
 * erratum notices. Asked directly from the browser on every origin (no
 * proxy route), without credentials, e-mail address or API key. DOM-free.
 */
import * as Net from "./net.js?v=20261011-s14";
import {
  authorNames, entryDoi, entryPmcid, entryPmid, foldText, htmlToText, normalizeDoi, normalizePmcid,
  normalizePmid, parseYear,
} from "./text.js?v=20261011-s14";
import { createRecord, mergeNotices } from "./records.js?v=20261011-s14";

  const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  // E-utilities ask callers to name their tool; no e-mail address or API key
  // is ever sent.
  const TOOL = "local-citation-verifier";
  const SEARCH_RETMAX = 5;
  const SUMMARY_MAX_IDS = 5;
  // Without an API key NCBI allows 3 requests per second (X-RateLimit-Limit:
  // 3, live 2026-10-10); the pacer starts there and follows the header.
  const INITIAL_INTERVAL_MS = 334;

  // ─── Query builders ────────────────────────────────────────────────
  // These pure builders (pubmedTerm, pubmedTermRelaxed, citmatchParts,
  // citmatchBdata) are a stable contract: external tools may reproduce these
  // queries, so document any change to their rules.
  //
  // Significant title words: the title folded (foldText: LaTeX → Unicode,
  // diacritics and special letters to ASCII, lower-case), split at every
  // character other than [a-z0-9], keeping words of at least 3 characters
  // that are not PubMed stopwords, each once, in title order.
  const MIN_WORD_LENGTH = 3;
  const STRICT_WORDS = 10;
  const RELAXED_WORDS = 5;
  // PubMed's published stopword list.
  const STOP_WORDS = new Set((
    "a about again all almost also although always among an and another any are as at be because been " +
    "before being between both but by can could did do does done due during each either enough especially " +
    "etc for found from further had has have having here how however i if in into is it its itself just kg " +
    "km made mainly make may mg might ml mm most mostly must nearly neither no nor obtained of often on our " +
    "overall perhaps pmid quite rather really regarding seem seen several should show showed shown shows " +
    "significantly since so some such than that the their theirs them then there therefore these they this " +
    "those through thus to upon use used using various very was we were what when which while with within " +
    "without would").split(" "));

  function significantTitleWords(title) {
    const words = [];
    for (const word of foldText(title).split(/[^a-z0-9]+/)) {
      if (word.length < MIN_WORD_LENGTH || STOP_WORDS.has(word) || words.includes(word)) continue;
      words.push(word);
    }
    return words;
  }

  // The first named author's family name, folded, apostrophes dropped, other
  // characters except letters, digits and hyphens turned into spaces.
  function firstAuthorFamily(entry) {
    const first = authorNames(entry?.author)[0];
    if (!first || first.others) return "";
    return foldText(first.family).replace(/['’`]/g, "").replace(/[^a-z0-9-]+/g, " ").trim();
  }

  // Strict: the first STRICT_WORDS significant title words, each [title],
  // joined with AND; "" without one.
  function pubmedTerm(entry) {
    return significantTitleWords(entry?.title).slice(0, STRICT_WORDS)
      .map(word => `${word}[title]`).join(" AND ");
  }

  // Relaxed (asked only when the strict term finds nothing): the first
  // RELAXED_WORDS significant title words [title] AND the first author's
  // family name [1au]; "" without a title word or a first author.
  function pubmedTermRelaxed(entry) {
    const words = significantTitleWords(entry?.title).slice(0, RELAXED_WORDS);
    const family = firstAuthorFamily(entry);
    if (!words.length || !family) return "";
    return [...words.map(word => `${word}[title]`), `${family}[1au]`].join(" AND ");
  }

  // The entry's own identifiers, OR-ed: PMID n[uid], PMCID PMCn[pmc], DOI
  // "doi"[doi] (quoted: DOIs hold "(", ")" and "/"); "" without one.
  function pubmedIdTerm(entry) {
    const pmid = entryPmid(entry);
    const pmcid = entryPmcid(entry);
    const doi = entryDoi(entry).replace(/"/g, "");
    return [
      pmid ? `${pmid}[uid]` : "",
      pmcid ? `${pmcid}[pmc]` : "",
      doi ? `"${doi}"[doi]` : "",
    ].filter(Boolean).join(" OR ");
  }

  // ECitMatch fields, or null unless journal, volume and first page are
  // known. Every part has "|" and line breaks removed:
  //   journal      the journal field folded, non-[a-z0-9] runs → one space
  //   year         parseYear(year), else ""
  //   volume       as written (trimmed)
  //   firstPage    pages up to the first dash
  //   firstAuthor  folded family name + " " + folded initials ("isensee f"), else ""
  //   key          the citation key
  function citmatchParts(entry) {
    const clean = value => String(value ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    const journal = foldText(entry?.journal).replace(/[^a-z0-9]+/g, " ").trim();
    const volume = clean(entry?.volume);
    const firstPage = clean(String(entry?.pages ?? "").split(/\s*[-–—]+\s*/)[0]);
    if (!journal || !volume || !firstPage) return null;
    const year = parseYear(entry?.year);
    const first = authorNames(entry?.author)[0];
    const initials = first && !first.others
      ? foldText(first.given).split(/[^a-z0-9]+/).filter(Boolean).map(part => part[0]).join("") : "";
    const family = firstAuthorFamily(entry);
    return {
      journal,
      year: Number.isInteger(year) ? String(year) : "",
      volume,
      firstPage,
      firstAuthor: family ? clean(`${family} ${initials}`) : "",
      key: clean(entry?.ID),
    };
  }

  // ECitMatch bdata: journal|year|volume|first_page|first_author|key| ("" when
  // citmatchParts is null).
  function citmatchBdata(entry) {
    const parts = citmatchParts(entry);
    if (!parts) return "";
    return `${[parts.journal, parts.year, parts.volume, parts.firstPage, parts.firstAuthor, parts.key].join("|")}|`;
  }

  // ─── Answers ───────────────────────────────────────────────────────
  // ESearch JSON → PMIDs (malformed answers → none).
  function searchIds(data) {
    const ids = data?.esearchresult?.idlist;
    return Array.isArray(ids) ? ids.map(normalizePmid).filter(Boolean) : [];
  }

  // ECitMatch text → PMIDs: each line is the bdata with the PMID (or
  // NOT_FOUND / AMBIGUOUS …) appended.
  function citmatchIds(text) {
    return String(text ?? "").split(/\r?\n/).map(line => normalizePmid(line.split("|").at(-1))).filter(Boolean);
  }

  // ESummary JSON → its document summaries, in uids order.
  function summaryItems(data) {
    const result = data?.result;
    const uids = Array.isArray(result?.uids) ? result.uids : [];
    return uids.map(uid => result[uid]).filter(item => item && typeof item === "object" && !item.error);
  }

  // ─── Converter ─────────────────────────────────────────────────────
  // "nnU-Net: … segmentation." → without the closing period; a translated
  // title "[…]." loses its brackets.
  function pubmedTitle(value) {
    const text = htmlToText(value).replace(/\.\s*$/, "").trim();
    const bracketed = /^\[(.*)\]$/.exec(text);
    return bracketed ? bracketed[1].trim() : text;
  }

  // PubMed "Smith JA" → "Smith, J. A." ("Smith JA Jr" → "Smith, Jr, J. A.");
  // a collective name (authtype CollectiveName) is braced as one name.
  function pubmedAuthorName(name, collective = false) {
    const text = htmlToText(name).replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (collective) return `{${text}}`;
    const tokens = text.split(" ");
    const suffix = tokens.length > 2 && /^(?:jr|sr|ii|iii|iv|2nd|3rd)\.?$/i.test(tokens.at(-1)) ? tokens.pop() : "";
    const initials = tokens.length > 1 && /^\p{Lu}{1,4}$/u.test(tokens.at(-1)) ? tokens.pop() : "";
    const given = [...initials].map(letter => `${letter}.`).join(" ");
    return [tokens.join(" "), suffix, given].filter(Boolean).join(", ");
  }

  // "637-41" → "637--641", "203-211" → "203--211"; other forms keep their
  // text with "-" as "--".
  function pubmedPages(value) {
    const text = String(value ?? "").trim();
    const match = /^([A-Za-z]*)(\d+)\s*-\s*([A-Za-z]*)(\d+)$/.exec(text);
    if (!match) return text.replace(/\s*-+\s*/g, "--");
    const [, startPrefix, start, endPrefix, end] = match;
    const full = end.length < start.length ? start.slice(0, start.length - end.length) + end : end;
    return `${startPrefix}${start}--${endPrefix || startPrefix}${full}`;
  }

  function articleIds(item) {
    const ids = {};
    for (const id of Array.isArray(item?.articleids) ? item.articleids : []) {
      const type = String(id?.idtype || "").toLowerCase();
      if (type && !(type in ids)) ids[type] = String(id?.value ?? "");
    }
    return ids;
  }

  // Publication types of a notice record (PubMed renamed "Retraction of
  // Publication" to "Retraction Notice"), and reference types: on a work,
  // the notices about it; on a notice record, the works it concerns.
  const NOTICE_PUBTYPES = new Map([
    ["retraction of publication", "retraction"],
    ["retraction notice", "retraction"],
    ["partial retraction", "partial_retraction"],
    ["published erratum", "erratum"],
    ["expression of concern", "expression_of_concern"],
  ]);
  const WORK_REFTYPES = new Map([
    ["retraction in", "retraction"],
    ["partial retraction in", "partial_retraction"],
    ["expression of concern in", "expression_of_concern"],
    ["erratum in", "erratum"],
  ]);
  const NOTICE_REFTYPES = new Map([
    ["retraction of", "retraction"],
    ["partial retraction of", "partial_retraction"],
    ["expression of concern for", "expression_of_concern"],
    ["erratum for", "erratum"],
  ]);
  const NOTICE_LABELS = {
    retraction: "Retraction",
    partial_retraction: "Partial retraction",
    expression_of_concern: "Expression of concern",
    erratum: "Erratum",
  };

  // A reference's DOI (refsource "Lancet. 2010 Feb 6;375(9713):445. doi:
  // 10.1016/S0140-6736(10)60175-4.").
  function referenceDoi(reference) {
    const match = /\bdoi:\s*(\S+?)\.?$/i.exec(String(reference?.refsource || "").trim());
    return match ? normalizeDoi(match[1]) : "";
  }

  function pubmedNotice(type, doi, pmid, label = NOTICE_LABELS[type]) {
    return { type, label, doi, pmid, source: "pubmed", date: "" };
  }

  // What a document summary says about notices: notices on this work (its
  // "… in" references, and "Retracted Publication" when no retraction
  // reference names one), updates for the works a notice record concerns
  // ({ target: DOI, else "pmid:n", notice }) and the record's own notice type.
  function pubmedNotices(item, ownDoi, ownPmid) {
    const pubtypes = (Array.isArray(item?.pubtype) ? item.pubtype : []).map(type => String(type).toLowerCase());
    const references = Array.isArray(item?.references) ? item.references : [];
    const notices = [];
    const updates = [];
    const noticeType = pubtypes.map(type => NOTICE_PUBTYPES.get(type)).find(Boolean) || "";
    for (const reference of references) {
      const reftype = String(reference?.reftype || "").toLowerCase();
      const pmid = normalizePmid(reference?.pmid);
      if (WORK_REFTYPES.has(reftype))
        notices.push(pubmedNotice(WORK_REFTYPES.get(reftype), referenceDoi(reference), pmid));
      else if (noticeType && NOTICE_REFTYPES.has(reftype)) {
        const target = referenceDoi(reference) || (pmid ? `pmid:${pmid}` : "");
        if (target) updates.push({ target, notice: pubmedNotice(NOTICE_REFTYPES.get(reftype), ownDoi, ownPmid) });
      }
    }
    if (pubtypes.includes("retracted publication") && !notices.some(notice => notice.type === "retraction"))
      notices.push(pubmedNotice("retraction", "", "", "Retracted Publication"));
    return { notices: mergeNotices(notices), updates, noticeType };
  }

  // One ESummary document summary as a record body (createRecord adds the
  // provenance). Year from pubdate (else epubdate); the epubdate year, when
  // it differs, is kept as _onlineYear (records.yearDriftOk: print vs online). Journal from
  // fulljournalname (its ISO abbreviation, source, as _journalAbbrev).
  function pubmedToStandard(item) {
    const ids = articleIds(item);
    const pmid = normalizePmid(ids.pubmed || item?.uid);
    const doi = normalizeDoi(ids.doi);
    const pmcid = normalizePmcid(ids.pmc) || normalizePmcid(/PMC\d+/i.exec(ids.pmcid || "")?.[0]);
    const authors = (Array.isArray(item?.authors) ? item.authors : [])
      .map(author => pubmedAuthorName(author?.name, String(author?.authtype || "Author") !== "Author"))
      .filter(Boolean);
    const fullName = htmlToText(item?.fulljournalname);
    const abbreviation = htmlToText(item?.source);
    const onlineYear = parseYear(item?.epubdate);
    const printYear = parseYear(item?.pubdate);
    const year = Number.isInteger(printYear) ? printYear : onlineYear;
    const out = {
      ENTRYTYPE: "article",
      title: pubmedTitle(item?.title),
      author: authors.join(" and "),
      year: Number.isInteger(year) ? String(year) : "",
      journal: fullName || abbreviation,
      volume: String(item?.volume ?? "").trim(),
      number: String(item?.issue ?? "").trim(),
      pages: pubmedPages(item?.pages),
      doi,
      pmid,
      pmcid,
      _source: "pubmed",
    };
    if (abbreviation && abbreviation !== out.journal) out._journalAbbrev = abbreviation;
    if (Number.isInteger(onlineYear) && onlineYear !== year) out._onlineYear = String(onlineYear);
    const { notices, updates, noticeType } = pubmedNotices(item, doi, pmid);
    if (notices.length) out._notices = notices;
    if (updates.length) out._updates = updates;
    if (noticeType) out._noticeType = noticeType;
    return out;
  }

  // Records for an ESummary answer (summaries without a title or PMID are skipped).
  function pubmedRecords(data, retrieval = "pubmed_search") {
    return summaryItems(data).map(pubmedToStandard).filter(record => record.title && record.pmid)
      .map(record => createRecord(record, { recordSource: "pubmed", recordId: record.pmid, retrieval }));
  }

  // ─── Client ────────────────────────────────────────────────────────
  // options: cache (Net.createTtlCache), pacer (default: one request at a
  // time, INITIAL_INTERVAL_MS apart, then X-RateLimit-Limit), endpoint,
  // budget (default Net.BUDGETS.search; tests).
  function createPubMedClient(options = {}) {
    const cache = options.cache || null;
    const endpoint = options.endpoint || EUTILS;
    const budget = options.budget || Net.BUDGETS.search;
    const pacer = options.pacer || Net.createRatePacer({ concurrency: 1, maxConcurrency: 1, intervalMs: INITIAL_INTERVAL_MS });

    // One paced E-utilities request: it waits its turn outside its deadlines,
    // a retry waits again, every answer teaches the pacer (429: Retry-After
    // or a doubling pause).
    function request(route, params, run, responseType = "json") {
      const attempt = () => Net.requestJson(`${endpoint}${route}`, { db: "pubmed", ...params, tool: TOOL }, {
        requestApi: Net,
        budget,
        signal: run?.signal,
        responseType,
        fetchOptions: { credentials: "omit" },
        beforeAttempt: async ({ signal, attempt: number }) => {
          if (number > 1) await pacer.spacing(signal);
        },
        onResponse: response => pacer.observe(response),
      });
      return pacer.run(attempt, { signal: run?.signal });
    }

    function cached(key, load, run) {
      return cache ? cache.getOrSet(key, load, run ? { runId: run.id, signal: run.signal } : {}) : load();
    }

    async function esearch(term, run) {
      const data = await cached(`pubmed-search:${term}`, () => request("esearch.fcgi", {
        term, retmode: "json", retmax: String(SEARCH_RETMAX), sort: "relevance",
      }, run), run);
      return searchIds(data);
    }

    async function ecitmatch(bdata, run) {
      const text = await cached(`pubmed-citmatch:${bdata}`, () => request("ecitmatch.cgi", { bdata, retmode: "xml" }, run, "text"), run);
      return citmatchIds(text);
    }

    async function esummary(ids, run) {
      const id = ids.join(",");
      return cached(`pubmed-summary:${id}`, () => request("esummary.fcgi", { id, retmode: "json" }, run), run);
    }

    // The PubMed records for an entry, stopping after the first step that
    // finds PMIDs: (1) the entry's identifiers OR the strict title term,
    // (2) the relaxed term, (3) ECitMatch; then one ESummary of at most
    // SUMMARY_MAX_IDS PMIDs. A failed request rejects (a provider failure).
    async function search(entry, run) {
      const strict = pubmedTerm(entry);
      const identifiers = pubmedIdTerm(entry);
      const first = identifiers && strict ? `${identifiers} OR (${strict})` : identifiers || strict;
      let ids = first ? await esearch(first, run) : [];
      let retrieval = "pubmed_search";
      const relaxed = pubmedTermRelaxed(entry);
      if (!ids.length && relaxed) {
        ids = await esearch(relaxed, run);
        retrieval = "pubmed_relaxed";
      }
      const bdata = citmatchBdata(entry);
      if (!ids.length && bdata) {
        ids = await ecitmatch(bdata, run);
        retrieval = "pubmed_citmatch";
      }
      ids = [...new Set(ids)].slice(0, SUMMARY_MAX_IDS);
      if (!ids.length) return [];
      return pubmedRecords(await esummary(ids, run), retrieval);
    }

    return { search, pacer };
  }

export {
  EUTILS,
  TOOL,
  INITIAL_INTERVAL_MS,
  STOP_WORDS,
  significantTitleWords,
  pubmedTerm,
  pubmedTermRelaxed,
  pubmedIdTerm,
  citmatchParts,
  citmatchBdata,
  searchIds,
  citmatchIds,
  pubmedTitle,
  pubmedAuthorName,
  pubmedPages,
  pubmedNotices,
  pubmedToStandard,
  pubmedRecords,
  createPubMedClient,
};
