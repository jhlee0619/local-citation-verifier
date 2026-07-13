const assert = require("assert");
const lib = require("../docs/lib.js");
const gemma = require("../docs/gemma-reranker.js");
const vllm = require("../docs/vllm-reranker.js");

globalThis.BibGemmaReranker = gemma;

async function testPostsGemmaPromptToVllmEndpoint() {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        output: "{\"best\": 2, \"status\": \"needs_review\", \"confidence\": 0.41, \"risk_flags\": [\"year_mismatch\"], \"reason\": \"The title is generic and the year changed.\"}",
      }),
    };
  };
  try {
    const candidates = [{ title: "Preprint" }, { title: "Journal" }];
    const result = await vllm.rerank({
      original: { title: "Paper" },
      candidates,
      parseChoice: lib.parseRerankChoice,
      preferPublished: true,
      endpoint: "/api/rerank/vllm",
    });
    assert.strictEqual(result.index, 1);
    assert.strictEqual(result.candidate, candidates[1]);
    assert.strictEqual(result.status, "needs_review");
    assert.strictEqual(result.confidence, 0.41);
    assert.deepStrictEqual(result.riskFlags, ["year_mismatch"]);
    assert.ok(result.reason.includes("title is generic"));
    assert.strictEqual(requestBody.candidate_count, 2);
    assert.ok(requestBody.prompt.includes("\"status\""));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testFallsBackToBestOnlyRerankJson() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ output: "{\"best\": 1}" }),
  });
  try {
    const candidates = [{ title: "Candidate" }, { title: "Other" }];
    const result = await vllm.rerank({
      original: { title: "Paper" },
      candidates,
      parseChoice: lib.parseRerankChoice,
      preferPublished: true,
      endpoint: "/api/rerank/vllm",
    });
    assert.strictEqual(result.index, 0);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.reason, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCachesIdenticalRerankRequests() {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ output: '{"best": 1}' }) };
  };
  try {
    const request = {
      original: { title: "Paper" },
      candidates: [{ title: "A" }, { title: "B" }],
      parseChoice: lib.parseRerankChoice,
      preferPublished: true,
      endpoint: "/api/rerank/vllm",
    };
    const first = await vllm.rerank(request);
    const second = await vllm.rerank(request);
    assert.strictEqual(first.index, 0);
    assert.strictEqual(second.index, 0);
    assert.strictEqual(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    vllm.clearCache?.();
  }
}

async function testHealthReportsUnavailableWithoutThrowing() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    assert.deepStrictEqual(await vllm.health(), { ready: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallerAbortReachesFetchAndDoesNotPopulateCache() {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  let observedSignal = null;
  globalThis.fetch = async (_url, options) => {
    calls++;
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  const request = {
    original: { title: "Abortable" },
    candidates: [{ title: "A" }, { title: "B" }],
    parseChoice: lib.parseRerankChoice,
    preferPublished: true,
    endpoint: "/api/rerank/vllm-abort",
    signal: controller.signal,
  };
  try {
    const pending = vllm.rerank(request);
    await Promise.resolve();
    controller.abort(new Error("run replaced"));
    await assert.rejects(pending, error => error.kind === "cancelled" && error.reason?.message === "run replaced");
    assert.strictEqual(calls, 1);
    assert.notStrictEqual(observedSignal, controller.signal);
    assert.strictEqual(observedSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    vllm.clearCache?.();
  }
}

async function testUsesVllmBudgetAndDerivedAttemptSignal() {
  const caller = new AbortController();
  const derived = new AbortController();
  let requestOptions = null;
  let fetchSignal = null;
  const requestApi = {
    BUDGETS: {
      vllm: { attemptTimeoutMs: 30000, maxAttempts: 1, totalTimeoutMs: 30000 },
    },
    request: async (attempt, options) => {
      requestOptions = options;
      return { value: await attempt({ signal: derived.signal }) };
    },
  };
  const result = await vllm.rerank({
    original: { title: "Budget" },
    candidates: [{ title: "A" }, { title: "B" }],
    parseChoice: lib.parseRerankChoice,
    preferPublished: true,
    endpoint: "/api/rerank/vllm-budget",
    signal: caller.signal,
    requestApi,
    fetch: async (_url, options) => {
      fetchSignal = options.signal;
      return { ok: true, json: async () => ({ output: '{"best": 1}' }) };
    },
  });
  assert.strictEqual(result.index, 0);
  assert.strictEqual(requestOptions.attemptTimeoutMs, 30000);
  assert.strictEqual(requestOptions.maxAttempts, 1);
  assert.strictEqual(requestOptions.totalTimeoutMs, 30000);
  assert.strictEqual(requestOptions.signal, caller.signal);
  assert.strictEqual(fetchSignal, derived.signal);
  vllm.clearCache?.();
}

async function testHealthUsesHealthBudget() {
  const budget = { attemptTimeoutMs: 5000, maxAttempts: 1, totalTimeoutMs: 5000 };
  let requestOptions = null;
  const requestApi = {
    BUDGETS: { health: budget },
    request: async (attempt, options) => {
      requestOptions = options;
      return { value: await attempt({ signal: new AbortController().signal }) };
    },
  };
  const result = await vllm.health("/health-budget", {
    requestApi,
    fetch: async () => ({ ok: true, json: async () => ({ ready: true }) }),
  });
  assert.deepStrictEqual(result, { ready: true });
  assert.strictEqual(requestOptions.attemptTimeoutMs, budget.attemptTimeoutMs);
  assert.strictEqual(requestOptions.maxAttempts, budget.maxAttempts);
  assert.strictEqual(requestOptions.totalTimeoutMs, budget.totalTimeoutMs);
}

(async () => {
  await testPostsGemmaPromptToVllmEndpoint();
  await testFallsBackToBestOnlyRerankJson();
  await testCachesIdenticalRerankRequests();
  await testHealthReportsUnavailableWithoutThrowing();
  await testCallerAbortReachesFetchAndDoesNotPopulateCache();
  await testUsesVllmBudgetAndDerivedAttemptSignal();
  await testHealthUsesHealthBudget();
  console.log("vLLM reranker tests passed");
})();
