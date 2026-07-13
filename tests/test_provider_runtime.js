"use strict";

const assert = require("assert");
const B = require("../docs/lib.js");
const A = require("../docs/atomic-candidates.js");
const P = require("../docs/provider-runtime.js");
const R = require("../docs/request.js");

const original = A.createOriginal({
  title: "Atomic Metadata",
  author: "Doe, Jane",
  year: "2024",
  doi: "10.1000/atomic",
  eprint: "2401.01234",
});

function record(fields, source = "crossref_search") {
  return A.createRecord(fields, { recordSource: source, recordId: fields.doi || fields.eprint || fields.title });
}

function relevant(candidate) {
  return P.isRelevantCandidate(original, candidate, {
    directLinkKinds: A.directLinkKinds,
    titleSimilarity: B.titleSimilarity,
    minTitleSim: B.MIN_TITLE_SIM,
  });
}

assert.strictEqual(relevant(record({ title: "Unrelated", author: "Other", year: "1999", doi: "10.1000/atomic" })), true);
assert.strictEqual(relevant(record({ title: "Unrelated", author: "Other", year: "1999", eprint: "2401.01234" })), true);
assert.strictEqual(relevant(record({ title: "Atomic Metadata", author: "Other", year: "1999" })), true);
assert.strictEqual(relevant(record({ title: "Correction: Atomic Metadata", author: "Doe, Jane", year: "2024" })), false);
assert.strictEqual(relevant(record({ title: "Completely Different", author: "Doe, Jane", year: "2024" })), false);

const exactComplete = record({
  title: "Atomic Metadata", author: "Doe, Jane", year: "2024", doi: "10.1000/atomic",
}, "crossref_doi");
const exactIncomplete = record({
  title: "Atomic Metadata", author: "", year: "2024", doi: "10.1000/atomic",
}, "crossref_doi");
const fuzzyOnly = record({ title: "Atomic Metadata", author: "Doe, Jane", year: "2024" });
const curatedOnly = record({ title: "Atomic Metadata", author: "Doe, Jane", year: "2024" }, "local_curation");
assert.strictEqual(A.selectCanonical(original, [exactComplete], {}).status, "auto_apply");
assert.strictEqual(A.selectCanonical(original, [exactIncomplete], {}).status, "needs_review");
assert.strictEqual(A.selectCanonical(original, [fuzzyOnly], {}).status, "needs_review");
assert.strictEqual(A.selectCanonical(original, [curatedOnly], {}).status, "needs_review");

const lowTitleExact = record({
  title: "Unrelated Provider Title", author: "", year: "2024", doi: "10.1000/atomic",
}, "crossref_doi");
const lowTitleSelection = A.selectCanonical(original, [lowTitleExact], {});
const lowTitleRanked = B.topCandidates(lowTitleSelection.candidates, original, { limit: 5 });
assert.strictEqual(lowTitleSelection.status, "needs_review");
assert.deepStrictEqual(lowTitleRanked, []);
assert.deepStrictEqual(P.reviewCandidates(original, lowTitleSelection.candidates, lowTitleRanked, {
  directLinkKinds: A.directLinkKinds,
  limit: 5,
}), [lowTitleExact], "exact-ID review candidates must survive title ranking");

const titleRanked = record({ title: "Atomic Metadata", author: "Doe, Jane", year: "2024" });
assert.deepStrictEqual(P.reviewCandidates(original, [titleRanked, lowTitleExact], [titleRanked], {
  directLinkKinds: A.directLinkKinds,
  limit: 5,
}), [lowTitleExact, titleRanked], "exact-ID review candidates must be shown before fuzzy alternatives");
assert.deepStrictEqual(P.reviewCandidates(original, [curatedOnly], [], {
  directLinkKinds: A.directLinkKinds,
  limit: 5,
}), [curatedOnly], "relevant local curation must remain reviewable without a title rank");

