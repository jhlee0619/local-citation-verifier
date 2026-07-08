(function (exports) {
  "use strict";

  const SS_FIELDS = "title,abstract,tldr,authors,year,venue,publicationVenue,externalIds,url";
  const MAX_EVIDENCE_CHARS = 2600;
  const DOT_SENTINEL = "__CITATION_DOT__";
  const BANG_SENTINEL = "__CITATION_BANG__";
  const QUERY_SENTINEL = "__CITATION_QUERY__";
  const EVIDENCE_LANGUAGE_STORAGE = "bv-evidence-language";
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 500;

  function useMetadataProxy() {
    if (typeof window === "undefined" || !window.location) return false;
    const { hostname, protocol } = window.location;
    if (protocol === "file:") return false;
    return !hostname.endsWith(".github.io");
  }

  const USE_METADATA_PROXY = useMetadataProxy();
  const SS_MATCH = USE_METADATA_PROXY
    ? "/api/semanticscholar/graph/v1/paper/search/match"
    : "https://api.semanticscholar.org/graph/v1/paper/search/match";
  const SS_PAPER = USE_METADATA_PROXY
    ? "/api/semanticscholar/graph/v1/paper/"
    : "https://api.semanticscholar.org/graph/v1/paper/";

  const CITE_COMMANDS = [
    "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear",
    "autocite", "parencite", "textcite", "supercite", "cite",
  ].join("|");
  const LATEX_CITE_RE = new RegExp(`\\\\(?:${CITE_COMMANDS})(?:\\s*\\[[^\\]]*\\]){0,2}\\s*\\{([^}]+)\\}`, "g");
  const LATEX_CITE_WITH_OPTIONS_RE = new RegExp(`\\\\(?:${CITE_COMMANDS})(?:\\s*\\[[^\\]]*\\]){0,2}`, "g");

  function normalizeEvidenceLanguage(value) {
    const lang = String(value || "").toLowerCase();
    return lang === "ko" || lang === "kor" || lang === "korean" ? "ko" : "en";
  }

  function evidenceLanguageInstruction(language) {
    return normalizeEvidenceLanguage(language) === "ko"
      ? "Write reason and evidence_quote in Korean."
      : "Write reason and evidence_quote in English.";
  }

  function currentEvidenceLanguage() {
    if (typeof document !== "undefined") {
      const select = document.getElementById("opt-evidence-language");
      if (select?.value) return normalizeEvidenceLanguage(select.value);
    }
    if (typeof localStorage !== "undefined")
      return normalizeEvidenceLanguage(localStorage.getItem(EVIDENCE_LANGUAGE_STORAGE));
    return "en";
  }

  function citationFallbackText(key, language) {
    const lang = normalizeEvidenceLanguage(language);
    const messages = {
      missingEntry: {
        en: "Citation key is not present in the BibTeX file.",
        ko: "인용 키가 BibTeX 파일에 없습니다.",
      },
      missingEvidence: {
        en: "No abstract or TLDR was available for this reference.",
        ko: "이 참고문헌에는 판단에 필요한 초록이나 TLDR이 없습니다.",
      },
    };
    return messages[key]?.[lang] || messages[key]?.en || "";
  }

  function stripLatexNoise(text) {
    return String(text || "")
      .replace(/%[^\n\r]*/g, "")
      .replace(/\\(?:emph|textbf|textit|texttt|mathbf|mathrm)\{([^{}]*)\}/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitSentences(text) {
    const clean = stripLatexNoise(text);
    if (!clean) return [];
    const masked = clean.replace(LATEX_CITE_WITH_OPTIONS_RE, (match) =>
      match.replace(/\./g, DOT_SENTINEL).replace(/!/g, BANG_SENTINEL).replace(/\?/g, QUERY_SENTINEL)
    );
    const chunks = masked.match(/[^.!?]+(?:[.!?]+|$)/g) || [masked];
    return chunks
      .map((chunk) => chunk
        .replaceAll(DOT_SENTINEL, ".")
        .replaceAll(BANG_SENTINEL, "!")
        .replaceAll(QUERY_SENTINEL, "?")
        .trim())
      .filter(Boolean);
  }

  function parseCitationKeys(raw) {
    return String(raw || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.replace(/^[^A-Za-z0-9_:-]*/, "").replace(/[^A-Za-z0-9_:-]*$/, ""))
      .filter(Boolean);
  }

  function extractCitationContexts(manuscriptText) {
    const contexts = [];
    const sentences = splitSentences(manuscriptText);
    sentences.forEach((sentence, sentenceIndex) => {
      const matches = [...sentence.matchAll(LATEX_CITE_RE)];
      for (const match of matches) {
        for (const key of parseCitationKeys(match[1])) {
          contexts.push({
            key,
            citation: match[0],
            sentence,
            sentenceIndex,
          });
        }
      }
    });
    return contexts;
  }

  function mapEntriesByKey(entries) {
    const map = new Map();
    for (const entry of entries || []) {
      if (entry?.ID) map.set(entry.ID, entry);
    }
    return map;
  }

  function authorNames(authors) {
    if (!Array.isArray(authors)) return "";
    return authors.map((author) => author?.name).filter(Boolean).slice(0, 8).join(" and ");
  }

  function encodeDoiPath(doi) {
    return String(doi || "")
      .trim()
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
  }

  function semanticScholarPaperIdForDoi(doi) {
    const path = encodeDoiPath(doi);
    return path ? `DOI:${path}` : "";
  }

  function safeExternalUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (_err) {
      return "";
    }
  }

  function paperUrlForEvidence(evidence, entry) {
    const evidenceUrl = safeExternalUrl(evidence?.url);
    if (evidenceUrl) return evidenceUrl;
    const doi = evidence?.externalIds?.DOI || entry?.doi;
    if (doi) return `https://doi.org/${encodeDoiPath(doi)}`;
    if (entry?.title) return `https://www.semanticscholar.org/search?q=${encodeURIComponent(entry.title)}`;
    return "";
  }

  function normalizeEvidence(data, entry) {
    if (!data) return {
      found: false,
      title: entry?.title || "",
      abstract: "",
      tldr: "",
      year: entry?.year || "",
      venue: entry?.journal || entry?.booktitle || "",
      authors: entry?.author || "",
      url: paperUrlForEvidence(null, entry),
      externalIds: {},
    };

    return {
      found: true,
      title: data.title || entry?.title || "",
      abstract: data.abstract || "",
      tldr: data.tldr?.text || "",
      year: data.year || entry?.year || "",
      venue: data.venue || data.publicationVenue?.name || entry?.journal || entry?.booktitle || "",
      authors: authorNames(data.authors) || entry?.author || "",
      url: paperUrlForEvidence(data, entry),
      externalIds: data.externalIds || {},
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isTransientHttpStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  function retryDelayMs(response, attempt, baseDelayMs) {
    const retryAfter = response?.headers?.get?.("Retry-After");
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return baseDelayMs * Math.pow(2, attempt);
  }

  async function fetchJson(url, params, options = {}) {
    const retries = Number.isInteger(options.retries) ? options.retries : MAX_RETRIES;
    const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : RETRY_BASE_MS;
    const u = new URL(url, window.location.origin);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") u.searchParams.set(key, value);
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(u.toString());
        if (response.ok) return response.json();
        if (!isTransientHttpStatus(response.status)) return null;
        if (attempt < retries) {
          const wait = retryDelayMs(response, attempt, baseDelayMs);
          if (wait > 0) await sleep(wait);
          continue;
        }
        throw new Error(`transient evidence lookup error ${response.status}`);
      } catch (err) {
        if (attempt < retries) {
          const wait = baseDelayMs * Math.pow(2, attempt);
          if (wait > 0) await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  async function fetchEvidence(entry) {
    if (!entry) return normalizeEvidence(null, null);
    const doi = entry.doi || entry.DOI;
    try {
      if (doi) {
        const paperId = semanticScholarPaperIdForDoi(doi);
        const paper = await fetchJson(`${SS_PAPER}${paperId}`, { fields: SS_FIELDS });
        if (paper) return normalizeEvidence(paper, entry);
      }
      if (entry.title) {
        const matched = await fetchJson(SS_MATCH, { query: entry.title, fields: SS_FIELDS });
        if (matched?.data?.[0]) return normalizeEvidence(matched.data[0], entry);
      }
      return normalizeEvidence(null, entry);
    } catch (err) {
      return { ...normalizeEvidence(null, entry), lookupError: err.message || String(err) };
    }
  }

  function shortEvidenceText(evidence) {
    const pieces = [
      evidence?.tldr ? `TLDR: ${evidence.tldr}` : "",
      evidence?.abstract ? `Abstract: ${evidence.abstract}` : "",
    ].filter(Boolean);
    const text = pieces.join("\n");
    return text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}...` : text;
  }

  function buildPrompt({ context, entry, evidence, language }) {
    const evidenceText = shortEvidenceText(evidence);
    return [
      "Judge whether the cited paper supports the cited sentence from a manuscript.",
      'Return only strict JSON: {"verdict":"supported","confidence":0.84,"reason":"The abstract directly supports the background claim.","evidence_quote":"short quote or metadata basis","risk_flags":[]}.',
      "Allowed verdict values: supported, weak, unsupported, insufficient_evidence.",
      "Use supported only when the cited paper evidence directly backs the sentence.",
      "Use weak when the paper is related but only broadly supports background, method context, or a softer version of the claim.",
      "Use unsupported when the sentence makes a claim contradicted by, unrelated to, or much stronger than the evidence.",
      "Use insufficient_evidence when abstract/TLDR/full evidence is missing or too thin to judge.",
      "Allowed risk_flags: missing_abstract, broad_claim, specific_result_claim, topic_mismatch, citation_key_missing, metadata_only.",
      "JSON keys, verdict values, and risk_flags must remain in English even when reason or evidence_quote uses another language.",
      evidenceLanguageInstruction(language),
      "Do not invent evidence. Keep reason under 24 words.",
      "",
      `Citation key: ${context.key}`,
      `Cited sentence: ${context.sentence}`,
      "",
      `BibTeX title: ${entry?.title || ""}`,
      `BibTeX authors: ${entry?.author || ""}`,
      `BibTeX year: ${entry?.year || ""}`,
      `BibTeX venue: ${entry?.journal || entry?.booktitle || ""}`,
      "",
      `Evidence title: ${evidence?.title || ""}`,
      `Evidence authors: ${evidence?.authors || ""}`,
      `Evidence year: ${evidence?.year || ""}`,
      `Evidence venue: ${evidence?.venue || ""}`,
      evidenceText ? `Evidence text:\n${evidenceText}` : "Evidence text: none",
    ].join("\n");
  }

  function parseJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try {
      return JSON.parse(candidate);
    } catch (_) {
      const match = candidate.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        return null;
      }
    }
  }

  function parseJudgement(text) {
    const parsed = parseJsonObject(text);
    const allowed = new Set(["supported", "weak", "unsupported", "insufficient_evidence"]);
    const verdict = allowed.has(String(parsed?.verdict || "")) ? parsed.verdict : "insufficient_evidence";
    const confidence = Number(parsed?.confidence);
    const riskFlags = Array.isArray(parsed?.risk_flags)
      ? parsed.risk_flags.map((flag) => String(flag || "").toLowerCase()).filter(Boolean)
      : [];
    return applyRiskFlagGuardrails({
      verdict,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "",
      evidenceQuote: typeof parsed?.evidence_quote === "string" ? parsed.evidence_quote : "",
      riskFlags,
      raw: String(text || ""),
    });
  }

  function applyRiskFlagGuardrails(judgement) {
    const flags = new Set(judgement?.riskFlags || []);
    if (!flags.size) return judgement;

    let verdict = judgement.verdict;
    if (flags.has("topic_mismatch")) {
      if (verdict === "supported" || verdict === "weak") verdict = "unsupported";
    } else if (flags.has("specific_result_claim") && verdict === "supported") {
      verdict = "weak";
    } else if (flags.has("broad_claim") && verdict === "supported") {
      verdict = "weak";
    } else if (verdict === "supported") {
      verdict = "weak";
    }

    if (verdict === judgement.verdict) return judgement;
    return { ...judgement, verdict };
  }

  async function completeWithVllm(prompt, onStatus) {
    onStatus?.("Judging citation support with local vLLM server...");
    const response = await fetch("/api/rerank/vllm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, candidate_count: 1, max_tokens: 220 }),
    });
    if (!response.ok) throw new Error(`vLLM judgement failed with HTTP ${response.status}`);
    const data = await response.json();
    return String(data.output || "");
  }

  async function detectVllmReady() {
    if (!window.BibVllmReranker?.health) return false;
    const health = await window.BibVllmReranker.health();
    return !!health?.ready;
  }

  async function judgeCitation({ context, entry, evidence, provider, language, onStatus }) {
    const evidenceLanguage = normalizeEvidenceLanguage(language);
    if (!entry) {
      return {
        verdict: "insufficient_evidence",
        confidence: 1,
        reason: citationFallbackText("missingEntry", evidenceLanguage),
        evidenceQuote: "",
        riskFlags: ["citation_key_missing"],
        raw: "",
      };
    }
    if (evidence?.lookupError) {
      return {
        verdict: "insufficient_evidence",
        confidence: 0.95,
        reason: evidence.lookupError,
        evidenceQuote: "",
        riskFlags: ["lookup_failed"],
        raw: "",
      };
    }
    if (!evidence?.abstract && !evidence?.tldr) {
      return {
        verdict: "insufficient_evidence",
        confidence: 0.92,
        reason: citationFallbackText("missingEvidence", evidenceLanguage),
        evidenceQuote: evidence?.title || entry.title || "",
        riskFlags: ["missing_abstract", "metadata_only"],
        raw: "",
      };
    }

    const prompt = buildPrompt({ context, entry, evidence, language: evidenceLanguage });
    let selectedProvider = provider || "auto";
    if (selectedProvider === "auto") selectedProvider = await detectVllmReady() ? "vllm" : "webgpu";
    const output = selectedProvider === "vllm"
      ? await completeWithVllm(prompt, onStatus)
      : await window.BibGemmaReranker.completePrompt(prompt, { maxNewTokens: 220, onStatus });
    return parseJudgement(output);
  }

  function verdictLabel(verdict) {
    return {
      supported: "Supported",
      weak: "Weak",
      unsupported: "Unsupported",
      insufficient_evidence: "Insufficient evidence",
    }[verdict] || verdict;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderResults(container, results) {
    if (!container) return;
    if (!results.length) {
      container.innerHTML = '<div class="citation-empty">No citation contexts found yet.</div>';
      return;
    }
    container.innerHTML = results.map((result) => {
      const url = safeExternalUrl(result.evidence?.url);
      const flags = result.judgement.riskFlags?.length
        ? `<div class="citation-flags">${result.judgement.riskFlags.map(escapeHtml).join(", ")}</div>`
        : "";
      return `
        <article class="citation-card citation-${escapeHtml(result.judgement.verdict)}">
          <div class="citation-card-head">
            <span class="citation-key">${escapeHtml(result.context.key)}</span>
            <span class="citation-verdict">${escapeHtml(verdictLabel(result.judgement.verdict))}</span>
          </div>
          <p class="citation-sentence">${escapeHtml(result.context.sentence)}</p>
          <div class="citation-paper">
            <strong>${escapeHtml(result.entry?.title || "Missing BibTeX entry")}</strong>
            <span>${escapeHtml(result.entry?.author || "")}</span>
          </div>
          <p class="citation-reason">${escapeHtml(result.judgement.reason || "No model reason returned.")}</p>
          ${result.judgement.evidenceQuote ? `<blockquote>${escapeHtml(result.judgement.evidenceQuote)}</blockquote>` : ""}
          ${flags}
          ${url ? `<a class="citation-open-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open paper</a>` : ""}
        </article>`;
    }).join("");
  }

  function summarize(results) {
    const counts = { supported: 0, weak: 0, unsupported: 0, insufficient_evidence: 0 };
    for (const result of results) counts[result.judgement.verdict] = (counts[result.judgement.verdict] || 0) + 1;
    return counts;
  }

  function updateSummary(root, results) {
    const counts = summarize(results);
    for (const [key, count] of Object.entries(counts)) {
      const el = root?.querySelector(`[data-citation-count="${key}"]`);
      if (el) el.textContent = String(count);
    }
  }

  function initToolSwitch() {
    const buttons = document.querySelectorAll("[data-tool-target]");
    const views = document.querySelectorAll("[data-tool-view]");
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.toolTarget;
        buttons.forEach((btn) => btn.classList.toggle("active", btn === button));
        views.forEach((view) => {
          const active = view.dataset.toolView === target;
          view.hidden = !active;
          view.classList.toggle("active", active);
        });
      });
    });
  }

  function currentSpeedMode() {
    if (typeof document !== "undefined") {
      const select = document.getElementById("opt-speed-mode");
      if (select?.value) return select.value;
    }
    return "balanced";
  }

  function citationAuditConcurrency() {
    const mode = currentSpeedMode();
    if (mode === "fast") return 3;
    if (mode === "thorough") return 1;
    return 2;
  }

  function judgementCacheKey(context, entry, evidence) {
    return JSON.stringify([
      context?.key || "",
      context?.sentence || "",
      entry?.title || "",
      entry?.year || "",
      evidence?.title || "",
      evidence?.abstract || evidence?.tldr || "",
    ]);
  }

  async function runBoundedQueue(items, worker, options = {}) {
    const list = Array.from(items || []);
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency || 1)));
    const results = new Array(list.length);
    let nextIndex = 0;
    async function runWorker() {
      while (nextIndex < list.length) {
        const index = nextIndex++;
        const result = await worker(list[index], index);
        results[index] = result;
        if (typeof options.onResult === "function") options.onResult(result, index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => runWorker()));
    return results;
  }

  function bindFileInput(input, textarea) {
    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file || !textarea) return;
      textarea.value = await file.text();
    });
  }

  function initCitationAudit() {
    if (typeof document === "undefined") return;
    initToolSwitch();
    const root = document.getElementById("citation-audit");
    if (!root || !window.BibLib) return;

    const bibInput = root.querySelector("#citation-bib-input");
    const manuscriptInput = root.querySelector("#citation-manuscript-input");
    const bibFile = root.querySelector("#citation-bib-file");
    const manuscriptFile = root.querySelector("#citation-manuscript-file");
    const runButton = root.querySelector("#btn-run-citation-audit");
    const outputEl = root.querySelector("#citation-output");
    const statusEl = root.querySelector("#citation-audit-status");
    const resultsEl = root.querySelector("#citation-audit-results");

    bindFileInput(bibFile, bibInput);
    bindFileInput(manuscriptFile, manuscriptInput);

    runButton?.addEventListener("click", async () => {
      const bibText = bibInput?.value || "";
      const manuscriptText = manuscriptInput?.value || "";
      const entries = window.BibLib.parseBib(bibText);
      const contexts = extractCitationContexts(manuscriptText);
      const entriesByKey = mapEntriesByKey(entries);
      const evidenceCache = new Map();
      const results = [];
      if (outputEl) outputEl.hidden = false;
      if (resultsEl) resultsEl.innerHTML = "";
      updateSummary(root, results);

      if (!entries.length) {
        statusEl.textContent = "Add a BibTeX file before running citation support.";
        return;
      }
      if (!contexts.length) {
        statusEl.textContent = "No LaTeX citation commands were found in the manuscript text.";
        renderResults(resultsEl, []);
        updateSummary(root, results);
        return;
      }

      runButton.disabled = true;
      try {
        const judgementCache = new Map();
        await runBoundedQueue(contexts, async (context, i) => {
          const entry = entriesByKey.get(context.key);
          let evidencePromise = evidenceCache.get(context.key);
          if (!evidencePromise) {
            evidencePromise = fetchEvidence(entry);
            evidenceCache.set(context.key, evidencePromise);
          }
          const evidence = await evidencePromise;
          const key = judgementCacheKey(context, entry, evidence);
          let judgementPromise = judgementCache.get(key);
          if (!judgementPromise) {
            judgementPromise = judgeCitation({
              context,
              entry,
              evidence,
              provider: "auto",
              language: currentEvidenceLanguage(),
              onStatus: (message) => { statusEl.textContent = `${context.key}: ${message}`; },
            });
            judgementCache.set(key, judgementPromise);
          }
          const judgement = await judgementPromise;
          return { context, entry, evidence, judgement };
        }, {
          concurrency: citationAuditConcurrency(),
          onResult: (result, i) => {
            results[i] = result;
            const visibleResults = results.filter(Boolean);
            statusEl.textContent = `Checked ${visibleResults.length}/${contexts.length}: ${result.context.key}`;
            updateSummary(root, visibleResults);
            renderResults(resultsEl, visibleResults);
          },
        });
        statusEl.textContent = `Finished ${contexts.length} citation checks.`;
      } catch (err) {
        statusEl.textContent = `Citation audit stopped: ${err.message}`;
        console.warn("Citation audit failed:", err);
      } finally {
        runButton.disabled = false;
      }
    });
  }

  exports.extractCitationContexts = extractCitationContexts;
  exports.mapEntriesByKey = mapEntriesByKey;
  exports.buildPrompt = buildPrompt;
  exports.encodeDoiPath = encodeDoiPath;
  exports.safeExternalUrl = safeExternalUrl;
  exports.paperUrlForEvidence = paperUrlForEvidence;
  exports.fetchJson = fetchJson;
  exports.isTransientHttpStatus = isTransientHttpStatus;
  exports.semanticScholarPaperIdForDoi = semanticScholarPaperIdForDoi;
  exports.parseJudgement = parseJudgement;
  exports.applyRiskFlagGuardrails = applyRiskFlagGuardrails;
  exports.judgeCitation = judgeCitation;
  exports.summarize = summarize;
  exports.initCitationAudit = initCitationAudit;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCitationAudit);
    else initCitationAudit();
  }
})(typeof module !== "undefined" && module.exports ? module.exports : (window.CitationAudit = {}));
