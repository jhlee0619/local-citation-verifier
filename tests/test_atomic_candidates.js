const assert = require("assert");
global.fuzzball = require("fuzzball");
const lib = require("../docs/lib.js");
const atomic = require("../docs/atomic-candidates.js");

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

function record(fields, source, id) {
  return atomic.createRecord(fields, {
    recordSource: source,
    recordId: id,
    retrieval: "fixture",
  });
}

console.log("\n── atomic candidates ──");

test("keeps Semantic Scholar and CrossRef core metadata in separate records", () => {
  const original = atomic.createOriginal({
    title: "Source Paper",
    author: "Original, A",
    year: "2023",
    doi: "10.1000/atomic",
  });
  const semanticScholar = record({
    title: "Source Paper",
    author: "Scholar, Sam",
    doi: "10.1000/atomic",
  }, "semantic_scholar_match", "ss-1");
  const crossref = record({
    title: "Published Source Paper",
    author: "Crossref, Casey",
    year: "2024",
    journal: "Journal of Atomic Records",
    doi: "10.1000/atomic",
  }, "crossref_doi", "10.1000/atomic");

  const result = atomic.selectCanonical(original, [semanticScholar, crossref], {
    preferPublished: true,
  });

  assert.strictEqual(result.status, "auto_apply");
  assert.deepStrictEqual(atomic.coreTuple(result.canonical), {
    title: crossref.title,
    author: crossref.author,
    year: crossref.year,
  });
  assert.strictEqual(result.canonical._coreSource, "crossref_doi");
  assert.ok(!String(result.canonical._source || "").includes("+"));
});

test("never auto-applies a generic title-only match", () => {
  const original = atomic.createOriginal({
    title: "Introduction",
    author: "Original, A",
    year: "2020",
  });
  const unrelated = record({
    title: "Introduction",
    author: "Else, Someone",
    year: "2024",
    journal: "Different Journal",
  }, "crossref_search", "10.1000/unrelated");

  const result = atomic.selectCanonical(original, [unrelated], { preferPublished: true });

  assert.strictEqual(result.status, "needs_review");
  assert.deepStrictEqual(atomic.coreTuple(result.canonical), atomic.coreTuple(original));
});

test("deduplicates only the same provider record identity", () => {
  const crossref = record({ title: "One", doi: "10.1/same" }, "crossref_search", "10.1/same");
  const semantic = record({ title: "One", doi: "10.1/same" }, "semantic_scholar_match", "ss-1");
  const duplicate = record({ title: "One", doi: "10.1/same" }, "crossref_search", "10.1/same");
  assert.deepStrictEqual(
    atomic.dedupeRecords([semantic, duplicate, crossref]).map(item => item._recordSource),
    ["crossref_search", "semantic_scholar_match"]
  );
});

test("keeps DOI and arXiv links non-transitive", () => {
  const original = atomic.createOriginal({
    title: "Bridge Paper", author: "Author, A", year: "2024", doi: "10.1/bridge",
  });
  const bridge = record({
    title: "Bridge Paper", author: "Author, A", year: "2024",
    doi: "10.1/bridge", eprint: "2401.01234", journal: "Journal A",
  }, "crossref_doi", "10.1/bridge");
  const arxivOnly = record({
    title: "Different Preprint", author: "Other, B", year: "2024",
    eprint: "2401.01234", archiveprefix: "arXiv", url: "https://example.test/leak",
  }, "local_arxiv", "2401.01234");

  const selected = atomic.selectCanonical(original, [arxivOnly, bridge], { preferPublished: true });
  const enriched = atomic.enrichNonCore(selected.canonical, [arxivOnly], { linkKind: selected.linkKind });
  assert.strictEqual(selected.canonical._recordId, "10.1/bridge");
  assert.deepStrictEqual(atomic.directLinkKinds(original, arxivOnly), []);
  assert.notStrictEqual(enriched.url, arxivOnly.url);
});

