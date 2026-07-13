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
assert.ok(app.includes('const DBLP_API = USE_METADATA_PROXY ? "/api/dblp/search/publ/api" : ""'));
assert.ok(!app.includes("R.jsonp("), "production metadata lookup must not inject remote scripts");
assert.ok(app.includes("if (DBLP_API)\n      searches.push({ source: \"dblp\""));
assert.ok(app.includes('...(DBLP_API ? ["DBLP"] : [])'));
assert.ok(app.includes('...(OPENREVIEW_API ? ["OpenReview"] : [])'));
assert.ok(app.includes('const METADATA_PROVIDERS_EN = formatProviderNames("and")'));
assert.ok(!app.includes("CrossRef, Semantic Scholar, DBLP, and OpenReview"));
assert.ok(app.includes("signal: run?.signal"));
assert.doesNotMatch(app, /activeRun\.completed\s*\?\s*activeRun\.settings/);
assert.match(app, /setTimeout\(\(\) => \{\s*if \(!isRunActive\(run\)\) return;\s*openOnboardingPostVerifyTour\(\);\s*\}, 450\)/);
assert.ok(app.includes("originals: run.originals"));
assert.ok(app.includes("function buildPreviewState()"));
assert.ok(app.includes("const D = window.BibDecisionPolicy"));
assert.ok(app.includes("const P = window.BibProviderRuntime"));
assert.ok(app.includes("budget: R.BUDGETS.metadata"));
assert.ok(app.includes("budget = R.BUDGETS.dblp"));
assert.ok(app.includes("budget: R.BUDGETS.arxiv"));
assert.ok(app.includes("const deadlineAt = P.budgetDeadline(R.BUDGETS.dblp)"));
assert.ok(app.includes("const budget = P.remainingBudget(R.BUDGETS.dblp, deadlineAt)"));
assert.ok(app.includes("const classification = P.classifyAbsence(outcomes, candidates)"));
assert.ok(app.includes("const sourceWarnings = P.sourceWarnings(outcomes)"));
assert.ok(app.includes("const reviewChoices = P.reviewCandidates(originalRecord, selection.candidates, titleRankedChoices"));
assert.ok(app.includes('const reviewBest = selection.status === "needs_review" ? candidateChoices[0] : ranked.best'));
assert.ok(app.includes('{ _lookupAbsence: "not_found", _sourceWarnings: pool.sourceWarnings }'));
assert.ok(app.includes('if (found?._lookupAbsence === "not_found")'));
assert.ok(app.includes("Source status: ${r.source_warnings.map(esc).join(\" \")}"));
assert.ok(app.includes("if (candidate._autoEligible !== true)"));
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
const providerIndex = html.indexOf("provider-runtime.js?v=");
const decisionIndex = html.indexOf("decision-policy.js?v=");
const appIndex = html.indexOf("app.js?v=");
assert.ok(libIndex >= 0 && runControllerIndex > libIndex && atomicIndex > runControllerIndex && providerIndex > atomicIndex && decisionIndex > providerIndex && appIndex > decisionIndex);
for (const script of ["lib.js", "request.js", "run-controller.js"])
  assert.ok(html.includes(`${script}?v=20260712-run-ownership-final`), `stale run-ownership asset version: ${script}`);
for (const script of ["webgpu-engine.js", "provider-runtime.js", "gemma-reranker.js", "vllm-reranker.js", "citation-audit.js"])
  assert.ok(html.includes(`${script}?v=20260712-provider-failures`), `stale provider-failure asset version: ${script}`);
assert.ok(html.includes("app.js?v=20260713-csp-vendor"), "stale app asset version after DBLP transport change");
assert.match(html, /<option value="0" selected>All<\/option>/);
assert.doesNotMatch(html, /<option value="10" selected>/);

console.log("atomic application contract tests passed");
