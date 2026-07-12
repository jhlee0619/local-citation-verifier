const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "docs", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");

const sources = [
  "semantic_scholar_match",
  "semantic_scholar_search",
  "crossref_doi",
  "crossref_search",
  "dblp",
  "openreview",
  "local_arxiv",
  "local_curation",
];

sources.forEach(source => assert.ok(app.includes(`"${source}"`), `missing provider source ${source}`));
[
  "B.mergeMetadata",
  "mergeSamePaperMetadata",
  "B.preservePublishedVenue",
  "B.preferPublishedVenueUpgrade",
].forEach(forbidden => assert.ok(!app.includes(forbidden), `forbidden hybrid path remains: ${forbidden}`));

assert.ok(app.includes("const preferPublished = run.settings.preferPublished"));
assert.ok(app.includes("runController.startVerification({"));
assert.ok(app.includes("const sleep = (ms, signal) => R.sleep(ms, { signal })"));
assert.ok(app.includes("await runController.settleOwned(run, sleep(500, run.signal))"));
assert.ok(app.includes("return R.jsonp(u.toString(), {"));
assert.ok(app.includes("signal: run?.signal"));
assert.doesNotMatch(app, /activeRun\.completed\s*\?\s*activeRun\.settings/);
assert.match(app, /setTimeout\(\(\) => \{\s*if \(!isRunActive\(run\)\) return;\s*openOnboardingPostVerifyTour\(\);\s*\}, 450\)/);
assert.ok(app.includes("originals: run.originals"));
assert.ok(app.includes("function buildPreviewState()"));
assert.ok(app.includes("const D = window.BibDecisionPolicy"));
assert.ok(app.includes("decisionStore = D.createStore()"));
assert.ok(app.includes("D.initialOutcome(status, proposedCandidate, 0)"));
assert.ok(app.includes("D.canApplySuggestion(currentDecision, run.fieldEdits[i] || {})"));
assert.ok(app.includes("D.candidateDecision(candidate, candidateIndex)"));
assert.ok(app.includes("D.originalDecision(true)"));
assert.ok(app.includes("D.fieldEdit(action, value, { candidate, extra })"));
assert.ok(app.includes('D.provenance("user", "setting:max_authors")'));
assert.ok(app.includes("const state = D.applyDecision({"));
assert.ok(app.includes('buildResult(run, entry, index, "lookup_failed"'));
assert.ok(!/decisions\[[^\]]+\]\s*=\s*\{/.test(app), "decision literals must stay inside decision-policy.js");
assert.ok(app.includes("preview-mixed-source-warning"));
assert.match(
  app,
  /const limitedAuthor = truncateAuthors\(out\.author, s\.maxAuthors\);\s*if \(limitedAuthor !== out\.author\)/,
  "unchanged max-author limits must not create mixed-source provenance",
);
assert.ok(
  app.includes('const useCandidateValue = r.selected_choice === "candidate" && !!candidateVal.trim();'),
  "whole-record selection must keep unchanged core fields on candidate provenance",
);

const libIndex = html.indexOf("lib.js?v=");
const runControllerIndex = html.indexOf("run-controller.js?v=");
const atomicIndex = html.indexOf("atomic-candidates.js?v=");
const decisionIndex = html.indexOf("decision-policy.js?v=");
const appIndex = html.indexOf("app.js?v=");
assert.ok(libIndex >= 0 && runControllerIndex > libIndex && atomicIndex > runControllerIndex && decisionIndex > atomicIndex && appIndex > decisionIndex);
for (const script of ["lib.js", "request.js", "run-controller.js", "vllm-reranker.js", "citation-audit.js", "app.js"])
  assert.ok(html.includes(`${script}?v=20260712-run-ownership-final`), `stale run-ownership asset version: ${script}`);
assert.match(html, /<option value="0" selected>All<\/option>/);
assert.doesNotMatch(html, /<option value="10" selected>/);

console.log("atomic application contract tests passed");