test("selects whole preprint or published records from the immutable preference", () => {
  const original = atomic.createOriginal({
    title: "Versioned Work", author: "Author, A", year: "2023",
    eprint: "2301.00001", archiveprefix: "arXiv", journal: "arXiv",
  });
  const preprint = record({
    title: "Versioned Work", author: "Author, A", year: "2023",
    eprint: "2301.00001", archiveprefix: "arXiv", journal: "arXiv",
  }, "local_arxiv", "2301.00001");
  const published = record({
    title: "Versioned Work Published", author: "Author, A", year: "2024",
    eprint: "2301.00001", doi: "10.1/published", journal: "Journal B",
  }, "crossref_doi", "10.1/published");

  const off = atomic.selectCanonical(original, [published, preprint], { preferPublished: false });
  const on = atomic.selectCanonical(original, [preprint, published], { preferPublished: true });
  assert.strictEqual(off.canonical._recordId, preprint._recordId);
  assert.deepStrictEqual(atomic.coreTuple(off.canonical), atomic.coreTuple(preprint));
  assert.strictEqual(on.canonical._recordId, published._recordId);
  assert.deepStrictEqual(atomic.coreTuple(on.canonical), atomic.coreTuple(published));
});

test("preserves the original on same-version exact-ID core conflict", () => {
  const original = atomic.createOriginal({
    title: "Conflict", author: "Author, A", year: "2024", doi: "10.1/conflict",
  });
  const first = record({
    title: "Conflict", author: "Author, A", year: "2024", doi: "10.1/conflict", journal: "Journal",
  }, "crossref_doi", "10.1/conflict");
  const second = record({
    title: "Conflict Retraction", author: "Author, A", year: "2024", doi: "10.1/conflict", journal: "Journal",
  }, "semantic_scholar_match", "ss-conflict");
  const result = atomic.selectCanonical(original, [second, first], { preferPublished: true });
  assert.strictEqual(result.status, "needs_review");
  assert.strictEqual(result.reason, "core_conflict");
  assert.deepStrictEqual(atomic.coreTuple(result.canonical), atomic.coreTuple(original));
});

test("keeps incomplete published and local curation records as review alternatives", () => {
  const original = atomic.createOriginal({
    ID: "curated", title: "Curated Work", author: "Author, A", year: "2023",
    eprint: "2301.00002", archiveprefix: "arXiv", journal: "arXiv",
  });
  const incomplete = record({
    title: "Curated Work", year: "2024", eprint: "2301.00002", doi: "10.1/curated", journal: "Journal",
  }, "crossref_doi", "10.1/curated");
  const curation = record({
    title: "Curated Work", author: "Curator, C", year: "2024", eprint: "2301.00002", journal: "Journal",
  }, "local_curation", "rule:curated");
  const result = atomic.selectCanonical(original, [curation, incomplete], { preferPublished: true });
  assert.strictEqual(result.status, "needs_review");
  assert.strictEqual(result.reason, "no_complete_direct_record");
  assert.ok(result.candidates.includes(curation));
  assert.deepStrictEqual(atomic.coreTuple(result.canonical), atomic.coreTuple(original));
});

test("detects title, surname, year, and notice-class conflicts", () => {
  const original = atomic.createOriginal({
    title: "Conflict Matrix", author: "Author, A", year: "2024", doi: "10.1/matrix",
  });
  const base = record({
    title: "Conflict Matrix", author: "Author, A", year: "2024", doi: "10.1/matrix", journal: "Journal",
  }, "crossref_doi", "10.1/matrix");
  const variants = [
    { ...base, title: "Different Matrix" },
    { ...base, author: "Else, B" },
    { ...base, year: "2025" },
    { ...base, title: "Retraction: Conflict Matrix" },
  ].map((fields, index) => record(fields, "semantic_scholar_match", `ss-matrix-${index}`));
  for (const variant of variants) {
    const result = atomic.selectCanonical(original, [base, variant], { preferPublished: true });
    assert.strictEqual(result.reason, "core_conflict");
    assert.deepStrictEqual(atomic.coreTuple(result.canonical), atomic.coreTuple(original));
  }
});

