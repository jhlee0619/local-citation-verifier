(function (exports) {
  "use strict";

  const SS_MATCH = "https://api.semanticscholar.org/graph/v1/paper/search/match";
  const SS_PAPER = "https://api.semanticscholar.org/graph/v1/paper/";
  const SS_FIELDS = "title,abstract,tldr,authors,year,venue,publicationVenue,externalIds,url";
  const MAX_EVIDENCE_CHARS = 2600;
  const DOT_SENTINEL = "__CITATION_DOT__";
  const BANG_SENTINEL = "__CITATION_BANG__";
  const QUERY_SENTINEL = "__CITATION_QUERY__";

  const CITE_COMMANDS = [
    "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear",
    "autocite", "parencite", "textcite", "supercite", "cite",
  ].join("|");
  const LATEX_CITE_RE = new RegExp(`\\\\(?:${CITE_COMMANDS})(?:\\s*\\[[^\\]]*\\]){0,2}\\s*\\{([^}]+)\\}`, "g");
  const LATEX_CITE_WITH_OPTIONS_RE = new RegExp(`\\\\(?:${CITE_COMMANDS})(?:\\s*\\[[^\\]]*\\]){0,2}`, "g");

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

  function paperUrlForEvidence(evidence, entry) {
    if (evidence?.url) return evidence.url;
    const doi = evidence?.externalIds?.DOI || entry?.doi;
    if (doi) return `https://doi.org/${encodeURIComponent(doi)}`;
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

  async function fetchJson(url, params) {
    const u = new URL(url);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") u.searchParams.set(key, value);
    }
    const response = await fetch(u.toString());
    if (!response.ok) return null;
    return response.json();
  }

  async function fetchEvidence(entry) {
    if (!entry) return normalizeEvidence(null, null);
    const doi = entry.doi || entry.DOI;
    if (doi) {
      const paper = await fetchJson(`${SS_PAPER}DOI:${encodeURIComponent(doi)}`, { fields: SS_FIELDS });
      if (paper) return normalizeEvidence(paper, entry);
    }
    if (entry.title) {
      const matched = await fetchJson(SS_MATCH, { query: entry.title, fields: SS_FIELDS });
      if (matched?.data?.[0]) return normalizeEvidence(matched.data[0], entry);
    }
    return normalizeEvidence(null, entry);
  }

  function shortEvidenceText(evidence) {
    const pieces = [
      evidence?.tldr ? `TLDR: ${evidence.tldr}` : "",
      evidence?.abstract ? `Abstract: ${evidence.abstract}` : "",
    ].filter(Boolean);
    const text = pieces.join("\n");
    return text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}...` : text;
  }

  function buildPrompt({ context, entry, evidence }) {
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
    return {
      verdict,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "",
      evidenceQuote: typeof parsed?.evidence_quote === "string" ? parsed.evidence_quote : "",
      riskFlags,
      raw: String(text || ""),
    };
  }

  async function completeWithVllm(prompt, onStatus) {
    onStatus?.("Judging citation support with local vLLM server...");
    const response = await fetch("/api/rerank/vllm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, candidate_count: 1 }),
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

  async function judgeCitation({ context, entry, evidence, provider, onStatus }) {
    if (!entry) {
      return {
        verdict: "insufficient_evidence",
        confidence: 1,
        reason: "Citation key is not present in the BibTeX file.",
        evidenceQuote: "",
        riskFlags: ["citation_key_missing"],
        raw: "",
      };
    }
    if (!evidence?.abstract && !evidence?.tldr) {
      return {
        verdict: "insufficient_evidence",
        confidence: 0.92,
        reason: "No abstract or TLDR was available for this reference.",
        evidenceQuote: evidence?.title || entry.title || "",
        riskFlags: ["missing_abstract", "metadata_only"],
        raw: "",
      };
    }

    const prompt = buildPrompt({ context, entry, evidence });
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
      .replace(/"/g, "&quot;");
  }

  function renderResults(container, results) {
    if (!container) return;
    if (!results.length) {
      container.innerHTML = '<div class="citation-empty">No citation contexts found yet.</div>';
      return;
    }
    container.innerHTML = results.map((result) => {
      const url = result.evidence?.url || "";
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
    const statusEl = root.querySelector("#citation-audit-status");
    const resultsEl = root.querySelector("#citation-audit-results");

    bindFileInput(bibFile, bibInput);
    bindFileInput(manuscriptFile, manuscriptInput);
    renderResults(resultsEl, []);

    runButton?.addEventListener("click", async () => {
      const bibText = bibInput?.value || "";
      const manuscriptText = manuscriptInput?.value || "";
      const entries = window.BibLib.parseBib(bibText);
      const contexts = extractCitationContexts(manuscriptText);
      const entriesByKey = mapEntriesByKey(entries);
      const evidenceCache = new Map();
      const results = [];

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
        for (let i = 0; i < contexts.length; i++) {
          const context = contexts[i];
          const entry = entriesByKey.get(context.key);
          statusEl.textContent = `Checking ${i + 1}/${contexts.length}: ${context.key}`;
          let evidence = evidenceCache.get(context.key);
          if (!evidence) {
            evidence = await fetchEvidence(entry);
            evidenceCache.set(context.key, evidence);
          }
          const judgement = await judgeCitation({
            context,
            entry,
            evidence,
            provider: "auto",
            onStatus: (message) => { statusEl.textContent = `${context.key}: ${message}`; },
          });
          results.push({ context, entry, evidence, judgement });
          updateSummary(root, results);
          renderResults(resultsEl, results);
        }
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
  exports.parseJudgement = parseJudgement;
  exports.summarize = summarize;
  exports.initCitationAudit = initCitationAudit;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCitationAudit);
    else initCitationAudit();
  }
})(typeof module !== "undefined" && module.exports ? module.exports : (window.CitationAudit = {}));
