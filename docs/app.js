(() => {
  "use strict";

  const B = window.BibLib;
  const A = window.BibAtomicCandidates;

  // ─── Configuration ───────────────────────────────────────────────────
  function useMetadataProxy() {
    if (typeof window === "undefined" || !window.location) return false;
    const { hostname, protocol } = window.location;
    if (protocol === "file:") return false;
    return !hostname.endsWith(".github.io");
  }

  const USE_METADATA_PROXY = useMetadataProxy();
  const CROSSREF_API = USE_METADATA_PROXY ? "/api/crossref/works" : "https://api.crossref.org/works";
  const SS_MATCH = USE_METADATA_PROXY
    ? "/api/semanticscholar/graph/v1/paper/search/match"
    : "https://api.semanticscholar.org/graph/v1/paper/search/match";
  const SS_SEARCH = USE_METADATA_PROXY
    ? "/api/semanticscholar/graph/v1/paper/search"
    : "https://api.semanticscholar.org/graph/v1/paper/search";
  const DBLP_API = USE_METADATA_PROXY ? "/api/dblp/search/publ/api" : "https://dblp.org/search/publ/api";
  const OPENREVIEW_API = USE_METADATA_PROXY ? "/api/openreview/notes/search" : "";
  const SS_FIELDS = "title,authors,year,venue,publicationVenue,externalIds";
  const LOCAL_ARXIV_BIBTEX = "/api/arxiv/bibtex";
  const MAX_RETRIES = 4;
  const RETRY_BASE_MS = 1500;
  const MAX_CANDIDATE_CHOICES = 3;
  const EVIDENCE_LANGUAGE_STORAGE = "bv-evidence-language";
  const SPEED_MODE_STORAGE = "bv-speed-mode";
  const METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const ARXIV_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const metadataCache = B.createTtlCache({ ttlMs: METADATA_CACHE_TTL_MS });
  const arxivCache = B.createTtlCache({ ttlMs: ARXIV_CACHE_TTL_MS });

  const EVIDENCE_TEXT = {
    en: {
      reviewPrefix: "The closest database record may not be the paper you meant",
      reviewMiddle: "title similarity to",
      reviewAction: "Review the suggestions below and use the checkmark on each row to adopt a value, or keep your original text.",
      localLlmReason: " Local LLM reason: ",
      notFoundWithTitle: "No matching publication was found in CrossRef, Semantic Scholar, DBLP, or OpenReview for this title. Try fixing typos or adding missing words, then re-run verification, or check the reference manually.",
      notFoundNoTitle: "This entry has no title, so it cannot be looked up automatically. Add a title in your .bib file or verify the entry by hand.",
      lookupFailed: "Publication lookup failed before the databases could answer. This is usually rate limiting or an upstream outage, not evidence that the paper is missing. Re-run verification later.",
    },
    ko: {
      reviewPrefix: "가장 가까운 데이터베이스 기록이 의도한 논문과 다를 수 있습니다",
      reviewMiddle: "제목 유사도:",
      reviewAction: "아래 제안을 검토한 뒤 각 행의 값을 채택하거나 원래 값을 유지하세요.",
      localLlmReason: " 로컬 LLM 근거: ",
      notFoundWithTitle: "CrossRef, Semantic Scholar, DBLP 또는 OpenReview에서 이 제목과 일치하는 출판물을 찾지 못했습니다. 오타나 누락된 단어를 고친 뒤 다시 검증하거나 직접 확인하세요.",
      notFoundNoTitle: "이 항목에는 title이 없어 자동 조회할 수 없습니다. .bib 파일에 title을 추가하거나 직접 확인하세요.",
      lookupFailed: "데이터베이스가 응답하기 전에 조회가 실패했습니다. 보통 rate limit 또는 upstream 장애이며, 논문이 없다는 뜻은 아닙니다. 잠시 뒤 다시 실행하세요.",
    },
  };

  function normalizeEvidenceLanguage(value) {
    const lang = String(value || "").toLowerCase();
    return lang === "ko" || lang === "kor" || lang === "korean" ? "ko" : "en";
  }

  function tEvidence(key, params = {}) {
    const lang = getEvidenceLanguage();
    let text = (EVIDENCE_TEXT[lang] || EVIDENCE_TEXT.en)[key] || EVIDENCE_TEXT.en[key] || "";
    for (const [name, value] of Object.entries(params))
      text = text.replaceAll(`{${name}}`, String(value ?? ""));
    return text;
  }

  // ─── Adaptive rate controller ──────────────────────────────────────
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

  // ─── Network ─────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isTransientHttpStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  function retryDelayMs(resp, attempt) {
    const retryAfter = resp?.headers?.get?.("Retry-After");
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return RETRY_BASE_MS * Math.pow(2, attempt);
  }

  function makeLookupError(kind, status, message) {
    const err = new Error(message);
    err.name = "LookupError";
    err.kind = kind;
    err.status = status;
    return err;
  }

  async function fetchJSON(url, params, { retries = MAX_RETRIES, is404Ok = false } = {}) {
    const u = new URL(url, window.location.origin);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

    const isSS = url.includes("semanticscholar.org") || url.startsWith("/api/semanticscholar");
    const source = isSS ? "ss" : "cr";
    const delay = isSS ? rateState.ssDelay : rateState.crDelay;
    const lastKey = isSS ? "lastSSTime" : "lastCRTime";
    const elapsed = Date.now() - rateState[lastKey];
    if (elapsed < delay) await sleep(delay - elapsed);
    rateState[lastKey] = Date.now();

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(u.toString());
        if (resp.ok) {
          rateSuccess(source);
          return resp.json();
        }
        if (resp.status === 404 && is404Ok) return null;
        if (isTransientHttpStatus(resp.status)) {
          rateBackoff(source);
          if (attempt < retries) {
            const wait = retryDelayMs(resp, attempt);
            console.warn(`Transient lookup error (${resp.status}) on attempt ${attempt + 1}, retrying in ${wait}ms...`);
            await sleep(wait);
            continue;
          }
          const kind = resp.status === 429 ? "rate_limited" : "upstream";
          throw makeLookupError(kind, resp.status, `transient lookup error ${resp.status}`);
        }
        return null;
      } catch (err) {
        rateBackoff(source);
        if (err?.name === "LookupError") throw err;
        if (attempt < retries) {
          const wait = RETRY_BASE_MS * Math.pow(2, attempt);
          console.warn(`Request failed (${err.message}), retrying in ${wait}ms...`);
          await sleep(wait);
          continue;
        }
        console.warn(`Request failed after ${retries + 1} attempts:`, err.message);
        throw makeLookupError("network", 0, err.message || "network lookup failed");
      }
    }
    return null;
  }

  // ─── API searches ────────────────────────────────────────────────────
  function metadataCacheKey(source, title) {
    return `${source}:${B.normalizeTitle(title || "")}`;
  }

  function providerRecord(entry, recordSource, recordId, retrieval) {
    let stableId = recordId;
    if (recordSource.startsWith("crossref")) stableId = B.normalizeDoiValue(recordId);
    if (recordSource === "local_arxiv") stableId = A.normalizeArxiv(recordId);
    return A.createRecord(entry, { recordSource, recordId: stableId, retrieval });
  }

  async function searchSSMatch(title) {
    const data = await metadataCache.getOrSet(metadataCacheKey("ss-match", title), () =>
      fetchJSON(SS_MATCH, { query: title, fields: SS_FIELDS }, { is404Ok: true }));
    if (!data?.data?.[0]) return null;
    const paper = data.data[0];
    return providerRecord(B.ssToStandard(paper), "semantic_scholar_match", paper.paperId, "title_match");
  }

  async function searchSSSearch(title) {
    const data = await metadataCache.getOrSet(metadataCacheKey("ss-search", title), () =>
      fetchJSON(SS_SEARCH, { query: title, limit: "5", fields: SS_FIELDS }));
    return (data?.data || []).map(paper =>
      providerRecord(B.ssToStandard(paper), "semantic_scholar_search", paper.paperId, "title_search"));
  }

  async function searchCrossref(title) {
    const data = await metadataCache.getOrSet(metadataCacheKey("crossref", title), () =>
      fetchJSON(CROSSREF_API, {
        "query.title": title, rows: "5",
        select: "title,author,published-print,published-online,container-title,volume,issue,page,DOI,publisher,URL,type",
      }));
    return (data?.message?.items || []).map(item =>
      providerRecord(B.crossrefToStandard(item), "crossref_search", item.DOI || item.URL, "title_search"));
  }

  function doiCacheKey(doi) {
    return String(doi || "").trim().toLowerCase();
  }

  async function searchCrossrefDoi(doi) {
    const key = doiCacheKey(doi);
    if (!key) return null;
    const encodedDoi = encodeURIComponent(key);
    const data = await metadataCache.getOrSet(`crossref-doi:${key}`, () =>
      fetchJSON(`${CROSSREF_API}/${encodedDoi}`, {}, {
        retries: Math.min(MAX_RETRIES, 2),
        is404Ok: true,
      }));
    return data?.message
      ? providerRecord(B.crossrefToStandard(data.message), "crossref_doi", data.message.DOI || key, "doi")
      : null;
  }

  async function crossrefDoiRecords(candidates) {
    const dois = [...new Set((candidates || []).map(candidate => B.normalizeDoiValue(candidate?.doi)).filter(Boolean))];
    const records = await Promise.all(dois.map(async doi => {
      try {
        return await searchCrossrefDoi(doi);
      } catch (err) {
        console.warn("CrossRef DOI lookup failed:", err.message);
        return null;
      }
    }));
    return records.filter(Boolean);
  }

  function firstAuthorSearchToken(original) {
    const first = String(original?.author || "").split(/\s+and\s+/i)[0] || "";
    const cleaned = B.stripLatex(first).replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    if (cleaned.includes(",")) return cleaned.split(",")[0].trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return parts[parts.length - 1] || "";
  }

  function dblpSearchQuery(title, original) {
    const author = firstAuthorSearchToken(original);
    return [title, author].filter(Boolean).join(" ");
  }

  function dblpSearchQueries(title, original) {
    return Array.from(new Set([
      dblpSearchQuery(title, original),
      title,
    ].map(q => String(q || "").trim()).filter(Boolean)));
  }

  function fetchDblpJsonp(params) {
    return new Promise((resolve, reject) => {
      const callbackName = `__dblpCallback${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const u = new URL(DBLP_API);
      for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
      u.searchParams.set("format", "jsonp");
      u.searchParams.set("callback", callbackName);
      let settled = false;
      const cleanup = () => {
        settled = true;
        delete window[callbackName];
        script.remove();
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(makeLookupError("upstream", 0, "DBLP JSONP timed out"));
      }, 12000);
      window[callbackName] = (data) => {
        window.clearTimeout(timer);
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        cleanup();
        reject(makeLookupError("network", 0, "DBLP JSONP request failed"));
      };
      script.src = u.toString();
      document.head.appendChild(script);
    });
  }

  async function fetchDblpData(params) {
    if (USE_METADATA_PROXY) return fetchJSON(DBLP_API, { ...params, format: "json" });
    return fetchDblpJsonp(params);
  }

  async function searchDblp(title, original) {
    let fallback = [];
    for (const query of dblpSearchQueries(title, original)) {
      const data = await metadataCache.getOrSet(metadataCacheKey("dblp", query), () =>
        fetchDblpData({ q: query, h: "10" }));
      const hits = data?.result?.hits?.hit || [];
      const candidates = hits.map(hit => {
        const converted = B.dblpToStandard(hit);
        return providerRecord(converted, "dblp", converted._dblpKey, "title_search");
      }).filter(candidate => candidate.title);
      if (!fallback.length) fallback = candidates;
      if (candidates.some(candidate => B.titleSimilarity(title, candidate.title || "") >= B.MIN_TITLE_SIM))
        return candidates;
    }
    return fallback;
  }

  function openreviewSearchQuery(title, original) {
    const compactTitle = B.looseTitleText(title)
      .split(/\s+/)
      .filter(token => token.length > 2)
      .slice(0, 8)
      .join(" ");
    const author = firstAuthorSearchToken(original);
    return [compactTitle, author].filter(Boolean).join(" ");
  }

  function openreviewValue(value) {
    return value && typeof value === "object" && "value" in value ? value.value : value;
  }

  function openreviewNoteScore(note, title) {
    const content = note?.content || {};
    const noteTitle = String(openreviewValue(content.title) || "");
    const invitation = String(note?.invitation || "");
    const venueid = String(openreviewValue(content.venueid) || "");
    const venue = String(openreviewValue(content.venue) || "");
    let score = B.titleSimilarity(title, noteTitle);
    if (/ICLR\.cc\//i.test(`${invitation} ${venueid}`) || /ICLR/i.test(venue)) score += 10;
    if (/^dblp\.org\//i.test(invitation) || /^dblp\.org\//i.test(venueid)) score -= 15;
    if (openreviewValue(content._bibtex)) score += 3;
    return score;
  }

  async function searchOpenReview(title, original) {
    if (!OPENREVIEW_API) return [];
    const query = openreviewSearchQuery(title, original);
    if (!query.trim()) return [];
    const data = await metadataCache.getOrSet(metadataCacheKey("openreview", query), () =>
      fetchJSON(OPENREVIEW_API, { term: query, content: "all", source: "all", limit: "10" }));
    return (data?.notes || [])
      .slice()
      .sort((a, b) => openreviewNoteScore(b, title) - openreviewNoteScore(a, title))
      .map(note => {
        const converted = B.openreviewToStandard(note);
        return providerRecord(converted, "openreview", converted._openreviewId, "title_search");
      })
      .filter(candidate => candidate.title);
  }

  function bibEntryToArxivCandidate(entry, arxivId) {
    return providerRecord({
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
      _arxivId: arxivId,
    }, "local_arxiv", arxivId, "arxiv_id");
  }

  async function fetchLocalArxivCandidate(arxivId) {
    const id = B.normalizeArxivId(arxivId);
    if (!id) return null;
    return arxivCache.getOrSet(`arxiv:${id}`, async () => {
      try {
        const u = new URL(LOCAL_ARXIV_BIBTEX, window.location.origin);
        u.searchParams.set("id", id);
        const resp = await fetch(u.toString());
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data?.bibtex) return null;
        const entry = B.parseBib(data.bibtex)[0];
        if (!entry?.title) return null;
        return bibEntryToArxivCandidate(entry, id);
      } catch (err) {
        console.warn("Local arXiv lookup failed:", err instanceof Error ? err.message : err);
        return null;
      }
    });
  }

  async function addLocalArxivCandidates(candidates, original) {
    const ids = new Set([B.extractArxivId(original)]);
    candidates.forEach(candidate => ids.add(B.extractArxivId(candidate)));
    const arxivIds = [...ids].filter(Boolean);
    if (!arxivIds.length) return candidates;
    const arxivCandidates = await Promise.all(arxivIds.map(fetchLocalArxivCandidate));
    return A.dedupeRecords(arxivCandidates.filter(Boolean).concat(candidates));
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
    const curatedCandidate = B.curatedCandidateForEntry(original);
    if (curatedCandidate) {
      candidates.push(providerRecord(
        curatedCandidate,
        "local_curation",
        `${original.ID || "entry"}:${B.normalizeTitle(original.title || "")}`,
        "curation_rule"
      ));
    }
    const errors = [];
    const results = await Promise.allSettled([
      searchSSMatch(title),
      searchCrossref(title),
      searchSSSearch(title),
      searchDblp(title, original),
      searchOpenReview(title, original),
    ]);

    const [ssMatchResult, crResult, ssSearchResult, dblpResult, openReviewResult] = results;
    if (ssMatchResult.status === "fulfilled" && ssMatchResult.value)
      candidates.push(ssMatchResult.value);
    else if (ssMatchResult.status === "rejected") rememberLookupError(errors, ssMatchResult.reason);

    if (crResult.status === "fulfilled") candidates.push(...crResult.value);
    else rememberLookupError(errors, crResult.reason);

    if (ssSearchResult.status === "fulfilled") candidates.push(...ssSearchResult.value);
    else rememberLookupError(errors, ssSearchResult.reason);

    if (dblpResult.status === "fulfilled") candidates.push(...dblpResult.value);
    else rememberLookupError(errors, dblpResult.reason);

    if (openReviewResult.status === "fulfilled") candidates.push(...openReviewResult.value);
    else rememberLookupError(errors, openReviewResult.reason);

    candidates.push(...await crossrefDoiRecords(candidates));
    const withArxiv = await addLocalArxivCandidates(A.dedupeRecords(candidates), original);
    throwIfAllLookupsFailed(withArxiv, errors);
    return A.dedupeRecords(withArxiv);
  }

  function selectedFirstCandidateChoices(selectedCandidate, candidates, selectedIndex) {
    const indexed = candidates.map((choice, index) => ({ choice, index }));
    if (selectedIndex > 0 && selectedIndex < indexed.length) {
      const [selected] = indexed.splice(selectedIndex, 1);
      indexed.unshift(selected);
    }
    if (indexed.length && selectedCandidate) {
      indexed[0] = {
        choice: selectedCandidate,
        index: selectedIndex >= 0 ? selectedIndex : indexed[0].index,
      };
    }
    return indexed.map(({ choice, index }) => ({
      ...choice,
      _choiceIndex: index,
      _paperUrl: B.paperUrlForEntry(choice),
    }));
  }

  function attachRerankDecision(candidate, aiChoice, candidates, selectedIndex, selection) {
    const candidateChoices = selectedFirstCandidateChoices(candidate, candidates, selectedIndex);
    return {
      ...candidate,
      _rerankStatus: aiChoice?.status || "",
      _rerankConfidence: aiChoice?.confidence ?? null,
      _rerankReason: aiChoice?.reason || "",
      _rerankRiskFlags: aiChoice?.riskFlags || [],
      _candidateChoices: candidateChoices,
      _selectedCandidateIndex: candidateChoices.length ? 0 : -1,
      _autoEligible: selection.status === "auto_apply" && candidate._enrichmentNeedsReview !== true &&
        candidate._recordSource === selection.canonical._recordSource &&
        candidate._recordId === selection.canonical._recordId,
      _canonicalStatus: selection.status,
      _canonicalReason: selection.reason,
      _selectedVersionClass: selection.selectedVersionClass,
    };
  }

  function sameRecord(left, right) {
    return !!left && !!right && left._recordSource === right._recordSource && left._recordId === right._recordId;
  }

  function buildRerankedCandidate(selection, rankedBest, candidateChoices, aiChoice) {
    let selected = selection.status === "auto_apply" ? selection.canonical : rankedBest;
    if (selection.status !== "auto_apply" && candidateChoices.some(candidate => sameRecord(candidate, aiChoice?.candidate)))
      selected = candidateChoices.find(candidate => sameRecord(candidate, aiChoice.candidate));
    if (!selected) return null;
    if (selection.status === "auto_apply")
      selected = A.enrichNonCore(selected, selection.candidates, { linkKind: selection.linkKind });
    const selectedIndex = candidateChoices.indexOf(selected);
    return attachRerankDecision(
      selected,
      aiChoice,
      candidateChoices,
      selectedIndex >= 0 ? selectedIndex : candidateChoices.findIndex(candidate => sameRecord(candidate, selected)),
      selection
    );
  }

  function includeCanonicalChoice(choices, selection) {
    if (selection.status !== "auto_apply" || choices.some(choice => sameRecord(choice, selection.canonical)))
      return choices;
    return [selection.canonical, ...choices].slice(0, MAX_CANDIDATE_CHOICES);
  }

  async function lookupPaperWithRerank(title, lookupEntry, runSnapshot, allowLlm = true, originalSnapshot = lookupEntry) {
    const candidates = await searchCandidatePool(title, lookupEntry);
    const original = originalSnapshot;
    const preferPublished = runSnapshot.preferPublished;
    const selection = A.selectCanonical(A.createOriginal(original), candidates, { preferPublished });
    const candidateChoices = includeCanonicalChoice(B.topCandidates(selection.candidates, original, {
      preferPublished,
      limit: MAX_CANDIDATE_CHOICES,
    }), selection);
    const ranked = B.rerankCandidates(candidateChoices, original, { preferPublished });
    if (!ranked.best && selection.status !== "auto_apply") return null;

    const heuristic = buildRerankedCandidate(selection, ranked.best, candidateChoices, null);
    const provider = getRerankProvider();
    const shouldUseLlm = B.shouldCallLlmRerank(ranked, candidateChoices, original, {
      preferPublished,
      speedMode: getSpeedMode(),
    });

    if (allowLlm && candidateChoices.length > 1 && provider !== "off" && shouldUseLlm) {
      heuristic._rerankPending = true;
      heuristic._pendingRerank = (async () => {
        try {
          const reranker = provider === "vllm" ? window.BibVllmReranker : window.BibGemmaReranker;
          if (!reranker) throw new Error(provider + " reranker is unavailable.");
          const aiChoice = await reranker.rerank({
            original,
            candidates: candidateChoices,
            parseChoice: B.parseRerankChoice,
            preferPublished,
            language: getEvidenceLanguage(),
            onStatus: setGemmaRerankStatus,
          });
          return buildRerankedCandidate(selection, ranked.best, candidateChoices, aiChoice);
        } catch (err) {
          console.warn(provider + " rerank failed; using heuristic candidate:", err.message);
          setGemmaRerankStatus((provider === "vllm" ? "vLLM" : "Gemma") + " unavailable · using heuristic rerank");
          return null;
        }
      })();
    }

    return heuristic;
  }

  async function lookupPaper(title, lookupEntry, runSnapshot, originalSnapshot) {
    return lookupPaperWithRerank(
      title,
      lookupEntry,
      runSnapshot,
      getRerankProvider() !== "off",
      originalSnapshot
    );
  }

  // ─── Theme ─────────────────────────────────────────────────────────
  const root = document.documentElement;
  const themeToggle = document.getElementById("theme-toggle");

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    localStorage.setItem("bv-theme", theme);
  }

  const savedTheme = localStorage.getItem("bv-theme") ||
    (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(savedTheme);

  themeToggle.addEventListener("click", () => {
    applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });

  // ─── UI State ──────────────────────────────────────────────────────
  let parsedEntries = [];
  let results = [];
  let currentInputValid = false;
  let currentRunSnapshot = null;
  let decisions = {};
  let fieldEdits = {};
  let activeFilter = "all";
  let activeSearch = "";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let onboardingOverlayEl = null;

  function closeOnboarding() {
    if (onboardingOverlayEl?._currentStepOnLeave) {
      onboardingOverlayEl._currentStepOnLeave();
      onboardingOverlayEl._currentStepOnLeave = null;
    }
    if (onboardingOverlayEl) {
      const fn = onboardingOverlayEl._kbdEsc;
      if (fn) document.removeEventListener("keydown", fn);
      const bd = onboardingOverlayEl._onboardingBackdrop;
      onboardingOverlayEl.remove();
      if (bd) bd.remove();
      onboardingOverlayEl = null;
    }
    document.body.removeAttribute("data-onboarding-stage");
    document.querySelectorAll(".onboarding-target").forEach(el => el.classList.remove("onboarding-target"));
    $("#floating-bar")?.classList.remove("onboarding-target-bar");
  }

  let onboardingResumeAfterCurrentRun = false;
  let pendingOnboardingResumeClick = false;

  const uploadZone = $(".upload-zone");
  const fileInput = $("#file-input");
  const resultsSection = $(".results-section");
  const entryList = $(".entry-list");
  const floatingBar = $("#floating-bar");
  const barProgress = $("#bar-progress");
  const barProgressFill = $(".bar-progress-fill");
  const barProgressText = $(".bar-progress-text");
  const btnDownload = $("#btn-download");
  btnDownload.disabled = true;
  const mainColumns = $("#main-columns");
  const colPreview = $("#col-preview");
  const previewPanelEl = $("#preview-panel");
  const btnPreviewToggle = $("#btn-preview-toggle");
  const previewShowHandle = $("#preview-show-handle");
  const previewCode = $("#preview-code");
  const previewPlaceholder = $(".preview-placeholder");

  function syncPreviewPanelCollapsed() {
    if (!previewPanelEl || !btnPreviewToggle) return;
    const collapsed = sessionStorage.getItem("bv-preview-collapsed") === "1";
    previewPanelEl.classList.toggle("is-collapsed", collapsed);
    mainColumns?.classList.toggle("preview-collapsed", collapsed);
    btnPreviewToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btnPreviewToggle.title = collapsed ? "Expand Live BibTeX preview" : "Collapse Live BibTeX preview";
    const lbl = btnPreviewToggle.querySelector(".btn-preview-toggle-text");
    if (lbl) lbl.textContent = collapsed ? "Show" : "Hide";
    if (previewShowHandle) {
      const hasResults = colPreview?.classList.contains("visible");
      previewShowHandle.classList.toggle("visible", collapsed && !!hasResults);
      previewShowHandle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  btnPreviewToggle?.addEventListener("click", () => {
    const willCollapse = !previewPanelEl.classList.contains("is-collapsed");
    sessionStorage.setItem("bv-preview-collapsed", willCollapse ? "1" : "0");
    syncPreviewPanelCollapsed();
  });
  previewShowHandle?.addEventListener("click", () => {
    sessionStorage.setItem("bv-preview-collapsed", "0");
    syncPreviewPanelCollapsed();
  });
  syncPreviewPanelCollapsed();

  // ─── Tab switching ─────────────────────────────────────────────────
  const inputTabs = $$(".input-tab");
  const tabPanels = $$(".tab-panel");

  inputTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      inputTabs.forEach(t => t.classList.remove("active"));
      tabPanels.forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      $(`#tab-${tab.dataset.tab}`).classList.add("active");
    });
  });

  // ─── Upload handling ──────────────────────────────────────────────
  uploadZone.addEventListener("click", () => fileInput.click());

  uploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadZone.classList.add("dragover");
  });

  uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("dragover"));

  uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadZone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  async function handleFile(file) {
    if (!file.name.endsWith(".bib")) { alert("Please upload a .bib file."); return; }
    const content = await file.text();
    startVerificationFromContent(content, "Reading file...");
  }

  // ─── Paste handling ───────────────────────────────────────────────
  const bibPaste = $("#bib-paste");
  const btnVerifyPaste = $("#btn-verify-paste");

  btnVerifyPaste.addEventListener("click", () => {
    const content = bibPaste.value;
    if (!content.trim()) { alert("Please paste your BibTeX content first."); return; }
    startVerificationFromContent(content, "Parsing pasted content...");
  });

  function startVerificationFromContent(content, statusMsg) {
    currentInputValid = false;
    currentRunSnapshot = Object.freeze({
      preferPublished: optPreferPublished?.checked !== false,
    });
    onboardingResumeAfterCurrentRun =
      pendingOnboardingResumeClick ||
      document.body.dataset.onboardingStage === "verify" ||
      document.body.dataset.onboardingStage === "verify-final";
    pendingOnboardingResumeClick = false;
    delete document.body.dataset.onboardingStage;

    closeOnboarding();
    results = [];
    currentPreviewBib = "";
    currentPreviewState = null;
    decisions = {};
    fieldEdits = {};
    activeFilter = "all";
    activeSearch = "";
    const searchInputEl = document.getElementById("entry-search-input");
    if (searchInputEl) searchInputEl.value = "";
    document.querySelector(".entry-search")?.classList.remove("has-query");
    entryList.innerHTML = "";
    document.getElementById("entry-empty")?.classList.remove("visible");
    rateState.ssDelay = 500;
    rateState.crDelay = 100;
    rateState.ssConsecutiveOk = 0;
    rateState.crConsecutiveOk = 0;
    $$(".info-section").forEach(s => s.style.display = "none");
    resultsSection.style.display = "none";

    barProgress.classList.add("active");
    barProgress.classList.remove("fade-out");
    barProgressFill.style.width = "0%";
    barProgressFill.classList.remove("done");
    barProgressText.textContent = statusMsg;
    btnDownload.classList.add("hidden");
    btnDownload.classList.remove("fade-in");
    btnDownload.disabled = true;
    floatingBar.classList.add("visible");

    mainColumns.classList.add("two-col");
    colPreview.classList.add("visible");
    previewPlaceholder.style.display = "flex";
    previewCode.style.display = "none";
    previewCode.textContent = "";
    syncPreviewPanelCollapsed();

    const parsedDocument = B.parseBibDocument(content);
    if (parsedDocument.diagnostic) {
      const { offset, reason } = parsedDocument.diagnostic;
      parsedEntries = [];
      alert(`BibTeX parse error at offset ${offset}: ${reason}. Nothing was verified or exported.`);
      floatingBar.classList.remove("visible");
      onboardingResumeAfterCurrentRun = false;
      return;
    }
    parsedEntries = parsedDocument.entries;

    if (!parsedEntries.length) {
      alert("No BibTeX entries found. Make sure the content contains valid @type{key, ...} entries.");
      floatingBar.classList.remove("visible");
      onboardingResumeAfterCurrentRun = false;
      return;
    }

    currentRunSnapshot = Object.freeze({
      ...currentRunSnapshot,
      originals: Object.freeze(parsedEntries.map(entry => Object.freeze({ ...entry }))),
    });

    currentInputValid = true;
    resultsSection.style.display = "block";
    barProgressText.textContent = `Verifying 0 / ${parsedEntries.length} entries...`;
    runVerification();
  }

  async function verifyEntryAt(index) {
    const entry = parsedEntries[index];
    const title = entry.title || "";
    const cleanTitle = B.stripLatex(title);
    const lookupEntry = B.normalizeEntryForLookup(entry);
    let found = null;
    let lookupError = null;
    const isTourFakeEntry = /QZX999/i.test(cleanTitle);
    if (isTourFakeEntry) {
      await sleep(500);
    } else {
      try {
        found = await lookupPaper(
          cleanTitle,
          lookupEntry,
          currentRunSnapshot,
          currentRunSnapshot.originals[index]
        );
      }
      catch (err) {
        lookupError = err;
        console.warn("Lookup failed:", err);
      }
    }

    if (lookupError) {
      const r = buildResult(entry, index, "needs_review", 0, [], {}, null);
      r.lookup_error = lookupError.message || String(lookupError);
      return r;
    }
    if (!found) return buildResult(entry, index, "not_found", 0, [], {}, null);

    const cmp = B.compareEntry(entry, found);
    let finalStatus = B.shouldKeepDeterministicStatus(entry, found, cmp)
      ? cmp.status
      : B.resolveRerankStatus(cmp.status, found._rerankStatus);
    if (found._canonicalStatus === "needs_review")
      finalStatus = "needs_review";
    let fieldDiffs = cmp.field_diffs;
    if (finalStatus === "needs_review" && found && !fieldDiffs.length)
      fieldDiffs = B.fieldDiffsForNeedsReview(entry, found);
    if (finalStatus === "needs_review" && B.fieldDiffsAreEquivalent(fieldDiffs)) {
      finalStatus = "verified";
      fieldDiffs = [];
    }
    return buildResult(entry, index, finalStatus, cmp.title_score, fieldDiffs, cmp.suggested, found);
  }

  async function runVerification() {
    const total = parsedEntries.length;
    const seenDuplicateKeys = new Map();
    let completed = 0;
    results = new Array(total);

    parsedEntries.forEach((entry, i) => {
      const entryId = entry.ID || `entry_${i}`;
      const duplicateOf = B.findDuplicateEntryId(entry, seenDuplicateKeys);
      if (duplicateOf) entry._duplicateOf = duplicateOf;
      B.registerDuplicateKeys(entryId, entry, seenDuplicateKeys);
    });

    await B.runBoundedQueue(parsedEntries, async (entry, i) => {
      const title = entry.title || "";
      if (!title.trim()) return buildResult(entry, i, "not_found", 0, [], {}, null);
      return verifyEntryAt(i);
    }, {
      concurrency: verificationConcurrency(),
      onResult: (r, i) => {
        completed++;
        results[i] = r;
        const pct = Math.round((completed / total) * 100);
        barProgressFill.style.width = pct + "%";
        barProgressText.textContent = `Verified ${completed} / ${total}: ${(r.title || "").slice(0, 50)}…`;
        renderEntryCard(r);
        updateSummary();
        updateAuthorPills();
        updatePreview();
        if (r.pending_rerank) {
          const pending = r.pending_rerank;
          pending.then(patchedFound => {
            if (!patchedFound || results[i]?.pending_rerank !== pending) return;
            const currentDecision = decisions[i];
            if (currentDecision?.touched || Object.values(fieldEdits[i] || {}).some(edit => edit?.touched))
              return;
            const stillDefaultCandidate = !currentDecision ||
              (currentDecision.action === "candidate" &&
                currentDecision.source === r.candidate_choices?.[r.selected_candidate_index]?._recordSource &&
                currentDecision.candidateId === r.candidate_choices?.[r.selected_candidate_index]?._recordId);
            if (!stillDefaultCandidate) return;

            const entry = parsedEntries[i];
            const cmp = B.compareEntry(entry, patchedFound);
            let finalStatus = B.shouldKeepDeterministicStatus(entry, patchedFound, cmp)
              ? cmp.status
              : B.resolveRerankStatus(cmp.status, patchedFound._rerankStatus);
            if (patchedFound._canonicalStatus === "needs_review")
              finalStatus = "needs_review";
            let fieldDiffs = cmp.field_diffs;
            if (finalStatus === "needs_review" && !fieldDiffs.length)
              fieldDiffs = B.fieldDiffsForNeedsReview(entry, patchedFound);
            if (finalStatus === "needs_review" && B.fieldDiffsAreEquivalent(fieldDiffs)) {
              finalStatus = "verified";
              fieldDiffs = [];
            }
            const patched = buildResult(entry, i, finalStatus, cmp.title_score, fieldDiffs, cmp.suggested, patchedFound);
            patched.pending_rerank = null;
            results[i] = patched;
            renderEntryCard(patched);
            updateSummary();
            updateAuthorPills();
            updatePreview();
          });
        }
      },
    });

    if (!currentInputValid) return;
    barProgressFill.classList.add("done");
    barProgressText.textContent = `Done — ${total} entries verified`;
    const resumeOnboardingAfterResults = onboardingResumeAfterCurrentRun;
    onboardingResumeAfterCurrentRun = false;
    setTimeout(() => {
      if (!currentInputValid) return;
      barProgress.classList.add("fade-out");
      setTimeout(() => {
        if (!currentInputValid) return;
        barProgress.classList.remove("active", "fade-out");
        btnDownload.disabled = false;
        btnDownload.classList.remove("hidden");
        btnDownload.classList.add("fade-in");
        if (resumeOnboardingAfterResults)
          setTimeout(() => openOnboardingPostVerifyTour(), 450);
      }, 350);
    }, 800);
  }

  function buildResult(entry, index, status, titleScore, fieldDiffs, suggested, found) {
    const candidateChoices = found ? (found._candidateChoices || []) : [];
    const defaultCandidateIndex = candidateChoices.length && found?._autoEligible === true ? 0 : -1;
    if (defaultCandidateIndex >= 0) {
      const candidate = candidateChoices[defaultCandidateIndex];
      decisions[index] = {
        action: "candidate",
        candidateIndex: defaultCandidateIndex,
        source: candidate._recordSource,
        candidateId: candidate._recordId,
        touched: false,
      };
    } else {
      decisions[index] = { action: "original", source: "original", touched: false };
    }

    return {
      index,
      entry_id: entry.ID || "",
      entry_type: entry.ENTRYTYPE || "",
      title: entry.title || "",
      status,
      title_score: titleScore,
      field_diffs: fieldDiffs,
      suggested,
      found_title: found ? (found.title || "") : "",
      ai_status: found ? (found._rerankStatus || "") : "",
      ai_reason: found ? (found._rerankReason || "") : "",
      ai_risk_flags: found ? (found._rerankRiskFlags || []) : [],
      candidate_choices: candidateChoices,
      selected_candidate_index: defaultCandidateIndex,
      selected_choice: defaultCandidateIndex >= 0 ? "candidate" : "original",
      paper_url: found ? B.paperUrlForEntry(found) : B.paperUrlForEntry(entry),
      pending_rerank: found ? (found._pendingRerank || null) : null,
      duplicate_of: entry._duplicateOf || null,
      lookup_error: null,
      canonical_reason: found ? (found._canonicalReason || "") : "",
      run_snapshot: currentRunSnapshot,
    };
  }

  // ─── Rendering ────────────────────────────────────────────────────
  function statusLabel(s) {
    return { verified: "Verified", updated: "Auto-Updated", needs_review: "Needs Review", not_found: "Not Found" }[s] || s;
  }

  function selectedChoiceKind(r) {
    if (r.selected_choice === "exclude") return "exclude";
    if (r.selected_choice === "original") return "original";
    if (r.selected_choice === "candidate") return `candidate:${r.selected_candidate_index}`;
    return `candidate:${r.selected_candidate_index}`;
  }

  function selectedCandidateForResult(r) {
    if (!r || r.selected_choice !== "candidate") return null;
    return r.candidate_choices?.[r.selected_candidate_index] || null;
  }

  function suggestedCandidateForResult(r) {
    return selectedCandidateForResult(r) || r?.candidate_choices?.[0] || null;
  }

  function setUserFieldEdit(index, field, action, value, extra = {}) {
    if (!fieldEdits[index]) fieldEdits[index] = {};
    const candidate = suggestedCandidateForResult(results[index]);
    let provenance = { actor: "user", source: "original" };
    if (action === "found" && candidate) provenance = A.userProvenance(candidate);
    if (action === "custom") provenance = A.manualProvenance();
    fieldEdits[index][field] = { action, value, touched: true, provenance, ...extra };
  }

  function isInternalBibField(field) {
    return field.startsWith("_") || field === "ENTRYTYPE" || field === "ID";
  }

  function isRedundantConferenceJournal(entry, candidate, field) {
    return field === "journal" &&
      (entry.ENTRYTYPE || "").toLowerCase() === "inproceedings" &&
      !!(entry.booktitle || candidate?.booktitle);
  }

  function candidateVenue(candidate) {
    return candidate.journal || candidate.booktitle || "";
  }

  function provenanceHTML(entry, candidate) {
    const provenance = B.candidateProvenance(entry || {}, candidate || {});
    const badges = provenance.badges.map(badge =>
      `<span class="provenance-badge provenance-${esc(badge.tone || "source")}">${esc(badge.label)}</span>`
    ).join("");
    const diagnostics = provenance.warnings.length
      ? provenance.warnings
      : provenance.diagnostics;
    const diagnosticHTML = diagnostics.length
      ? `<div class="candidate-provenance-notes">${diagnostics.map(note => `<span>${esc(note)}</span>`).join("")}</div>`
      : "";
    return `<div class="candidate-provenance">
      <span class="provenance-confidence provenance-${esc(provenance.confidence.toLowerCase())}">${esc(provenance.confidence)}</span>
      ${badges}
      ${diagnosticHTML}
    </div>`;
  }

  function candidateChoiceHTML(r) {
    const choices = r.candidate_choices || [];
    if (choices.length < 1) return "";

    const selected = selectedChoiceKind(r);
    const rows = choices.map((candidate, index) => {
      const key = `candidate:${index}`;
      const title = candidate.title || "(untitled candidate)";
      const venue = candidateVenue(candidate);
      const meta = [candidate.year, venue, candidate._coreSource, candidate._recordId].filter(Boolean).join(" · ");
      const doi = candidate.doi ? `<span class="candidate-doi">${esc(candidate.doi)}</span>` : "";
      const openUrl = candidate._paperUrl || B.paperUrlForEntry(candidate);
      const openLink = openUrl
        ? `<a class="candidate-open-link" href="${esc(openUrl)}" target="_blank" rel="noopener" title="Open paper page">Open paper</a>`
        : "";
      const score = Math.round(B.candidateScore(candidate, parsedEntries[r.index] || {}, {
        preferPublished: r.run_snapshot?.preferPublished === true,
      }));
      const provenance = provenanceHTML(parsedEntries[r.index] || {}, candidate);
      return `<div class="candidate-option ${selected === key ? "active" : ""}">
        <button class="candidate-option-btn" type="button" data-entry="${r.index}" data-choice-action="candidate" data-candidate-index="${index}">
          <span class="candidate-rank">${index + 1}</span>
          <span class="candidate-main">
            <span class="candidate-title">${esc(title)}</span>
            <span class="candidate-meta">${esc(meta)}${doi}</span>
            ${provenance}
          </span>
          <span class="candidate-score">${Number.isFinite(score) ? esc(String(score)) : ""}</span>
        </button>
        ${openLink}
      </div>`;
    }).join("");

    const originalActive = selected === "original";
    const excludeActive = selected === "exclude";
    return `<div class="candidate-panel">
      <div class="candidate-panel-head">
        <span>Candidate choices</span>
        <span>${choices.length} shown · reranked locally</span>
      </div>
      <div class="candidate-options">${rows}</div>
      <div class="candidate-control-row">
        <button class="candidate-control-btn ${originalActive ? "active" : ""}" type="button" data-entry="${r.index}" data-choice-action="original">Keep original</button>
        <button class="candidate-control-btn danger ${excludeActive ? "active" : ""}" type="button" data-entry="${r.index}" data-choice-action="exclude">Exclude from export</button>
      </div>
    </div>`;
  }

  function cardMatchesFilter(card) {
    if (activeFilter === "all") return true;
    if (activeFilter === "duplicate") return card.dataset.duplicate === "true";
    return card.dataset.status === activeFilter;
  }

  function cardMatchesSearch(card) {
    if (!activeSearch) return true;
    const hay = card.dataset.searchHay || "";
    const tokens = activeSearch.split(/\s+/).filter(Boolean);
    return tokens.every(tok => {
      if (tok.startsWith("title:")) {
        const sub = tok.slice(6);
        return hay.includes(sub);
      }
      if (tok.startsWith("id:") || tok.startsWith("key:")) {
        const sub = tok.slice(tok.indexOf(":") + 1);
        return hay.split(" ", 1)[0].includes(sub);
      }
      return hay.includes(tok);
    });
  }

  function applyCardVisibility(card) {
    const visible = cardMatchesFilter(card) && cardMatchesSearch(card);
    card.classList.toggle("hidden", !visible);
  }

  function updateEntryEmptyState() {
    const empty = $("#entry-empty");
    if (!empty) return;
    const cards = $$(".entry-card");
    if (!cards.length) { empty.classList.remove("visible"); return; }
    const anyVisible = [...cards].some(c => !c.classList.contains("hidden"));
    empty.classList.toggle("visible", !anyVisible);
  }

  function applyAllCardVisibility() {
    $$(".entry-card").forEach(applyCardVisibility);
    updateEntryEmptyState();
  }

  function renderEntryCard(r) {
    const card = document.createElement("div");
    card.className = `entry-card status-${r.status}`;
    card.classList.toggle("is-excluded", r.selected_choice === "exclude");
    card.dataset.status = r.status;
    card.dataset.index = r.index;
    if (r.duplicate_of) card.dataset.duplicate = "true";

    const idx = r.index;
    if (!fieldEdits[idx]) fieldEdits[idx] = {};
    const entry = parsedEntries[idx];

    let diffHTML = "";
    const appliedCandidate = selectedCandidateForResult(r);
    const selectedCandidate = suggestedCandidateForResult(r);
    const fieldProvenanceLabel = field => {
      const provenance = selectedCandidate?._fieldProvenance?.[field];
      return provenance
        ? `<span class="field-provenance">${esc(provenance.source)} · ${esc(provenance.candidateId)}</span>`
        : "";
    };
    const visibleFieldDiffs = (r.field_diffs || [])
      .filter(d => !isRedundantConferenceJournal(entry, selectedCandidate, d.field));
    const hasDiffs = visibleFieldDiffs.length > 0;
    /* Show Suggested column whenever status implies adoptable API/enrichment diffs (includes
       verified+enrichments-only from compareEntry, not only updated/needs_review). */
    const hasSuggestion =
      r.status === "updated" ||
      r.status === "needs_review" ||
      (r.status === "verified" && hasDiffs);

    if (hasDiffs) {
      const rows = visibleFieldDiffs.map(d => {
        const isEnrichment = !(d.original || "").trim();
        // Enrichments (original empty) should default to "found" so the suggested
        // value is reflected in the preview without requiring a click. For real
        // diffs, "updated" status auto-adopts; verified/needs_review keeps original.
        const defaultAction = r.selected_choice === "candidate"
          ? "found"
          : r.selected_choice === "original"
            ? "original"
            : (isEnrichment || r.status === "updated") ? "found" : "original";

        if (!fieldEdits[idx][d.field]) {
          fieldEdits[idx][d.field] = {
            action: defaultAction,
            value: d.found || "",
            touched: false,
            provenance: defaultAction === "found" && selectedCandidate
              ? { actor: "system", source: selectedCandidate._recordSource, candidateId: selectedCandidate._recordId }
              : { actor: "system", source: "original" },
          };
        }
        const fe = fieldEdits[idx][d.field];
        const currentAction = fe.action;

        const suggestionText = currentAction === "custom" ? (fe.value || "") : (d.found || "");
        const origAttr = encodeURIComponent(d.original || "");
        const foundAttr = encodeURIComponent(d.found || "");

        // Apply author truncation for display (suggested only)
        const maxA = parseInt(optMaxAuthors.value) || 0;
        const displaySuggestion = (d.field === "author" && maxA > 0 && currentAction !== "custom") ? truncateAuthors(suggestionText, maxA) : suggestionText;
        const authorMatchHidden = (d.field === "author" && maxA > 0 && displaySuggestion.trim() === (d.original || "").trim());

        return `<tr class="diff-row${authorMatchHidden ? " author-match-hidden" : ""}" data-entry="${idx}" data-field="${esc(d.field)}" data-action="${currentAction}"
          data-enrichment="${isEnrichment ? "1" : ""}"
          data-found-val="${foundAttr}"
          data-original-val="${origAttr}">
          <td class="field-name"><span class="field-name-pill">${esc(d.field)}</span>${fieldProvenanceLabel(d.field)}</td>
          <td class="val-col val-col-original">
            ${!isEnrichment ? `<button class="choice-pill pill-original ${currentAction === "original" ? "active" : ""}"
                    data-entry="${idx}" data-field="${esc(d.field)}" data-action="original" data-val="${esc(d.original || "")}"
                    title="Keep your value">${esc(d.original)}</button>` : '<span class="empty-val">\u2014</span>'}
          </td>
          <td class="val-col val-col-suggested">
            ${hasSuggestion ? `<span class="choice-pill pill-suggested ${currentAction === "found" || currentAction === "custom" ? "active" : ""} ${currentAction === "remove" ? "removed" : ""}"
                    contenteditable="${currentAction === "remove" ? "false" : "true"}"
                    spellcheck="false"
                    data-entry="${idx}" data-field="${esc(d.field)}" data-action="found" data-val="${esc(d.found || "")}"
                    title="Use suggested value (click to select, edit to customize)">${esc(displaySuggestion)}</span>` : ""}
          </td>
          <td class="field-actions-mini">
            <button class="fa-btn-x ${currentAction === "remove" ? "active" : ""}" title="${isEnrichment ? "Don\u2019t add" : "Remove field"}"
                    data-entry="${idx}" data-field="${esc(d.field)}" data-action="remove" data-val="">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </td>
        </tr>`;
      }).join("");

      diffHTML = `<table class="diff-table">
        <tr><th>Field</th><th>Your Value</th><th>Suggested</th><th></th></tr>
        ${rows}
      </table>`;
    }

    const candidateFields = selectedCandidate
      ? Object.keys(selectedCandidate).filter(f => !isInternalBibField(f))
      : [];
    const EDITABLE_FIELDS = Array.from(new Set(["title", ...B.COMPARED_FIELDS, "url", "eprint", "archiveprefix", "archivePrefix", "primaryclass", "primaryClass", ...candidateFields]));
    const diffFieldsSet = new Set(visibleFieldDiffs.map(d => d.field));
    const extraFields = EDITABLE_FIELDS.filter(f => {
      if (diffFieldsSet.has(f)) return false;
      if (isRedundantConferenceJournal(entry, selectedCandidate, f)) return false;
      const originalValue = entry[f] || "";
      const candidateValue = selectedCandidate?.[f] || "";
      return !!(originalValue || candidateValue).trim();
    });

    if (extraFields.length) {
      const extraRows = extraFields.map(f => {
        const val = entry[f] || "";
        const candidateVal = selectedCandidate?.[f] || "";
        const useCandidateValue = r.selected_choice === "candidate" && !!candidateVal.trim();
        if (!fieldEdits[idx][f]) {
          fieldEdits[idx][f] = {
            action: useCandidateValue ? "found" : "original",
            value: useCandidateValue ? candidateVal : val,
            touched: false,
            provenance: useCandidateValue && selectedCandidate
              ? { actor: "system", source: selectedCandidate._recordSource, candidateId: selectedCandidate._recordId }
              : { actor: "system", source: "original" },
          };
        }
        const fe = fieldEdits[idx][f];
        const currentAction = fe.action;

        return `<tr class="diff-row field-row-plain" data-entry="${idx}" data-field="${esc(f)}" data-action="${currentAction}">
          <td class="field-name"><span class="field-name-pill">${esc(f)}</span>${fieldProvenanceLabel(f)}</td>
          <td class="val-col" colspan="2">
            <span class="choice-pill pill-value ${currentAction === "remove" ? "removed" : "active"}"
                  contenteditable="${currentAction === "remove" ? "false" : "true"}" spellcheck="false"
                  data-entry="${idx}" data-field="${esc(f)}">${esc(currentAction === "remove" ? "" : fe.value)}</span>
          </td>
          <td class="field-actions-mini">
            <button class="fa-btn-x ${currentAction === "remove" ? "active" : ""}" title="Remove field"
                    data-entry="${idx}" data-field="${esc(f)}" data-action="remove" data-val="">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </td>
        </tr>`;
      }).join("");

      const fieldsLabel = hasDiffs ? "Other fields" : "Fields";
      const collapsed = true;
      diffHTML += `<div class="fields-toggle-wrap${collapsed ? " collapsed" : ""}">
        <button class="fields-toggle-btn" type="button">
          <svg class="fields-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          ${fieldsLabel} (${extraFields.length})
        </button>
        <table class="diff-table fields-table">
          <tr><th>Field</th><th colspan="2">Value</th><th></th></tr>
          ${extraRows}
        </table>
      </div>`;
    }

    let duplicateHTML = "";
    if (r.duplicate_of)
      duplicateHTML = `<div class="duplicate-row">Duplicate of <strong>${esc(r.duplicate_of)}</strong></div>`;

    let reviewHintHTML = "";
    if (r.status === "needs_review" && r.lookup_error) {
      reviewHintHTML = `<div class="review-hint">${esc(tEvidence("lookupFailed"))}</div>`;
    } else if (r.status === "needs_review" && r.found_title) {
      const aiReason = r.ai_reason
        ? `${esc(tEvidence("localLlmReason"))}${esc(r.ai_reason)}`
        : "";
      reviewHintHTML = `<div class="review-hint">${esc(tEvidence("reviewPrefix"))}
        (<strong>${esc(String(r.title_score))}%</strong> ${esc(tEvidence("reviewMiddle"))}
        <strong class="review-hint-match">${esc(r.found_title)}</strong>).
        ${esc(tEvidence("reviewAction"))}${aiReason}</div>`;
    }

    let notFoundHintHTML = "";
    if (r.status === "not_found") {
      const hasTitle = (r.title || "").trim();
      notFoundHintHTML = `<div class="not-found-hint">${hasTitle
        ? esc(tEvidence("notFoundWithTitle"))
        : esc(tEvidence("notFoundNoTitle"))}</div>`;
    }

    const candidateHTML = candidateChoiceHTML(r);

    let actionsHTML = "";
    const hasEditable = Object.keys(fieldEdits[idx]).length > 0;
    if (hasEditable && hasSuggestion && hasDiffs) {
      const allFound = r.field_diffs.every(d => (fieldEdits[idx][d.field] || {}).action === "found");
      const allOriginal = r.field_diffs.every(d => (fieldEdits[idx][d.field] || {}).action === "original");
      actionsHTML = `<div class="entry-actions">
        <button class="seg-btn btn-accept-all ${allFound ? "active-accept" : ""}" data-entry="${idx}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Accept all
        </button>
        <button class="seg-btn btn-revert-all ${allOriginal ? "active-revert" : ""}" data-entry="${idx}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
          Keep original
        </button>
      </div>`;
    }

    const jumpBtn = `<button class="btn-jump-preview" type="button" data-entry-id="${esc(r.entry_id)}" title="Scroll to this entry in the live preview">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </button>`;

    const paperOpenLink = r.paper_url
      ? `<a class="paper-open-link" href="${esc(r.paper_url)}" target="_blank" rel="noopener" title="Open selected paper page">Open paper</a>`
      : "";
    const searchQuery = encodeURIComponent(B.stripLatex(r.title || ""));
    const searchLinks = (r.title || "").trim() ? `<div class="search-links">
      <a class="search-link" href="https://scholar.google.com/scholar?q=${searchQuery}" target="_blank" rel="noopener" title="Google Scholar">
        <img src="https://scholar.google.com/favicon.ico" width="14" height="14" alt="Scholar">
      </a>
      <a class="search-link" href="https://www.google.com/search?q=${searchQuery}" target="_blank" rel="noopener" title="Google">
        <img src="https://www.google.com/favicon.ico" width="14" height="14" alt="Google">
      </a>
      <a class="search-link" href="https://www.semanticscholar.org/search?q=${searchQuery}" target="_blank" rel="noopener" title="Semantic Scholar">
        <img src="https://www.semanticscholar.org/favicon.ico" width="14" height="14" alt="S2">
      </a>
      <a class="search-link search-link-crossref" href="https://search.crossref.org/?q=${searchQuery}&from_ui=yes" target="_blank" rel="noopener" title="CrossRef">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="search-link-svg">
          <rect width="24" height="24" rx="4" fill="#f89838"/>
          <path fill="#fff" fill-rule="evenodd" d="M7 8h10v2H7V8zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/>
        </svg>
      </a>
      <a class="search-link" href="https://dblp.org/search?q=${searchQuery}" target="_blank" rel="noopener" title="DBLP">
        <img src="https://dblp.org/img/dblp.icon.192x192.png" width="14" height="14" alt="DBLP">
      </a>
    </div>` : "";

    const coreProvenance = A.mixedCoreProvenance(appliedCandidate, fieldEdits[idx]);
    const mixedWarningHTML = coreProvenance.mixed
      ? '<div class="review-hint mixed-source-warning">Mixed-source core metadata · explicit user choices are preserved with provenance.</div>'
      : "";

    card.innerHTML = `<div class="entry-header">
      <div class="entry-header-text">
        <div class="entry-title">${esc(r.title || "(no title)")}</div>
        <div class="entry-meta">${esc(r.entry_id)} &middot; ${esc(r.entry_type)}</div>
      </div>
      <div class="entry-header-aside">
        ${jumpBtn}
        <div class="entry-tags">
          ${r.duplicate_of ? '<span class="status-tag tag-duplicate">Duplicate</span>' : ""}
          ${r.selected_choice === "exclude" ? '<span class="status-tag tag-excluded">Excluded</span>' : ""}
          ${r.selected_choice === "exclude" ? "" : `<span class="status-tag tag-${r.status}">${statusLabel(r.status)}</span>`}
        </div>
      </div>
    </div>${duplicateHTML}${reviewHintHTML}${notFoundHintHTML}${candidateHTML}${mixedWarningHTML}${r.selected_choice === "exclude" ? "" : diffHTML}${r.selected_choice === "exclude" ? "" : actionsHTML}${paperOpenLink}${searchLinks}`;

    // Cache normalized search haystack so search filtering stays cheap.
    card.dataset.searchHay = `${(r.entry_id || "").toLowerCase()} ${B.stripLatex(r.title || "").toLowerCase()}`;

    applyCardVisibility(card);
    const existing = entryList.querySelector(`.entry-card[data-index="${idx}"]`);
    if (existing) existing.replaceWith(card);
    else entryList.appendChild(card);
    updateEntryEmptyState();
  }

  function statusForCandidate(entry, candidate) {
    const cmp = B.compareEntry(entry, candidate);
    let status = B.shouldKeepDeterministicStatus(entry, candidate, cmp)
      ? cmp.status
      : B.resolveRerankStatus(cmp.status, candidate._rerankStatus);
    if (status !== "not_found" && B.hasCriticalMetadataConflict(entry, candidate))
      status = "needs_review";
    let fieldDiffs = status === "needs_review" && !cmp.field_diffs.length
      ? B.fieldDiffsForNeedsReview(entry, candidate)
      : cmp.field_diffs;
    if (status === "needs_review" && B.fieldDiffsAreEquivalent(fieldDiffs)) {
      status = "verified";
      fieldDiffs = [];
    }
    return { cmp, fieldDiffs, status };
  }

  function applyCandidateChoice(entryIndex, candidateIndex) {
    const r = results[entryIndex];
    const entry = parsedEntries[entryIndex];
    const candidate = r?.candidate_choices?.[candidateIndex];
    if (!r || !entry || !candidate) return;

    const next = statusForCandidate(entry, candidate);
    decisions[entryIndex] = {
      action: "candidate",
      candidateIndex,
      source: candidate._recordSource,
      candidateId: candidate._recordId,
      touched: true,
    };
    fieldEdits[entryIndex] = {};
    r.status = next.status;
    r.title_score = next.cmp.title_score;
    r.field_diffs = next.fieldDiffs;
    r.suggested = next.cmp.suggested;
    r.found_title = candidate.title || "";
    r.paper_url = B.paperUrlForEntry(candidate);
    r.selected_candidate_index = candidateIndex;
    r.selected_choice = "candidate";
    renderEntryCard(r);
    updateAuthorPills();
    updatePreview();
  }

  function applyOriginalChoice(entryIndex) {
    const r = results[entryIndex];
    if (!r) return;
    decisions[entryIndex] = { action: "original", source: "original", touched: true };
    fieldEdits[entryIndex] = {};
    r.selected_choice = "original";
    renderEntryCard(r);
    updateAuthorPills();
    updatePreview();
  }

  function applyExcludeChoice(entryIndex) {
    const r = results[entryIndex];
    if (!r) return;
    decisions[entryIndex] = { action: "exclude", source: "user", touched: true };
    fieldEdits[entryIndex] = {};
    r.selected_choice = "exclude";
    renderEntryCard(r);
    updateAuthorPills();
    updatePreview();
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".candidate-option-btn, .candidate-control-btn");
    if (!btn) return;
    const entryIndex = parseInt(btn.dataset.entry);
    const action = btn.dataset.choiceAction;
    if (action === "candidate") {
      applyCandidateChoice(entryIndex, parseInt(btn.dataset.candidateIndex));
    } else if (action === "original") {
      applyOriginalChoice(entryIndex);
    } else if (action === "exclude") {
      applyExcludeChoice(entryIndex);
    }
  });

  // ─── Fields table toggle ─────────────────────────────────────────
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".fields-toggle-btn");
    if (!btn) return;
    btn.closest(".fields-toggle-wrap").classList.toggle("collapsed");
  });

  // ─── Jump to preview ─────────────────────────────────────────────
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-jump-preview");
    if (!btn) return;
    const entryId = btn.dataset.entryId;
    const target = previewCode.querySelector(`.diff-line[data-entry-id="${entryId}"]`);
    if (!target) return;

    const previewBody = previewCode.closest(".preview-body");
    previewBody.scrollTo({
      top: target.offsetTop - previewBody.offsetTop - 40,
      behavior: "smooth",
    });

    const toHighlight = [];
    let node = target;
    while (node) {
      toHighlight.push(node);
      const next = node.nextElementSibling;
      if (!next || next.dataset.entryId) break;
      node = next;
    }

    previewCode.querySelectorAll(".highlight-flash").forEach(el =>
      el.classList.remove("highlight-flash"));
    void previewCode.offsetWidth;
    toHighlight.forEach(el => el.classList.add("highlight-flash"));
  });

  // ─── Autoscroll preview ──────────────────────────────────────────
  let autoScrollEnabled = true;
  const btnAutoScroll = $("#btn-autoscroll");

  btnAutoScroll.addEventListener("click", () => {
    autoScrollEnabled = !autoScrollEnabled;
    btnAutoScroll.classList.toggle("active", autoScrollEnabled);
  });

  function getVisibleEntryCard() {
    const cards = $$(".entry-card:not(.hidden)");
    const viewMid = window.innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const cardMid = rect.top + rect.height / 2;
      const dist = Math.abs(cardMid - viewMid);
      if (dist < bestDist) {
        bestDist = dist;
        best = card;
      }
    }
    return best;
  }

  let scrollTicking = false;
  window.addEventListener("scroll", () => {
    if (!autoScrollEnabled || !scrollTicking) {
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        if (!autoScrollEnabled) return;
        const card = getVisibleEntryCard();
        if (!card) return;
        const entryId = card.querySelector(".btn-jump-preview")?.dataset?.entryId;
        if (!entryId) return;
        const target = previewCode.querySelector(`.diff-line[data-entry-id="${entryId}"]`);
        if (!target) return;

        const previewBody = previewCode.closest(".preview-body");
        const bodyHeight = previewBody.clientHeight;
        previewBody.scrollTo({
          top: target.offsetTop - previewBody.offsetTop - bodyHeight / 2 + 20,
          behavior: "smooth",
        });
      });
    }
  });

  // ─── Helpers for row visual state ────────────────────────────────
  function flashRow(row) {
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  }

  function syncRowState(row, action) {
    row.dataset.action = action;
    flashRow(row);
  }

  function syncBulkBtns(card, idx) {
    const diffRows = card.querySelectorAll(".diff-row:not(.field-row-plain)");
    if (!diffRows.length) return;
    const allFound = [...diffRows].every(r => r.dataset.action === "found");
    const allOriginal = [...diffRows].every(r => r.dataset.action === "original");
    const acceptBtn = card.querySelector(".btn-accept-all");
    const revertBtn = card.querySelector(".btn-revert-all");
    if (acceptBtn) acceptBtn.classList.toggle("active-accept", allFound);
    if (revertBtn) revertBtn.classList.toggle("active-revert", allOriginal);
  }

  // ─── Per-field action handlers ────────────────────────────────────
  document.addEventListener("click", (e) => {
    // Handle pill-original click (select original value)
    const origPill = e.target.closest(".pill-original");
    if (origPill) {
      const idx = parseInt(origPill.dataset.entry);
      const field = origPill.dataset.field;
      const val = origPill.dataset.val;
      const row = origPill.closest(".diff-row");

      setUserFieldEdit(idx, field, "original", val);

      row.querySelectorAll(".pill-original").forEach(p => p.classList.add("active"));
      row.querySelectorAll(".pill-suggested").forEach(p => p.classList.remove("active"));
      row.querySelectorAll(".fa-btn-x").forEach(b => b.classList.remove("active"));

      const sugPill = row.querySelector(".pill-suggested");
      if (sugPill) {
        sugPill.contentEditable = "false";
        sugPill.classList.remove("removed");
      }

      syncRowState(row, "original");
      syncBulkBtns(row.closest(".entry-card"), idx);
      updatePreview();
      return;
    }

    // Handle pill-suggested click (select suggested value) — only respond to click, not during editing
    const sugPill = e.target.closest(".pill-suggested");
    if (sugPill && !sugPill.classList.contains("active")) {
      const idx = parseInt(sugPill.dataset.entry);
      const field = sugPill.dataset.field;
      const val = sugPill.dataset.val;
      const row = sugPill.closest(".diff-row");

      setUserFieldEdit(idx, field, "found", val);

      row.querySelectorAll(".pill-original").forEach(p => p.classList.remove("active"));
      sugPill.classList.add("active");
      sugPill.classList.remove("removed");
      sugPill.contentEditable = "true";
      row.querySelectorAll(".fa-btn-x").forEach(b => b.classList.remove("active"));

      syncRowState(row, "found");
      syncBulkBtns(row.closest(".entry-card"), idx);
      updatePreview();
      return;
    }

    // Handle × button click (toggle remove field)
    const xBtn = e.target.closest(".fa-btn-x");
    if (xBtn) {
      const idx = parseInt(xBtn.dataset.entry);
      const field = xBtn.dataset.field;
      const row = xBtn.closest(".diff-row");
      const isEnc = row.dataset.enrichment === "1";
      const foundVal = decodeURIComponent(row.getAttribute("data-found-val") || "");
      const origVal = decodeURIComponent(row.getAttribute("data-original-val") || "");

      if (!fieldEdits[idx]) fieldEdits[idx] = {};

      // If already removed, undo back to the default action
      if (row.dataset.action === "remove") {
        const r = results[idx];
        const defaultAction = (r && r.status === "updated") ? "found" : "original";
        const origVal = decodeURIComponent(row.getAttribute("data-original-val") || "");

        // Handle pill-value (plain field rows)
        const valPill = row.querySelector(".pill-value");
        if (valPill) {
          const restoreVal = origVal || fieldEdits[idx]?.[field]?._savedValue || "";
          setUserFieldEdit(idx, field, "original", restoreVal);
          valPill.textContent = restoreVal;
          valPill.classList.add("active");
          valPill.classList.remove("removed");
          valPill.contentEditable = "true";
          xBtn.classList.remove("active");
          syncRowState(row, "original");
        } else if (defaultAction === "found" || isEnc) {
          setUserFieldEdit(idx, field, "found", foundVal);
          const sug = row.querySelector(".pill-suggested");
          if (sug) {
            sug.classList.add("active");
            sug.classList.remove("removed");
            sug.contentEditable = "true";
            sug.textContent = foundVal;
          }
          row.querySelectorAll(".pill-original").forEach(p => p.classList.remove("active"));
          xBtn.classList.remove("active");
          syncRowState(row, "found");
        } else {
          setUserFieldEdit(idx, field, "original", origVal);
          row.querySelectorAll(".pill-original").forEach(p => p.classList.add("active"));
          const sug = row.querySelector(".pill-suggested");
          if (sug) {
            sug.classList.remove("active");
            sug.classList.remove("removed");
            sug.contentEditable = "false";
          }
          xBtn.classList.remove("active");
          syncRowState(row, "original");
        }
      } else {
        // Remove the field
        // Save current value for undo
        if (fieldEdits[idx][field]) {
          fieldEdits[idx][field]._savedValue = fieldEdits[idx][field].value;
        }
        setUserFieldEdit(idx, field, "remove", "", {
          _savedValue: fieldEdits[idx][field]?._savedValue || "",
        });
        row.querySelectorAll(".pill-original").forEach(p => p.classList.remove("active"));
        const sug = row.querySelector(".pill-suggested");
        if (sug) {
          sug.classList.remove("active");
          sug.classList.add("removed");
          sug.contentEditable = "false";
        }
        const valPill = row.querySelector(".pill-value");
        if (valPill) {
          valPill.classList.remove("active");
          valPill.classList.add("removed");
          valPill.contentEditable = "false";
        }
        xBtn.classList.add("active");
        syncRowState(row, "remove");
      }
      syncBulkBtns(row.closest(".entry-card"), idx);
      updatePreview();
      return;
    }

    // Handle old-style fa-btn (for "other fields" section)
    const btn = e.target.closest(".fa-btn");
    if (!btn) return;
    const idx = parseInt(btn.dataset.entry);
    const field = btn.dataset.field;
    const action = btn.dataset.action;
    const val = btn.dataset.val;

    const row = btn.closest(".diff-row");
    const isEnc = row.dataset.enrichment === "1";
    const foundVal = decodeURIComponent(row.getAttribute("data-found-val") || "");
    const origVal = decodeURIComponent(row.getAttribute("data-original-val") || "");

    if (action === "original")
      setUserFieldEdit(idx, field, "original", isEnc ? foundVal : val);
    else if (action === "found")
      setUserFieldEdit(idx, field, "found", val);
    else
      setUserFieldEdit(idx, field, "remove", "");

    row.querySelectorAll(".fa-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    const span = row.querySelector(".found-text");
    if (span) {
      if (action === "found") {
        span.textContent = foundVal;
        span.contentEditable = "true";
      } else if (action === "original") {
        span.textContent = foundVal;
        span.contentEditable = "false";
      } else {
        span.contentEditable = "false";
      }
      span.classList.toggle("removed", action === "remove");
    }

    syncRowState(row, action);
    syncBulkBtns(row.closest(".entry-card"), idx);
    updatePreview();
  });

  document.addEventListener("input", (e) => {
    const span = e.target.closest(".found-text[contenteditable], .pill-suggested[contenteditable], .pill-value[contenteditable]");
    if (!span) return;
    const idx = parseInt(span.dataset.entry);
    const field = span.dataset.field;
    setUserFieldEdit(idx, field, "custom", span.textContent.trim());

    const row = span.closest(".diff-row");
    row.querySelectorAll(".fa-btn").forEach(b => b.classList.remove("active"));
    // For pill UI: mark suggested as active, original as inactive
    row.querySelectorAll(".pill-original").forEach(p => p.classList.remove("active"));
    if (span.classList.contains("pill-suggested")) span.classList.add("active");
    syncRowState(row, "custom");
    syncBulkBtns(row.closest(".entry-card"), idx);
    updatePreview();
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-accept-all, .btn-revert-all");
    if (!btn) return;
    const idx = parseInt(btn.dataset.entry);
    const isAccept = btn.classList.contains("btn-accept-all");
    const card = btn.closest(".entry-card");

    card.querySelectorAll(".diff-row:not(.field-row-plain)").forEach(row => {
      const field = row.dataset.field;
      const target = isAccept ? "found" : "original";
      const isEnc = row.dataset.enrichment === "1";
      const foundVal = decodeURIComponent(row.getAttribute("data-found-val") || "");

      // New pill-based UI
      const origPill = row.querySelector(".pill-original");
      const sugPill = row.querySelector(".pill-suggested");

      if (origPill || sugPill) {
        if (isAccept) {
          // Accept suggested
          if (sugPill) {
            const val = sugPill.dataset.val;
            setUserFieldEdit(idx, field, "found", val);
            if (origPill) origPill.classList.remove("active");
            sugPill.classList.add("active");
            sugPill.classList.remove("removed");
            sugPill.contentEditable = "true";
            sugPill.textContent = foundVal;
          }
        } else {
          // Keep original
          if (origPill) {
            setUserFieldEdit(idx, field, "original", origPill.dataset.val);
            origPill.classList.add("active");
            if (sugPill) {
              sugPill.classList.remove("active");
              sugPill.classList.remove("removed");
              sugPill.contentEditable = "false";
            }
          } else if (isEnc && sugPill) {
            // Enrichment row: no original pill
            setUserFieldEdit(idx, field, "original", foundVal);
            sugPill.classList.remove("active");
            sugPill.classList.remove("removed");
            sugPill.contentEditable = "false";
            sugPill.textContent = foundVal;
          }
        }

        row.querySelectorAll(".fa-btn-x").forEach(b => b.classList.remove("active"));
        syncRowState(row, target);
      } else {
        // Fallback for old-style rows
        const targetBtn = row.querySelector(`.fa-btn[data-action="${target}"]`);

        if (targetBtn) {
          const val = targetBtn.dataset.val;
          setUserFieldEdit(idx, field, target, val);

          row.querySelectorAll(".fa-btn").forEach(b => b.classList.remove("active"));
          targetBtn.classList.add("active");

          const span = row.querySelector(".found-text");
          if (span) {
            span.textContent = foundVal;
            span.classList.remove("removed");
            span.contentEditable = target === "found" ? "true" : "false";
          }

          syncRowState(row, target);
        } else if (!isAccept && isEnc) {
          setUserFieldEdit(idx, field, "original", foundVal);

          row.querySelectorAll(".fa-btn").forEach(b => b.classList.remove("active"));

          const span = row.querySelector(".found-text");
          if (span) {
            span.textContent = foundVal;
            span.classList.remove("removed");
            span.contentEditable = "false";
          }

          syncRowState(row, "original");
        }
      }
    });
    syncBulkBtns(card, idx);
    updatePreview();
  });

  function updateSummary() {
    const c = { verified: 0, updated: 0, needs_review: 0, not_found: 0 };
    let dupes = 0;
    results.forEach(r => {
      c[r.status] = (c[r.status] || 0) + 1;
      if (r.duplicate_of) dupes++;
    });
    $(".badge-verified .summary-count").textContent = c.verified;
    $(".badge-updated .summary-count").textContent = c.updated;
    $(".badge-review .summary-count").textContent = c.needs_review;
    $(".badge-notfound .summary-count").textContent = c.not_found;
    $(".badge-duplicates .summary-count").textContent = dupes;
    $$(".summary-badge").forEach(b => b.classList.add("active"));
  }

  // ─── Author truncation ────────────────────────────────────────────
  function truncateAuthors(authorStr, max) {
    if (!authorStr || max <= 0) return authorStr;
    // BibTeX authors are separated by " and "
    const authors = authorStr.split(/\s+and\s+/i);
    if (authors.length <= max) return authorStr;
    return authors.slice(0, max).join(" and ") + " and others";
  }

  function updateAuthorPills() {
    const max = parseInt(optMaxAuthors.value) || 0;

    // Update existing API author diff rows
    $$('.diff-row[data-field="author"]:not([data-injected])').forEach(row => {
      const foundVal = decodeURIComponent(row.getAttribute("data-found-val") || "");
      const origVal = decodeURIComponent(row.getAttribute("data-original-val") || "");
      const sugPill = row.querySelector(".pill-suggested");
      if (sugPill && row.dataset.action !== "custom") {
        const truncated = max > 0 ? truncateAuthors(foundVal, max) : foundVal;
        sugPill.textContent = truncated;
        if (truncated.trim() === origVal.trim()) {
          row.classList.add("author-match-hidden");
        } else {
          row.classList.remove("author-match-hidden");
        }
      }
    });

    // Remove any previously injected rows
    $$('.diff-row[data-injected]').forEach(row => {
      const card = row.closest(".entry-card");
      const idx = parseInt(row.dataset.entry);
      row.remove();
      // Clean up empty diff tables
      if (card) {
        const diffTable = card.querySelector(".diff-table:not(.fields-table)");
        if (diffTable && diffTable.querySelectorAll(".diff-row").length === 0) {
          diffTable.remove();
        }
        // Unhide plain author row
        const plainRow = card.querySelector('.field-row-plain[data-field="author"]');
        if (plainRow) plainRow.classList.remove("author-match-hidden");
      }
      // Clean up fieldEdits injected entry
      if (fieldEdits[idx]?.author?._injected) {
        delete fieldEdits[idx].author;
      }
    });

    // For entries WITHOUT an existing author diff row, inject if truncation differs
    if (max > 0) {
      $$(".entry-card").forEach(card => {
        const idx = parseInt(card.dataset.index);
        const entry = parsedEntries[idx];
        const res = results[idx];
        if (!entry || !entry.author) return;
        /* No lookup match — don't inject truncation as if it were an API suggestion row */
        if (res && res.status === "not_found") return;

        const existingRow = card.querySelector('.diff-row[data-field="author"]:not(.field-row-plain)');
        if (existingRow) return; // Already has an API diff row

        const authorCount = entry.author.split(/\s+and\s+/i).length;
        if (authorCount <= max) return;

        const truncated = truncateAuthors(entry.author, max);
        if (truncated.trim() === entry.author.trim()) return;

        // Set fieldEdits for this entry
        if (!fieldEdits[idx]) fieldEdits[idx] = {};
        fieldEdits[idx].author = { action: "found", value: truncated, _injected: true };

        // Find or create the diff table
        let diffTable = card.querySelector(".diff-table:not(.fields-table)");
        if (!diffTable) {
          const tableHTML = `<table class="diff-table"><tr><th>Field</th><th>Your Value</th><th>Suggested</th><th></th></tr></table>`;
          const insertAfter = card.querySelector(".review-hint") || card.querySelector(".not-found-hint") || card.querySelector(".entry-header");
          insertAfter.insertAdjacentHTML("afterend", tableHTML);
          diffTable = card.querySelector(".diff-table:not(.fields-table)");
        }

        const origAttr = encodeURIComponent(entry.author);
        const foundAttr = encodeURIComponent(truncated);
        const rowHTML = `<tr class="diff-row" data-entry="${idx}" data-field="author" data-action="found"
          data-enrichment="" data-injected="1"
          data-found-val="${foundAttr}"
          data-original-val="${origAttr}">
          <td class="field-name"><span class="field-name-pill">author</span></td>
          <td class="val-col val-col-original">
            <button class="choice-pill pill-original"
                    data-entry="${idx}" data-field="author" data-action="original" data-val="${esc(entry.author)}"
                    title="Keep your value">${esc(entry.author)}</button>
          </td>
          <td class="val-col val-col-suggested">
            <span class="choice-pill pill-suggested active"
                    contenteditable="true" spellcheck="false"
                    data-entry="${idx}" data-field="author" data-action="found" data-val="${esc(truncated)}"
                    title="Use suggested value (click to select, edit to customize)">${esc(truncated)}</span>
          </td>
          <td class="field-actions-mini">
            <button class="fa-btn-x" title="Remove field"
                    data-entry="${idx}" data-field="author" data-action="remove" data-val="">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </td>
        </tr>`;
        const headerRow = diffTable.querySelector("tr");
        headerRow.insertAdjacentHTML("afterend", rowHTML);

        // Also hide the author from "Other fields" if it exists there
        const plainAuthorRow = card.querySelector('.field-row-plain[data-field="author"]');
        if (plainAuthorRow) plainAuthorRow.classList.add("author-match-hidden");
      });
    } else {
      // max is 0 (All) — unhide any hidden plain author rows
      $$('.field-row-plain[data-field="author"].author-match-hidden').forEach(row => {
        row.classList.remove("author-match-hidden");
      });
    }

    // Update card statuses
    updateCardStatuses();
  }

  function updateCardStatuses() {
    $$(".entry-card").forEach(card => {
      const idx = parseInt(card.dataset.index);
      const r = results[idx];
      if (!r) return;
      const origStatus = r.status;
      if (card.classList.contains("is-excluded")) return;

      // Store original status on the card if not already saved
      if (!card.dataset.origStatus) card.dataset.origStatus = origStatus;
      const savedStatus = card.dataset.origStatus;

      // Check all non-plain diff rows (including injected ones)
      const diffRows = card.querySelectorAll(".diff-row:not(.field-row-plain)");
      const hasVisibleDiffs = diffRows.length > 0 && ![...diffRows].every(row => row.classList.contains("author-match-hidden"));
      const hasInjectedRows = card.querySelector('.diff-row[data-injected]') !== null;

      const effectiveStatus = B.displayStatusForCard(savedStatus, { hasVisibleDiffs, hasInjectedRows });

      // Update card visuals
      card.dataset.status = effectiveStatus;
      card.className = card.className.replace(/status-\S+/, `status-${effectiveStatus}`);
      const tag = card.querySelector(".status-tag:not(.tag-duplicate):not(.tag-excluded)");
      if (tag) {
        tag.className = `status-tag tag-${effectiveStatus}`;
        tag.textContent = statusLabel(effectiveStatus);
      }

      // Hide/show the diff table and actions
      const diffTable = card.querySelector(".diff-table:not(.fields-table)");
      if (diffTable) diffTable.style.display = !hasVisibleDiffs && !hasInjectedRows ? "none" : "";
      const actions = card.querySelector(".entry-actions");
      if (actions) actions.style.display = !hasVisibleDiffs ? "none" : "";
    });

    // Recount summary
    updateDynamicSummary();
  }

  function updateDynamicSummary() {
    const c = { verified: 0, updated: 0, needs_review: 0, not_found: 0 };
    let dupes = 0;
    $$(".entry-card").forEach(card => {
      const status = card.dataset.status;
      c[status] = (c[status] || 0) + 1;
      if (card.dataset.duplicate === "true") dupes++;
    });
    $(".badge-verified .summary-count").textContent = c.verified;
    $(".badge-updated .summary-count").textContent = c.updated;
    $(".badge-review .summary-count").textContent = c.needs_review;
    $(".badge-notfound .summary-count").textContent = c.not_found;
    $(".badge-duplicates .summary-count").textContent = dupes;
  }

  // ─── Live preview ────────────────────────────────────────────────
  function resolveDecisionCandidate(result, decision) {
    if (decision.action !== "candidate") return null;
    const stableMatch = result.candidate_choices?.find(candidate =>
      candidate._recordSource === decision.source && candidate._recordId === decision.candidateId
    );
    if (decision.source || decision.candidateId) return stableMatch || null;
    return result.candidate_choices?.[decision.candidateIndex] || null;
  }

  function buildPreviewState() {
    const s = getSettings();
    const count = results.length;
    let projected = parsedEntries.slice(0, count).map((entry, i) => {
      const r = results[i];
      const originalProvenance = Object.fromEntries(A.CORE_FIELDS.map(field => [field, {
        actor: "system", source: "original", candidateId: entry.ID || `entry_${i}`,
      }]));
      if (!r) return { entry: { ...entry }, provenance: originalProvenance, mixed: false };
      const decision = decisions[i] || {};
      if (decision.action === "exclude") return null;
      if (s.removeNotFound && r.status === "not_found") return null;

      const selectedCandidate = resolveDecisionCandidate(r, decision);
      const out = selectedCandidate
        ? B.applyCandidateToEntry(entry, selectedCandidate)
        : { ...entry };
      const provenance = { ...originalProvenance };
      if (selectedCandidate) {
        for (const field of A.CORE_FIELDS) {
          if (selectedCandidate[field]) provenance[field] = {
            actor: decision.touched ? "user" : "system",
            source: selectedCandidate._recordSource,
            candidateId: selectedCandidate._recordId,
          };
        }
      }
      const edits = fieldEdits[i] || {};
      for (const [field, fe] of Object.entries(edits)) {
        if (!fe) continue;
        if (fe.action === "found" || fe.action === "custom") {
          if (fe.value) {
            out[field] = fe.value;
            if (A.CORE_FIELDS.includes(field)) provenance[field] = fe.provenance ||
              (fe.action === "custom" ? A.manualProvenance() : A.userProvenance(selectedCandidate));
          }
        } else if (fe.action === "original") {
          if ((entry[field] || "").trim()) out[field] = entry[field];
          else delete out[field];
          if (A.CORE_FIELDS.includes(field)) provenance[field] = fe.provenance || { actor: "user", source: "original" };
        } else if (fe.action === "remove") {
          delete out[field];
          if (A.CORE_FIELDS.includes(field)) provenance[field] = fe.provenance || { actor: "user", source: "manual" };
        }
      }

      if (s.maxAuthors > 0 && out.author && r.status !== "not_found") {
        const limitedAuthor = truncateAuthors(out.author, s.maxAuthors);
        if (limitedAuthor !== out.author) {
          out.author = limitedAuthor;
          provenance.author = { actor: "user", source: "setting:max_authors" };
        }
      }
      if ((out.ENTRYTYPE || "").toLowerCase() === "inproceedings" && out.booktitle)
        delete out.journal;
      const sources = new Set(Object.values(provenance).map(value => `${value.source}\u001f${value.candidateId || ""}`));
      const state = { entry: out, provenance, mixed: sources.size > 1 };
      r.preview_provenance = provenance;
      r.mixed_core_warning = state.mixed;
      return state;
    }).filter(Boolean);

    if (s.removeDuplicates) {
      const seen = new Set();
      projected = projected.filter(item => {
        const entry = item.entry;
        let key;
        if (s.dedupBy === "doi") key = (entry.doi || "").toLowerCase().trim();
        else if (s.dedupBy === "id") key = (entry.ID || "").toLowerCase().trim();
        else key = B.normalizeTitle(entry.title || "");
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const entries = projected.map(item => item.entry);
    return Object.freeze({
      entries,
      bib: B.entriesToBib(entries, { latexEscape: s.latexEscape }),
      provenanceByEntry: projected.map(item => item.provenance),
      mixedWarnings: projected.map(item => item.mixed),
    });
  }

  function buildPreviewBib() {
    return buildPreviewState().bib;
  }

  let currentPreviewBib = "";
  let currentPreviewState = null;

  function diffLines(oldLines, newLines) {
    const m = oldLines.length, n = newLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);

    const result = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        result.push({ type: "ctx", text: newLines[j - 1] });
        i--; j--;
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

  function buildOriginalBib() {
    return B.entriesToBib(parsedEntries.slice(0, results.length));
  }

  function renderDiff(oldBib, newBib) {
    const oldLines = oldBib.split("\n");
    const newLines = newBib.split("\n");
    const ops = diffLines(oldLines, newLines);
    const hasChanges = ops.some(o => o.type !== "ctx");

    if (!hasChanges) {
      return ops.map(o => {
        const entryMatch = o.text.match(/^@\w+\{(.+),\s*$/);
        const idAttr = entryMatch ? ` data-entry-id="${esc(entryMatch[1])}"` : "";
        return `<span class="diff-line diff-ctx"${idAttr}>${esc(o.text)}</span>`;
      }).join("");
    }

    return ops.map(o => {
      const cls = o.type === "add" ? "diff-add" : o.type === "del" ? "diff-del" : "diff-ctx";
      const entryMatch = o.text.match(/^@\w+\{(.+),\s*$/);
      const idAttr = entryMatch ? ` data-entry-id="${esc(entryMatch[1])}"` : "";
      return `<span class="diff-line ${cls}"${idAttr}>${esc(o.text)}</span>`;
    }).join("");
  }

  function updatePreview() {
    if (!currentInputValid || !parsedEntries.length) return;
    currentPreviewState = buildPreviewState();
    currentPreviewBib = currentPreviewState.bib;
    results.forEach((result, index) => {
      const card = entryList.querySelector(`.entry-card[data-index="${index}"]`);
      if (!card) return;
      let warning = card.querySelector(".mixed-source-warning");
      if (result?.mixed_core_warning && !warning) {
        warning = document.createElement("div");
        warning.className = "review-hint mixed-source-warning";
        warning.textContent = "Mixed-source core metadata · explicit user choices are preserved with provenance.";
        card.querySelector(".candidate-panel")?.insertAdjacentElement("afterend", warning);
      } else if (!result?.mixed_core_warning && warning) {
        warning.remove();
      }
    });
    let previewWarning = previewPanelEl.querySelector(".preview-mixed-source-warning");
    if (currentPreviewState.mixedWarnings.some(Boolean) && !previewWarning) {
      previewWarning = document.createElement("div");
      previewWarning.className = "review-hint preview-mixed-source-warning";
      previewWarning.textContent = "Preview contains explicitly mixed title, author, or year sources.";
      previewCode.insertAdjacentElement("beforebegin", previewWarning);
    } else if (!currentPreviewState.mixedWarnings.some(Boolean) && previewWarning) {
      previewWarning.remove();
    }
    const origBib = buildOriginalBib();
    previewPlaceholder.style.display = "none";
    previewCode.style.display = "block";
    previewCode.innerHTML = renderDiff(origBib, currentPreviewBib);
  }

  const btnCopy = $("#btn-copy-preview");
  btnCopy.addEventListener("click", () => {
    if (!currentInputValid || !currentPreviewBib) return;
    currentPreviewState = buildPreviewState();
    currentPreviewBib = currentPreviewState.bib;
    navigator.clipboard.writeText(currentPreviewState.bib).then(() => {
      btnCopy.classList.add("copied");
      const origHTML = btnCopy.innerHTML;
      btnCopy.innerHTML = origHTML.replace("Copy", "Copied!");
      setTimeout(() => {
        btnCopy.classList.remove("copied");
        btnCopy.innerHTML = origHTML;
      }, 1500);
    });
  });

  // ─── Filtering ────────────────────────────────────────────────────
  document.addEventListener("click", (e) => {
    const badge = e.target.closest(".summary-badge");
    if (!badge) return;
    const filter = badge.dataset.filter;
    activeFilter = activeFilter === filter ? "all" : filter;
    $$(".summary-badge").forEach(b =>
      b.classList.toggle("active", activeFilter === "all" || b.dataset.filter === activeFilter));
    applyAllCardVisibility();
  });

  // ─── Entry search ────────────────────────────────────────────────
  const entrySearchWrap = $(".entry-search");
  const entrySearchInput = $("#entry-search-input");
  const entrySearchClear = $("#entry-search-clear");

  function setSearch(value) {
    activeSearch = (value || "").trim().toLowerCase();
    entrySearchWrap?.classList.toggle("has-query", !!activeSearch);
    applyAllCardVisibility();
  }

  entrySearchInput?.addEventListener("input", (e) => setSearch(e.target.value));
  entrySearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      entrySearchInput.value = "";
      setSearch("");
      entrySearchInput.blur();
    }
  });
  entrySearchClear?.addEventListener("click", () => {
    if (!entrySearchInput) return;
    entrySearchInput.value = "";
    setSearch("");
    entrySearchInput.focus();
  });

  // Global "/" hotkey to focus search, unless the user is already typing somewhere.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!entrySearchInput || entrySearchInput.offsetParent === null) return;
    e.preventDefault();
    entrySearchInput.focus();
    entrySearchInput.select();
  });

  // ─── Settings popover ────────────────────────────────────────────
  const settingsToggle = $("#settings-toggle");
  const settingsPopover = $("#settings-popover");
  const optRemoveDuplicates = $("#opt-remove-duplicates");
  const optRemoveNotFound = $("#opt-remove-notfound");
  const optMaxAuthors = $("#opt-max-authors");
  const optPreferPublished = $("#opt-prefer-published");
  const optLatexEscape = $("#opt-latex-escape");
  const optLocalGpuRerank = $("#opt-local-gpu-rerank");
  const optRerankProvider = $("#opt-rerank-provider");
  const optEvidenceLanguage = $("#opt-evidence-language");
  const optSpeedMode = $("#opt-speed-mode");
  const gpuRerankStatus = $("#gpu-rerank-status");
  const dedupCriteriaWrap = $("#dedup-criteria-wrap");

  if (optEvidenceLanguage) {
    optEvidenceLanguage.value = normalizeEvidenceLanguage(
      localStorage.getItem(EVIDENCE_LANGUAGE_STORAGE) || optEvidenceLanguage.value
    );
  }
  if (optSpeedMode) {
    optSpeedMode.value = normalizeSpeedMode(localStorage.getItem(SPEED_MODE_STORAGE) || optSpeedMode.value);
  }

  function normalizeSpeedMode(value) {
    const mode = String(value || "").toLowerCase();
    return ["fast", "balanced", "thorough"].includes(mode) ? mode : "balanced";
  }

  function getSpeedMode() {
    return normalizeSpeedMode(optSpeedMode?.value || localStorage.getItem(SPEED_MODE_STORAGE));
  }

  function verificationConcurrency() {
    const mode = getSpeedMode();
    if (mode === "fast") return 4;
    if (mode === "thorough") return 2;
    return 3;
  }

  function getRerankProvider() {
    if (!optLocalGpuRerank?.checked) return "off";
    return optRerankProvider?.value || "webgpu";
  }

  function getEvidenceLanguage() {
    return normalizeEvidenceLanguage(optEvidenceLanguage?.value || localStorage.getItem(EVIDENCE_LANGUAGE_STORAGE));
  }

  window.BibEvidenceLanguage = getEvidenceLanguage;

  function describeRerankProvider() {
    const provider = getRerankProvider();
    if (provider === "off") return "Off · uses heuristic matching";
    if (provider === "vllm") return "On · vLLM server rerank";
    return "On · WebGPU Gemma by default";
  }

  function setGemmaRerankStatus(message) {
    if (!gpuRerankStatus) return;
    gpuRerankStatus.textContent = message;
  }

  async function detectVllmServer() {
    if (!window.BibVllmReranker || !optRerankProvider || !optLocalGpuRerank) return;
    const health = await window.BibVllmReranker.health();
    if (!health?.ready) return;
    optLocalGpuRerank.checked = true;
    optRerankProvider.value = "vllm";
    setGemmaRerankStatus(`On · vLLM server ready${health.model ? ` (${health.model})` : ""}`);
  }

  settingsToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = settingsPopover.classList.toggle("open");
    settingsToggle.classList.toggle("active", isOpen);
  });

  document.addEventListener("click", (e) => {
    if (!settingsPopover.contains(e.target) && e.target !== settingsToggle) {
      settingsPopover.classList.remove("open");
      settingsToggle.classList.remove("active");
    }
  });

  optRemoveDuplicates.addEventListener("change", () => {
    dedupCriteriaWrap.classList.toggle("visible", optRemoveDuplicates.checked);
    updatePreview();
  });

  [optRemoveNotFound, optPreferPublished, optLatexEscape].forEach(el =>
    el?.addEventListener("change", updatePreview));
  optLocalGpuRerank?.addEventListener("change", () => {
    setGemmaRerankStatus(describeRerankProvider());
  });
  optRerankProvider?.addEventListener("change", () => {
    if (optLocalGpuRerank) optLocalGpuRerank.checked = true;
    setGemmaRerankStatus(describeRerankProvider());
  });
  optEvidenceLanguage?.addEventListener("change", () => {
    localStorage.setItem(EVIDENCE_LANGUAGE_STORAGE, getEvidenceLanguage());
  });
  optSpeedMode?.addEventListener("change", () => {
    localStorage.setItem(SPEED_MODE_STORAGE, getSpeedMode());
  });
  detectVllmServer();
  optMaxAuthors.addEventListener("change", () => {
    updateAuthorPills();
    updatePreview();
  });
  $$('input[name="dedup-criteria"]').forEach(el =>
    el.addEventListener("change", updatePreview));

  function getSettings() {
    return {
      removeDuplicates: optRemoveDuplicates.checked,
      dedupBy: (document.querySelector('input[name="dedup-criteria"]:checked') || {}).value || "title",
      removeNotFound: optRemoveNotFound.checked,
      maxAuthors: parseInt(optMaxAuthors.value) || 0,
      preferPublished: optPreferPublished.checked,
      latexEscape: optLatexEscape?.checked || false,
    };
  }

  // ─── Download ─────────────────────────────────────────────────────
  btnDownload.addEventListener("click", () => {
    if (!currentInputValid || btnDownload.disabled || !results.length) return;
    currentPreviewState = buildPreviewState();
    const bibContent = currentPreviewState.bib;
    currentPreviewBib = bibContent;
    const blob = new Blob([bibContent], { type: "application/x-bibtex" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "verified_refs.bib";
    a.click();
    URL.revokeObjectURL(url);
  });

  // ─── First-visit onboarding tour ───────────────────────────────────
  const ONBOARDING_STORAGE = "bv-onboarding-dismissed";
  const ONBOARDING_VER_KEY = "bv-onboarding-version";
  const ONBOARDING_VER = "3";

  const ONBOARDING_SAMPLE_BIB = `@article{tour_attention2017,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and others},
  journal = {Wrong Venue Placeholder},
  year = {2017},
}

@article{tour_fabricated2099,
  title = {Totally Fabricated Paper Title QZX999},
  author = {Nobody, N.},
  journal = {Journal of Nonexistence},
  year = {2099},
}`;

  function shouldAutoShowOnboarding() {
    if (localStorage.getItem(ONBOARDING_VER_KEY) !== ONBOARDING_VER)
      return true;
    return !localStorage.getItem(ONBOARDING_STORAGE);
  }

  function markOnboardingComplete() {
    localStorage.setItem(ONBOARDING_STORAGE, "1");
    localStorage.setItem(ONBOARDING_VER_KEY, ONBOARDING_VER);
  }

  function switchToPasteTab() {
    inputTabs.forEach(t => t.classList.toggle("active", t.dataset.tab === "paste"));
    tabPanels.forEach(p => p.classList.toggle("active", p.id === "tab-paste"));
  }

  const introOnboardingSteps = [
    {
      title: "Welcome",
      body: "Local Citation Verifier checks each entry against CrossRef, Semantic Scholar, DBLP, and OpenReview — wrong metadata, missing DOIs, duplicates, and citations that don’t exist online (including AI hallucinations). Your file stays in the browser.",
      target: null,
    },
    {
      title: "Add your bibliography",
      body: "Upload a <strong>.bib</strong> file or switch to <strong>Paste BibTeX</strong> and paste from Overleaf or anywhere else.",
      target: ".input-tabs",
    },
    {
      title: "Sample loaded",
      body: "We’ve switched to the paste tab and inserted a tiny <strong>two-entry sample</strong>: one famous paper with intentional wrong venue text, and one fake title so you can see how mismatches look.",
      target: "#bib-paste",
      onEnter: () => {
        switchToPasteTab();
        bibPaste.value = ONBOARDING_SAMPLE_BIB;
        bibPaste.focus({ preventScroll: true });
      },
    },
    {
      title: "Run verification",
      body: "Click <strong>Verify pasted BibTeX</strong> when you’re ready. The app queries CrossRef, Semantic Scholar, DBLP, and OpenReview (a short wait per entry). <strong>When it finishes, the tour continues</strong> and walks through both sample results — updated vs not found — plus settings.",
      target: "#btn-verify-paste",
    },
    {
      title: "Start with the sample",
      body: "Use <strong>Verify sample &amp; explore</strong> below to run the demo (same as the real verify button). Or close the tour and paste your own .bib anytime.",
      target: "#btn-verify-paste",
      final: true,
    },
  ];

  function mountOnboardingTour(steps, variant = "intro") {
    closeOnboarding();

    let stepIndex = 0;
    let lastRenderedStepIndex = -1;
    const isIntro = variant === "intro";
    const finalActionsDual = isIntro;

    const backdrop = document.createElement("div");
    backdrop.className = "onboarding-backdrop onboarding-backdrop-fixed";
    backdrop.setAttribute("data-dismiss", "1");

    const panelLayer = document.createElement("div");
    panelLayer.className = "onboarding-panel-layer";
    panelLayer.setAttribute("role", "dialog");
    panelLayer.setAttribute("aria-modal", "true");
    panelLayer.setAttribute("aria-labelledby", "onboarding-title");
    panelLayer._onboardingBackdrop = backdrop;

    const finalBlock = finalActionsDual
      ? `<div class="onboarding-actions onboarding-actions-final hidden">
          <button type="button" class="btn-onboarding secondary" data-action="finish">Close tour</button>
          <button type="button" class="btn-onboarding primary" data-action="verify-sample">Verify sample &amp; explore</button>
        </div>`
      : `<div class="onboarding-actions onboarding-actions-final hidden">
          <button type="button" class="btn-onboarding primary" data-action="finish">Got it</button>
        </div>`;
    panelLayer.innerHTML = `
      <div class="onboarding-panel glass">
        <div class="onboarding-meta">
          <span class="onboarding-step-label"></span>
          <div class="onboarding-dots"></div>
        </div>
        <h2 id="onboarding-title" class="onboarding-title"></h2>
        <div class="onboarding-body"></div>
        <div class="onboarding-actions onboarding-actions-main">
          <button type="button" class="btn-onboarding ghost" data-action="skip">Skip tour</button>
          <button type="button" class="btn-onboarding primary" data-action="next">Next</button>
        </div>
        ${finalBlock}
      </div>`;
    document.body.appendChild(backdrop);
    document.body.appendChild(panelLayer);
    onboardingOverlayEl = panelLayer;

    const titleEl = panelLayer.querySelector(".onboarding-title");
    const bodyEl = panelLayer.querySelector(".onboarding-body");
    const stepLabel = panelLayer.querySelector(".onboarding-step-label");
    const dotsWrap = panelLayer.querySelector(".onboarding-dots");
    const actionsMain = panelLayer.querySelector(".onboarding-actions-main");

    dotsWrap.innerHTML = steps.map((_, i) =>
      `<span class="onboarding-dot${i === 0 ? " active" : ""}" data-i="${i}"></span>`
    ).join("");

    function updateHighlight(selector, step = {}) {
      document.querySelectorAll(".onboarding-target").forEach(el => el.classList.remove("onboarding-target"));
      floatingBar?.classList.remove("onboarding-target-bar");

      panelLayer.classList.toggle("onboarding-panel-top", !!step.panelTop);

      if (!selector) return;
      const el = document.querySelector(selector);
      if (floatingBar && el && floatingBar.contains(el))
        floatingBar.classList.add("onboarding-target-bar");
      if (el) {
        el.classList.add("onboarding-target");
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }

    function renderStep() {
      if (lastRenderedStepIndex >= 0) {
        const prev = steps[lastRenderedStepIndex];
        if (prev?.onLeave) prev.onLeave();
      }
      lastRenderedStepIndex = stepIndex;

      const step = steps[stepIndex];
      panelLayer._currentStepOnLeave = step.onLeave || null;

      if (isIntro) {
        if (stepIndex <= 2) document.body.removeAttribute("data-onboarding-stage");
        else if (stepIndex === 3) document.body.dataset.onboardingStage = "verify";
        else if (step.final) document.body.dataset.onboardingStage = "verify-final";
      }

      if (step.onEnter) step.onEnter();

      titleEl.textContent = step.title;
      bodyEl.innerHTML = step.body;
      stepLabel.textContent = `Step ${stepIndex + 1} of ${steps.length}`;

      dotsWrap.querySelectorAll(".onboarding-dot").forEach((d, i) => {
        d.classList.toggle("active", i === stepIndex);
      });

      const isFinal = !!step.final;
      actionsMain.classList.toggle("hidden", isFinal);
      panelLayer.querySelector(".onboarding-actions-final").classList.toggle("hidden", !isFinal);

      updateHighlight(step.target, step);

      const nextBtn = panelLayer.querySelector(".onboarding-actions-main [data-action=\"next\"]");
      if (nextBtn) nextBtn.textContent = "Next";
    }

    backdrop.addEventListener("click", () => {
      markOnboardingComplete();
      closeOnboarding();
    });

    panelLayer.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const act = btn.dataset.action;
      if (act === "skip") {
        markOnboardingComplete();
        closeOnboarding();
        return;
      }
      if (act === "next") {
        stepIndex++;
        if (stepIndex >= steps.length) {
          markOnboardingComplete();
          closeOnboarding();
        } else renderStep();
        return;
      }
      if (act === "finish") {
        markOnboardingComplete();
        closeOnboarding();
        return;
      }
      if (act === "verify-sample" && finalActionsDual) {
        pendingOnboardingResumeClick = true;
        closeOnboarding();
        const txt = bibPaste.value.trim() || ONBOARDING_SAMPLE_BIB;
        if (!bibPaste.value.trim()) bibPaste.value = ONBOARDING_SAMPLE_BIB;
        switchToPasteTab();
        startVerificationFromContent(txt, "Parsing pasted content...");
      }
    });

    function onEsc(ev) {
      if (ev.key !== "Escape" || !onboardingOverlayEl) return;
      markOnboardingComplete();
      closeOnboarding();
    }
    panelLayer._kbdEsc = onEsc;
    document.addEventListener("keydown", onEsc);

    renderStep();
  }

  function openOnboardingPostVerifyTour() {
    const postSteps = [
      {
        title: "Summary filters",
        body: "These <strong>badges</strong> count results by status — verified, updated, needs review, not found. Click one to filter the list below.",
        target: ".summary-bar",
        panelTop: true,
      },
      {
        title: "First entry — metadata updated",
        body: "This row matched a real paper. The sample used a <strong>wrong journal</strong> on purpose — suggested venue, DOI, and other fields come from CrossRef / Semantic Scholar / DBLP / OpenReview. Each line compares your text to the suggestion; accept or revert per field.",
        target: ".entry-list .entry-card:nth-child(1)",
        panelTop: true,
      },
      {
        title: "Fake entry — not found",
        body: "This title is <strong>made up</strong>. Nothing credible matched online, so it’s labeled <strong>Not found</strong> — what you’d see for hallucinated or mistaken references.",
        target: ".entry-list .entry-card:nth-child(2)",
        panelTop: true,
      },
      {
        title: "Settings",
        body: "Use the <strong>gear</strong> in the bottom bar (above the dimmed area) to open settings: download options (for example removing not-found rows), author limits, and more. Try toggles here; press <strong>Next</strong> when you’re done exploring.",
        target: "#settings-toggle",
        panelTop: true,
        onEnter: () => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              settingsPopover.classList.add("open");
              settingsToggle.classList.add("active");
            });
          });
        },
        onLeave: () => {
          settingsPopover.classList.remove("open");
          settingsToggle.classList.remove("active");
        },
      },
      {
        title: "Bottom bar & download",
        body: "The <strong>floating bar</strong> stays here for settings and <strong>download verified BibTeX</strong> when you’re ready. Replace the sample with your own bibliography anytime.",
        target: "#floating-bar",
        panelTop: true,
        final: true,
      },
    ];
    mountOnboardingTour(postSteps, "postResults");
  }

  function openOnboardingTour({ force = false } = {}) {
    if (!force && onboardingOverlayEl) return;
    mountOnboardingTour(introOnboardingSteps, "intro");
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function loadFixtureFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const fixture = params.get("fixture");
    if (!fixture) return;
    const autoVerify = params.get("autoverify") === "1";
    try {
      const resp = await fetch(`fixtures/${encodeURIComponent(fixture)}.bib`);
      if (!resp.ok) throw new Error(`fixture not found (${resp.status})`);
      const content = await resp.text();
      switchToPasteTab();
      bibPaste.value = content;
      if (autoVerify) startVerificationFromContent(content, "Loading fixture...");
    } catch (err) {
      console.warn("Fixture load failed:", err);
    }
  }

  loadFixtureFromQuery();
})();
