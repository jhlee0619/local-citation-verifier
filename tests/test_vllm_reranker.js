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

(async () => {
  await testPostsGemmaPromptToVllmEndpoint();
  await testFallsBackToBestOnlyRerankJson();
  await testHealthReportsUnavailableWithoutThrowing();
  console.log("vLLM reranker tests passed");
})();
