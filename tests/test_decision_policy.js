"use strict";

const assert = require("assert");
const policy = require("../docs/decision-policy.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

function candidate(overrides = {}) {
  return {
    title: "Atomic Paper",
    author: "Lovelace, Ada",
    year: "2024",
    journal: "Atomic Journal",
    _recordSource: "crossref_doi",
    _recordId: "10.1234/atomic",
    _versionClass: "published",
    _autoEligible: true,
    _canonicalStatus: "auto_apply",
    _canonicalReason: "direct_complete_atomic_record",
    _directLinkKind: "doi",
    _selectedVersionClass: "published",
    ...overrides,
  };
}

console.log("\n── decision policy ──");

test("defaults every uncertain or unchanged status to original", () => {
  for (const status of ["verified", "needs_review", "not_found", "lookup_failed", "cancelled", "parse_failed"])
    assert.deepStrictEqual(policy.initialDecision(status, candidate(), 0), {
      action: "original",
      source: "original",
      candidateId: "",
      touched: false,
      provenance: { actor: "system", source: "original" },
    });
});

test("auto-selects only a fully gated updated candidate", () => {
  const selected = policy.initialDecision("updated", candidate(), 0);
  assert.strictEqual(selected.action, "candidate");
  assert.strictEqual(selected.touched, false);
  assert.deepStrictEqual(selected.provenance, {
    actor: "system", source: "crossref_doi", candidateId: "10.1234/atomic",
  });

  const rejected = [
    candidate({ _autoEligible: false }),
    candidate({ _canonicalStatus: "needs_review" }),
    candidate({ _canonicalReason: "core_conflict" }),
    candidate({ _directLinkKind: "" }),
    candidate({ author: "" }),
    candidate({ _selectedVersionClass: "preprint" }),
    candidate({ _recordSource: "local_curation" }),
    candidate({ _enrichmentNeedsReview: true }),
  ];
  for (const item of rejected) {
    assert.strictEqual(policy.initialDecision("updated", item, 0).action, "original");
    assert.strictEqual(policy.initialOutcome("updated", item, 0).status, "needs_review");
  }
});

test("records explicit candidate and original choices as user intent", () => {
  const selected = policy.candidateDecision(candidate(), 2);
  assert.strictEqual(selected.touched, true);
  assert.strictEqual(selected.candidateIndex, 2);
  assert.deepStrictEqual(selected.provenance, {
    actor: "user", source: "crossref_doi", candidateId: "10.1234/atomic",
  });
  assert.deepStrictEqual(policy.originalDecision(true).provenance, { actor: "user", source: "original" });
});

test("distinguishes provider field adoption from direct typing", () => {
  const imported = policy.fieldEdit("found", "Ada Lovelace", { candidate: candidate() });
  assert.deepStrictEqual(imported.provenance, {
    actor: "user", source: "crossref_doi", candidateId: "10.1234/atomic",
  });
  const manual = policy.fieldEdit("custom", "A. Lovelace");
  assert.deepStrictEqual(manual.provenance, { actor: "user", source: "manual" });
});

test("blocks delayed suggestions after any explicit decision or field edit", () => {
  assert.strictEqual(policy.canApplySuggestion(policy.originalDecision(false), {}), true);
  assert.strictEqual(policy.canApplySuggestion(policy.originalDecision(true), {}), false);
  assert.strictEqual(policy.canApplySuggestion(policy.originalDecision(false), {
    author: policy.fieldEdit("custom", "A. Lovelace"),
  }), false);
});

test("resolves provider records by stable identity and fails closed", () => {
  const records = [candidate(), candidate({ _recordSource: "semantic_scholar_match", _recordId: "ss-1" })];
  assert.strictEqual(policy.resolveCandidate(records, policy.candidateDecision(records[1], 0)), records[1]);
  assert.strictEqual(policy.resolveCandidate(records, {
    ...policy.candidateDecision(records[1], 0), candidateId: "stale-id",
  }), null);
});

test("ignores implicit edits when a selected candidate identity becomes stale", () => {
  const original = { title: "Original", author: "Original Author", year: "2023" };
  const decision = { ...policy.candidateDecision(candidate(), 0), candidateId: "stale-id" };
  const implicitEdit = policy.fieldEdit("found", "Stale Provider Author", { candidate: candidate() });
  implicitEdit.touched = false;
  const projected = policy.applyDecision({
    original,
    candidates: [candidate()],
    decision,
    fieldEdits: { author: implicitEdit },
  });
  assert.deepStrictEqual(projected.entry, original);
});

test("keeps explicit edits when a selected candidate identity becomes stale", () => {
  const original = { title: "Original", author: "Original Author", year: "2023" };
  const decision = { ...policy.candidateDecision(candidate(), 0), candidateId: "stale-id" };
  const projected = policy.applyDecision({
    original,
    candidates: [candidate()],
    decision,
    fieldEdits: { author: policy.fieldEdit("custom", "Explicit Author") },
  });
  assert.strictEqual(projected.entry.author, "Explicit Author");
  assert.strictEqual(projected.entry.title, "Original");
});

test("projects untouched originals byte-equivalently and explicit edits only", () => {
  const original = { ENTRYTYPE: "article", ID: "paper", title: "Original", author: "Old", year: "2023", note: "keep" };
  const unchanged = policy.applyDecision({
    original, candidates: [candidate()], decision: policy.originalDecision(false), fieldEdits: {},
    applyCandidate: (entry, selected) => ({ ENTRYTYPE: entry.ENTRYTYPE, ID: entry.ID, ...selected }),
  });
  assert.deepStrictEqual(unchanged.entry, original);

  const selected = policy.applyDecision({
    original,
    candidates: [candidate()],
    decision: policy.candidateDecision(candidate(), 0),
    fieldEdits: { author: policy.fieldEdit("custom", "A. Lovelace") },
    applyCandidate: (entry, record) => ({ ENTRYTYPE: entry.ENTRYTYPE, ID: entry.ID, ...record }),
  });
  assert.strictEqual(selected.entry.title, "Atomic Paper");
  assert.strictEqual(selected.entry.author, "A. Lovelace");
  assert.strictEqual(selected.entry.note, undefined);
  assert.deepStrictEqual(selected.provenance.author, { actor: "user", source: "manual" });
  assert.strictEqual(selected.mixed, true);
});

test("creates isolated stores for new verification runs", () => {
  const first = policy.createStore();
  first.decisions[0] = policy.originalDecision(true);
  first.fieldEdits[0] = { title: policy.fieldEdit("custom", "Changed") };
  const second = policy.createStore();
  assert.deepStrictEqual(second.decisions, {});
  assert.deepStrictEqual(second.fieldEdits, {});
  assert.notStrictEqual(second.decisions, first.decisions);
});

test("preserves long original author lists for every original-default status", () => {
  const original = {
    title: "Original",
    author: Array.from({ length: 12 }, (_, index) => `Author ${index + 1}`).join(" and "),
    year: "2023",
  };
  for (const status of policy.ORIGINAL_DEFAULT_STATUSES) {
    const projected = policy.applyDecision({
      original,
      candidates: [candidate()],
      decision: policy.initialDecision(status, candidate(), 0),
      fieldEdits: {},
    });
    assert.strictEqual(projected.entry.author, original.author, status);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