const emptyOutcomes = [
  { source: "semantic_scholar_match", role: "primary", state: "success" },
  { source: "crossref_search", role: "primary", state: "success" },
];
assert.strictEqual(P.classifyAbsence(emptyOutcomes, []), "not_found");
assert.strictEqual(
  P.classifyAbsence(emptyOutcomes, P.relevantCandidates(original, [
    record({ title: "Completely Different", author: "Other", year: "1999" }),
  ], {
    directLinkKinds: A.directLinkKinds,
    titleSimilarity: B.titleSimilarity,
    minTitleSim: B.MIN_TITLE_SIM,
  })),
  "not_found",
);
assert.strictEqual(P.classifyAbsence([
  ...emptyOutcomes,
  { source: "dblp", role: "primary", state: "failure", error: { kind: "deadline_timeout", message: "secret URL" } },
], []), "lookup_failed");
assert.strictEqual(P.classifyAbsence([
  { source: "crossref_doi", role: "enrichment", state: "failure", error: { kind: "deadline_timeout" } },
  ...emptyOutcomes,
], []), "not_found");
assert.strictEqual(P.classifyAbsence([
  ...emptyOutcomes,
  { source: "dblp", role: "primary", state: "failure", error: { kind: "network" } },
], [record({ title: "Atomic Metadata", author: "Doe, Jane", year: "2024" })]), "candidate");

const cancelled = Object.assign(new Error("user secret"), { kind: "cancelled" });
assert.throws(
  () => P.classifyAbsence([{ source: "dblp", role: "primary", state: "failure", error: cancelled }], []),
  error => error === cancelled,
);

const warnings = P.sourceWarnings([
  { source: "semantic_scholar_match", role: "primary", state: "failure", error: { kind: "deadline_timeout", message: "raw one" } },
  { source: "semantic_scholar_search", role: "primary", state: "failure", error: { kind: "retry_exhausted", message: "raw two" } },
  { source: "crossref_search", role: "primary", state: "failure", error: { kind: "rate_limited", message: "raw three" } },
]);
assert.deepStrictEqual(warnings, ["Semantic Scholar timed out or was unavailable.", "CrossRef was rate limited."]);
assert.ok(warnings.every(warning => !warning.includes("raw")));

const sharedDeadline = P.budgetDeadline({ totalTimeoutMs: 12000 }, 1000);
assert.strictEqual(sharedDeadline, 13000);
assert.deepStrictEqual(
  P.remainingBudget({ attemptTimeoutMs: 12000, maxAttempts: 1, totalTimeoutMs: 12000 }, sharedDeadline, 4500),
  { attemptTimeoutMs: 8500, maxAttempts: 1, totalTimeoutMs: 8500 },
);
assert.strictEqual(P.remainingBudget({ attemptTimeoutMs: 12000, totalTimeoutMs: 12000 }, sharedDeadline, 13000), null);

(async () => {
  const caller = new AbortController();
  const attempt = new AbortController();
  const budget = { attemptTimeoutMs: 12, maxAttempts: 3, totalTimeoutMs: 41, baseDelayMs: 1, maxDelayMs: 5 };
  let requestOptions;
  let fetchedUrl;
  const requestApi = {
    classifyResponse: value => ({ kind: "success", value }),
    request: async (execute, options) => {
      requestOptions = options;
      return { kind: "success", value: await execute({ signal: attempt.signal }) };
    },
  };
  const data = await P.requestJson("/provider", { query: "paper" }, {
    requestApi, budget, signal: caller.signal, origin: "https://example.test",
    fetch: async (url, options) => {
      fetchedUrl = url;
      assert.strictEqual(options.signal, attempt.signal);
      return { ok: true, status: 200, json: async () => ({ title: "Paper" }) };
    },
  });
  assert.deepStrictEqual(data, { title: "Paper" });
  assert.strictEqual(requestOptions.signal, caller.signal);
  assert.deepStrictEqual(
    Object.fromEntries(Object.keys(budget).map(key => [key, requestOptions[key]])),
    budget,
  );
  assert.ok(fetchedUrl.includes("query=paper"));

  let parsed204 = false;
  const empty = await P.requestJson("/empty", {}, {
    requestApi: R,
    budget: { attemptTimeoutMs: 50, maxAttempts: 1, totalTimeoutMs: 50 },
    origin: "https://example.test",
    fetch: async () => ({
      ok: true,
      status: 204,
      json: async () => { parsed204 = true; throw new Error("empty body"); },
    }),
  });
  assert.strictEqual(empty, null);
  assert.strictEqual(parsed204, false);
  console.log("provider runtime tests passed");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
