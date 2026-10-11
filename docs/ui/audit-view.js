/*
 * Citation-audit page wiring: tool switch, inputs, the audit's own AI judge
 * selector and Cancel button, the run (its own lifecycle: a verification
 * never cancels it), result cards, skipped citations and report export.
 * main.js calls initCitationAudit() once the page is ready.
 */
import { parseBib } from "../core/bibtex.js?v=20261012-s15";
import { normalizeEvidenceLanguage, safeExternalUrl } from "../core/text.js?v=20261012-s15";
import * as Judge from "../core/judge.js?v=20261012-s15";
import {
  combinedVerdictLabel, combinedVerdicts, formatAuditMarkdown, insufficientBreakdown, insufficientReasonLabel,
  planAudit, runAuditContexts, skipReasonLabel, summarize, verdictLabel,
} from "../core/audit.js?v=20261012-s15";
import { defaultController } from "../core/verify.js?v=20261012-s15";
import { html, setHTML } from "./dom.js?v=20261012-s15";
import { storage } from "./panels.js?v=20261012-s15";

  const ENGINE_STORAGE = "bv-audit-engine";
  const ENGINES = Judge.ENGINE_NAMES;
  const BLOB_URL_LIFETIME_MS = 10_000;

  function currentEvidenceLanguage() {
    const select = document.getElementById("opt-evidence-language");
    return normalizeEvidenceLanguage(select?.value || storage.get("bv-evidence-language"));
  }

  function currentSpeedMode() {
    return document.getElementById("opt-speed-mode")?.value || "balanced";
  }

  // The audit's AI judge is opt-in: no manuscript sentence goes to a model
  // until the user selects an engine here. The evidence lookup always sends
  // reference metadata to the public databases.
  const AI_OFF_STATUS = "AI off: manuscript sentences are not sent to any model. Reference metadata (titles, authors, identifiers) is still sent to public databases to fetch abstracts.";

  function engineStatus(engine) {
    if (engine === "vllm")
      return "On · vLLM server: each cited sentence and its abstract go to the local proxy (/api/rerank/vllm).";
    return AI_OFF_STATUS;
  }

  // ─── Cards ─────────────────────────────────────────────────────────
  function paperMarkup(label, paper, className = "citation-paper") {
    const meta = [paper.year, paper.authors].filter(Boolean).join(" · ");
    return html`<div class="${className}">
      <span class="citation-paper-label">${label}</span>
      <strong>${paper.title || "(untitled)"}</strong>
      ${meta ? html`<span>${meta}</span>` : ""}
    </div>`;
  }

  // The evidence paper's own title is always shown; a record that was not
  // the cited work is shown as rejected.
  function evidenceMarkup(evidence) {
    if (evidence?.found !== false && evidence?.title)
      return paperMarkup("Evidence paper", evidence, "citation-paper citation-evidence");
    if (evidence?.rejected?.length) {
      return evidence.rejected.map(paper => paperMarkup(
        `Rejected evidence (${paper.via === "doi" ? "DOI lookup" : "title match"}): not the cited work`,
        paper, "citation-paper citation-evidence citation-evidence-rejected"));
    }
    return html`<div class="citation-paper citation-evidence">
      <span class="citation-paper-label">Evidence paper</span>
      <span>${evidence?.lookupError ? "Lookup failed" : "No matching record found"}</span>
    </div>`;
  }

  function cardMarkup(result, combined) {
    const { context, entry, evidence, judgement } = result;
    const verdict = judgement.verdict;
    const reason = verdict === "insufficient_evidence" ? insufficientReasonLabel(judgement.reasonCode) : "";
    const url = safeExternalUrl(evidence?.url);
    return html`<article class="citation-card citation-${verdict}" data-verdict="${verdict}" data-reason-code="${judgement.reasonCode || ""}">
      <div class="citation-card-head">
        <span class="citation-key">${context.key}</span>
        <span class="citation-verdict">${verdictLabel(verdict)}${reason ? ` · ${reason}` : ""}</span>
      </div>
      <p class="citation-sentence">${context.sentence}</p>
      ${combined ? html`<p class="citation-combined" title="Supported only if at least one cited abstract supports the sentence; partial support alone stays partial.">Combined verdict for this sentence (${combined.references} references): ${combinedVerdictLabel(combined.verdict)}</p>` : ""}
      ${paperMarkup("Cited (BibTeX)", { title: entry?.title || "Missing BibTeX entry", year: entry?.year || "", authors: entry?.author || "" })}
      ${evidenceMarkup(evidence)}
      <p class="citation-reason">${judgement.reason || "No model reason returned."}</p>
      ${judgement.evidenceQuote ? html`<blockquote>${judgement.evidenceQuote}</blockquote>` : ""}
      ${judgement.riskFlags?.length ? html`<div class="citation-flags">${judgement.riskFlags.join(", ")}</div>` : ""}
      ${url ? html`<a class="citation-open-link" href="${url}" target="_blank" rel="noopener">Open paper</a>` : ""}
    </article>`;
  }

  function isBlankText(value) {
    return !String(value || "").trim();
  }

  function syncBibliographyOnToolSwitch(target) {
    const verifierBib = document.getElementById("bib-paste");
    const auditBib = document.getElementById("citation-bib-input");
    if (!verifierBib || !auditBib) return;
    if (target === "citation-audit" && isBlankText(auditBib.value) && !isBlankText(verifierBib.value))
      auditBib.value = verifierBib.value;
    if (target === "verifier" && isBlankText(verifierBib.value) && !isBlankText(auditBib.value))
      verifierBib.value = auditBib.value;
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
        syncBibliographyOnToolSwitch(target);
      });
    });
  }

  function bindFileInput(input, textarea) {
    let changeId = 0;
    input?.addEventListener("change", async () => {
      const currentChangeId = ++changeId;
      const file = input.files?.[0];
      if (!file || !textarea) return;
      const value = await file.text();
      if (currentChangeId === changeId) textarea.value = value;
    });
  }

  const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

  function initCitationAudit() {
    if (typeof document === "undefined") return;
    initToolSwitch();
    const root = document.getElementById("citation-audit");
    const controller = defaultController;
    if (!root) return;

    const bibInput = root.querySelector("#citation-bib-input");
    const manuscriptInput = root.querySelector("#citation-manuscript-input");
    const engineSelect = root.querySelector("#citation-ai-engine");
    const engineStatusEl = root.querySelector("#citation-ai-status");
    const runButton = root.querySelector("#btn-run-citation-audit");
    const cancelButton = root.querySelector("#btn-cancel-citation-audit");
    const copyReportBtn = root.querySelector("#btn-copy-citation-report");
    const downloadReportBtn = root.querySelector("#btn-download-citation-report");
    const outputEl = root.querySelector("#citation-output");
    const statusEl = root.querySelector("#citation-audit-status");
    const breakdownEl = root.querySelector("#citation-audit-breakdown");
    const skippedEl = root.querySelector("#citation-audit-skipped");
    const resultsEl = root.querySelector("#citation-audit-results");
    // The last completed audit (Copy / Download report), and the running one.
    let report = null;
    let current = null;

    const setStatus = text => { statusEl.textContent = text; };
    function setExportEnabled(enabled) {
      copyReportBtn.disabled = !enabled;
      downloadReportBtn.disabled = !enabled;
    }
    setExportEnabled(false);

    function syncEngine() {
      const engine = engineSelect.value;
      engineStatusEl.textContent = engineStatus(engine);
    }
    // A stored engine that no longer exists (a retired browser engine) means off.
    const storedEngine = storage.get(ENGINE_STORAGE);
    if (ENGINES.includes(storedEngine)) engineSelect.value = storedEngine;
    else if (storedEngine) storage.set(ENGINE_STORAGE, "off");
    engineSelect.addEventListener("change", () => {
      storage.set(ENGINE_STORAGE, engineSelect.value);
      syncEngine();
    });
    syncEngine();

    function renderSummary(results, skipped) {
      const counts = { ...summarize(results), skipped: skipped.length };
      for (const [key, count] of Object.entries(counts)) {
        const node = root.querySelector(`[data-citation-count="${key}"]`);
        if (node) node.textContent = String(count);
      }
      const breakdown = Object.entries(insufficientBreakdown(results))
        .map(([code, count]) => `${insufficientReasonLabel(code) || code}: ${count}`).join(" · ");
      breakdownEl.hidden = !breakdown;
      breakdownEl.textContent = breakdown ? `Insufficient evidence — ${breakdown}` : "";
    }

    function renderSkipped(skipped) {
      skippedEl.hidden = !skipped.length;
      setHTML(skippedEl, skipped.length ? html`<h3>Skipped citations (${skipped.length})</h3>
        <ul>${skipped.map(item => html`<li data-skip-reason="${item.reason}">
          <code>${item.key || item.citation}</code> — ${skipReasonLabel(item.reason)}: <span>${item.sentence}</span>
        </li>`)}</ul>` : "");
    }

    function renderResults(results) {
      if (!results.length) {
        setHTML(resultsEl, html`<div class="citation-empty">No citation contexts found yet.</div>`);
        return;
      }
      const combined = combinedVerdicts(results);
      const cards = results.map(result => cardMarkup(result, combined.get(result.context.sentenceIndex)));
      setHTML(resultsEl, cards);
    }

    bindFileInput(root.querySelector("#citation-bib-file"), bibInput);
    bindFileInput(root.querySelector("#citation-manuscript-file"), manuscriptInput);

    root.querySelector("#btn-use-verifier-bib")?.addEventListener("click", () => {
      const verifierBib = document.getElementById("bib-paste");
      if (!bibInput || !verifierBib) return;
      if (isBlankText(verifierBib.value)) {
        setStatus("Verifier bibliography is empty.");
        return;
      }
      bibInput.value = verifierBib.value;
      setStatus("Copied bibliography from the verifier.");
    });

    const reportMarkdown = () => formatAuditMarkdown(report.results, { skipped: report.skipped });

    copyReportBtn.addEventListener("click", async () => {
      if (!report) return;
      try {
        await navigator.clipboard.writeText(reportMarkdown());
        setStatus("Copied Markdown audit report.");
      } catch {
        setStatus("Copy failed — clipboard access was denied.");
      }
    });

    downloadReportBtn.addEventListener("click", () => {
      if (!report) return;
      const url = URL.createObjectURL(new Blob([reportMarkdown()], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "citation-audit-report.md";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
      setStatus("Downloaded Markdown audit report.");
    });

    // Cancelling keeps the cards already shown; the report stays disabled
    // because it would look complete.
    cancelButton.addEventListener("click", () => {
      if (!current || !controller.isActive(current.run)) return;
      const checked = current.run.results.filter(Boolean).length;
      controller.cancelAudit("cancelled by user");
      cancelButton.hidden = true;
      setExportEnabled(false);
      setStatus(`Citation audit cancelled — ${checked} of ${plural(current.total, "citation")} checked. No report was made for this run.`);
    });

    runButton.addEventListener("click", async () => {
      const superseded = !!current && controller.isActive(current.run);
      const engine = engineSelect.value;
      const run = controller.startAudit({
        inputs: {
          bibText: bibInput?.value || "",
          manuscriptText: manuscriptInput?.value || "",
        },
        settings: {
          evidenceLanguage: currentEvidenceLanguage(),
          speedMode: currentSpeedMode(),
          provider: engine,
        },
      });
      const entries = parseBib(run.inputs.bibText);
      const plan = planAudit(run.inputs.manuscriptText, entries);
      const results = run.results;
      const note = superseded ? "The previous audit was superseded by this run. " : "";
      current = { run, total: plan.contexts.length };
      report = null;
      setExportEnabled(false);
      outputEl.hidden = false;
      renderResults([]);
      renderSummary([], plan.skipped);
      renderSkipped(plan.skipped);

      if (!entries.length) {
        cancelButton.hidden = true;
        setStatus(`${note}Add a BibTeX file before running citation support.`);
        return;
      }
      if (!plan.contexts.length) {
        cancelButton.hidden = true;
        report = { results: [], skipped: plan.skipped };
        setExportEnabled(plan.skipped.length > 0);
        setStatus(`${note}${plan.skipped.length
          ? `No citation could be checked; ${plural(plan.skipped.length, "citation")} skipped.`
          : "No LaTeX citation commands were found in the manuscript text."}`);
        return;
      }

      cancelButton.hidden = false;
      let aiUnavailable = "";
      try {
        if (engine === "vllm") {
          setStatus(`${note}Checking the vLLM server…`);
          const health = await Judge.health(engine, { signal: run.signal });
          if (!health?.ready) aiUnavailable = "The vLLM server is not ready; no AI judgement was made.";
        }
        if (!controller.isActive(run)) return;
        setStatus(`${note}Checking ${plural(plan.contexts.length, "citation")}…`);
        await runAuditContexts({
          runContext: run, contexts: plan.contexts, entriesByKey: plan.entriesByKey, controller, aiUnavailable,
          onStatus: (message, citationContext) => setStatus(`${citationContext.key}: ${message}`),
          onResult: (result, index) => {
            results[index] = result;
            const visible = results.filter(Boolean);
            setStatus(`Checked ${visible.length}/${plan.contexts.length}: ${result.context.key}`);
            renderSummary(visible, plan.skipped);
            renderResults(visible);
            syncEngine();
          },
        });
        if (!controller.isActive(run)) return;
        report = { results: results.filter(Boolean), skipped: plan.skipped };
        setExportEnabled(true);
        const skippedNote = plan.skipped.length ? `; ${plural(plan.skipped.length, "citation")} skipped` : "";
        setStatus(`${note}Finished ${plural(plan.contexts.length, "citation check")}${skippedNote}.`);
      } catch (error) {
        // A cancelled or superseded run says so where it was stopped.
        if (!run.signal.aborted && controller.isActive(run)) setStatus(`Citation audit stopped: ${error.message}`);
      } finally {
        if (current?.run === run) cancelButton.hidden = true;
        syncEngine();
      }
    });
  }

export {
  initCitationAudit,
};
