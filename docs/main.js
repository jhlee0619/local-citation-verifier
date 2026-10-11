// Entry module: wires the ui/ modules to core/verify.js and owns the
// verification session (start, retry, cancel) and the user's decisions.
import * as Bib from "./core/bibtex.js?v=20261012-s15";
import * as Formats from "./core/formats.js?v=20261012-s15";
import * as Net from "./core/net.js?v=20261012-s15";
import * as Prov from "./core/providers.js?v=20261012-s15";
import * as D from "./core/verify.js?v=20261012-s15";
import * as Out from "./core/output.js?v=20261012-s15";
import { $ } from "./ui/dom.js?v=20261012-s15";
import * as Cards from "./ui/cards.js?v=20261012-s15";
import * as Preview from "./ui/preview.js?v=20261012-s15";
import * as Panels from "./ui/panels.js?v=20261012-s15";
import { initCitationAudit } from "./ui/audit-view.js?v=20261012-s15";

  const controller = D.defaultController;
  const RESOLVED = { isReviewResolved: D.isReviewResolved };
  const metadataCache = Net.createTtlCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 512 });
  // One GET /api/health at startup on proxy origins (never on GitHub Pages):
  // without the proxy, the banner shows and every lookup is lookup_failed.
  const proxyHealth = Prov.USE_METADATA_PROXY ? Prov.checkProxyHealth() : null;
  const providers = Prov.createProviderAdapters({
    metadataCache,
    arxivCache: Net.createTtlCache({ ttlMs: 7 * 24 * 60 * 60 * 1000, maxEntries: 256 }),
    endpoints: Prov.ENDPOINTS,
    proxyHealth: proxyHealth && (() => proxyHealth),
  });

  // The verification session: the parsed document and the run that holds
  // its results, decisions and field edits; while a retry runs, also the
  // state the retry started from (beforeRetry), restored if it is cancelled.
  let session = null;

  const active = () => (session && controller.isActive(session.run) ? session : null);
  const exportAllowed = () => active()?.run.completed === true;

  const el = {
    entries: $(".entry-list"),
    results: $(".results-section"),
    parseErrors: $("#parse-error-list"),
    formatNotice: $("#input-format-notice"),
    bar: $("#floating-bar"),
    progress: $("#bar-progress"),
    fill: $(".bar-progress-fill"),
    text: $(".bar-progress-text"),
    download: $("#btn-download"),
    cancel: $("#btn-cancel-verification"),
    retry: $("#btn-retry-failed"),
    paste: $("#bib-paste"),
  };

  // ─── Cards ─────────────────────────────────────────────────────────
  function cardView(run, index, maxAuthors = Panels.getSettings().maxAuthors) {
    return {
      entry: run.entries[index],
      decision: run.decisions[index] || D.originalDecision(false),
      edits: run.fieldEdits[index] || {},
      maxAuthors,
      lang: run.settings.evidenceLanguage,
      mixed: Preview.mixedFor(index),
    };
  }

  const cardAt = index => el.entries.querySelector(`.entry-card[data-index="${index}"]`);

  // Cards stay in entry order whatever order the lookups finish in.
  function renderEntry(index, maxAuthors) {
    const run = session.run;
    const card = Cards.renderCard(run.results[index], cardView(run, index, maxAuthors));
    Panels.applyCardVisibility(card);
    const existing = cardAt(index);
    const last = el.entries.lastElementChild;
    if (existing) existing.replaceWith(card);
    else if (!last || Number(last.dataset.index) < index) el.entries.append(card);
    else el.entries.insertBefore(card, [...el.entries.children].find(other => Number(other.dataset.index) > index));
    Panels.updateEntryEmptyState();
  }

  function renderAll() {
    const maxAuthors = Panels.getSettings().maxAuthors;
    session.run.results.forEach((result, index) => { if (result) renderEntry(index, maxAuthors); });
  }

  function pendingReviews() {
    const run = session?.run;
    if (!run) return [];
    return run.results.filter((result, index) => !!result && !D.isReviewResolved({
      review_required: result.review_required,
      decision: run.decisions[index] || D.originalDecision(false),
      candidates: result.candidate_choices || [],
    }));
  }

  function updateSummary() {
    const run = session?.run;
    Panels.updateSummary(run ? Out.summaryCounts(run.results, run.decisions, RESOLVED)
      : { verified: 0, updated: 0, needs_review: 0, not_found: 0, duplicates: 0 }, pendingReviews().length);
  }

  function focusEntry(index) {
    Panels.showAllEntries();
    const card = cardAt(Number(index));
    if (!card) return;
    card.tabIndex = -1;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.focus({ preventScroll: true });
  }

  function focusPending(delta) {
    const pending = pendingReviews();
    if (!pending.length) return;
    const focused = Number(document.activeElement?.closest?.(".entry-card")?.dataset.index);
    let position = pending.findIndex(result => result.index === focused);
    if (position < 0) position = delta > 0 ? -1 : 0;
    focusEntry(pending[(position + delta + pending.length) % pending.length].index);
  }

  function choose(index, choice) {
    const current = active();
    if (!current || !D.applyChoice(current.run, index, choice)) return;
    renderEntry(index);
    updateSummary();
    Preview.schedule();
  }

  function keepOriginalForAllPending() {
    const pending = pendingReviews();
    if (!pending.length) return;
    if (!confirm(`Keep the original BibTeX for ${pending.length} pending review ${pending.length === 1 ? "entry" : "entries"}?`))
      return;
    pending.forEach(result => choose(result.index, { action: "original" }));
  }

  // ─── Run lifecycle ─────────────────────────────────────────────────
  const failedIndices = results => results.flatMap((result, index) => result?.status === "lookup_failed" ? [index] : []);

  function syncRunControls() {
    const run = active()?.run;
    const failed = run ? failedIndices(run.results).length : 0;
    el.retry.classList.toggle("hidden", failed === 0);
    el.retry.disabled = failed === 0 || !run.completed;
    el.retry.textContent = failed > 0 ? `Retry failed lookups (${failed})` : "Retry failed lookups";
    Preview.setExportEnabled(exportAllowed());
  }

  function showProgress(text) {
    el.bar.classList.add("visible");
    el.progress.classList.add("active");
    el.progress.classList.remove("fade-out");
    el.fill.style.width = "0%";
    el.fill.classList.remove("done");
    el.text.textContent = text;
    el.download.disabled = true;
    el.cancel.classList.remove("hidden");
  }

  async function runAndShow(run, { indices, progressLabel = "Verified", doneLabel } = {}) {
    const outcome = await D.runVerification(run, {
      providers,
      controller,
      onRerankStatus: Panels.setRerankStatus,
      onProgress: (completed, total, result) => {
        el.fill.style.width = `${Math.round((completed / Math.max(1, total)) * 100)}%`;
        el.text.textContent = `${progressLabel} ${completed} / ${total}: ${(result.title || "").slice(0, 50)}…`;
      },
      onResult: index => {
        renderEntry(index);
        updateSummary();
        Preview.schedule();
        syncRunControls();
      },
      onFinalizing: count => {
        el.text.textContent = `Finalizing ${count} AI rerank${count === 1 ? "" : "s"}…`;
      },
    }, { indices });

    if (outcome.state === "rerank_failed") {
      console.error("AI rerank finalization failed:", outcome.error);
      el.text.textContent = "Verification stopped during AI rerank finalization.";
      syncRunControls();
      return;
    }
    if (outcome.state !== "completed" || !controller.isActive(run)) return;
    Preview.flush();
    run.completed = true;
    session.beforeRetry = null;
    el.fill.classList.add("done");
    el.text.textContent = doneLabel || `Done — ${run.entries.length} entries verified`;
    el.cancel.classList.add("hidden");
    syncRunControls();
    setTimeout(() => {
      if (!controller.isActive(run)) return;
      el.progress.classList.add("fade-out");
      setTimeout(() => {
        if (!controller.isActive(run)) return;
        el.progress.classList.remove("active", "fade-out");
        el.download.disabled = false;
        el.download.classList.remove("hidden");
        el.download.classList.add("fade-in");
        syncRunControls();
      }, 350);
    }, 800);
  }

  // A new input replaces the session only if it has at least one entry;
  // otherwise the parse errors are shown and the current session stays.
  // RIS and MEDLINE (.nbib) exports are converted to BibTeX first
  // (core/formats.js); the session then holds that BibTeX document.
  function startFromContent(content) {
    const converted = Formats.convertToBibtex(content);
    const parsed = Bib.parseBibDocument(converted ? converted.text : content);
    if (!parsed.entries.length) {
      alert(parsed.errors.length
        ? `BibTeX parse errors (${parsed.errors.length}). Nothing was verified or exported.\n\n${Cards.parseErrorLines(parsed.errors).join("\n")}`
        : "No BibTeX entries found. Make sure the content contains valid @type{key, ...} entries.");
      return;
    }
    controller.cancelVerification("superseded by new input");
    Preview.invalidateExport();
    Preview.reset();
    Panels.resetResults();
    el.entries.replaceChildren();
    providers.resetRateState();
    document.querySelectorAll(".info-section").forEach(section => { section.style.display = "none"; });
    Cards.showParseErrors(el.parseErrors, parsed.errors);
    el.formatNotice.hidden = !converted;
    el.formatNotice.textContent = converted
      ? `Converted ${converted.count} ${converted.format === "ris" ? "RIS" : "MEDLINE"} ${converted.count === 1 ? "record" : "records"} to BibTeX.`
      : "";
    showProgress(`Verifying 0 / ${parsed.entries.length} entries...`);
    el.download.classList.add("hidden");
    el.download.classList.remove("fade-in");

    const run = controller.startVerification({ entries: parsed.entries, settings: Panels.runSettings() });
    D.initRunState(run);
    session = { document: parsed, run, beforeRetry: null };
    Preview.setVisible(true);
    el.results.style.display = "block";
    syncRunControls();
    runAndShow(run);
  }

  function retryFailedLookups() {
    const current = active();
    if (!current?.run.completed) return;
    const indices = failedIndices(current.run.results);
    if (!indices.length) return;
    const before = current.run;
    const beforeRetry = {
      retained: D.retainForRetry(before, before.results, before.decisions, before.fieldEdits),
      settings: before.settings,
    };
    Preview.invalidateExport();
    metadataCache.clear();
    providers.resetRateState();
    showProgress(`Retrying failed lookups 0 / ${indices.length}…`);

    const run = controller.startVerification({ entries: before.entries, settings: Panels.runSettings() });
    D.seedRetryRun(run, beforeRetry.retained, indices);
    session = { document: current.document, run, beforeRetry };
    syncRunControls();
    runAndShow(run, {
      indices,
      progressLabel: "Retrying failed lookups",
      doneLabel: `Done — retried ${indices.length} failed lookup${indices.length === 1 ? "" : "s"}`,
    });
  }

  // Cancelling a retry restores the session it started from: the retried
  // entries are lookup_failed again, every other result, decision and field
  // edit is as it was. Cancelling a verification clears it.
  function cancelVerification() {
    const cancelled = controller.cancelVerification("cancelled by user");
    if (!cancelled || cancelled !== session?.run) return;
    Preview.invalidateExport();
    el.fill.classList.remove("done");
    el.cancel.classList.add("hidden");
    if (session.beforeRetry) {
      const { retained, settings } = session.beforeRetry;
      const run = controller.startVerification({ entries: cancelled.entries, settings });
      D.seedRetryRun(run, retained, []);
      run.completed = true;
      session = { document: session.document, run, beforeRetry: null };
      renderAll();
      updateSummary();
      Preview.update();
      el.text.textContent = "Cancelled — retry stopped; the previous results were kept";
      el.download.disabled = false;
      el.download.classList.remove("hidden");
    } else {
      D.clearRunResults(cancelled);
      session = null;
      Preview.reset();
      Preview.setVisible(false);
      el.entries.replaceChildren();
      updateSummary();
      el.text.textContent = "Cancelled — no pending lookup result was published";
      el.download.disabled = true;
      el.download.classList.add("hidden");
    }
    syncRunControls();
  }

  // ─── Wiring ────────────────────────────────────────────────────────
  let inputIntentId = 0;

  function initInput() {
    const zone = $(".upload-zone");
    const fileInput = $("#file-input");
    const handleFile = async file => {
      if (!/\.(?:bib|ris|nbib|txt)$/i.test(file.name)) {
        alert("Please upload a .bib, .ris, .nbib or .txt file.");
        return;
      }
      const intentId = ++inputIntentId;
      const content = await file.text();
      if (intentId === inputIntentId) startFromContent(content);
    };
    zone.addEventListener("click", () => fileInput.click());
    zone.addEventListener("dragover", event => {
      event.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", event => {
      event.preventDefault();
      zone.classList.remove("dragover");
      if (event.dataTransfer.files[0]) handleFile(event.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files[0]) handleFile(fileInput.files[0]);
    });
    $("#btn-verify-paste").addEventListener("click", () => {
      inputIntentId++;
      if (!el.paste.value.trim()) {
        alert("Please paste your BibTeX, RIS or MEDLINE content first.");
        return;
      }
      startFromContent(el.paste.value);
    });
  }

  Panels.initTheme();
  Panels.initBanners(proxyHealth);
  Panels.initTabs();
  Preview.initPreview({
    session: active,
    settings: Panels.getSettings,
    exportAllowed,
    focusEntry,
    onPreview: () => {
      for (const card of el.entries.children) Cards.syncMixedWarning(card, Preview.mixedFor(Number(card.dataset.index)));
    },
  });
  Panels.initSettings({
    previewNow: () => Preview.update(),
    previewSoon: () => Preview.schedule(),
    maxAuthorsChanged: () => {
      if (!active()) return;
      renderAll();
      updateSummary();
      Preview.schedule();
    },
  });
  Panels.initToolbar({
    hasResults: () => !!active(),
    focusPending,
    focusFirstPending: () => {
      const first = pendingReviews()[0];
      if (first) focusEntry(first.index);
    },
    keepOriginalForAllPending,
  });
  Cards.bindCardEvents(el.entries, {
    choose,
    edit: (index, field, action, value, extra) => {
      const current = active();
      if (!current?.run.results[index]) return;
      D.editField(current.run, index, field, action, value, extra);
      Preview.schedule();
    },
    entryState: index => ({
      status: session?.run.results[index]?.status,
      edits: session?.run.fieldEdits[index] || {},
    }),
  });
  initInput();
  el.download.disabled = true;
  el.download.addEventListener("click", () => {
    if (!el.download.disabled) Preview.exportAction("download");
  });
  el.cancel.addEventListener("click", cancelVerification);
  el.retry.addEventListener("click", () => {
    if (!el.retry.disabled) retryFailedLookups();
  });

  // boot.js shows a reload notice if this flag is missing after load.
  document.documentElement.dataset.appReady = "1";

  // The citation audit initialises on DOMContentLoaded, after this module, so
  // an audit init error cannot abort the verifier.
  if (document.readyState !== "complete") document.addEventListener("DOMContentLoaded", initCitationAudit);
  else initCitationAudit();
