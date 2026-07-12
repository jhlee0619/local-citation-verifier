(function (exports) {
  "use strict";

  function cloneFrozen(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
    if (value && typeof value === "object") {
      const copy = {};
      for (const [key, child] of Object.entries(value)) copy[key] = cloneFrozen(child);
      return Object.freeze(copy);
    }
    return value;
  }

  function abortError(reason) {
    const message = typeof reason === "string" && reason ? reason : "run cancelled";
    const error = new Error(message);
    error.name = "AbortError";
    error.kind = "cancelled";
    error.reason = reason;
    return error;
  }

  function createRunController() {
    let nextVerificationId = 1;
    let nextAuditId = 1;
    let activeVerification = null;
    let activeAudit = null;

    function abort(context, reason) {
      if (!context || context.signal.aborted) return context || null;
      context.cancelReason = reason;
      context.controller.abort(abortError(reason));
      return context;
    }

    function isActive(context) {
      if (!context || context.signal.aborted) return false;
      if (context.kind === "verification") return activeVerification?.id === context.id;
      if (context.kind === "citation-audit") return activeAudit?.id === context.id;
      return false;
    }

    function startVerification({ entries = [], settings = {} } = {}) {
      const previousVerificationId = activeVerification?.id ?? null;
      abort(activeVerification, "superseded by a newer verification");
      if (previousVerificationId !== null && activeAudit?.verificationId === previousVerificationId)
        abort(activeAudit, "owning verification was superseded");
      const controller = new AbortController();
      const frozenEntries = cloneFrozen(entries);
      const context = {
        kind: "verification",
        id: nextVerificationId++,
        controller,
        signal: controller.signal,
        entries: frozenEntries,
        originals: frozenEntries,
        settings: cloneFrozen(settings),
        results: new Array(frozenEntries.length),
        decisions: [],
        fieldEdits: [],
        cancelReason: null,
      };
      activeVerification = context;
      return context;
    }

    function startAudit({ inputs = {}, settings = {} } = {}) {
      abort(activeAudit, "superseded by a newer citation audit");
      const controller = new AbortController();
      const verificationId = isActive(activeVerification) ? activeVerification.id : null;
      const context = {
        kind: "citation-audit",
        id: nextAuditId++,
        verificationId,
        controller,
        signal: controller.signal,
        inputs: cloneFrozen(inputs),
        settings: cloneFrozen(settings),
        results: [],
        cancelReason: null,
      };
      activeAudit = context;
      return context;
    }

    function cancelVerification(reason = "cancelled by user") {
      const cancelled = abort(activeVerification, reason);
      if (activeAudit?.verificationId === activeVerification?.id)
        abort(activeAudit, "owning verification was cancelled");
      return cancelled;
    }

    function cancelAudit(reason = "cancelled by user") {
      return abort(activeAudit, reason);
    }

    function ifActive(context, writer) {
      if (!isActive(context)) return false;
      writer();
      return true;
    }

    async function settleOwned(context, promise) {
      try {
        return await promise;
      } catch (error) {
        if (!isActive(context)) return null;
        throw error;
      }
    }

    return {
      startVerification,
      startAudit,
      cancelVerification,
      cancelAudit,
      isActive,
      ifActive,
      settleOwned,
      activeVerification: () => activeVerification,
      activeAudit: () => activeAudit,
    };
  }

  exports.abortError = abortError;
  exports.createRunController = createRunController;
  exports.defaultController = createRunController();
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BibRunController = {}));
