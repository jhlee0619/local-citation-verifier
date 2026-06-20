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
      json: async () => ({ output: "{\"best\": 2}" }),
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
    assert.strictEqual(requestBody.candidate_count, 2);
    assert.ok(requestBody.prompt.includes("Return only JSON"));
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
  await testHealthReportsUnavailableWithoutThrowing();
  console.log("vLLM reranker tests passed");
})();
