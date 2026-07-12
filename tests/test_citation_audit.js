#!/usr/bin/env node

const assert = require("assert");
const audit = require("../docs/citation-audit.js");

let passed = 0;
let failed = 0;
const testRuns = [];

function test(name, fn) {
  testRuns.push(Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`FAIL ${name}`);
      console.error(err);
    }));
}

test("extracts multiple keys from LaTeX citation commands", () => {
  const contexts = audit.extractCitationContexts(
    "Attention is commonly used in sequence models \\citep{vaswani2017, devlin2019}. It works."
  );
  assert.deepStrictEqual(contexts.map((ctx) => ctx.key), ["vaswani2017", "devlin2019"]);
  assert.ok(contexts[0].sentence.includes("Attention is commonly used"));
});

test("supports optional citation arguments", () => {
  const contexts = audit.extractCitationContexts(
    "Prior work established the baseline \\citep[see][p. 4]{smith2020}."
  );
  assert.strictEqual(contexts.length, 1);
  assert.strictEqual(contexts[0].key, "smith2020");
});

test("builds strict citation judgement prompt", () => {
  const prompt = audit.buildPrompt({
    context: { key: "x", sentence: "Transformers use self-attention \\cite{x}." },
    entry: { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017" },
    evidence: { title: "Attention Is All You Need", abstract: "The Transformer relies entirely on attention mechanisms." },
  });
  assert.ok(prompt.includes("Return only strict JSON"));
  assert.ok(prompt.includes("Allowed verdict values"));
  assert.ok(prompt.includes("Transformers use self-attention"));
});

test("builds English citation judgement prompt by default", () => {
  const prompt = audit.buildPrompt({
    context: { key: "x", sentence: "Transformers use self-attention \\cite{x}." },
    entry: { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017" },
    evidence: { title: "Attention Is All You Need", abstract: "The Transformer relies entirely on attention mechanisms." },
  });
  assert.ok(prompt.includes("Write reason and evidence_quote in English."));
  assert.ok(prompt.includes("JSON keys, verdict values, and risk_flags must remain in English"));
});

test("builds Korean citation judgement prompt when requested", () => {
  const prompt = audit.buildPrompt({
    context: { key: "x", sentence: "Transformers use self-attention \\cite{x}." },
    entry: { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017" },
    evidence: { title: "Attention Is All You Need", abstract: "The Transformer relies entirely on attention mechanisms." },
    language: "ko",
  });
  assert.ok(prompt.includes("Write reason and evidence_quote in Korean."));
  assert.ok(prompt.includes("JSON keys, verdict values, and risk_flags must remain in English"));
});

test("retries transient evidence fetch failures before returning JSON", async () => {
  const originalWindow = global.window;
  const originalFetch = global.fetch;
  let calls = 0;
  global.window = { location: { origin: "http://localhost" } };
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503, headers: { get: () => "0" } };
    return { ok: true, json: async () => ({ title: "Recovered" }) };
  };
  try {
    const data = await audit.fetchJson("/api/test", {}, { retries: 1, baseDelayMs: 0 });
    assert.strictEqual(data.title, "Recovered");
    assert.strictEqual(calls, 2);
  } finally {
    global.window = originalWindow;
    global.fetch = originalFetch;
  }
});

test("classifies only 429 and 5xx gateway statuses as transient", () => {
  assert.strictEqual(audit.isTransientHttpStatus(429), true);
  assert.strictEqual(audit.isTransientHttpStatus(503), true);
  assert.strictEqual(audit.isTransientHttpStatus(404), false);
});

test("keeps DOI slash unescaped for Semantic Scholar paper ids", () => {
  assert.strictEqual(
    audit.semanticScholarPaperIdForDoi("10.1145/3290605.3300233"),
    "DOI:10.1145/3290605.3300233"
  );
  assert.strictEqual(
    audit.semanticScholarPaperIdForDoi(" 10.1000/a b/c+d "),
    "DOI:10.1000/a%20b/c%2Bd"
  );
});

test("safeExternalUrl rejects unsafe citation links", () => {
  assert.strictEqual(audit.safeExternalUrl("https://example.test/paper"), "https://example.test/paper");
  assert.strictEqual(audit.safeExternalUrl("javascript:alert(1)"), "");
  assert.strictEqual(audit.safeExternalUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.strictEqual(audit.safeExternalUrl("ftp://example.test/paper"), "");
});

test("paperUrlForEvidence falls back from unsafe evidence URL to DOI", () => {
  assert.strictEqual(
    audit.paperUrlForEvidence(
      { url: "javascript:alert(1)", externalIds: { DOI: "10.1000/a b" } },
      {},
    ),
    "https://doi.org/10.1000/a%20b",
  );
});

test("parses judgement JSON conservatively", () => {
  const result = audit.parseJudgement('{"verdict":"supported","confidence":0.7,"reason":"Directly stated.","risk_flags":["broad_claim"]}');
  assert.strictEqual(result.verdict, "weak");
  assert.strictEqual(result.confidence, 0.7);
  assert.deepStrictEqual(result.riskFlags, ["broad_claim"]);
});

test("escalates topic mismatch to unsupported", () => {
  const result = audit.applyRiskFlagGuardrails(audit.parseJudgement(
    '{"verdict":"supported","confidence":0.91,"reason":"Same topic.","risk_flags":["topic_mismatch"]}',
  ));
  assert.strictEqual(result.verdict, "unsupported");
});

test("escalates specific result claims from supported to weak", () => {
  const result = audit.applyRiskFlagGuardrails(audit.parseJudgement(
    '{"verdict":"supported","confidence":0.88,"reason":"Exact number cited.","risk_flags":["specific_result_claim"]}',
  ));
  assert.strictEqual(result.verdict, "weak");
});

test("returns Korean fallback reason for missing BibTeX entry", async () => {
  const result = await audit.judgeCitation({
    context: { key: "missing", sentence: "A claim \\cite{missing}." },
    entry: null,
    evidence: null,
    language: "ko",
  });
  assert.strictEqual(result.verdict, "insufficient_evidence");
  assert.strictEqual(result.reason, "인용 키가 BibTeX 파일에 없습니다.");
  assert.deepStrictEqual(result.riskFlags, ["citation_key_missing"]);
});

test("returns Korean fallback reason for missing abstract evidence", async () => {
  const result = await audit.judgeCitation({
    context: { key: "x", sentence: "A claim \\cite{x}." },
    entry: { title: "Known Paper", author: "Doe, Jane", year: "2024" },
    evidence: { title: "Known Paper" },
    language: "ko",
  });
  assert.strictEqual(result.verdict, "insufficient_evidence");
  assert.strictEqual(result.reason, "이 참고문헌에는 판단에 필요한 초록이나 TLDR이 없습니다.");
  assert.deepStrictEqual(result.riskFlags, ["missing_abstract", "metadata_only"]);
});

test("does not invoke WebGPU citation judgement before explicit opt-in", async () => {
  const originalWindow = globalThis.window;
  let completeCalls = 0;
  globalThis.window = {
    BibVllmReranker: { health: async () => ({ ready: false }) },
    BibGemmaReranker: {
      isEnabled: () => false,
      completePrompt: async () => { completeCalls++; return ""; },
    },
  };
  try {
    const result = await audit.judgeCitation({
      context: { key: "x", sentence: "A claim \\cite{x}." },
      entry: { title: "Known Paper", author: "Doe, Jane", year: "2024" },
      evidence: { title: "Known Paper", abstract: "Evidence text." },
      provider: "auto",
      language: "en",
    });
    assert.strictEqual(result.verdict, "insufficient_evidence");
    assert.deepStrictEqual(result.riskFlags, ["local_ai_disabled"]);
    assert.strictEqual(completeCalls, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("falls back to insufficient evidence for invalid verdict", () => {
  const result = audit.parseJudgement('{"verdict":"certain","confidence":9}');
  assert.strictEqual(result.verdict, "insufficient_evidence");
  assert.strictEqual(result.confidence, 1);
});

test("summarizes citation verdict counts", () => {
  const counts = audit.summarize([
    { judgement: { verdict: "supported" } },
    { judgement: { verdict: "weak" } },
    { judgement: { verdict: "weak" } },
    { judgement: { verdict: "unsupported" } },
  ]);
  assert.strictEqual(counts.supported, 1);
  assert.strictEqual(counts.weak, 2);
  assert.strictEqual(counts.unsupported, 1);
  assert.strictEqual(counts.insufficient_evidence, 0);
});

Promise.all(testRuns).then(() => {
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
