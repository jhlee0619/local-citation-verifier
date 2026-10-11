/*
 * The Live Preview: its debounced rebuilds, the drawer (open, close, resize,
 * jump-to-preview, autoscroll), the diff rendering, the export review dialog
 * and Copy / Download. main.js passes the session accessors to initPreview.
 */
import { html, setHTML, $, $$ } from "./dom.js?v=20261011-s14";
import { sessionStore, storage } from "./panels.js?v=20261011-s14";
import * as Out from "../core/output.js?v=20261011-s14";

  // ─── Scheduler ─────────────────────────────────────────────────────
  // Trailing-debounced preview rebuilds owned by the active run: a burst of
  // edits collapses into one rebuild after the interval.
  function createPreviewScheduler(options = {}) {
    const intervalMs = Math.max(0, Number(options.intervalMs || 0));
    const { isActive, updatePreview } = options;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    let timer = null;
    const owned = run => typeof isActive !== "function" || isActive(run);
    const clear = () => {
      if (timer) clearTimer(timer);
      timer = null;
    };
    return {
      schedule(run) {
        clear();
        timer = setTimer(() => {
          timer = null;
          if (owned(run)) updatePreview?.();
        }, intervalMs);
      },
      // Rebuilds now; any pending rebuild, for this or an older run, is dropped.
      flush(run, updateOptions) {
        clear();
        if (owned(run)) updatePreview?.(updateOptions);
      },
      clear,
    };
  }

  // ─── Page wiring ───────────────────────────────────────────────────
  const PREVIEW_INTERVAL_MS = 120;
  const COLLAPSED_KEY = "bv-preview-collapsed";
  const WIDTH_KEY = "bv-preview-width";
  const WIDTH_MIN = 288;
  // A download's blob URL stays valid long enough for the browser to start it.
  const BLOB_URL_LIFETIME_MS = 10_000;
  const COPIED_MS = 1500;
  const LINE_CLASS = { add: "diff-add", del: "diff-del", ctx: "diff-ctx" };

  let app = null;
  let el = null;
  let scheduler = null;
  let state = null;
  let mixedByIndex = new Map();
  let collapsed = false;
  let exportRevision = 0;
  let confirmationToken = "";
  let pendingAction = null;
  let returnFocus = null;
  let copiedTimer = 0;
  let copyLabel = null;
  let copyText = "";
  let overlayMedia = null;

  function currentRun() {
    return app.session()?.run || null;
  }

  // ─── Drawer ────────────────────────────────────────────────────────
  function syncDrawer() {
    const hasResults = el.column.classList.contains("visible");
    const open = hasResults && !collapsed;
    el.panel.classList.toggle("is-collapsed", !open);
    el.column.classList.toggle("is-open", open);
    el.column.setAttribute("aria-hidden", open ? "false" : "true");
    el.column.inert = !open;
    document.body.classList.toggle("preview-drawer-open", open);
    el.toggle.setAttribute("aria-expanded", open ? "true" : "false");
    el.toggle.title = open ? "Close Live BibTeX preview" : "Open Live BibTeX preview";
    el.toggle.querySelector(".btn-preview-toggle-text").textContent = open ? "Close" : "Open";
    el.showHandle.classList.toggle("visible", hasResults && !open);
    el.showHandle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setDrawerOpen(open, { focusControl = false } = {}) {
    collapsed = !open;
    sessionStore.set(COLLAPSED_KEY, open ? "0" : "1");
    syncDrawer();
    if (focusControl) requestAnimationFrame(() => (open ? el.toggle : el.showHandle).focus());
  }

  // The drawer exists while there are results to preview.
  function setVisible(visible) {
    el.column.classList.toggle("visible", visible);
    syncDrawer();
  }

  function initResize() {
    const handle = el.resize;
    const maxWidth = () => Math.max(WIDTH_MIN, Math.min(960, innerWidth - 320));
    const apply = px => {
      const clamped = Math.round(Math.min(maxWidth(), Math.max(WIDTH_MIN, px)));
      document.documentElement.style.setProperty("--preview-drawer-width", `${clamped}px`);
      handle.setAttribute("aria-valuenow", String(clamped));
      storage.set(WIDTH_KEY, String(clamped));
    };
    const reset = () => {
      document.documentElement.style.removeProperty("--preview-drawer-width");
      handle.removeAttribute("aria-valuenow");
      storage.remove(WIDTH_KEY);
    };
    handle.setAttribute("aria-valuemin", String(WIDTH_MIN));
    const stored = Number(storage.get(WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= WIDTH_MIN) apply(stored);
    let pointerId = null;
    handle.addEventListener("pointerdown", event => {
      if (!event.isPrimary) return;
      pointerId = event.pointerId;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("preview-resizing");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", event => {
      if (pointerId === event.pointerId) apply(innerWidth - event.clientX);
    });
    const end = event => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      document.body.classList.remove("preview-resizing");
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("dblclick", reset);
    handle.addEventListener("keydown", event => {
      const width = el.column.getBoundingClientRect().width;
      if (event.key === "ArrowLeft") apply(width + 24);
      else if (event.key === "ArrowRight") apply(width - 24);
      else if (event.key === "Home") reset();
      else return;
      event.preventDefault();
    });
  }

  function entryLine(entryIndex) {
    return $$(".diff-line[data-entry-index]", el.code).find(line => Number(line.dataset.entryIndex) === entryIndex) || null;
  }

  function scrollToLine(line, offset) {
    const body = el.code.closest(".preview-body");
    body.scrollTo({ top: line.offsetTop - body.offsetTop - offset(body), behavior: "smooth" });
  }

  function initNavigation() {
    document.addEventListener("click", event => {
      const button = event.target.closest(".btn-jump-preview");
      const entryIndex = Number(button?.dataset.entryIndex);
      if (!button || !Number.isInteger(entryIndex)) return;
      setDrawerOpen(true);
      requestAnimationFrame(() => {
        const target = entryLine(entryIndex);
        if (!target) return;
        scrollToLine(target, () => 40);
        const lines = [target];
        for (let next = target.nextElementSibling; next && !next.hasAttribute("data-entry-index"); next = next.nextElementSibling)
          lines.push(next);
        $$(".highlight-flash", el.code).forEach(line => line.classList.remove("highlight-flash"));
        void el.code.offsetWidth;
        lines.forEach(line => line.classList.add("highlight-flash"));
      });
    });

    // Autoscroll: the preview follows the card nearest the viewport middle.
    let autoScroll = true;
    let ticking = false;
    el.autoscroll.addEventListener("click", () => {
      autoScroll = !autoScroll;
      el.autoscroll.classList.toggle("active", autoScroll);
    });
    addEventListener("scroll", () => {
      if (autoScroll && ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!autoScroll || el.panel.classList.contains("is-collapsed")) return;
        const middle = innerHeight / 2;
        let best = null;
        let bestDistance = Infinity;
        for (const card of $$(".entry-card:not(.hidden)")) {
          const rect = card.getBoundingClientRect();
          const distance = Math.abs(rect.top + rect.height / 2 - middle);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = card;
          }
        }
        const target = best && entryLine(Number(best.dataset.index));
        if (target) scrollToLine(target, body => body.clientHeight / 2 - 20);
      });
    });

    el.toggle.addEventListener("click", () => setDrawerOpen(false, { focusControl: true }));
    el.showHandle.addEventListener("click", () => setDrawerOpen(true, { focusControl: true }));
    el.backdrop.addEventListener("click", () => setDrawerOpen(false, { focusControl: true }));
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !document.body.classList.contains("preview-drawer-open")) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setDrawerOpen(false, { focusControl: true });
    });
    overlayMedia.addEventListener("change", syncDrawer);
  }

  // ─── Rendering ─────────────────────────────────────────────────────
  function build(session) {
    return Out.buildPreviewState({
      document: session.document,
      parsedEntries: session.run.entries,
      results: session.run.results,
      decisions: session.run.decisions,
      fieldEdits: session.run.fieldEdits,
      settings: app.settings(),
    });
  }

  function invalidateExport() {
    exportRevision++;
    confirmationToken = "";
    pendingAction = null;
    if (el.dialog.open) el.dialog.close();
  }

  // options.invalidateExport: false when export preparation flushes pending
  // edits; that must not clear an in-flight confirmation or close the dialog.
  function update(options = {}) {
    const session = app.session();
    if (!session) return;
    if (options.invalidateExport !== false) invalidateExport();
    state = build(session);
    mixedByIndex = new Map(state.sourceIndexes.map((index, position) => [index, state.mixedWarnings[position]]));
    app.onPreview();
    const mixed = state.mixedWarnings.some(Boolean);
    let warning = $(".preview-mixed-source-warning", el.panel);
    if (mixed && !warning) {
      warning = document.createElement("div");
      warning.className = "review-hint preview-mixed-source-warning";
      warning.textContent = "Preview contains explicitly mixed title, author, or year sources.";
      el.code.before(warning);
    } else if (!mixed) warning?.remove();
    el.placeholder.style.display = "none";
    el.code.style.display = "block";
    setHTML(el.code, linesMarkup(Out.previewLines(state)));
  }

  // One span per diff line; an entry's first exported line carries
  // data-entry-index / data-entry-id for jump-to-preview.
  function linesMarkup(lines) {
    return lines.map(line => line.entryIndex === undefined
      ? html`<span class="diff-line ${LINE_CLASS[line.type]}">${line.text}</span>`
      : html`<span class="diff-line ${LINE_CLASS[line.type]}" data-entry-index="${line.entryIndex}" data-entry-id="${line.entryId}">${line.text}</span>`);
  }

  // Back to the empty placeholder (a new input, a cancelled run).
  function reset() {
    scheduler.clear();
    state = null;
    mixedByIndex = new Map();
    $(".preview-mixed-source-warning", el.panel)?.remove();
    el.placeholder.style.display = "flex";
    el.code.style.display = "none";
    el.code.textContent = "";
  }

  const schedule = () => scheduler.schedule(currentRun());
  const flush = options => scheduler.flush(currentRun(), options);
  const mixedFor = index => mixedByIndex.get(index) === true;

  // ─── Export ────────────────────────────────────────────────────────
  function prepare(action) {
    flush({ invalidateExport: false });
    const session = app.session();
    const prepared = Out.prepareExport({
      document: session.document,
      entries: session.run.entries,
      results: session.run.results,
      decisions: session.run.decisions,
      fieldEdits: session.run.fieldEdits,
      settings: app.settings(),
      runId: session.run.id,
      revision: exportRevision,
    });
    const { readiness } = prepared;
    const acknowledgements = readiness.unsafe.length + readiness.notFound.length + readiness.notices.length +
      readiness.unconfirmed.length + readiness.invalid.length;
    state = prepared.state;
    return {
      action,
      bib: state.bib,
      readiness,
      acknowledgements,
      authorized: !readiness.unresolved.length &&
        (!acknowledgements || confirmationToken === readiness.token),
    };
  }

  const NOTICE_WORDS = {
    retraction: "a retraction",
    partial_retraction: "a partial retraction",
    withdrawal: "a withdrawal",
    removal: "a removal",
    expression_of_concern: "an expression of concern",
  };

  function issueReason(item, unsafe) {
    if (item.code === "not_found_ack")
      return "Not found: no matching publication record; it will be exported unchanged.";
    if (item.code === "notice_ack") {
      const where = notice => notice.doi ? ` (notice ${notice.doi}${notice.date ? `, ${notice.date}` : ""})`
        : notice.pmid ? ` (notice PMID ${notice.pmid})`
          : notice.source === "pubmed" ? " (PubMed publication type)" : " (stamped in the record's title)";
      const notices = item.notices.map(notice => `${NOTICE_WORDS[notice.type] || notice.type}${where(notice)}`);
      const listers = Out.noticeListers(item.notices);
      return `Flagged: ${listers} ${listers.includes(" and ") ? "list" : "lists"} ${notices.join("; ")} for this work. It will be exported as chosen.`;
    }
    if (item.code === "unconfirmed_ack")
      return "Semantic Scholar only: no Crossref, PubMed, arXiv, DBLP or OpenReview record confirms the chosen record. It will be exported as chosen.";
    if (item.code === "invalid_ack")
      return `Not parsed (line ${item.line}, column ${item.column}): ${item.message} It is exported verbatim, unverified.`;
    if (unsafe) return item.message || `Output issue: ${item.code}`;
    if (item.code === "stale_candidate_decision") return "The selected candidate is no longer available. Choose again.";
    return "Decision required: choose a candidate, keep the original, or exclude this entry.";
  }

  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  function showExportReview(prepared) {
    const { unresolved, unsafe, notFound, notices, unconfirmed, invalid } = prepared.readiness;
    const blockedByDecision = unresolved.length > 0;
    const acknowledgeOnly = !blockedByDecision && !unsafe.length;
    const items = blockedByDecision ? unresolved : [...unsafe, ...notices, ...unconfirmed, ...notFound, ...invalid];
    const unchanged = [
      notices.length ? `${plural(notices.length, "entry cites a work", "entries cite works")} that Crossref or PubMed lists as retracted, withdrawn, removed or under an expression of concern.` : "",
      unconfirmed.length ? `${plural(unconfirmed.length, "entry uses a record", "entries use records")} that only Semantic Scholar lists, not confirmed by Crossref, PubMed, arXiv, DBLP or OpenReview.` : "",
      notFound.length ? `${plural(notFound.length, "entry was", "entries were")} not found in any metadata provider and will be exported unchanged.` : "",
      invalid.length ? `${plural(invalid.length, "entry", "entries")} could not be parsed and will be exported verbatim, unverified.` : "",
    ].filter(Boolean).join(" ");
    pendingAction = prepared.action;
    returnFocus = document.activeElement;
    el.kicker.textContent = blockedByDecision ? "Decision required"
      : !acknowledgeOnly ? "Unsafe output" : notices.length ? "Flagged works"
        : unconfirmed.length ? "Unconfirmed records" : invalid.length ? "Exported unchanged" : "Not found";
    el.title.textContent = blockedByDecision ? "Resolve entries before export"
      : !acknowledgeOnly ? "Review integrity issues before export"
        : notices.length ? "Confirm citing retracted or flagged works"
          : unconfirmed.length ? "Confirm records only Semantic Scholar lists"
            : invalid.length ? "Confirm entries exported unchanged" : "Confirm entries that were not found";
    el.summary.textContent = blockedByDecision
      ? `${plural(unresolved.length, "review entry is", "review entries are")} still pending. No ${prepared.action} action was performed.`
      : acknowledgeOnly
        ? `${unchanged} Confirm once to export them all.`
        : `${plural(unsafe.length, "final-output issue remains", "final-output issues remain")}. ${unchanged ? `${unchanged} ` : ""}Export only if you intentionally accept this exact projected metadata.`;
    setHTML(el.list, items.map(item => html`<li><span class="export-review-entry-key">${item.key || (Number.isInteger(item.index) ? String(item.index) : "(no citation key)")}</span><span class="export-review-entry-reason">${issueReason(item, !blockedByDecision)}</span></li>`));
    el.dialog.dataset.firstIndex = String(items.find(item => Number.isInteger(item.index))?.index ?? "");
    el.confirm.classList.toggle("hidden", blockedByDecision);
    el.close.textContent = "Review entries";
    if (!el.dialog.open) el.dialog.showModal();
    el.close.focus();
  }

  function closeExportReview({ focusEntry = false } = {}) {
    const firstIndex = el.dialog.dataset.firstIndex ? Number(el.dialog.dataset.firstIndex) : NaN;
    const drawerWasOpen = document.body.classList.contains("preview-drawer-open");
    if (el.dialog.open) el.dialog.close();
    pendingAction = null;
    if (focusEntry && Number.isInteger(firstIndex)) {
      if (drawerWasOpen && overlayMedia.matches) setDrawerOpen(false);
      app.focusEntry(firstIndex);
    } else {
      returnFocus?.focus?.();
    }
  }

  // Copies through the Clipboard API, else (non-secure origins such as
  // http://<lan-host>, or a denied permission) through a hidden textarea and
  // execCommand("copy"). The textarea holds the exact export; the preview
  // itself also shows deleted lines.
  async function copy(text) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      const focused = document.activeElement;
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      try {
        copied = document.execCommand("copy") === true;
      } catch {
        copied = false;
      }
      area.remove();
      focused?.focus?.();
    }
    if (!copied) {
      alert("Copy failed: this browser blocked clipboard access on this page (it needs https or localhost). Use Download Corrected .bib instead.");
      return;
    }
    el.copy.classList.add("copied");
    copyLabel.nodeValue = copyText.replace("Copy", "Copied!");
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      el.copy.classList.remove("copied");
      copyLabel.nodeValue = copyText;
    }, COPIED_MS);
  }

  function download(text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/x-bibtex" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "verified_refs.bib";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
  }

  // Copy and Download share one gate: the run (with its AI reranks) has
  // completed, then the same readiness and confirmation.
  function exportAction(action) {
    if (!app.exportAllowed()) return;
    const prepared = prepare(action);
    if (!prepared.authorized) {
      showExportReview(prepared);
      return;
    }
    closeExportReview();
    if (action === "copy") copy(prepared.bib);
    else download(prepared.bib);
  }

  function setExportEnabled(enabled) {
    el.copy.disabled = !enabled;
  }

  function initExport() {
    copyLabel = [...el.copy.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.nodeValue.includes("Copy"));
    copyText = copyLabel.nodeValue;
    el.copy.addEventListener("click", () => exportAction("copy"));
    el.close.addEventListener("click", () => closeExportReview({ focusEntry: true }));
    el.dialog.addEventListener("close", () => { pendingAction = null; });
    el.dialog.addEventListener("cancel", event => {
      event.preventDefault();
      closeExportReview();
    });
    el.confirm.addEventListener("click", () => {
      const action = pendingAction;
      if (!action || !app.exportAllowed()) return;
      const prepared = prepare(action);
      if (prepared.readiness.unresolved.length || !prepared.acknowledgements) {
        if (prepared.authorized) exportAction(action);
        else showExportReview(prepared);
        return;
      }
      confirmationToken = prepared.readiness.token;
      exportAction(action);
    });
  }

  // host: session() → { document, run } while its run is active, else null;
  // settings(); exportAllowed(); focusEntry(index); onPreview() after each
  // rebuild (mixedFor answers for the new state).
  function initPreview(host) {
    app = host;
    el = {
      column: $("#col-preview"),
      panel: $("#preview-panel"),
      toggle: $("#btn-preview-toggle"),
      showHandle: $("#preview-show-handle"),
      backdrop: $("#preview-drawer-backdrop"),
      resize: $("#preview-resize-handle"),
      autoscroll: $("#btn-autoscroll"),
      code: $("#preview-code"),
      placeholder: $(".preview-placeholder"),
      copy: $("#btn-copy-preview"),
      dialog: $("#export-review-dialog"),
      kicker: $("#export-review-kicker"),
      title: $("#export-review-title"),
      summary: $("#export-review-summary"),
      list: $("#export-review-list"),
      close: $("#export-review-close"),
      confirm: $("#export-review-confirm"),
    };
    overlayMedia = matchMedia("(max-width: 1200px)");
    collapsed = sessionStore.get(COLLAPSED_KEY) === "1";
    scheduler = createPreviewScheduler({
      intervalMs: PREVIEW_INTERVAL_MS,
      isActive: run => !!run && app.session()?.run === run,
      updatePreview: update,
    });
    initResize();
    initNavigation();
    initExport();
    setExportEnabled(false);
    syncDrawer();
  }

export {
  createPreviewScheduler,
  linesMarkup,
  initPreview,
  setVisible,
  setDrawerOpen,
  update,
  reset,
  schedule,
  flush,
  mixedFor,
  invalidateExport,
  exportAction,
  setExportEnabled,
};
