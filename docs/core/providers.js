/*
 * Metadata providers: endpoint selection and the proxy health check,
 * CrossRef / Semantic Scholar / DBLP / OpenReview / local arXiv adapters and
 * record converters (Crossref's query.bibliographic builder, notices and
 * request pacing), PubMed (core/pubmed.js, asked directly on every origin),
 * candidate relevance and review-candidate selection, and absence
 * classification. DOM-free (reads window.location only to pick endpoints and
 * request origins).
 */
import * as Net from "./net.js?v=20261012-s17";
import { parseBib } from "./bibtex.js?v=20261012-s17";
import * as PubMed from "./pubmed.js?v=20261012-s17";
import {
  arxivIdInText, arxivYearFromId, authorNames, entryDoi, entryPmcid, entryPmid, entryVenue, expandVenue, extractArxivId,
  extractOpenReviewForumId, firstAuthorSearchToken, foldText, htmlToText, isPreprintVenue, isSeriesVenue, MIN_TITLE_SIM,
  normalizeArxivId, normalizeDoi, parseYear, queryTitleKey, safeExternalUrl, searchTitleTokens, stripLatex,
  titleKey, titleSimilarity,
} from "./text.js?v=20261012-s17";
import {
  createRecord, dedupeRecords, directLinkKinds, identifierStates, INFO_NOTICE_TYPES,
  isCleanPublishedManifestation, mergeNotices, noticeType, recordNoticeClass, sameWork, SERIOUS_NOTICE_TYPES,
} from "./records.js?v=20261012-s17";

  // ─── Endpoints ─────────────────────────────────────────────────────
  // Every origin except GitHub Pages and file:// expects the local metadata
  // proxy at /api/*. Without the proxy no /api/* path is ever requested:
  // the providers are asked directly, and DBLP on GitHub Pages (blocked by
  // CORS), OpenReview, the arXiv BibTeX enrichment and the health probe are
  // skipped (""). PubMed (NCBI E-utilities, CORS "*") and DataCite (CORS for
  // any origin; DOI and arXiv ID existence) are asked directly from every
  // origin.
  const currentLocation = () => (typeof window === "undefined" ? null : window.location || null);

  function isGithubPages(location = currentLocation()) {
    return !!location?.hostname?.endsWith(".github.io");
  }

  function useMetadataProxy(location = currentLocation()) {
    if (!location || location.protocol === "file:") return false;
    return !isGithubPages(location);
  }

  const SS_FIELDS = "title,authors,year,venue,publicationVenue,externalIds";
  // DataCite's REST API, one DOI per request (GET /dois/{doi}; 404 when the
  // DOI is not registered there).
  const DATACITE_API = "https://api.datacite.org/dois/";

  // The provider endpoints for a page location (window.location).
  function endpointsFor(location) {
    const proxy = useMetadataProxy(location);
    const ON_GITHUB_PAGES = isGithubPages(location);
    return Object.freeze({
      CROSSREF_API: proxy ? "/api/crossref/works" : "https://api.crossref.org/works",
      SS_MATCH: proxy
        ? "/api/semanticscholar/graph/v1/paper/search/match"
        : "https://api.semanticscholar.org/graph/v1/paper/search/match",
      SS_SEARCH: proxy
        ? "/api/semanticscholar/graph/v1/paper/search"
        : "https://api.semanticscholar.org/graph/v1/paper/search",
      SS_PAPER: proxy
        ? "/api/semanticscholar/graph/v1/paper/"
        : "https://api.semanticscholar.org/graph/v1/paper/",
      // On GitHub Pages, DBLP is blocked by CORS — skip the endpoint like OpenReview.
      DBLP_API: proxy
        ? "/api/dblp/search/publ/api"
        : (ON_GITHUB_PAGES ? "" : "https://dblp.org/search/publ/api"),
      OPENREVIEW_API: proxy ? "/api/openreview/notes/search" : "",
      SS_FIELDS,
      LOCAL_ARXIV_BIBTEX: proxy ? "/api/arxiv/bibtex" : "",
      HEALTH: proxy ? "/api/health" : "",
      PUBMED_API: PubMed.EUTILS,
      DATACITE_API,
    });
  }

  const ENDPOINTS = endpointsFor(currentLocation());
  const USE_METADATA_PROXY = useMetadataProxy();
  const ON_GITHUB_PAGES = isGithubPages();
  const { CROSSREF_API, SS_MATCH, SS_SEARCH, SS_PAPER, DBLP_API, OPENREVIEW_API, LOCAL_ARXIV_BIBTEX } = ENDPOINTS;

  // ─── Proxy health ──────────────────────────────────────────────────
  // server/vllm_proxy_server.py answers GET /api/health with this body.
  const PROXY_SIGNATURE = Object.freeze({ app: "local-citation-verifier", ok: true });

  // Whether this origin serves the local metadata proxy: GET /api/health
  // answers PROXY_SIGNATURE as JSON. A 404, an HTML page (a plain static
  // server), another body or a network failure means it does not. Never
  // asked without a proxy endpoint (GitHub Pages, file://).
  async function checkProxyHealth(options = {}) {
    const endpoint = options.endpoint ?? ENDPOINTS.HEALTH;
    if (!endpoint) return false;
    try {
      const body = await Net.requestJson(endpoint, {}, {
        requestApi: Net,
        budget: Net.BUDGETS.proxy,
        signal: options.signal,
        origin: options.origin || currentLocation()?.origin,
        fetch: options.fetch,
        fetchOptions: { cache: "no-store" },
      });
      return body?.app === PROXY_SIGNATURE.app && body?.ok === PROXY_SIGNATURE.ok;
    } catch {
      return false;
    }
  }

  // The lookup failure when the proxy health check failed: no provider is
  // asked, and a 404 from a static server never becomes "Not Found".
  function proxyMissingError() {
    const error = new Error("the local metadata proxy does not answer on this origin");
    error.name = "LookupFailedError";
    error.reason = "proxy_missing";
    error.sourceWarnings = ["The local metadata proxy did not answer at /api/health, so no metadata provider was asked."];
    error.outcomes = [];
    return error;
  }

  // ─── Crossref: query, notices, records ─────────────────────────────
  // crossrefBibliographicQuery is a stable contract: external tools may
  // reproduce these queries, so document any change to its rules.
  //
  // The query.bibliographic text for a BibTeX entry, in this order:
  //   1. the family names of the first three named authors (authorNames:
  //      LaTeX → Unicode, braces dropped, particles kept, "others" skipped);
  //   2. the title;
  //   3. the venue (entryVenue: booktitle first for @inproceedings /
  //      @conference / @proceedings, else journal first), left out when it
  //      is a preprint server (isPreprintVenue: arXiv, CoRR, bioRxiv, …);
  //   4. the year (parseYear: the first four-digit year), if any.
  // Each text part is folded (foldText: LaTeX → Unicode, diacritics and
  // special letters to ASCII, lower-case), every run of characters other
  // than letters and digits becomes one space, and the parts are joined
  // with one space. "" when the entry has neither title nor author.
  const CROSSREF_QUERY_AUTHORS = 3;
  const CROSSREF_ROWS = 5;
  // Fields every Crossref list query returns (the brief's set plus publisher,
  // which the records keep, and created, the last year fallback). The
  // /works/{doi} route rejects select (HTTP 400 "This route does not
  // support select", live 2026-10-10) and always returns the full record.
  const CROSSREF_SELECT = "DOI,title,author,issued,published-print,published-online,created,container-title," +
    "type,score,updated-by,update-to,volume,issue,page,URL,publisher";

  function crossrefQueryText(value) {
    return foldText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function crossrefBibliographicQuery(entry) {
    const surnames = authorNames(entry?.author)
      .filter(name => !name.others && name.family)
      .slice(0, CROSSREF_QUERY_AUTHORS)
      .map(name => crossrefQueryText(name.family))
      .filter(Boolean);
    const title = crossrefQueryText(entry?.title);
    if (!title && !surnames.length) return "";
    const venue = entryVenue(entry);
    const year = parseYear(entry?.year);
    return [
      ...surnames,
      title,
      isPreprintVenue(venue) ? "" : crossrefQueryText(venue),
      Number.isInteger(year) ? String(year) : "",
    ].filter(Boolean).join(" ");
  }

  // Crossref's year: issued (the earliest publication date it knows), else
  // published-print, published-online, created.
  function crossrefYear(item) {
    for (const field of ["issued", "published-print", "published-online", "created"]) {
      const year = Number(item?.[field]?.["date-parts"]?.[0]?.[0]);
      if (Number.isInteger(year) && year > 0) return String(year);
    }
    return "";
  }

  // A Crossref date ({ "date-parts": [[2010, 2, 6]] }) as "2010-02-06" (as
  // many parts as it has), else "".
  function crossrefDate(value) {
    const parts = (value?.["date-parts"]?.[0] || []).map(Number);
    const count = parts.findIndex(part => !Number.isInteger(part) || part <= 0);
    const known = count < 0 ? parts.slice(0, 3) : parts.slice(0, Math.min(count, 3));
    return known.map((part, index) => (index ? String(part).padStart(2, "0") : String(part))).join("-");
  }

  function crossrefNotice(update, doi) {
    const type = noticeType(update?.type);
    if (!type) return null;
    return {
      type,
      label: htmlToText(update.label) || type.replace(/_/g, " "),
      doi,
      source: String(update.source || ""),
      date: crossrefDate(update.updated),
    };
  }

  // What a Crossref item says about updates. notices: the notices on this
  // work (updated-by; one per notice DOI + type, though Crossref repeats a
  // notice per source). updates: for a notice record (update-to), the works
  // it updates, { target, notice } with the notice's own DOI. noticeType:
  // the most serious update-to type when the item IS a notice (a new version
  // or edition is a work, not a notice), else "".
  function crossrefNotices(item) {
    const notices = mergeNotices((Array.isArray(item?.["updated-by"]) ? item["updated-by"] : [])
      .map(update => crossrefNotice(update, normalizeDoi(update?.DOI))).filter(Boolean));
    const ownDoi = normalizeDoi(item?.DOI);
    const seen = new Set();
    const updates = [];
    for (const update of Array.isArray(item?.["update-to"]) ? item["update-to"] : []) {
      const target = normalizeDoi(update?.DOI);
      const notice = crossrefNotice(update, ownDoi);
      if (!target || !notice || seen.has(`${target}\u001f${notice.type}`)) continue;
      seen.add(`${target}\u001f${notice.type}`);
      updates.push({ target, notice });
    }
    const types = updates.map(update => update.notice.type).filter(type => type !== "new_version" && type !== "new_edition");
    const ownType = types.find(type => SERIOUS_NOTICE_TYPES.has(type)) || types.find(type => INFO_NOTICE_TYPES.has(type)) || "";
    return { notices, updates, noticeType: ownType };
  }

  // Crossref stamps a retracted or withdrawn work's own title ("RETRACTED:
  // …", "RETRACTED ARTICLE: …", "WITHDRAWN: …"; live: 10.1016/s0140-6736(97)
  // 11096-0 is "RETRACTED: Ileal-lymphoid-nodular hyperplasia, …" with its
  // retraction in updated-by). That record is the work itself, not a notice:
  // the stamp leaves the title and stays as a notice (source "title") unless
  // updated-by already names a notice of that type.
  const TITLE_STAMP = /^\s*(retracted|withdrawn)(?:\s+article)?\s*:\s*/i;

  function unstampedTitle(title, notices) {
    const match = TITLE_STAMP.exec(title);
    const rest = match ? title.slice(match[0].length).trim() : "";
    if (!rest) return { title, notices };
    const type = match[1].toLowerCase() === "retracted" ? "retraction" : "withdrawal";
    if (notices.some(notice => notice.type === type)) return { title: rest, notices };
    const label = type === "retraction" ? "Retracted (title)" : "Withdrawn (title)";
    return { title: rest, notices: mergeNotices(notices, [{ type, label, doi: "", source: "title", date: "" }]) };
  }

  // ─── Crossref container titles ─────────────────────────────────────
  // A book chapter or proceedings paper may list several container titles:
  // the series ("Lecture Notes in Computer Science") and the volume
  // ("Medical Image Computing and Computer Assisted Intervention – MICCAI
  // 2025"), or a volume's short and full names. The series is the one a
  // series pattern names (text.isSeriesVenue among several), else, for a
  // book part with an ISSN and exactly two container titles, the first
  // (Crossref lists a book's series first); the volume is the longest of the
  // others.
  const BOOK_PART_TYPES = new Set(["book-chapter", "book-part", "book-section"]);
  const PROCEEDINGS_SERIES = new RegExp("^(?:lecture notes in (?:computer science|artificial intelligence|bioinformatics|" +
    "networks and systems|electrical engineering|business information processing)|communications in computer and " +
    "information science|leibniz international proceedings in informatics|lipics|proceedings of machine learning research|" +
    "ifip advances in information and communication technology|ceur workshop proceedings)\\b");
  const PROCEEDINGS_WORDS = /\b(?:proceedings|conference|workshops?|symposi(?:um|a)|congress|colloquium|meeting)\b/i;
  // An event acronym and its year: "MICCAI 2025", "ECCV 2020".
  const EVENT_ACRONYM_YEAR = /\b[A-Z][A-Za-z0-9-]*[A-Z][A-Za-z0-9-]*\s*['’]?(?:19|20)\d{2}\b/;

  function crossrefContainers(item, titles) {
    const list = titles.filter(Boolean);
    if (list.length < 2) return { volume: list[0] || "", series: "" };
    let seriesIndex = list.findIndex(title => isSeriesVenue(title, { among: true }));
    if (seriesIndex < 0 && list.length === 2 && BOOK_PART_TYPES.has(String(item?.type || "").toLowerCase()) &&
        Array.isArray(item?.ISSN) && item.ISSN.length) seriesIndex = 0;
    const volume = list.filter((_, index) => index !== seriesIndex)
      .reduce((best, title) => (title.length > best.length ? title : best), "");
    return { volume, series: seriesIndex >= 0 ? list[seriesIndex] : "" };
  }

  // A book volume that is a proceedings volume: its title says so (or names
  // an event and its year), or its series publishes proceedings.
  function isProceedingsVolume(volume, series) {
    return PROCEEDINGS_SERIES.test(foldText(series)) || PROCEEDINGS_WORDS.test(volume) || EVENT_ACRONYM_YEAR.test(volume);
  }

  // ─── Record converters ─────────────────────────────────────────────
  // Crossref text may carry HTML/JATS/MathML markup and entities (htmlToText).
  // DOIs are lower-cased (Crossref's search already answers in lower case).
  // Notices go to _notices, a notice record's targets to _updates and its
  // type to _noticeType (records.recordNoticeClass: never the same work).
  function crossrefToStandard(item) {
    const authors = (item.author || []).map(a => {
      const f = htmlToText(a.family), g = htmlToText(a.given);
      return f ? `${f}, ${g}`.replace(/, $/, "") : "";
    }).filter(Boolean);

    const container = (item["container-title"] || []).map(htmlToText);
    const updates = crossrefNotices(item);
    const { title, notices } = unstampedTitle(htmlToText((item.title || [""])[0]), updates.notices);

    const out = {
      title,
      author: authors.join(" and "),
      year: crossrefYear(item),
      volume: item.volume || "",
      number: item.issue || "",
      pages: normalizePageRangeValue(item.page || ""),
      doi: String(item.DOI || "").trim().toLowerCase(),
      publisher: htmlToText(item.publisher),
      url: item.URL || "",
      _source: "crossref",
    };
    // Crossref's issued year is the earliest of print and online; an entry may
    // cite the other one. Keep it as the record's alternative year
    // (_onlineYear, accepted next to year by the year rules).
    const datedYear = field => Number(item?.[field]?.["date-parts"]?.[0]?.[0]);
    const alternative = ["published-print", "published-online"].map(datedYear)
      .find(value => Number.isInteger(value) && value > 0 && String(value) !== out.year);
    if (alternative) out._onlineYear = String(alternative);
    if (notices.length) out._notices = notices;
    if (updates.updates.length) out._updates = updates.updates;
    if (updates.noticeType) out._noticeType = updates.noticeType;
    const type = String(item.type || "").toLowerCase();
    if (type === "proceedings-article" || BOOK_PART_TYPES.has(type)) {
      // A proceedings paper, or a chapter of a proceedings volume
      // (@inproceedings) or of another book (@incollection): the volume is
      // the booktitle, the series apart; all container titles are kept
      // (_containerTitles: an entry may name any of them). A volume number
      // that is the year (a proceedings volume numbered by its year) is no
      // volume.
      const { volume, series } = crossrefContainers(item, container);
      out.ENTRYTYPE = type === "proceedings-article" || isProceedingsVolume(volume, series) ? "inproceedings" : "incollection";
      out.booktitle = volume;
      if (series) out.series = series;
      if (container.filter(Boolean).length > 1) out._containerTitles = container.filter(Boolean);
      const number = String(out.volume || "").trim();
      if (/^\d{4}$/.test(number) && (number === out.year || number === out._onlineYear)) delete out.volume;
    } else {
      if (type === "journal-article") out.ENTRYTYPE = "article";
      out.journal = container[0] || "";
    }
    return out;
  }

  function ssToStandard(paper) {
    // "First von Last" display names become BibTeX "von Last, First" (one name parser).
    const authors = (paper.authors || []).map(a => {
      const name = String(a.name || "").trim();
      const parsed = authorNames(name)[0];
      return parsed && parsed.given ? `${parsed.family}, ${parsed.given}` : name;
    }).filter(Boolean);

    const ext = paper.externalIds || {};
    const pv = paper.publicationVenue;
    const venue = (pv && typeof pv === "object" ? pv.name : null) || paper.venue || "";
    const doiValue = normalizeDoi(ext.DOI || "");
    const arxivDoi = /^10\.48550\/arxiv\./i.test(doiValue);
    // A published venue claim is only trustworthy on a Semantic Scholar record
    // when a published DOI backs it. A record whose only identifiers are the
    // preprint's (arXiv DOI, or no DOI at all) IS the preprint — the claimed
    // venue is preserved as a related-venue note instead of emitting a mixed
    // manifestation that the export integrity gate would reject.
    const mixedPreprintMetadata = !!(ext.ArXiv && (arxivDoi || !doiValue) && venue && !isPreprintVenue(venue));

    const journal = mixedPreprintMetadata ? "arXiv" : venue;
    return {
      ENTRYTYPE: journal ? "article" : "misc",
      title: paper.title || "",
      author: authors.join(" and "),
      year: (paper.year || "").toString(),
      journal,
      volume: "", number: "", pages: "",
      doi: ext.DOI || "",
      publisher: "",
      url: ext.DOI ? `https://doi.org/${ext.DOI}` : (ext.ArXiv ? `https://arxiv.org/abs/${ext.ArXiv}` : ""),
      eprint: ext.ArXiv || "",
      archiveprefix: ext.ArXiv ? "arXiv" : "",
      _source: "semantic_scholar",
      _externalIds: ext,
      _arxivId: ext.ArXiv || "",
      _relatedPublicationVenue: mixedPreprintMetadata ? venue : "",
      _manifestationWarning: mixedPreprintMetadata
        ? `Semantic Scholar linked this arXiv preprint identifier to published venue "${venue}"; it is kept as a separate preprint record.`
        : "",
    };
  }

  // A DataCite DOI record (JSON:API { data: { attributes } }) → a record
  // body, or null without attributes. It confirms that the DOI (an arXiv DOI
  // also its arXiv ID) exists and names its title; it is never a candidate.
  function dataciteToStandard(data) {
    const attributes = data?.data?.attributes;
    if (!attributes || typeof attributes !== "object") return null;
    const creators = (Array.isArray(attributes.creators) ? attributes.creators : []).map(creator => {
      const family = htmlToText(creator?.familyName);
      const given = htmlToText(creator?.givenName);
      if (family) return given ? `${family}, ${given}` : family;
      const name = htmlToText(creator?.name);
      return name && creator?.nameType === "Organizational" ? `{${name}}` : name;
    }).filter(Boolean);
    const titles = Array.isArray(attributes.titles) ? attributes.titles : [];
    const publisher = attributes.publisher && typeof attributes.publisher === "object" ? attributes.publisher.name : attributes.publisher;
    return {
      ENTRYTYPE: "misc",
      title: htmlToText((titles.find(title => !title?.titleType) || titles[0])?.title),
      author: creators.join(" and "),
      year: Number.isInteger(Number(attributes.publicationYear)) && Number(attributes.publicationYear) > 0 ? String(attributes.publicationYear) : "",
      publisher: htmlToText(publisher),
      doi: normalizeDoi(attributes.doi || data.data.id),
      url: safeExternalUrl(attributes.url),
      _source: "datacite",
    };
  }

  function dblpAuthorText(author) {
    const raw = typeof author === "string" ? author : (author?.text || "");
    return stripLatex(raw).replace(/\s+\d{4}$/g, "").trim();
  }

  function dblpAuthorsToBibtex(authors) {
    const raw = authors?.author || [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map(dblpAuthorText).filter(Boolean).join(" and ");
  }

  function normalizeDblpKey(value) {
    return String(value || "")
      .trim()
      .replace(/^https?:\/\/(?:dblp\.org|dblp\.uni-trier\.de|dblp\.dagstuhl\.de)\/rec\//i, "")
      .replace(/^dblp:\s*/i, "")
      .replace(/\.(html|xml|bib)$/i, "")
      .replace(/\/+$/, "")
      .trim();
  }

  function isPublishedDblpKey(value) {
    const key = normalizeDblpKey(value).toLowerCase();
    if (!key) return false;
    if (/^journals\/corr\b/.test(key)) return false;
    return /^(conf|journals)\//.test(key);
  }

  function stripDblpTitle(title) {
    return String(title || "").replace(/\s*\.\s*$/g, "").trim();
  }

  function normalizePageRangeValue(pages) {
    if (!pages) return pages;
    return String(pages).replace(/(\d)\s*-\s*(\d)/g, "$1--$2");
  }

  function dblpToStandard(hit) {
    const info = hit?.info || hit || {};
    const venue = expandVenue(info.venue || "");
    const key = String(info.key || "");
    const type = String(info.type || "");
    const isProceedings = /conference|workshop/i.test(type) || key.startsWith("conf/");
    const out = {
      ENTRYTYPE: isProceedings ? "inproceedings" : "article",
      title: stripDblpTitle(info.title || ""),
      author: dblpAuthorsToBibtex(info.authors),
      year: String(info.year || ""),
      volume: info.volume || "",
      number: info.number || "",
      pages: normalizePageRangeValue(info.pages || ""),
      doi: info.doi || "",
      publisher: "",
      url: safeExternalUrl(info.ee || info.url || ""),
      _source: "dblp",
      _dblpKey: key,
    };
    if (isProceedings) out.booktitle = venue;
    else out.journal = venue;
    return out;
  }

  function openreviewValue(value) {
    return value && typeof value === "object" && "value" in value ? value.value : value;
  }

  function openreviewYear(note, entry) {
    const content = note?.content || {};
    const venue = String(openreviewValue(content.venue) || "");
    const venueid = String(openreviewValue(content.venueid) || "");
    const invitation = String(note?.invitation || "");
    const match = /(?:^|\/)(\d{4})(?:\/|\b)/.exec(`${venueid} ${invitation} ${venue}`);
    return String(entry?.year || (match ? match[1] : ""));
  }

  function isOpenReviewUnpublishedVenue(venueHints, venue) {
    const venueText = String(venue || "").trim();
    const hints = String(venueHints || "");
    if (/^submitted to\b/i.test(venueText)) return true;
    if (/\b(withdrawn|rejected|desk rejected)\b/i.test(venueText)) return true;
    if (/Withdrawn_Submission|Rejected_Submission|Desk_Rejected/i.test(hints)) return true;
    return false;
  }

  function openreviewBooktitle(note, entry) {
    const content = note?.content || {};
    const venueid = String(openreviewValue(content.venueid) || "");
    const invitation = String(note?.invitation || "");
    const venue = String(openreviewValue(content.venue) || "");
    const parsedVenue = String(entry?.booktitle || entry?.journal || "");
    const venueHints = `${venueid} ${invitation} ${venue} ${parsedVenue}`;
    if (isOpenReviewUnpublishedVenue(venueHints, venue) || isOpenReviewUnpublishedVenue(venueHints, parsedVenue))
      return "";
    if (/\/Workshop/i.test(venueHints) || /\bworkshop\b/i.test(`${venue} ${parsedVenue}`))
      return parsedVenue || venue.replace(/\s+(?:poster|oral|spotlight|submission)\b.*$/i, "").trim();
    if (/ICLR\.cc\//i.test(venueHints) || /(?:^|[\/\s])ICLR(?:[\/\s]|\b)/i.test(venueHints))
      return "International Conference on Learning Representations";
    if (/ICML\.cc\//i.test(venueHints) || /(?:^|[\/\s])ICML(?:[\/\s]|\b)/i.test(venueHints))
      return "International Conference on Machine Learning";
    const resolved = entry?.booktitle || venue.replace(/\s+(?:poster|oral|spotlight|submission)\b.*$/i, "").trim();
    if (/^submitted to\b/i.test(resolved)) return "";
    return resolved;
  }

  function sanitizeOpenReviewParsedEntry(entry) {
    const out = { ...(entry || {}) };
    for (const field of [
      "bibsource",
      "biburl",
      "cdate",
      "crossref",
      "ee",
      "timestamp",
      "publtype",
    ]) delete out[field];
    return out;
  }

  function openreviewAuthors(note) {
    const authors = openreviewValue(note?.content?.authors) || [];
    return (Array.isArray(authors) ? authors : [authors]).filter(Boolean).join(" and ");
  }

  function openreviewDblpMirrorKey(note, parsed) {
    const invitation = String(note?.invitation || "").trim();
    if (!/^dblp\.org\/-\/record$/i.test(invitation)) return "";

    const parsedId = String(parsed?.ID || parsed?.entry_id || "").trim();
    const match = /^DBLP:([A-Za-z0-9][A-Za-z0-9._:+()'~=-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+()'~=-]*)+)$/i.exec(parsedId);
    return match ? match[1] : "";
  }

  function openreviewToStandard(note) {
    const content = note?.content || {};
    const bibtex = String(openreviewValue(content._bibtex) || "");
    const parsed = sanitizeOpenReviewParsedEntry(bibtex ? parseBib(bibtex)[0] : null);
    const forum = note?.forum || note?.id || "";
    const dblpMirrorKey = openreviewDblpMirrorKey(note, parsed);
    const isDblpMirror = Boolean(dblpMirrorKey);
    const out = {
      ...parsed,
      title: parsed.title || String(openreviewValue(content.title) || ""),
      author: parsed.author || openreviewAuthors(note),
      year: openreviewYear(note, parsed),
      url: safeExternalUrl(
        isDblpMirror
          ? (parsed.url || (forum ? `https://openreview.net/forum?id=${forum}` : ""))
          : (forum ? `https://openreview.net/forum?id=${forum}` : parsed.url)
      ),
      _source: isDblpMirror ? "dblp" : "openreview",
      _openreviewId: forum,
      _dblpKey: dblpMirrorKey,
    };
    const booktitle = openreviewBooktitle(note, parsed);
    if (booktitle) {
      out.booktitle = booktitle;
      delete out.journal;
    } else if (/^submitted to\b/i.test(String(out.booktitle || out.journal || openreviewValue(content.venue) || ""))) {
      delete out.booktitle;
      delete out.journal;
      out._manifestationWarning =
        "OpenReview lists this record as a submission; the target venue is not treated as a published venue.";
    }
    return out;
  }

  function openreviewNotePriority(note, original) {
    let score = 0;
    const wanted = extractOpenReviewForumId(original);
    const forum = String(note?.forum || "").trim();
    const id = String(note?.id || "").trim();
    if (wanted && (forum === wanted || id === wanted)) score += 50;
    const venueid = String(openreviewValue(note?.content?.venueid) || "");
    const invitation = String(note?.invitation || "");
    const venue = String(openreviewValue(note?.content?.venue) || "");
    const hints = `${invitation} ${venueid} ${venue}`;
    if (/\/Conference(?:\/|\b)/i.test(hints) && !/\/Workshop/i.test(hints)) score += 8;
    if (/\/Workshop/i.test(hints) || /\bworkshop\b/i.test(venue)) score -= 12;
    if (/^dblp\.org\//i.test(invitation) || /^dblp\.org\//i.test(venueid)) score -= 15;
    return score;
  }

  // ─── Relevance, review candidates and absence ──────────────────────
  const SOURCE_NAMES = Object.freeze({
    semantic_scholar_match: "Semantic Scholar",
    semantic_scholar_search: "Semantic Scholar",
    crossref_search: "CrossRef",
    crossref_doi: "CrossRef DOI enrichment",
    pubmed: "PubMed",
    datacite: "DataCite",
    dblp: "DBLP",
    openreview: "OpenReview",
    local_arxiv: "arXiv enrichment",
    dblp_key: "DBLP",
    vllm: "local vLLM",
    citation_evidence: "citation evidence",
  });

  function publicationSearchQueries(title, authorToken) {
    const exactTitle = String(title || "").trim();
    const author = String(authorToken || "").trim();
    const titleTokens = queryTitleKey(exactTitle).split(/\s+/).filter(Boolean);
    const stablePrefix = author && titleTokens.length >= 3
      ? titleTokens.slice(0, -1).join(" ")
      : "";
    return Array.from(new Set([
      exactTitle && author ? `${exactTitle} ${author}` : exactTitle,
      exactTitle,
      stablePrefix ? `${stablePrefix} ${author}` : "",
    ].filter(Boolean)));
  }

  function isRelevantCandidate(original, candidate, options = {}) {
    if (!candidate) return false;
    if (options.directLinkKinds?.(original, candidate)?.length) return true;
    const score = options.titleSimilarity?.(original?.title || "", candidate.title || "") || 0;
    return score >= (options.minTitleSim || 0) && recordNoticeClass(original) === recordNoticeClass(candidate);
  }

  function relevantCandidates(original, candidates, options = {}) {
    return (candidates || []).filter(candidate => isRelevantCandidate(original, candidate, options));
  }

  function failureOutcomes(outcomes) {
    return (outcomes || []).filter(outcome => outcome?.state === "failure");
  }

  function throwCancellation(outcomes) {
    const cancelled = failureOutcomes(outcomes).find(outcome => Net.isCancelled(outcome.error));
    if (cancelled) throw cancelled.error;
  }

  function classifyAbsence(outcomes, candidates) {
    throwCancellation(outcomes);
    if ((candidates || []).length) return "candidate";
    return failureOutcomes(outcomes).some(outcome => outcome.role === "primary")
      ? "lookup_failed"
      : "not_found";
  }

  function warningText(outcome) {
    const name = SOURCE_NAMES[outcome.source] || "A metadata provider";
    const error = outcome.error || {};
    if (error.challenge) return `${name} was rate limited (bot challenge).`;
    if (error.kind === "rate_limited" || error.status === 429)
      return `${name} was rate limited.`;
    if (error.kind === "deadline_timeout")
      return `${name} timed out or was unavailable.`;
    return `${name} was unavailable.`;
  }

  function sourceWarnings(outcomes) {
    throwCancellation(outcomes);
    const bySource = new Map();
    for (const outcome of failureOutcomes(outcomes)) {
      const group = outcome.source?.startsWith("semantic_scholar") ? "semantic_scholar"
        : outcome.source === "dblp_key" ? "dblp"
        : outcome.source;
      const current = bySource.get(group);
      const warning = warningText(outcome);
      const rank = text => text?.includes("rate limited") ? 3 : text?.includes("timed out") ? 2 : 1;
      if (!current || rank(warning) > rank(current))
        bySource.set(group, warning);
    }
    return [...bySource.values()];
  }

  // ─── Per-entry provider status ─────────────────────────────────────
  // Which providers answered an entry's lookup and which failed (any failed
  // request of theirs), by provider key.
  const PROVIDER_NAMES = Object.freeze({
    crossref: "Crossref", pubmed: "PubMed", datacite: "DataCite", dblp: "DBLP", openreview: "OpenReview",
    arxiv: "arXiv", semantic_scholar: "Semantic Scholar",
  });
  const OUTCOME_PROVIDER = Object.freeze({
    crossref_search: "crossref", crossref_doi: "crossref", pubmed: "pubmed", datacite: "datacite", dblp: "dblp",
    dblp_key: "dblp", openreview: "openreview", local_arxiv: "arxiv", semantic_scholar_match: "semantic_scholar",
    semantic_scholar_search: "semantic_scholar",
  });

  function providerStates(outcomes) {
    const states = {};
    for (const outcome of outcomes || []) {
      const key = OUTCOME_PROVIDER[outcome?.source];
      if (!key) continue;
      if (outcome.state === "failure") states[key] = "failed";
      else states[key] ??= "answered";
    }
    return states;
  }

  // Venues OpenReview hosts (and its own URLs).
  const OPENREVIEW_VENUE = new RegExp("\\b(?:iclr|neurips|nips|icml|tmlr|colm|corl|midl|uai|aistats|automl|" +
    "learning representations|neural information processing|machine learning research|language modeling|" +
    "robot learning|openreview)\\b", "i");

  // The authoritative providers an entry's verdict depends on, by key:
  // Crossref and PubMed always; DataCite for a DOI or arXiv ID; arXiv for an
  // arXiv ID (through the proxy); DBLP and OpenReview when this origin
  // reaches them and the entry is not clearly outside their coverage.
  // Conservatively, an entry without a PMID/PMCID or a DOI that resolved
  // (identifierResolved) always needs DBLP; it needs OpenReview too when its
  // venue is one OpenReview hosts, a preprint server or none.
  function applicableProviders(original, endpoints = ENDPOINTS, { identifierResolved = false } = {}) {
    const keys = ["crossref", "pubmed"];
    if (endpoints.DATACITE_API && (entryDoi(original) || extractArxivId(original))) keys.push("datacite");
    if (endpoints.LOCAL_ARXIV_BIBTEX && extractArxivId(original)) keys.push("arxiv");
    const searchNeeded = !identifierResolved && !entryPmid(original) && !entryPmcid(original);
    if (endpoints.DBLP_API && searchNeeded) keys.push("dblp");
    const venue = entryVenue(original);
    if (endpoints.OPENREVIEW_API && searchNeeded &&
        (!venue || isPreprintVenue(venue) || OPENREVIEW_VENUE.test(`${venue} ${original?.url || ""}`)))
      keys.push("openreview");
    return keys;
  }

  // ─── Paced providers: DBLP and OpenReview ──────────────────────────
  // One request at a time, one per second: neither announces its limits, and
  // a burst of ~50 DBLP requests drew 429s and then its "Making sure you're
  // not a bot!" page for more than 30 minutes.
  const PACED_PROVIDER = Object.freeze({ concurrency: 1, maxConcurrency: 1, intervalMs: 1000 });
  const BOT_CHALLENGE = /making sure you(?:'|’|&#39;|&rsquo;)re not a bot|are you a robot|captcha/i;

  // An answer in place of JSON that is a bot check or portal page: HTML by
  // its content type or body. Through the local proxy or lcv the content
  // type says JSON whatever the body is, so the body decides too; a body
  // that starts like JSON is JSON.
  function isChallengePage(contentType, text) {
    const body = String(text ?? "");
    if (/^\s*[[{]/.test(body)) return false;
    return /html/i.test(String(contentType || "")) || /^\s*</.test(body) || BOT_CHALLENGE.test(body.slice(0, 4096));
  }

  // ─── Provider adapters ─────────────────────────────────────────────
  // Notices from every Crossref and PubMed record seen for an entry, by DOI
  // and by "pmid:<n>": a work's own notices (Crossref updated-by and title
  // stamp, PubMed "… in" references and publication type) and those a
  // notice record declares for the works it concerns (Crossref update-to,
  // PubMed "… of" references).
  function noticeKeys(record) {
    const pmid = entryPmid(record);
    return [entryDoi(record), pmid ? `pmid:${pmid}` : ""].filter(Boolean);
  }

  function noticeIndex(records) {
    const lists = new Map();
    const add = (key, notices) => {
      if (key && notices?.length) lists.set(key, [...(lists.get(key) || []), ...notices]);
    };
    for (const record of records || []) {
      if (!record) continue;
      for (const key of noticeKeys(record)) add(key, record._notices);
      for (const update of record._updates || []) add(update.target, [update.notice]);
    }
    return new Map([...lists].map(([key, notices]) => [key, mergeNotices(notices)]));
  }

  // Each record with the notices its DOI (or PMID) has (a Semantic Scholar or
  // DBLP record of a retracted work carries Crossref's retraction too).
  function withNotices(records, index) {
    return records.map(record => {
      const own = record._notices || [];
      const notices = mergeNotices(own, ...noticeKeys(record).map(key => index.get(key) || []));
      return notices.length === own.length ? record : Object.freeze({ ...record, _notices: notices });
    });
  }

  /**
   * Create provider adapters with injected dependencies. deps.proxyHealth()
   * (optional) resolves to false when the origin's metadata proxy is missing:
   * every lookup then fails as lookup_failed (reason proxy_missing).
   * deps.crossrefPacers ({ list, single }, optional) replaces the Crossref
   * pacers, deps.pubmedPacer / deps.pubmedBudget the PubMed ones,
   * deps.dblpPacer / deps.openreviewPacer the DBLP and OpenReview ones, and
   * deps.clock ({ now, setTimer, clearTimer }) the clock of the default
   * DBLP and OpenReview pacers (tests).
   */
  function createProviderAdapters(deps) {
    const { metadataCache, arxivCache, endpoints = ENDPOINTS } = deps;
    // PubMed: one pacer for every E-utilities request (concurrency 1, 334 ms
    // apart until X-RateLimit-Limit says otherwise).
    const pubmed = PubMed.createPubMedClient({
      cache: metadataCache,
      pacer: deps.pubmedPacer,
      budget: deps.pubmedBudget,
      endpoint: endpoints.PUBMED_API || PubMed.EUTILS,
    });

    // Crossref pacing (live 2026-10-10): list queries answer from the
    // "public-array" pool (x-rate-limit-limit 1 per x-rate-limit-interval
    // 1s), /works/{doi} from "public-single" (5 per 1s); both say
    // x-concurrency-limit 1. One pacer per route learns the announced limits
    // from every answer and backs off on 429 (Retry-After). A page on another
    // origin cannot read those headers (Crossref's CORS exposes only Link),
    // so direct requests (GitHub Pages) start from the observed limits;
    // through the local proxy, which forwards the headers, the first answer
    // sets the pace and concurrency 1 holds until then.
    // DataCite (asked directly on every origin): one request at a time,
    // 100 ms apart (its public limit is 3000 requests per 5 minutes).
    const datacitePacer = deps.datacitePacer || Net.createRatePacer({ concurrency: 1, maxConcurrency: 1, intervalMs: 100 });

    // DBLP and OpenReview (PACED_PROVIDER): a 429 pauses the pacer for
    // Retry-After (else a doubling backoff). An HTML page in place of JSON
    // (isChallengePage: DBLP's bot challenge answers HTTP 200) is a
    // rate-limit failure, never an empty result, and opens the provider's
    // circuit: it is not asked again during that run. providerAlerts()
    // reports each opened circuit once.
    const clock = deps.clock || {};
    const pacedProvider = (key, pacer) => ({ key, name: PROVIDER_NAMES[key], pacer, open: null });
    const paced = {
      dblp: pacedProvider("dblp", deps.dblpPacer || Net.createRatePacer({ ...clock, ...PACED_PROVIDER })),
      openreview: pacedProvider("openreview", deps.openreviewPacer || Net.createRatePacer({ ...clock, ...PACED_PROVIDER })),
    };
    const alerts = [];
    const now = () => (clock.now || Date.now)();

    const circuitError = (provider, run) =>
      (provider.open && provider.open.run === (run || null) ? provider.open.error : null);

    // One paced JSON request. timing.spentMs (optional) adds the time the
    // request took, never its wait in the queue.
    async function pacedJson(provider, url, params, run, { budget = Net.BUDGETS.search, timing = null } = {}) {
      if (circuitError(provider, run)) throw circuitError(provider, run);
      return provider.pacer.run(async () => {
        if (circuitError(provider, run)) throw circuitError(provider, run);
        const started = now();
        let contentType = "";
        try {
          const text = await Net.requestJson(url, params, {
            requestApi: Net,
            budget,
            signal: run?.signal,
            origin: window.location.origin,
            responseType: "text",
            beforeAttempt: async ({ signal, attempt }) => {
              if (attempt > 1) await provider.pacer.spacing(signal);
            },
            onResponse: response => {
              provider.pacer.observe(response);
              contentType = response?.headers?.get?.("content-type") || "";
            },
          });
          if (text === null || text === undefined) return null;
          if (isChallengePage(contentType, text)) {
            const error = new Net.RequestError("rate_limited", `${provider.name} rate limited / bot challenge`,
              { challenge: true, provider: provider.key });
            provider.open = { run: run || null, error };
            if (!alerts.some(alert => alert.provider === provider.name)) alerts.push({ provider: provider.name, message: error.message });
            throw error;
          }
          try {
            return JSON.parse(text);
          } catch {
            throw new Net.RequestError("invalid_response", `${provider.name} answered with something other than JSON`);
          }
        } finally {
          if (timing) timing.spentMs += now() - started;
        }
      }, { signal: run?.signal });
    }

    const directCrossref = /^https?:/i.test(endpoints.CROSSREF_API);
    const crossrefPacers = deps.crossrefPacers || {
      list: Net.createRatePacer({ concurrency: 1, maxConcurrency: 3, intervalMs: directCrossref ? 1000 : 0 }),
      single: Net.createRatePacer({ concurrency: 1, maxConcurrency: 3, intervalMs: directCrossref ? 200 : 0 }),
    };

    // Rate control state 
    const rateState = {
      ssDelay: 500,
      crDelay: 100,
      ssMin: 300,   ssMax: 3000,
      crMin: 50,    crMax: 2000,
      lastSSTime: 0,
      lastCRTime: 0,
      ssConsecutiveOk: 0,
      crConsecutiveOk: 0,
    };

    function rateBackoff(source) {
      if (source === "ss") {
        rateState.ssDelay = Math.min(rateState.ssDelay * 1.3, rateState.ssMax);
        rateState.ssConsecutiveOk = 0;
      } else {
        rateState.crDelay = Math.min(rateState.crDelay * 1.3, rateState.crMax);
        rateState.crConsecutiveOk = 0;
      }
    }

    function rateSuccess(source) {
      if (source === "ss") {
        rateState.ssConsecutiveOk++;
        if (rateState.ssConsecutiveOk >= 2) {
          rateState.ssDelay = Math.max(rateState.ssDelay * 0.85, rateState.ssMin);
          rateState.ssConsecutiveOk = 0;
        }
      } else {
        rateState.crConsecutiveOk++;
        if (rateState.crConsecutiveOk >= 2) {
          rateState.crDelay = Math.max(rateState.crDelay * 0.85, rateState.crMin);
          rateState.crConsecutiveOk = 0;
        }
      }
    }

    const sleep = (ms, signal) => Net.sleep(ms, { signal });

    // options.pacer (Crossref): the request waits its turn there, outside its
    // deadlines; a retry attempt waits again; every answer teaches the pacer.
    // Other providers keep the adaptive delays above.
    async function fetchJSON(url, params, { signal, budget = Net.BUDGETS.search, pacer = null } = {}) {
      const isSS = url.includes("semanticscholar.org") || url.startsWith("/api/semanticscholar");
      const source = isSS ? "ss" : "cr";
      const request = () => Net.requestJson(url, params, {
        requestApi: Net,
        budget,
        signal,
        origin: window.location.origin,
        beforeAttempt: async ({ signal: attemptSignal, attempt }) => {
          if (pacer) {
            if (attempt > 1) await pacer.spacing(attemptSignal);
            return;
          }
          const delay = isSS ? rateState.ssDelay : rateState.crDelay;
          const lastKey = isSS ? "lastSSTime" : "lastCRTime";
          const elapsed = Date.now() - rateState[lastKey];
          if (elapsed < delay) await sleep(delay - elapsed, attemptSignal);
          Net.throwIfAborted(attemptSignal);
          rateState[lastKey] = Date.now();
        },
        onResponse: response => {
          if (pacer) pacer.observe(response);
          else if (response.ok) rateSuccess(source);
          else if (Net.isRetryableStatus(response.status)) rateBackoff(source);
        },
      });
      return pacer ? pacer.run(request, { signal }) : request();
    }

    function metadataCacheKey(source, title) {
      return `${source}:${titleKey(title)}`;
    }

    function providerRecord(entry, recordSource, recordId, retrieval) {
      let stableId = recordId;
      if (recordSource.startsWith("crossref")) stableId = normalizeDoi(recordId);
      if (recordSource === "local_arxiv") stableId = normalizeArxivId(recordId) || recordId;
      return createRecord(entry, { recordSource, recordId: stableId, retrieval });
    }

    function cacheOptions(run) {
      return run ? { runId: run.id, signal: run.signal } : {};
    }

    async function searchSSMatch(title, run) {
      const data = await metadataCache.getOrSet(metadataCacheKey("ss-match", title), () =>
        fetchJSON(endpoints.SS_MATCH, { query: title, fields: endpoints.SS_FIELDS }, { signal: run?.signal }), cacheOptions(run));
      if (!data?.data?.[0]) return null;
      const paper = data.data[0];
      return providerRecord(ssToStandard(paper), "semantic_scholar_match", paper.paperId, "title_match");
    }

    async function searchSSSearch(title, run) {
      const data = await metadataCache.getOrSet(metadataCacheKey("ss-search", title), () =>
        fetchJSON(endpoints.SS_SEARCH, { query: title, limit: "5", fields: endpoints.SS_FIELDS }, { signal: run?.signal }), cacheOptions(run));
      return (data?.data || []).map(paper =>
        providerRecord(ssToStandard(paper), "semantic_scholar_search", paper.paperId, "title_search"));
    }

    async function crossrefSearchRecords(params, cacheKey, retrieval, run) {
      const data = await metadataCache.getOrSet(cacheKey, () =>
        fetchJSON(endpoints.CROSSREF_API, { ...params, rows: String(CROSSREF_ROWS), select: CROSSREF_SELECT }, {
          signal: run?.signal,
          pacer: crossrefPacers.list,
        }), cacheOptions(run));
      return (data?.message?.items || []).map(item => {
        const converted = crossrefToStandard(item);
        if (Number.isFinite(item.score)) converted._crossrefScore = item.score;
        return providerRecord(converted, "crossref_search", item.DOI || item.URL, retrieval);
      });
    }

    // query.bibliographic (crossrefBibliographicQuery) first; the title-only
    // query.title search whenever it returns no record of the same work
    // (related records such as corrections, letters or an earlier version do
    // not count), so a Not Found always rests on both queries. A failed
    // request is a failure, never a reason to fall back. Every item
    // is then judged by title similarity and sameWork like any record;
    // Crossref's relevance score is kept for display only (_crossrefScore).
    async function searchCrossref(title, original, run) {
      const query = crossrefBibliographicQuery({ ...original, title: original?.title || title });
      const records = query
        ? await crossrefSearchRecords({ "query.bibliographic": query }, metadataCacheKey("crossref-bib", query), "bibliographic_search", run)
        : [];
      if (records.some(record => sameWork(original, record))) return records;
      const fallback = await crossrefSearchRecords({ "query.title": title }, metadataCacheKey("crossref", title), "title_search", run);
      return records.concat(fallback);
    }

    // PubMed (core/pubmed.js): identifiers OR strict title term, relaxed
    // term, ECitMatch, then one ESummary. Records are authoritative.
    function searchPubMed(title, original, run) {
      return pubmed.search({ ...original, title: original?.title || title }, run);
    }

    async function searchCrossrefDoi(doi, run) {
      const key = normalizeDoi(doi);
      if (!key) return null;
      const encodedDoi = encodeURIComponent(key);
      const data = await metadataCache.getOrSet(`crossref-doi:${key}`, () =>
        fetchJSON(`${endpoints.CROSSREF_API}/${encodedDoi}`, {}, {
          budget: Net.BUDGETS.metadata,
          signal: run?.signal,
          pacer: crossrefPacers.single,
        }), cacheOptions(run));
      return data?.message
        ? providerRecord(crossrefToStandard(data.message), "crossref_doi", data.message.DOI || key, "doi")
        : null;
    }

    // DataCite's record of one DOI, or null when DataCite has no such DOI
    // (404). Paced, cached (a 404 too), without credentials; a failure rejects.
    async function searchDataCite(doi, run) {
      const key = normalizeDoi(doi);
      if (!key || !endpoints.DATACITE_API) return null;
      const url = `${endpoints.DATACITE_API}${encodeURIComponent(key).replace(/%2F/gi, "/")}`;
      const data = await metadataCache.getOrSet(`datacite-doi:${key}`, () => datacitePacer.run(() => Net.requestJson(url, {}, {
        requestApi: Net,
        budget: deps.dataciteBudget || Net.BUDGETS.metadata,
        signal: run?.signal,
        fetchOptions: { credentials: "omit" },
        beforeAttempt: async ({ signal, attempt }) => {
          if (attempt > 1) await datacitePacer.spacing(signal);
        },
        onResponse: response => datacitePacer.observe(response),
      }), { signal: run?.signal }), cacheOptions(run));
      const converted = dataciteToStandard(data);
      return converted ? providerRecord(converted, "datacite", converted.doi || key, "doi") : null;
    }

    // Existence checks for the entry's identifiers that no pooled record
    // confirms (records.identifierStates), { kind: { id, state, record } }:
    //   DOI     Crossref's by-DOI answer, else DataCite. Absent only when
    //           DataCite has no such DOI and Crossref answered that it has
    //           none either (an arXiv DOI is DataCite's alone).
    //   arXiv   its DataCite DOI 10.48550/arXiv.<id> (on every origin).
    //   PMID, PMCID  PubMed (ESummary of the PMID, ESearch PMCn[pmc]), unless
    //           the PubMed search itself failed.
    // A failed request makes the state "failed", never "absent".
    async function checkIdentifiers(original, candidates, crossrefByDoi, outcomes, run) {
      const pubmedFailed = (outcomes || []).some(outcome => outcome.source === "pubmed" && outcome.state === "failure");
      // Without a DataCite endpoint (custom endpoint tables) DOIs and arXiv IDs stay unchecked.
      const pending = identifierStates(original, candidates).filter(item => item.state !== "confirmed" &&
        (item.kind === "pmid" || item.kind === "pmcid" || !!endpoints.DATACITE_API));
      const settled = await Promise.all(pending.map(async ({ kind, id }) => {
        const source = kind === "pmid" || kind === "pmcid" ? "pubmed" : "datacite";
        try {
          if (source === "pubmed") {
            if (pubmedFailed) return { kind, id, state: "failed", record: null, records: [] };
            const records = await pubmed.identifierRecords(kind, id, run);
            return { kind, id, state: records.length ? "confirmed" : "absent", record: records[0] || null, records, outcome: { source, role: "enrichment", state: "success" } };
          }
          const crossref = kind === "doi" && crossrefByDoi?.has(id) ? crossrefByDoi.get(id) : undefined;
          if (crossref) return { kind, id, state: "confirmed", record: crossref, records: [] };
          const record = await searchDataCite(kind === "doi" ? id : `10.48550/arxiv.${id}`, run);
          const crossrefSilent = kind === "doi" && !arxivIdInText(id) && crossref === undefined;
          return { kind, id, state: record ? "confirmed" : crossrefSilent ? "failed" : "absent", record, records: [], outcome: { source, role: "enrichment", state: "success" } };
        } catch (error) {
          if (Net.isCancelled(error)) throw error;
          return { kind, id, state: "failed", record: null, records: [], outcome: { source, role: "enrichment", state: "failure", error } };
        }
      }));
      return {
        identifiers: Object.fromEntries(settled.map(({ kind, id, state, record }) => [kind, { id, state, record }])),
        records: settled.flatMap(item => item.records),
        outcomes: settled.map(item => item.outcome).filter(Boolean),
      };
    }

    // Crossref by-DOI records for the original's and every candidate's DOI.
    // byDoi maps each DOI that answered to its record (null: Crossref has no
    // such DOI), so a later DOI round trip need not fetch it again.
    async function crossrefDoiRecords(candidates, original, run) {
      const dois = [...new Set([
        normalizeDoi(original?.doi),
        ...(candidates || []).map(candidate => normalizeDoi(candidate?.doi)),
      ].filter(Boolean))];
      const settled = await Promise.allSettled(dois.map(doi => searchCrossrefDoi(doi, run)));
      const byDoi = new Map();
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") byDoi.set(dois[index], result.value || null);
      });
      return {
        byDoi,
        candidates: settled.filter(result => result.status === "fulfilled" && result.value).map(result => result.value),
        outcomes: settled.map((result, index) => result.status === "fulfilled"
          ? { source: "crossref_doi", role: "enrichment", state: "success", id: dois[index] }
          : { source: "crossref_doi", role: "enrichment", state: "failure", id: dois[index], error: result.reason }),
      };
    }

    function dblpSearchQueries(title, original) {
      return publicationSearchQueries(title, firstAuthorSearchToken(original));
    }

    function dblpHits(data) {
      const hit = data?.result?.hits?.hit;
      if (!hit) return [];
      return Array.isArray(hit) ? hit : [hit];
    }

    function dblpKeyFrom(entry) {
      const direct = normalizeDblpKey(entry?._dblpKey || entry?._externalIds?.DBLP || "");
      if (direct) return direct;
      const url = String(entry?.url || "");
      const match = /dblp\.(?:org|uni-trier\.de|dagstuhl\.de)\/rec\/((?:conf|journals)\/[^\s?#]+)/i.exec(url);
      return match ? normalizeDblpKey(match[1]) : "";
    }

    function publishedDblpKeys(original, candidates) {
      const keys = [];
      const seen = new Set();
      function add(value) {
        const key = normalizeDblpKey(value);
        const id = key.toLowerCase();
        if (!key || !isPublishedDblpKey(key) || seen.has(id)) return;
        seen.add(id);
        keys.push(key);
      }
      add(dblpKeyFrom(original));
      for (const candidate of candidates || []) add(dblpKeyFrom(candidate));
      return keys;
    }

    async function fetchDblpByKey(key, run) {
      const normalized = normalizeDblpKey(key);
      if (!normalized || !isPublishedDblpKey(normalized) || !endpoints.DBLP_API) return null;
      const data = await metadataCache.getOrSet(`dblp-key:${normalized.toLowerCase()}`, () =>
        fetchDblpData({ q: normalized, h: "5" }, run, Net.BUDGETS.dblp), cacheOptions(run));
      const wanted = normalized.toLowerCase();
      const hit = dblpHits(data).find(item =>
        normalizeDblpKey(item?.info?.key || item?.key || "").toLowerCase() === wanted);
      if (!hit) return null;
      const converted = dblpToStandard(hit);
      if (!converted.title) return null;
      return providerRecord(converted, "dblp", converted._dblpKey, "dblp_key");
    }

    async function addDblpKeyCandidates(candidates, original, run) {
      if (!endpoints.DBLP_API) return { candidates, outcomes: [] };
      const have = new Set((candidates || [])
        .filter(candidate => candidate?._recordSource === "dblp")
        .map(candidate => normalizeDblpKey(candidate._dblpKey || candidate._recordId).toLowerCase())
        .filter(Boolean));
      const keys = publishedDblpKeys(original, candidates)
        .filter(key => !have.has(key.toLowerCase()))
        .slice(0, 3);
      if (!keys.length) return { candidates, outcomes: [] };
      const settled = await Promise.allSettled(keys.map(key => fetchDblpByKey(key, run)));
      return {
        candidates: dedupeRecords(settled
          .filter(result => result.status === "fulfilled" && result.value)
          .map(result => result.value)
          .concat(candidates)),
        outcomes: settled.map(result => result.status === "fulfilled"
          ? { source: "dblp_key", role: "enrichment", state: "success" }
          : { source: "dblp_key", role: "enrichment", state: "failure", error: result.reason }),
      };
    }

    function fetchDblpData(params, run, budget = Net.BUDGETS.dblp, timing = null) {
      return pacedJson(paced.dblp, endpoints.DBLP_API, { ...params, format: "json" }, run, { budget, timing });
    }

    // One search's queries share the DBLP budget (12 s of request time; the
    // wait for the pacer does not count).
    async function searchDblp(title, original, run) {
      const collected = [];
      const originalYear = parseYear(original?.year);
      const preferPublished = run?.settings?.preferPublished === true;
      const timing = { spentMs: 0 };
      for (const query of dblpSearchQueries(title, original)) {
        const remaining = Net.BUDGETS.dblp.totalTimeoutMs - timing.spentMs;
        if (remaining <= 0)
          throw new Net.RequestError("deadline_timeout", "DBLP search deadline exceeded", { scope: "total", attempts: 1 });
        const budget = {
          ...Net.BUDGETS.dblp,
          attemptTimeoutMs: Math.min(Net.BUDGETS.dblp.attemptTimeoutMs, remaining),
          totalTimeoutMs: remaining,
        };
        const data = await metadataCache.getOrSet(metadataCacheKey("dblp", query), () =>
          fetchDblpData({ q: query, h: "10" }, run, budget, timing), cacheOptions(run));
        const hits = dblpHits(data);
        const candidates = hits.map(hit => {
          const converted = dblpToStandard(hit);
          return providerRecord(converted, "dblp", converted._dblpKey, "title_search");
        }).filter(candidate => candidate.title);
        collected.push(...candidates);
        const plausibleMatch = candidates.some(candidate => {
          if (titleSimilarity(title, candidate.title || "") < MIN_TITLE_SIM) return false;
          const candidateYear = parseYear(candidate.year);
          const plausibleYear = !Number.isInteger(originalYear) || !Number.isInteger(candidateYear) ||
            Math.abs(candidateYear - originalYear) <= 1;
          return plausibleYear && (!preferPublished || isCleanPublishedManifestation(candidate));
        });
        if (plausibleMatch) return dedupeRecords(collected);
      }
      return dedupeRecords(collected);
    }

    function openreviewSearchQuery(title, original) {
      const compactTitle = searchTitleTokens(title).join(" ");
      const author = firstAuthorSearchToken(original);
      return [compactTitle, author].filter(Boolean).join(" ");
    }

    function openreviewNoteScore(note, title, original) {
      const content = note?.content || {};
      const noteTitle = String(openreviewValue(content.title) || "");
      const invitation = String(note?.invitation || "");
      const venueid = String(openreviewValue(content.venueid) || "");
      const venue = String(openreviewValue(content.venue) || "");
      let score = titleSimilarity(title, noteTitle);
      if (/ICLR\.cc\//i.test(`${invitation} ${venueid}`) || /\bICLR\b/i.test(venue)) score += 10;
      if (/COLM\//i.test(`${invitation} ${venueid}`) || /\bCOLM\b/i.test(venue) || /language modeling/i.test(venue))
        score += 10;
      if (openreviewValue(content._bibtex)) score += 3;
      score += openreviewNotePriority(note, original);
      return score;
    }

    async function searchOpenReview(title, original, run) {
      if (!endpoints.OPENREVIEW_API) return [];
      const query = openreviewSearchQuery(title, original);
      if (!query.trim()) return [];
      const data = await metadataCache.getOrSet(metadataCacheKey("openreview", `forum:${query}`), () =>
        pacedJson(paced.openreview, endpoints.OPENREVIEW_API, { term: query, content: "all", source: "forum", limit: "10" }, run),
      cacheOptions(run));
      return (data?.notes || [])
        .slice()
        .sort((a, b) => openreviewNoteScore(b, title, original) - openreviewNoteScore(a, title, original))
        .map(note => {
          const converted = openreviewToStandard(note);
          const recordSource = converted._source === "dblp" ? "dblp" : "openreview";
          const recordId = recordSource === "dblp" ? converted._dblpKey : converted._openreviewId;
          const retrieval = recordSource === "dblp" ? "openreview_mirror" : "title_search";
          return providerRecord(converted, recordSource, recordId, retrieval);
        })
        .filter(candidate => candidate.title);
    }

    function bibEntryToArxivCandidate(entry, arxivId) {
      return providerRecord({
        ENTRYTYPE: entry.ENTRYTYPE || "misc",
        title: entry.title || "",
        author: entry.author || "",
        year: arxivYearFromId(arxivId) || entry.year || "",
        journal: entry.journal || entry.booktitle || "arXiv",
        volume: entry.volume || "",
        number: entry.number || "",
        pages: entry.pages || "",
        doi: entry.doi || "",
        publisher: entry.publisher || "",
        url: entry.url || `https://arxiv.org/abs/${arxivId}`,
        eprint: entry.eprint || arxivId,
        archiveprefix: entry.archiveprefix || "arXiv",
        _arxivId: arxivId,
      }, "local_arxiv", arxivId, "arxiv_id");
    }

    async function fetchLocalArxivCandidate(arxivId, run) {
      const id = normalizeArxivId(arxivId);
      if (!id || !endpoints.LOCAL_ARXIV_BIBTEX) return null;
      return arxivCache.getOrSet(`arxiv:${id}`, async () => {
        const data = await Net.requestJson(endpoints.LOCAL_ARXIV_BIBTEX, { id }, {
          requestApi: Net,
          budget: Net.BUDGETS.arxiv,
          signal: run?.signal,
          origin: window.location.origin,
        });
        if (!data?.bibtex) return null;
        const entry = parseBib(data.bibtex)[0];
        if (!entry?.title) return null;
        return bibEntryToArxivCandidate(entry, id);
      }, cacheOptions(run));
    }

    // Through the local proxy only: without it (GitHub Pages, file://) the
    // arXiv BibTeX enrichment is skipped and /api/arxiv/bibtex never asked.
    async function addLocalArxivCandidates(candidates, original, run) {
      if (!endpoints.LOCAL_ARXIV_BIBTEX) return { candidates, outcomes: [] };
      const ids = new Set([extractArxivId(original)]);
      candidates.forEach(candidate => ids.add(extractArxivId(candidate)));
      const arxivIds = [...ids].filter(Boolean);
      if (!arxivIds.length) return { candidates, outcomes: [] };
      const settled = await Promise.allSettled(arxivIds.map(id => fetchLocalArxivCandidate(id, run)));
      return {
        candidates: dedupeRecords(settled
          .filter(result => result.status === "fulfilled" && result.value)
          .map(result => result.value)
          .concat(candidates)),
        outcomes: settled.map((result, index) => result.status === "fulfilled"
          ? { source: "local_arxiv", role: "enrichment", state: "success", id: arxivIds[index] }
          : { source: "local_arxiv", role: "enrichment", state: "failure", id: arxivIds[index], error: result.reason }),
      };
    }

    function relevantProviderCandidates(original, candidates) {
      return relevantCandidates(original, candidates, {
        directLinkKinds,
        titleSimilarity,
        minTitleSim: MIN_TITLE_SIM,
      });
    }

    async function searchCandidatePool(title, original, run) {
      if (deps.proxyHealth && await deps.proxyHealth() !== true) throw proxyMissingError();
      const rawCandidates = [];
      const searches = [
        { source: "semantic_scholar_match", run: () => searchSSMatch(title, run) },
        { source: "crossref_search", run: () => searchCrossref(title, original, run) },
        { source: "semantic_scholar_search", run: () => searchSSSearch(title, run) },
      ];
      if (endpoints.DBLP_API)
        searches.push({ source: "dblp", run: () => searchDblp(title, original, run) });
      if (endpoints.OPENREVIEW_API)
        searches.push({ source: "openreview", run: () => searchOpenReview(title, original, run) });
      searches.push({ source: "pubmed", run: () => searchPubMed(title, original, run) });
      const settled = await Promise.allSettled(searches.map(search => search.run()));
      const outcomes = settled.map((result, index) => result.status === "fulfilled"
        ? { source: searches[index].source, role: "primary", state: "success" }
        : { source: searches[index].source, role: "primary", state: "failure", error: result.reason });
      settled.forEach(result => {
        if (result.status !== "fulfilled" || !result.value) return;
        if (Array.isArray(result.value)) rawCandidates.push(...result.value);
        else rawCandidates.push(result.value);
      });

      let candidates = dedupeRecords(relevantProviderCandidates(original, rawCandidates));
      const doiEnrichment = await crossrefDoiRecords(candidates, original, run);
      outcomes.push(...doiEnrichment.outcomes);
      candidates = dedupeRecords(candidates.concat(relevantProviderCandidates(original, doiEnrichment.candidates)));
      const arxivEnrichment = await addLocalArxivCandidates(candidates, original, run);
      outcomes.push(...arxivEnrichment.outcomes);
      candidates = dedupeRecords(relevantProviderCandidates(original, arxivEnrichment.candidates));
      const dblpKeyEnrichment = await addDblpKeyCandidates(candidates, original, run);
      outcomes.push(...dblpKeyEnrichment.outcomes);
      candidates = dedupeRecords(relevantProviderCandidates(original, dblpKeyEnrichment.candidates));
      // Without any candidate there is no work to confirm identifiers for.
      const checks = candidates.length
        ? await checkIdentifiers(original, candidates, doiEnrichment.byDoi, outcomes, run)
        : { identifiers: {}, records: [], outcomes: [] };
      outcomes.push(...checks.outcomes);
      candidates = dedupeRecords(candidates.concat(relevantProviderCandidates(original, checks.records)));
      const noticesByDoi = noticeIndex([...rawCandidates, ...doiEnrichment.byDoi.values(), ...checks.records]);
      candidates = withNotices(candidates, noticesByDoi);

      const classification = classifyAbsence(outcomes, candidates);
      const warnings = sourceWarnings(outcomes);
      if (classification === "lookup_failed") {
        const error = new Error("one or more primary metadata providers were unavailable");
        error.name = "LookupFailedError";
        error.sourceWarnings = warnings;
        error.outcomes = outcomes;
        throw error;
      }

      // Which providers answered; the applicable authoritative ones that
      // failed make a verdict that rests on absence a lookup failure
      // (verify.decide: provider_unavailable).
      const providers = providerStates(outcomes);
      const identifierResolved = identifierStates(original, candidates, checks.identifiers)
        .some(item => item.kind === "doi" && item.state === "confirmed");
      const unavailableProviders = applicableProviders(original, endpoints, { identifierResolved })
        .filter(key => providers[key] === "failed").map(key => PROVIDER_NAMES[key]);
      return {
        candidates, classification, sourceWarnings: warnings, outcomes, doiRecords: doiEnrichment.byDoi, noticesByDoi,
        identifiers: checks.identifiers, providers, unavailableProviders,
      };
    }

    function resetRateState() {
      rateState.ssDelay = 500;
      rateState.crDelay = 100;
      rateState.ssConsecutiveOk = 0;
      rateState.crConsecutiveOk = 0;
      rateState.lastSSTime = 0;
      rateState.lastCRTime = 0;
    }

    return {
      searchCandidatePool,
      resetRateState,
      // Providers whose circuit opened (a bot challenge), once each:
      // [{ provider, message }].
      providerAlerts: () => alerts.map(alert => ({ ...alert })),
      // For testing - expose individual search functions
      searchSSMatch,
      searchSSSearch,
      searchCrossref,
      searchCrossrefDoi,
      searchDataCite,
      searchPubMed,
      pubmedPacer: pubmed.pacer,
      searchDblp,
      searchOpenReview,
      crossrefDoiRecords,
      addLocalArxivCandidates,
      addDblpKeyCandidates,
      relevantProviderCandidates,
    };
  }

export {
  isGithubPages,
  useMetadataProxy,
  endpointsFor,
  USE_METADATA_PROXY,
  ON_GITHUB_PAGES,
  PROXY_SIGNATURE,
  checkProxyHealth,
  CROSSREF_API,
  SS_MATCH,
  SS_SEARCH,
  SS_PAPER,
  DBLP_API,
  OPENREVIEW_API,
  SS_FIELDS,
  LOCAL_ARXIV_BIBTEX,
  DATACITE_API,
  ENDPOINTS,
  CROSSREF_SELECT,
  crossrefBibliographicQuery,
  crossrefYear,
  crossrefNotices,
  crossrefToStandard,
  noticeIndex,
  withNotices,
  ssToStandard,
  dataciteToStandard,
  dblpToStandard,
  normalizeDblpKey,
  isPublishedDblpKey,
  openreviewToStandard,
  openreviewNotePriority,
  publicationSearchQueries,
  isRelevantCandidate,
  relevantCandidates,
  classifyAbsence,
  sourceWarnings,
  PROVIDER_NAMES,
  providerStates,
  applicableProviders,
  PACED_PROVIDER,
  isChallengePage,
  createProviderAdapters,
};
