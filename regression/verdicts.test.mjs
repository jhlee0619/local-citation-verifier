// What "Verified" means, as a regression suite anyone can run from the public
// repository: no network, no npm dependencies (node --test "regression/*.test.mjs").
//
// Every case is a small synthetic bibliography (fixtures/<name>.bib) and the
// metadata services' answers for it (fixtures/<name>.json). The real path
// runs on them, in process: `lcv check --strict --json` (BibTeX parse →
// provider lookups → verdict → strict gate) with the services replaced by a
// fake transport, and the web page's export readiness (core/output.js
// prepareExport) on the same verification. Fabricated references must never
// pass; the positive controls measure over-blocking; a provider outage must
// stay a lookup failure (rerun), never a verdict. A summary table ends the
// run.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

// docs/ modules import each other with the page's "?v=BUILD" query; strip
// it, as cli/lcv.mjs does, so each module loads exactly once.
const DOCS_URL = pathToFileURL(path.join(HERE, "..", "docs") + path.sep).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!result.url.startsWith(DOCS_URL)) return result;
    const url = new URL(result.url);
    if (!url.search) return result;
    url.search = "";
    return { ...result, url: url.href };
  },
});
const { main } = await import("../cli/lib/main.mjs");
const Network = await import("../cli/lib/network.mjs");
const Check = await import("../cli/lib/check.mjs");
const Out = await import("../docs/core/output.js");
const Audit = await import("../docs/core/audit.js");

// ─── The fake metadata services ─────────────────────────────────────
// A fixture JSON lists what each service holds for the case:
//   crossref         Crossref works: every list query answers them all,
//                    /works/{doi} the one with that DOI (else 404)
//   datacite         DataCite DOI attributes (else 404)
//   dblp             DBLP hits (info objects): every query answers them all
//   arxiv            { id: BibTeX } for arxiv.org/bibtex/{id} (else 404)
//   semanticscholar  Semantic Scholar papers: the match query answers the
//                    first, the search query all
// OpenReview and PubMed know nothing. A host listed in a case's `down` fails
// at the network level; one in `challenge` answers DBLP's bot page (HTTP 200,
// an HTML page in place of JSON).
const EUTILS_HEADERS = { "X-RateLimit-Limit": "100" };
const answer = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body),
  { status, headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers } });

const BOT_PAGE = "<!DOCTYPE html><html><head><title>dblp: Making sure you're not a bot!</title></head><body></body></html>";