test("normalizes equivalent surname particles across BibTeX name forms", () => {
  for (const [bibtexName, naturalName] of [
    ["de Vries, Lucas", "Lucas de Vries"],
    ["van den Berg, Ada", "Ada van den Berg"],
  ]) {
    const original = atomic.createOriginal({
      title: "Particle Names", author: bibtexName, year: "2024", doi: "10.1/particles",
    });
    const crossref = record({
      title: "Particle Names", author: bibtexName, year: "2024", doi: "10.1/particles", journal: "Journal",
    }, "crossref_doi", "10.1/particles");
    const semanticScholar = record({
      title: "Particle Names", author: naturalName, year: "2024", doi: "10.1/particles", journal: "Journal",
    }, "semantic_scholar_match", "ss-particles");
    const result = atomic.selectCanonical(original, [semanticScholar, crossref], { preferPublished: true });
    assert.strictEqual(result.status, "auto_apply");
    assert.strictEqual(result.canonical._recordSource, "crossref_doi");
  }
});

test("produces the same canonical decision for every candidate permutation", () => {
  const original = atomic.createOriginal({
    title: "Permutation", author: "Author, A", year: "2024", doi: "10.1/permutation",
  });
  const candidates = [
    record({ title: "Permutation", author: "Author, A", year: "2024", doi: "10.1/permutation", journal: "J" }, "semantic_scholar_search", "ss-p"),
    record({ title: "Permutation", author: "Author, A", year: "2024", doi: "10.1/permutation", journal: "J" }, "crossref_doi", "10.1/permutation"),
    record({ title: "Permutation" }, "dblp", "conf/p"),
  ];
  const permutations = [
    candidates,
    [candidates[0], candidates[2], candidates[1]],
    [candidates[1], candidates[0], candidates[2]],
    [candidates[1], candidates[2], candidates[0]],
    [candidates[2], candidates[0], candidates[1]],
    candidates.slice().reverse(),
  ];
  const decisions = permutations.map(items => {
    const result = atomic.selectCanonical(original, items, { preferPublished: true });
    return [result.status, result.reason, result.canonical._recordSource, result.canonical._recordId, result.candidates.map(item => `${item._recordSource}:${item._recordId}`)];
  });
  decisions.slice(1).forEach(decision => assert.deepStrictEqual(decision, decisions[0]));
});

test("keeps top, rerank, margin, and LLM-call policy permutation invariant", () => {
  const original = { title: "Stable Ranking", author: "Author, A", year: "2024", doi: "10.1/stable" };
  const candidates = [
    record({ title: "Stable Ranking", author: "Author, A", year: "2024", doi: "10.1/stable", journal: "Journal" }, "crossref_doi", "10.1/stable"),
    record({ title: "Stable Ranking", author: "Author, A", year: "2024", doi: "10.1/stable", journal: "Journal" }, "semantic_scholar_match", "ss-stable"),
    record({ title: "Stable Ranking Draft", author: "Author, A", year: "2023", eprint: "2301.00003", journal: "arXiv" }, "local_arxiv", "2301.00003"),
  ];
  const permutations = [candidates, [candidates[1], candidates[2], candidates[0]], candidates.slice().reverse()];
  const summaries = permutations.map(items => {
    const top = lib.topCandidates(items, original, { preferPublished: true, limit: 3 });
    const ranked = lib.rerankCandidates(items, original, { preferPublished: true });
    return {
      top: top.map(item => `${item._recordSource}:${item._recordId}`),
      best: `${ranked.best._recordSource}:${ranked.best._recordId}`,
      margin: lib.scoreMargin(items, original, { preferPublished: true }),
      call: lib.shouldCallLlmRerank(ranked, items, original, { preferPublished: true, speedMode: "balanced" }),
    };
  });
  summaries.slice(1).forEach(summary => assert.deepStrictEqual(summary, summaries[0]));
});

