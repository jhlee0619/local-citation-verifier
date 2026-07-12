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
assert.ok(
  app.includes("if (decision.source || decision.candidateId) return stableMatch || null;"),
  "stable candidate identity mismatch must fail closed instead of using a stale index",
);
assert.ok(app.includes("source: candidate._recordSource"));
assert.ok(app.includes("candidateId: candidate._recordId"));
assert.ok(app.includes("A.userProvenance(candidate)"));
assert.ok(app.includes("A.manualProvenance()"));
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
const appIndex = html.indexOf("app.js?v=");
assert.ok(libIndex >= 0 && atomicIndex > libIndex && appIndex > atomicIndex);

console.log("atomic application contract tests passed");
