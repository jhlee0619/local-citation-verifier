#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fuzzball = require("fuzzball");

global.fuzzball = fuzzball;
const lib = require("../docs/lib.js");

const fixtureDir = path.join(__dirname, "fixtures");
const bibPath = path.join(fixtureDir, "user-stroke-bib.bib");
const casesPath = path.join(fixtureDir, "offline-status-cases.json");

function entriesById() {
  const entries = lib.parseBib(fs.readFileSync(bibPath, "utf8"));
  return new Map(entries.map((entry) => [entry.ID, entry]));
}

function evaluateStatus(original, found) {
  const cmp = lib.compareEntry(original, found);
  let status = lib.resolveRerankStatus(cmp.status, found._rerankStatus);
  if (status !== "not_found" && lib.hasCriticalMetadataConflict(original, found))
    status = "needs_review";
  return {
    status,
    titleScore: cmp.title_score,
    diffFields: (cmp.field_diffs || []).map((diff) => diff.field),
    hasCriticalConflict: lib.hasCriticalMetadataConflict(original, found),
  };
}

function assertReason(caseRow, evaluated) {
  if (caseRow.expectedReason === "title_below_threshold") {
    assert.ok(
      evaluated.titleScore < lib.TITLE_MATCH_THRESHOLD,
      `${caseRow.id} should exercise the title threshold guard`,
    );
    return;
  }
  if (caseRow.expectedReason === "published_cvpr_candidate") {
    assert.ok(
      evaluated.diffFields.includes("doi") || evaluated.diffFields.includes("booktitle"),
      `${caseRow.id} should exercise an actionable published-candidate update`,
    );
    assert.strictEqual(evaluated.hasCriticalConflict, false, `${caseRow.id} should not be a critical conflict`);
    return;
  }
  assert.strictEqual(evaluated.hasCriticalConflict, true, `${caseRow.id} should exercise critical metadata conflict`);
}

const entries = entriesById();
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));

for (const caseRow of cases) {
  const original = entries.get(caseRow.id);
  assert.ok(original, `${caseRow.id} must exist in ${path.basename(bibPath)}`);
  const evaluated = evaluateStatus(original, caseRow.found);
  assert.strictEqual(evaluated.status, caseRow.expectedStatus, `${caseRow.id} status drifted`);
  assertReason(caseRow, evaluated);
}

console.log("fixture snapshot tests passed");