test("enriches only empty non-core fields through one direct identifier kind", () => {
  const canonical = record({
    title: "Enrichment", author: "Author, A", year: "2024", doi: "10.1/enrich", journal: "Canonical Journal",
  }, "crossref_doi", "10.1/enrich");
  const sameYear = record({
    title: "Enrichment", author: "Author, A", year: "2024", doi: "10.1/enrich",
    journal: "Canonical Journal", volume: "7", pages: "1--9", publisher: "Publisher", url: "https://example.test/paper",
  }, "dblp", "journals/enrich");
  const wrongYear = record({
    title: "Enrichment", author: "Author, A", year: "2023", doi: "10.1/enrich", number: "99",
  }, "semantic_scholar_match", "ss-enrich");
  const enriched = atomic.enrichNonCore(canonical, [wrongYear, sameYear], { linkKind: "doi" });

  assert.strictEqual(enriched.title, canonical.title);
  assert.strictEqual(enriched.journal, canonical.journal);
  assert.strictEqual(enriched.volume, "7");
  assert.strictEqual(Object.isFrozen(enriched._fieldProvenance), true);
  assert.strictEqual(enriched.pages, "1--9");
  assert.strictEqual(enriched.number, undefined);
  assert.strictEqual(enriched.url, sameYear.url);
  assert.deepStrictEqual(enriched._fieldProvenance.volume, sameYear._fieldProvenance.volume);
});

test("flags a conflicting same-year publication block instead of transplanting it", () => {
  const canonical = record({
    title: "Block", author: "Author, A", year: "2024", doi: "10.1/block", journal: "Journal A",
  }, "crossref_doi", "10.1/block");
  const conflicting = record({
    title: "Block", author: "Author, A", year: "2024", doi: "10.1/block", journal: "Journal B", volume: "9",
  }, "dblp", "journals/block");
  const enriched = atomic.enrichNonCore(canonical, [conflicting], { linkKind: "doi" });
  assert.strictEqual(enriched.journal, "Journal A");
  assert.strictEqual(enriched.volume, undefined);
  assert.strictEqual(enriched._enrichmentNeedsReview, true);
});

test("records imported and explicit user provenance without exporting internals", () => {
  const candidate = record({
    ENTRYTYPE: "article", ID: "candidate", title: "Provenance", author: "Author, A",
    year: "2024", doi: "10.1/provenance",
  }, "crossref_doi", "10.1/provenance");
  const user = atomic.userProvenance(candidate);
  const manual = atomic.manualProvenance();
  const mixed = atomic.mixedCoreProvenance(candidate, {
    title: { action: "found", provenance: user },
    author: { action: "original" },
    year: { action: "custom", provenance: manual },
  });
  const bib = lib.entriesToBib([candidate]);

  assert.deepStrictEqual(user, { actor: "user", source: "crossref_doi", candidateId: "10.1/provenance" });
  assert.deepStrictEqual(manual, { actor: "user", source: "manual" });
  assert.strictEqual(mixed.mixed, true);
  assert.deepStrictEqual(candidate._fieldProvenance.title, {
    source: "crossref_doi", candidateId: "10.1/provenance", retrieval: "fixture",
  });
  assert.strictEqual(Object.isFrozen(candidate), true);
  assert.strictEqual(Object.isFrozen(candidate._fieldProvenance), true);
  assert.strictEqual(Object.isFrozen(candidate._fieldProvenance.title), true);
  assert.ok(!bib.includes("_recordSource"));
  assert.ok(!bib.includes("_fieldProvenance"));
});

process.on("exit", () => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
