/*
 * Page panels: the one guarded storage wrapper, theme, the proxy and Pages
 * banners, input tabs, the settings popover (persisted bv-* settings, the AI
 * rerank engine) and the results toolbar (summary badges, filters, search
 * and hotkeys).
 */
import { $, $$ } from "./dom.js?v=20261012-s15";
import { normalizeEvidenceLanguage } from "../core/text.js?v=20261012-s15";
import { ON_GITHUB_PAGES, USE_METADATA_PROXY } from "../core/providers.js?v=20261012-s15";
import * as Judge from "../core/judge.js?v=20261012-s15";
import { summaryStatus } from "../core/output.js?v=20261012-s15";
import { verificationConcurrency } from "../core/verify.js?v=20261012-s15";

  // ─── Storage ───────────────────────────────────────────────────────
  // Every storage access goes through here. A browser that blocks storage
  // (privacy settings, sandboxed frames) throws on access; the app then runs
  // without persistence.
  function guardedStorage(name) {
    const area = () => {
      try {
        return globalThis[name] || null;
      } catch {
        return null;
      }
    };
    return {
      get(key) {
        try {
          return area()?.getItem(key) ?? null;
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          area()?.setItem(key, String(value));
        } catch { /* not persisted */ }
      },
      remove(key) {
        try {
          area()?.removeItem(key);
        } catch { /* not persisted */ }
      },
    };
  }

  const storage = guardedStorage("localStorage");
  const sessionStore = guardedStorage("sessionStorage");

  // ─── Theme, banners, tabs ──────────────────────────────────────────
  function initTheme() {
    const root = document.documentElement;
    const apply = theme => {
      root.setAttribute("data-theme", theme);
      storage.set("bv-theme", theme);
    };
    apply(storage.get("bv-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
    $("#theme-toggle").addEventListener("click", () => apply(root.getAttribute("data-theme") === "dark" ? "light" : "dark"));
  }

  // On any non-github.io origin the app expects the local metadata proxy at
  // /api/*. proxyHealth is main.js's one GET /api/health check at startup
  // (providers.checkProxyHealth); when it fails (a plain static server's 404
  // or HTML page, a network error) the banner shows, and the lookups fail as
  // lookup_failed (proxy_missing) instead of reading 404s as Not Found.
  function initBanners(proxyHealth) {
    $("#pages-provider-banner").hidden = !ON_GITHUB_PAGES;
    const banner = $("#proxy-status-banner");
    if (!banner || !USE_METADATA_PROXY || !proxyHealth) return;
    proxyHealth.then(ok => { banner.hidden = ok === true; });
  }

  function initTabs() {
    const tabs = $$(".input-tab");
    const panels = $$(".tab-panel");
    for (const tab of tabs) tab.addEventListener("click", () => {
      tabs.forEach(other => other.classList.toggle("active", other === tab));
      panels.forEach(panel => panel.classList.toggle("active", panel.id === `tab-${tab.dataset.tab}`));
    });
  }

  // ─── Settings ──────────────────────────────────────────────────────
  const CHECKBOXES = [
    ["opt-remove-duplicates", "bv-remove-duplicates"],
    ["opt-remove-notfound", "bv-remove-notfound"],
    ["opt-prefer-published", "bv-prefer-published"],
    ["opt-latex-escape", "bv-latex-escape"],
    ["opt-local-gpu-rerank", "bv-local-gpu-rerank"],
  ];

  function normalizeSpeedMode(value) {
    const mode = String(value || "").toLowerCase();
    return ["fast", "balanced", "thorough"].includes(mode) ? mode : "balanced";
  }

  const control = id => document.getElementById(id);
  const getSpeedMode = () => normalizeSpeedMode(control("opt-speed-mode").value);
  const getEvidenceLanguage = () => normalizeEvidenceLanguage(control("opt-evidence-language").value);
  const getRerankProvider = () => control("opt-local-gpu-rerank").checked ? control("opt-rerank-provider").value || "vllm" : "off";

  // Export settings, read when the preview is built.
  function getSettings() {
    return {
      removeDuplicates: control("opt-remove-duplicates").checked,
      dedupBy: ($('input[name="dedup-criteria"]:checked') || {}).value || "title",
      removeNotFound: control("opt-remove-notfound").checked,
      maxAuthors: parseInt(control("opt-max-authors").value) || 0,
      preferPublished: control("opt-prefer-published").checked,
      latexEscape: control("opt-latex-escape").checked,
    };
  }

  // The settings a verification run freezes when it starts.
  function runSettings() {
    const speedMode = getSpeedMode();
    return {
      ...getSettings(),
      speedMode,
      rerankProvider: getRerankProvider(),
      evidenceLanguage: getEvidenceLanguage(),
      concurrency: verificationConcurrency(speedMode),
    };
  }

  function setRerankStatus(message) {
    control("gpu-rerank-status").textContent = message;
  }

  function describeRerankProvider() {
    const provider = getRerankProvider();
    if (provider === "off") return "Off · uses heuristic matching";
    return "On · vLLM server rerank";
  }

  async function detectVllmServer() {
    const health = await Judge.health("vllm");
    if (!health?.ready) return;
    control("opt-rerank-provider").value = "vllm";
    setRerankStatus(`Available · vLLM server ready${health.model ? ` (${health.model})` : ""}; enable AI rerank to use it`);
  }

  // hooks: previewNow() rebuilds the preview, previewSoon() schedules it,
  // maxAuthorsChanged() re-renders the cards.
  function initSettings(hooks) {
    const toggle = control("settings-toggle");
    const popover = control("settings-popover");
    const dedupWrap = control("dedup-criteria-wrap");
    const maxAuthors = control("opt-max-authors");
    const provider = control("opt-rerank-provider");
    const language = control("opt-evidence-language");
    const speed = control("opt-speed-mode");
    const radios = $$('input[name="dedup-criteria"]');
    const hasOption = (select, value) => [...select.options].some(option => option.value === value);

    storage.remove("bv-enable-local-curation"); // a removed setting
    for (const [id, key] of CHECKBOXES) {
      const box = control(id);
      const stored = storage.get(key);
      if (stored != null) box.checked = stored === "1";
      box.addEventListener("change", () => storage.set(key, box.checked ? "1" : "0"));
    }
    language.value = normalizeEvidenceLanguage(storage.get("bv-evidence-language") || language.value);
    speed.value = normalizeSpeedMode(storage.get("bv-speed-mode") || speed.value);
    const storedMax = storage.get("bv-max-authors");
    if (storedMax != null && hasOption(maxAuthors, storedMax)) maxAuthors.value = storedMax;
    const storedProvider = storage.get("bv-rerank-provider");
    // A stored engine that no longer exists (a retired browser engine) means the default.
    if (storedProvider && hasOption(provider, storedProvider)) provider.value = storedProvider;
    else if (storedProvider) storage.set("bv-rerank-provider", provider.value);
    const storedDedup = storage.get("bv-dedup-by");
    const radio = storedDedup && radios.find(item => item.value === storedDedup);
    if (radio) radio.checked = true;
    dedupWrap.classList.toggle("visible", control("opt-remove-duplicates").checked);

    toggle.addEventListener("click", event => {
      event.stopPropagation();
      toggle.classList.toggle("active", popover.classList.toggle("open"));
    });
    document.addEventListener("click", event => {
      if (popover.contains(event.target) || event.target === toggle) return;
      popover.classList.remove("open");
      toggle.classList.remove("active");
    });

    control("opt-remove-duplicates").addEventListener("change", event => {
      dedupWrap.classList.toggle("visible", event.target.checked);
      hooks.previewSoon();
    });
    for (const id of ["opt-remove-notfound", "opt-prefer-published", "opt-latex-escape"])
      control(id).addEventListener("change", () => hooks.previewNow());
    const rerankChanged = () => setRerankStatus(describeRerankProvider());
    control("opt-local-gpu-rerank").addEventListener("change", rerankChanged);
    provider.addEventListener("change", () => {
      storage.set("bv-rerank-provider", provider.value || "vllm");
      rerankChanged();
    });
    language.addEventListener("change", () => storage.set("bv-evidence-language", getEvidenceLanguage()));
    speed.addEventListener("change", () => storage.set("bv-speed-mode", getSpeedMode()));
    maxAuthors.addEventListener("change", () => {
      storage.set("bv-max-authors", maxAuthors.value || "0");
      hooks.maxAuthorsChanged();
    });
    for (const item of radios) item.addEventListener("change", () => {
      storage.set("bv-dedup-by", item.value || "title");
      hooks.previewNow();
    });

    if (USE_METADATA_PROXY) { detectVllmServer(); }
  }

  // ─── Results toolbar: summary, filters, search, hotkeys ────────────
  let activeFilter = "all";
  let activeSearch = "";

  function cardMatches(card) {
    const status = card.dataset.status;
    const filterOk = activeFilter === "all" ||
      (activeFilter === "duplicate" ? card.dataset.duplicate === "true"
        : status === activeFilter || (activeFilter === "needs_review" && summaryStatus(status) === "needs_review"));
    if (!filterOk || !activeSearch) return filterOk;
    const hay = card.dataset.searchHay || "";
    return activeSearch.split(/\s+/).filter(Boolean).every(token => {
      if (token.startsWith("title:")) return hay.includes(token.slice(6));
      if (token.startsWith("id:") || token.startsWith("key:"))
        return hay.split(" ", 1)[0].includes(token.slice(token.indexOf(":") + 1));
      return hay.includes(token);
    });
  }

  function applyCardVisibility(card) {
    card.classList.toggle("hidden", !cardMatches(card));
  }

  function updateEntryEmptyState() {
    const cards = $$(".entry-card");
    control("entry-empty").classList.toggle("visible", cards.length > 0 && cards.every(card => card.classList.contains("hidden")));
  }

  function applyAllCardVisibility() {
    $$(".entry-card").forEach(applyCardVisibility);
    updateEntryEmptyState();
  }

  function setSearch(value) {
    activeSearch = (value || "").trim().toLowerCase();
    $(".entry-search").classList.toggle("has-query", !!activeSearch);
    applyAllCardVisibility();
  }

  // A new input: no filter, no search, zero counts.
  function resetResults() {
    activeFilter = "all";
    activeSearch = "";
    control("entry-search-input").value = "";
    $(".entry-search").classList.remove("has-query");
    $$(".summary-count").forEach(element => { element.textContent = "0"; });
    control("entry-empty").classList.remove("visible");
  }

  function showAllEntries() {
    activeFilter = "all";
    $$(".summary-badge").forEach(badge => badge.classList.add("active"));
    applyAllCardVisibility();
  }

  function updateSummary(counts, pending) {
    $(".badge-verified .summary-count").textContent = counts.verified;
    $(".badge-updated .summary-count").textContent = counts.updated;
    $(".badge-review .summary-count").textContent = counts.needs_review;
    $(".badge-notfound .summary-count").textContent = counts.not_found;
    $(".badge-duplicates .summary-count").textContent = counts.duplicates;
    control("unresolved-review-summary").textContent = `${pending} pending`;
    const keep = control("btn-keep-original-pending");
    keep.classList.toggle("hidden", pending === 0);
    keep.disabled = pending === 0;
    $$(".summary-badge").forEach(badge => badge.classList.add("active"));
  }

  // hooks: hasResults(), focusPending(delta), focusFirstPending(),
  // keepOriginalForAllPending().
  function initToolbar(hooks) {
    const input = control("entry-search-input");
    document.addEventListener("click", event => {
      const badge = event.target.closest(".summary-badge");
      if (!badge) return;
      activeFilter = activeFilter === badge.dataset.filter ? "all" : badge.dataset.filter;
      $$(".summary-badge").forEach(item =>
        item.classList.toggle("active", activeFilter === "all" || item.dataset.filter === activeFilter));
      applyAllCardVisibility();
    });
    control("unresolved-review-summary").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      hooks.focusFirstPending();
    });
    control("btn-keep-original-pending").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      hooks.keepOriginalForAllPending();
    });
    input.addEventListener("input", event => setSearch(event.target.value));
    input.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      input.value = "";
      setSearch("");
      input.blur();
    });
    control("entry-search-clear").addEventListener("click", () => {
      input.value = "";
      setSearch("");
      input.focus();
    });
    // "/" focuses the search and j / k step through pending reviews, unless
    // the user is typing or a dialog is open.
    document.addEventListener("keydown", event => {
      if (event.ctrlKey || event.metaKey || event.altKey || !["/", "j", "k"].includes(event.key)) return;
      const target = event.target;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.key === "/") {
        if (input.offsetParent === null) return;
        event.preventDefault();
        input.focus();
        input.select();
        return;
      }
      if (document.querySelector("dialog[open]") || !hooks.hasResults()) return;
      event.preventDefault();
      hooks.focusPending(event.key === "j" ? 1 : -1);
    });
  }

export {
  storage,
  sessionStore,
  initTheme,
  initBanners,
  initTabs,
  getSettings,
  runSettings,
  setRerankStatus,
  initSettings,
  applyCardVisibility,
  updateEntryEmptyState,
  resetResults,
  showAllEntries,
  updateSummary,
  initToolbar,
};
