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

assert.ok(app.includes("const preferPublished = runSnapshot.preferPublished"));
assert.ok(app.includes("originals: Object.freeze(parsedEntries.map"));
assert.ok(app.includes("function buildPreviewState()"));
assert.ok(app.includes("const D = window.BibDecisionPolicy"));
assert.ok(app.includes("decisionStore = D.createStore()"));
assert.ok(app.includes("D.initialOutcome(status, proposedCandidate, 0)"));
assert.ok(app.includes("D.canApplySuggestion(currentDecision, fieldEdits[i] || {})"));
assert.ok(app.includes("D.candidateDecision(candidate, candidateIndex)"));
assert.ok(app.includes("D.originalDecision(true)"));
assert.ok(app.includes("D.fieldEdit(action, value, { candidate, extra })"));
assert.ok(app.includes('D.provenance("user", "setting:max_authors")'));
assert.ok(app.includes("const state = D.applyDecision({"));
assert.ok(app.includes('buildResult(entry, index, "lookup_failed"'));
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
const atomicIndex = html.indexOf("atomic-candidates.js?v=");
const decisionIndex = html.indexOf("decision-policy.js?v=");
const appIndex = html.indexOf("app.js?v=");
assert.ok(libIndex >= 0 && atomicIndex > libIndex && decisionIndex > atomicIndex && appIndex > decisionIndex);
assert.match(html, /<option value="0" selected>All<\/option>/);
assert.doesNotMatch(html, /<option value="10" selected>/);

console.log("atomic application contract tests passed");
