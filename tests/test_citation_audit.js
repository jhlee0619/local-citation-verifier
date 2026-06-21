#!/usr/bin/env node

const assert = require("assert");
const audit = require("../docs/citation-audit.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
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

test("parses judgement JSON conservatively", () => {
  const result = audit.parseJudgement('{"verdict":"supported","confidence":0.7,"reason":"Directly stated.","risk_flags":["broad_claim"]}');
  assert.strictEqual(result.verdict, "supported");
  assert.strictEqual(result.confidence, 0.7);
  assert.deepStrictEqual(result.riskFlags, ["broad_claim"]);
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

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