function upstream(world, down = [], challenge = []) {
  return async url => {
    const target = new URL(url);
    if (down.includes(target.host)) throw new TypeError("fetch failed");
    if (challenge.includes(target.host))
      return new Response(BOT_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    const tail = prefix => decodeURIComponent(target.pathname.slice(prefix.length)).toLowerCase();
    switch (target.host) {
      case "api.crossref.org": {
        const works = world.crossref || [];
        if (target.pathname === "/works") return answer({ message: { items: works.slice(0, 5) } });
        const work = works.find(item => item.DOI.toLowerCase() === tail("/works/"));
        return work ? answer({ message: work }) : answer("Resource not found.", 404);
      }
      case "api.datacite.org": {
        const attributes = (world.datacite || []).find(item => item.doi.toLowerCase() === tail("/dois/"));
        return attributes ? answer({ data: { id: attributes.doi.toLowerCase(), type: "dois", attributes } })
          : answer({ errors: [{ status: "404", title: "The resource you are looking for doesn't exist." }] }, 404);
      }
      case "dblp.org":
        return answer({ result: { hits: { hit: (world.dblp || []).map(info => ({ info })) } } });
      case "api.semanticscholar.org": {
        const papers = world.semanticscholar || [];
        return answer({ data: target.pathname.endsWith("/match") ? papers.slice(0, 1) : papers });
      }
      case "api2.openreview.net":
        return answer({ notes: [] });
      case "arxiv.org": {
        const bibtex = world.arxiv?.[target.pathname.split("/").pop()];
        return bibtex ? answer(bibtex) : answer("not found", 404);
      }
      case "eutils.ncbi.nlm.nih.gov": {
        if (target.pathname.endsWith("/esearch.fcgi"))
          return answer({ esearchresult: { count: "0", idlist: [] } }, 200, EUTILS_HEADERS);
        if (target.pathname.endsWith("/esummary.fcgi")) {
          const ids = (target.searchParams.get("id") || "").split(",");
          const result = { uids: ids, ...Object.fromEntries(ids.map(uid => [uid, { uid, error: "cannot get document summary" }])) };
          return answer({ result }, 200, EUTILS_HEADERS);
        }
        return answer("", 200, EUTILS_HEADERS); // ECitMatch: no match
      }
    }
    throw new Error(`the regression suite has no answer for ${url}`);
  };
}

// The cases run concurrently (the providers pace each run's requests), so
// one transport serves them all and AsyncLocalStorage routes each request
// to the case that made it. Outside a case nothing answers.
const current = new AsyncLocalStorage();
const transport = url => {
  const route = current.getStore();
  if (!route) throw new Error(`no network in the regression suite: ${url}`);
  return route(url);
};
// Each lcv command installs its own fetch and restores the previous one when
// it ends; with concurrent commands that may be this one, so it answers too.
const realFetch = globalThis.fetch;
globalThis.fetch = Network.createCliFetch({ transport, cache: null, env: {}, stats: { requests: 0, cacheHits: 0, hosts: {} } });

function sink() {
  const chunks = [];
  return { write: text => { chunks.push(String(text)); return true; }, text: () => chunks.join("") };
}

async function lcv(argv) {
  const stdout = sink();
  const stderr = sink();
  const code = await main([...argv, "--no-cache", "--json"], { stdout, stderr, transport, env: {}, progress: null, interactive: false });
  assert.ok(stdout.text(), `lcv ${argv.join(" ")} printed nothing: ${stderr.text()}`);
  return { code, report: JSON.parse(stdout.text()) };
}

// The page's export readiness for the same bibliography: the CLI's own
// verification (core/verify.js through cli/lib/check.mjs), then
// core/output.js prepareExport, as the Export button asks it.
async function exportReadiness(file) {
  const loaded = Check.loadBibliography(fs.readFileSync(file, "utf8"));
  const { run } = await Check.verifyDocument(loaded.document, Check.createCliProviders());
  return Out.prepareExport({
    document: loaded.document, entries: run.entries, results: run.results, decisions: run.decisions,
    fieldEdits: run.fieldEdits, settings: Check.RUN_SETTINGS,
  }).readiness;
}

// ─── Cases ───────────────────────────────────────────────────────────
// expect: the one entry's status and review reasons, the strict exit code
// (0 pass, 1 blocks, 3 only a failed lookup blocks) and what the export
// still requires ([] = ready); unavailable: the providers named as not
// answering; alert: the provider reported once for its bot challenge.
// fix: the entry passes after `lcv fix`. versions: the review offers the
// preprint and the published version.
const REVIEW = { exit: 1, export: ["decision"] };
const CASES = [
  // The external reviewer's counterexamples.
  { name: "korean-titles", group: "reviewer", about: "another Korean title under the same DOI, authors, year and venue",
    expect: { status: "needs_review", reasons: ["id_title_mismatch"], ...REVIEW } },
  { name: "given-names", group: "reviewer", about: "\"Smith, John\" vs a record by \"Smith, James\"",
    expect: { status: "needs_review", reasons: ["core_change_without_id"], ...REVIEW, diff: "author" } },
  { name: "doi-unconfirmed", group: "reviewer", about: "DOI unknown to Crossref and DataCite, DOI-less DBLP record matches",
    expect: { status: "needs_review", reasons: ["doi_unconfirmed"], ...REVIEW } },
  { name: "doi-lookup-failed", fixture: "doi-unconfirmed", down: ["api.datacite.org"], group: "reviewer",
    about: "the same, but the DataCite lookup fails",
    expect: { status: "lookup_failed", reasons: ["identifier_lookup_failed"], exit: 3, export: ["decision"] } },
  // Fabricated references (one per kind).
  { name: "fab-invented-title", group: "fabricated", about: "invented title, real authors, venue and year",
    expect: { status: "not_found", reasons: ["no_matching_record"], exit: 1, export: ["not_found_ack"] } },
  { name: "fab-wrong-first-author", group: "fabricated", about: "real title, another first author",
    expect: { status: "needs_review", reasons: ["wrong_authors"], ...REVIEW } },
  { name: "fab-year-shift", group: "fabricated", about: "real title and authors, year moved by 3",
    expect: { status: "needs_review", reasons: ["wrong_year"], ...REVIEW } },
  { name: "fab-doi-of-other-paper", group: "fabricated", about: "real work carrying another paper's DOI",
    expect: { status: "needs_review", reasons: ["id_title_mismatch"], ...REVIEW } },
  { name: "fab-arxiv-of-other-paper", group: "fabricated", about: "real work carrying another paper's arXiv ID",
    expect: { status: "needs_review", reasons: ["id_title_mismatch"], ...REVIEW } },
  { name: "fab-nonexistent-doi", group: "fabricated", about: "real work with a well-formed DOI nobody registered",
    expect: { status: "needs_review", reasons: ["doi_unconfirmed"], ...REVIEW } },
  { name: "fab-nonexistent-pmid", group: "fabricated", about: "real work with a PMID PubMed does not have",
    expect: { status: "needs_review", reasons: ["pmid_unconfirmed"], ...REVIEW } },
  { name: "fab-chimera", group: "fabricated", about: "title, authors and year of A; venue, volume and pages of B",
    expect: { status: "needs_review", reasons: ["core_change_without_id"], ...REVIEW } },
  { name: "fab-wrong-journal", group: "fabricated", about: "real work in another journal",
    expect: { status: "needs_review", reasons: ["core_change_without_id"], ...REVIEW } },
  { name: "fab-invented-authors", group: "fabricated", about: "real title, invented author list",
    expect: { status: "needs_review", reasons: ["wrong_authors"], ...REVIEW } },
  // Provider outages: a verdict never rests on a provider that did not answer.
  { name: "outage-dblp-down", fixture: "outage-dblp-only", down: ["dblp.org"], group: "outage",
    about: "only DBLP lists the paper (no DOI), and DBLP is down",
    expect: { status: "lookup_failed", reasons: ["provider_unavailable"], exit: 3, export: ["decision"], unavailable: ["DBLP"] } },
  { name: "outage-dblp-challenge", fixture: "outage-published-version", challenge: ["dblp.org"], group: "outage",
    about: "DBLP serves its bot challenge; elsewhere only the arXiv preprint is listed",
    expect: { status: "lookup_failed", reasons: ["provider_unavailable"], exit: 3, export: ["decision"], unavailable: ["DBLP"], alert: "DBLP" } },
  // Positive controls (over-blocking).
  { name: "control-verified", group: "control", about: "entry confirmed by its own DOI",
    expect: { status: "verified", reasons: ["core_fields_match"], exit: 0, export: [] } },
  { name: "control-missing-doi", group: "control", about: "entry lacking only the DOI the record supplies",
    expect: { status: "updated", reasons: ["additive_only"], exit: 1, export: [] }, fix: { added: ["doi"] } },
  { name: "control-preprint-published", group: "control", about: "preprint's arXiv ID with the published version's year",
    expect: { status: "needs_review", reasons: ["identifier_record_not_auto_applicable"], ...REVIEW }, versions: true },
  { name: "control-dblp-only", fixture: "outage-dblp-only", group: "control", about: "the DBLP-only paper with DBLP answering",
    expect: { status: "verified", reasons: ["core_fields_match"], exit: 0, export: [] } },
  { name: "control-dblp-published", fixture: "outage-published-version", group: "control", about: "the conference version with DBLP answering",
    expect: { status: "verified", reasons: ["core_fields_match"], exit: 0, export: [] } },
];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lcv-regression-"));

async function runCase(spec) {
  const fixture = spec.fixture || spec.name;
  const bib = path.join(FIXTURES, `${fixture}.bib`);
  const world = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${fixture}.json`), "utf8"));
  return current.run(upstream(world, spec.down, spec.challenge), async () => {
    const [checked, readiness] = await Promise.all([lcv(["check", bib, "--strict"]), exportReadiness(bib)]);
    const outcome = { checked, readiness, entry: checked.report.files[0].entries[0] };
    if (spec.fix) {
      const fixed = path.join(tempRoot, `${spec.name}.bib`);
      outcome.fixed = await lcv(["fix", bib, "-o", fixed]);
      outcome.rechecked = await lcv(["check", fixed, "--strict"]);
    }
    return outcome;
  });
}

// Every case starts now; each test awaits its own. A failure is kept for its test.
const started = Date.now();
const outcomes = new Map(CASES.map(spec => [spec.name, runCase(spec).then(value => ({ value }), error => ({ error }))]));
async function outcomeOf(name) {
  const { value, error } = await outcomes.get(name);
  if (error) throw error;
  return value;
}

const isPreprint = candidate => !!candidate.arxiv && /^(arxiv|corr)?$/i.test(candidate.venue || "");
const offersBothVersions = entry => entry.candidates.some(isPreprint) &&
  entry.candidates.some(candidate => candidate.authoritative && !isPreprint(candidate));

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

for (const spec of CASES) {
  test(`${spec.group}: ${spec.name} — ${spec.about}`, async () => {
    const { checked, readiness, entry, fixed, rechecked } = await outcomeOf(spec.name);
    const { expect } = spec;
    assert.equal(checked.report.files[0].entries.length, 1, "one entry per fixture");
    assert.deepEqual([entry.status, entry.reasons], [expect.status, expect.reasons], entry.action);
    assert.equal(checked.code, expect.exit, "strict exit code");
    assert.equal(entry.blocking, expect.exit !== 0, "strict blocking");
    assert.deepEqual(readiness.requirements, expect.export, "export readiness");
    assert.equal(readiness.ready, expect.export.length === 0);
    if (expect.diff) assert.ok(entry.diffs.some(diff => diff.field === expect.diff), `the ${expect.diff} difference is shown`);
    if (spec.group === "fabricated") assert.ok(entry.blocking && !readiness.ready, "a fabricated reference never passes");
    if (expect.unavailable) {
      assert.deepEqual(entry.unavailable_providers, expect.unavailable, "the providers that did not answer");
      assert.equal(entry.network_only, true, "only the outage blocks it: rerun");
      assert.doesNotMatch(entry.action, /replace|delete|resolve|approve/i, "no action against the entry");
      assert.match(entry.action, /rerun lcv check/);
    }
    if (expect.alert)
      assert.deepEqual(checked.report.network.provider_alerts.map(alert => alert.provider), [expect.alert], "the bot challenge is reported once");
    if (spec.fix) {
      assert.deepEqual(entry.fix.changes.map(change => (change.from === null ? `+${change.field}` : change.field)), spec.fix.added.map(field => `+${field}`));
      assert.equal(fixed.code, 0, "lcv fix applies the auto-update");
      assert.deepEqual(fixed.report.applied.map(item => item.key), [entry.key]);
      const again = rechecked.report.files[0].entries[0];
      assert.deepEqual([again.status, again.blocking, rechecked.code], ["verified", false, 0], "passes after lcv fix");
    }
    if (spec.versions) assert.ok(offersBothVersions(entry), "the preprint and the published version are offered");
  });
}

// ─── Audit rules (pure functions of core/audit.js) ───────────────────
test("audit: weak references never combine into 'supported'", () => {
  assert.equal(Audit.combineVerdicts(["weak", "weak"]), "weak");
  assert.equal(Audit.combineVerdicts(["weak", "weak", "unsupported"]), "weak");
  assert.equal(Audit.combineVerdicts(["supported", "weak"]), "supported", "one supporting reference is enough");
});

test("audit: 'supported' with an empty evidence quote becomes weak", () => {
  const evidence = { found: true, title: "Synthetic", abstract: "The method converges in every tested case.", rejected: [] };
  for (const evidenceQuote of [undefined, "", "   ", "\"\""]) {
    const judged = Audit.verifyEvidenceQuote({ verdict: "supported", confidence: 0.9, reason: "r", evidenceQuote, riskFlags: [] }, evidence);
    assert.equal(judged.verdict, "weak", JSON.stringify(evidenceQuote));
    assert.ok(judged.riskFlags.includes("missing_quote"));
  }
  const quoted = Audit.verifyEvidenceQuote({ verdict: "supported", evidenceQuote: "converges in every tested case", riskFlags: [] }, evidence);
  assert.equal(quoted.verdict, "supported", "a quote found in the abstract keeps it");
});

// ─── Summary ─────────────────────────────────────────────────────────
test("summary: fabricated references accepted and controls wrongly blocked", async t => {
  const rows = [];
  for (const spec of CASES) {
    const { value, error } = await outcomes.get(spec.name);
    const entry = value?.entry;
    const pass = !!entry && !entry.blocking;
    const fixed = spec.fix ? value?.rechecked?.report.files[0].entries[0]?.blocking === false : false;
    rows.push({
      spec, error, pass, fixed,
      status: entry ? `${entry.status} (${entry.reasons.join(", ")})` : `error: ${error?.message}`,
      strict: pass ? "passes" : fixed ? "blocks until lcv fix" : "blocks",
      export: value?.readiness?.ready ? "ready" : "held",
      versions: !!entry && !!spec.versions && offersBothVersions(entry),
      networkOnly: !!entry?.network_only,
    });
  }
  const fabricated = rows.filter(row => row.spec.group === "fabricated");
  // Not shown to block (an error counts) is accepted.
  const accepted = fabricated.filter(row => row.error || row.pass || row.export === "ready");
  const controls = rows.filter(row => row.spec.group === "control");
  // A control is wrongly blocked when it does not pass (directly or after
  // lcv fix), or, for the version pair, when the review lacks a version.
  const wronglyBlocked = controls.filter(row => row.error || (row.spec.versions ? !row.versions : !row.pass && !row.fixed));
  // An outage turned into a verdict: anything but a lookup failure to rerun.
  const outages = rows.filter(row => row.spec.group === "outage");
  const outageVerdicts = outages.filter(row => row.error || !row.networkOnly);
  const columns = [["group", row => row.spec.group], ["case", row => row.spec.name], ["status (reasons)", row => row.status],
    ["--strict", row => row.strict], ["export", row => row.export]];
  const widths = columns.map(([title, value]) => Math.max(title.length, ...rows.map(row => value(row).length)) + 2);
  const line = cells => cells.map((text, index) => text.padEnd(widths[index])).join("").trimEnd();
  const table = [
    `Verdict regression: ${rows.length} cases in ${((Date.now() - started) / 1000).toFixed(1)} s, no network`,
    line(columns.map(([title]) => title)),
    ...rows.map(row => line(columns.map(([, value]) => value(row)))),
    `fabricated references accepted: ${accepted.length} of ${fabricated.length} (must be 0)`,
    `controls wrongly blocked: ${wronglyBlocked.length} of ${controls.length}`,
    `provider outages turned into a verdict: ${outageVerdicts.length} of ${outages.length} (must be 0)`,
  ];
  for (const text of table) t.diagnostic(text);
  assert.deepEqual(accepted.map(row => row.spec.name), []);
  assert.deepEqual(wronglyBlocked.map(row => row.spec.name), []);
  assert.deepEqual(outageVerdicts.map(row => row.spec.name), []);
});
