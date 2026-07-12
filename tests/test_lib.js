const assert = require("assert");
const fuzzball = require("fuzzball");
global.fuzzball = fuzzball;
const lib = require("../docs/lib.js");
const gemma = require("../docs/gemma-reranker.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── stripLatex ──");

test("removes LaTeX accents", () => {
  assert.strictEqual(lib.stripLatex("\\'a"), "á");
  assert.strictEqual(lib.stripLatex('\\"o'), "ö");
  assert.strictEqual(lib.stripLatex("\\~n"), "ñ");
});

test("removes LaTeX commands", () => {
  assert.strictEqual(lib.stripLatex("\\textbf{bold}"), "bold");
  assert.strictEqual(lib.stripLatex("\\emph{text}"), "text");
});

test("removes braces", () => {
  assert.strictEqual(lib.stripLatex("{Hello} {World}"), "Hello World");
});

test("returns empty for falsy input", () => {
  assert.strictEqual(lib.stripLatex(""), "");
  assert.strictEqual(lib.stripLatex(null), "");
  assert.strictEqual(lib.stripLatex(undefined), "");
});

test("handles combined LaTeX", () => {
  const input = "Ren\\'{e} {D}escartes";
  const result = lib.stripLatex(input);
  assert.ok(result.includes("Descartes"), `Expected Descartes in "${result}"`);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── normalizeTitle ──");

test("lowercases and strips LaTeX", () => {
  assert.strictEqual(lib.normalizeTitle("{Attention} Is All You Need"), "attention is all you need");
});

test("handles empty string", () => {
  assert.strictEqual(lib.normalizeTitle(""), "");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── parseBib ──");

test("parses a single article entry", () => {
  const bib = `@article{vaswani2017,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish},
  year = {2017},
}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].ENTRYTYPE, "article");
  assert.strictEqual(entries[0].ID, "vaswani2017");
  assert.strictEqual(entries[0].title, "Attention Is All You Need");
  assert.strictEqual(entries[0].author, "Vaswani, Ashish");
  assert.strictEqual(entries[0].year, "2017");
});

test("parses multiple entries", () => {
  const bib = `@article{a, title={Paper A}, year={2020}}
@inproceedings{b, title={Paper B}, year={2021}}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].ID, "a");
  assert.strictEqual(entries[1].ID, "b");
  assert.strictEqual(entries[1].ENTRYTYPE, "inproceedings");
});

test("skips @string and @comment entries", () => {
  const bib = `@string{foo = {bar}}

@comment{This is a comment, with commas}

@article{real, title={Real Entry}, year={2023}}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].ID, "real");
});

test("handles double-quoted field values", () => {
  const bib = `@article{test, title="Quoted Title", year={2023}}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries[0].title, "Quoted Title");
});

test("preserves every escape pair in quoted values without corrupting following data", () => {
  const bib = String.raw`@article{escaped,
  title = "Using \LaTeX with H{\"a}ni and \{braces\}",
  note = "literal \\ slash, escaped quote \"inside\", and final \\",
  year = "2024",
}
@book{following,
  title = "Following Entry",
  year = "2025",
}`;
  const entries = lib.parseBib(bib);

  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].title, String.raw`Using \LaTeX with H{\"a}ni and \{braces\}`);
  assert.strictEqual(entries[0].note, String.raw`literal \\ slash, escaped quote \"inside\", and final \\`);
  assert.strictEqual(entries[0].year, "2024");
  assert.strictEqual(entries[1].ID, "following");
  assert.strictEqual(entries[1].title, "Following Entry");
});

test("quoted escape values survive parse serialize parse round trips", () => {
  const source = String.raw`@article{roundtrip,
  title = "\LaTeX and H{\"a}ni",
  note = "\{kept\}, \\, \"quoted\", final \\",
  year = "2024",
}`;
  const first = lib.parseBib(source);
  const serialized = lib.entriesToBib(first);
  const second = lib.parseBib(serialized);

  assert.deepStrictEqual(second, first);
  assert.ok(serialized.includes(String.raw`\LaTeX and H{\"a}ni`));
  assert.ok(serialized.includes(String.raw`\{kept\}, \\, \"quoted\", final \\`));
});

test("strict document parsing rejects malformed structure without partial entries", () => {
  const unterminatedQuote = '@article{ok, title={Complete}}\n@article{bad, title="unterminated}';
  const unterminatedEscape = '@article{bad, title="unterminated' + "\\";
  const cases = [
    {
      source: unterminatedQuote,
      reason: "unterminated_quote",
      offset: unterminatedQuote.lastIndexOf('"'),
    },
    {
      source: "@article{bad, title={unterminated}",
      reason: "unterminated_brace",
      offset: 8,
    },
    {
      source: unterminatedEscape,
      reason: "unterminated_escape",
      offset: unterminatedEscape.length - 1,
    },
  ];

  for (const { source, reason, offset } of cases) {
    const parsed = lib.parseBibDocument(source);
    assert.strictEqual(parsed.source, source);
    assert.deepStrictEqual(parsed.entries, []);
    assert.strictEqual(parsed.diagnostic.reason, reason);
    assert.strictEqual(parsed.diagnostic.offset, offset);
  }
});

test("strict document parsing accepts escaped delimiters and parenthesized entries", () => {
  const source = String.raw`@article(ok,
  title = "Escaped \"quote\" and final \\",
  note = {Escaped \{ braces \}},
  year = 2024,
)`;
  const parsed = lib.parseBibDocument(source);

  assert.strictEqual(parsed.source, source);
  assert.strictEqual(parsed.diagnostic, null);
  assert.strictEqual(parsed.entries.length, 1);
  assert.strictEqual(parsed.entries[0].ID, "ok");
});

test("strict document parsing does not treat quotes inside braced values as delimiters", () => {
  const source = '@article{inch, title={A 5" Disk Study}, year={2024}}';
  const parsed = lib.parseBibDocument(source);

  assert.strictEqual(parsed.diagnostic, null);
  assert.strictEqual(parsed.entries[0].title, 'A 5" Disk Study');
});

test("strict document parsing ignores assignment-like text inside braced values", () => {
  const source = '@article{draft, note={status = "draft}, year={2024}}';
  const parsed = lib.parseBibDocument(source);

  assert.strictEqual(parsed.diagnostic, null);
  assert.strictEqual(parsed.entries[0].note, 'status = "draft');
});

test("handles numeric field values", () => {
  const bib = `@article{test, title={Test}, year=2023}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries[0].year, "2023");
});

test("resolves duplicate year fields toward the published year", () => {
  const bib = `@article{edupuganti2021uncertainty,
  title = {Uncertainty quantification in deep {MRI} reconstruction},
  journal = {IEEE Transactions on Medical Imaging},
  year = {2021},
  year = {2019},
  doi = {10.1109/TMI.2020.3025065},
  eprint = {1901.11228},
  archiveprefix = {arXiv},
}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries[0].year, "2021");
});

test("returns empty array for invalid input", () => {
  assert.deepStrictEqual(lib.parseBib("not bibtex"), []);
  assert.deepStrictEqual(lib.parseBib(""), []);
});

test("parses misc with missing closing braces before next field (double-brace typos)", () => {
  const bib = `@misc{github_copilot_2025,
  author = {{GitHub},
  title = {{GitHub Copilot},
  howpublished = {\\url{https://github.com/features/copilot},
  year = {2025},
  note = {Accessed: 2025-06-01},
}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].author, "{GitHub}");
  assert.strictEqual(entries[0].title, "{GitHub Copilot}");
  assert.ok(entries[0].howpublished.includes("github.com/features/copilot"));
  assert.strictEqual(entries[0].year, "2025");
});

test("parses misc Cursor-style malformed braces", () => {
  const bib = `@misc{cursor_2025,
  author = {{Anysphere},
  title = {{Cursor: The AI Code Editor},
  howpublished = {\\url{https://www.cursor.com},
  year = {2025},
}`;
  const entries = lib.parseBib(bib);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].author, "{Anysphere}");
  assert.strictEqual(entries[0].title, "{Cursor: The AI Code Editor}");
});

test("parses bare-word macro values without dropping following fields", () => {
  const bib = `@article{x, title={Foo Bar}, month=jan, year={2024}, doi={10.1/abc} }`;
  const entries = lib.parseBib(bib);

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].title, "Foo Bar");
  assert.strictEqual(entries[0].month, "jan");
  assert.strictEqual(entries[0].year, "2024");
  assert.strictEqual(entries[0].doi, "10.1/abc");
});

test("keeps at-sign characters inside field values", () => {
  const bib = `@article{y, title={Reach me at a@b.com today}, year={2024}, doi={10.1/xyz} }`;
  const entries = lib.parseBib(bib);

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].title, "Reach me at a@b.com today");
  assert.strictEqual(entries[0].year, "2024");
  assert.strictEqual(entries[0].doi, "10.1/xyz");
});

test("parses fieldless entries instead of dropping them", () => {
  const entries = lib.parseBib("@misc{empty_key}");

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].ENTRYTYPE, "misc");
  assert.strictEqual(entries[0].ID, "empty_key");
});

test("keeps parsing following entries after LaTeX accent quotes", () => {
  const bib = `@article{k1,
  author={H{\\"a}ni, Levin},
  year={2017}
}
@article{k2, title={Second}, year={2022}}`;
  const entries = lib.parseBib(bib);

  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].ID, "k1");
  assert.strictEqual(entries[1].ID, "k2");
});

test("keeps parsing following entries after escaped closing brace text", () => {
  const bib = "@article{k1, title={Path ends with \}, year={2001}} @article{k2, title={Second}, year={2002}}";
  const entries = lib.parseBib(bib);

  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].ID, "k1");
  assert.strictEqual(entries[0].year, "2001");
  assert.strictEqual(entries[1].ID, "k2");
  assert.strictEqual(entries[1].year, "2002");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── entriesToBib ──");

test("serializes entries back to BibTeX", () => {
  const entries = [{ ENTRYTYPE: "article", ID: "test2023", title: "My Paper", year: "2023" }];
  const bib = lib.entriesToBib(entries);
  assert.ok(bib.includes("@article{test2023,"));
  assert.ok(bib.includes("title = {My Paper}"));
  assert.ok(bib.includes("year = {2023}"));
});

test("skips internal fields starting with _", () => {
  const entries = [{ ENTRYTYPE: "article", ID: "x", title: "T", _source: "crossref" }];
  const bib = lib.entriesToBib(entries);
  assert.ok(!bib.includes("_source"));
});

test("round-trips parse → serialize", () => {
  const original = `@inproceedings{bert2019,
  title = {BERT: Pre-training of Deep Bidirectional Transformers},
  author = {Devlin, Jacob},
  year = {2019},
}`;
  const entries = lib.parseBib(original);
  const serialized = lib.entriesToBib(entries);
  const reparsed = lib.parseBib(serialized);
  assert.strictEqual(reparsed.length, 1);
  assert.strictEqual(reparsed[0].title, entries[0].title);
  assert.strictEqual(reparsed[0].author, entries[0].author);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── titleSimilarity ──");

test("identical titles score 100", () => {
  assert.strictEqual(lib.titleSimilarity("Attention Is All You Need", "Attention Is All You Need"), 100);
});

test("case-insensitive comparison", () => {
  assert.strictEqual(lib.titleSimilarity("attention is all you need", "ATTENTION IS ALL YOU NEED"), 100);
});

test("completely different titles score low", () => {
  const score = lib.titleSimilarity("Attention Is All You Need", "Quantum Chromodynamics at Finite Baryon Density");
  assert.ok(score < 75, `Expected < 75, got ${score}`);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── normalizeText ──");

test("removes diacritics and lowercases", () => {
  assert.strictEqual(lib.normalizeText("René Descartes"), "rene descartes");
});

test("collapses whitespace", () => {
  assert.strictEqual(lib.normalizeText("  hello   world  "), "hello world");
});

test("returns empty for falsy input", () => {
  assert.strictEqual(lib.normalizeText(""), "");
  assert.strictEqual(lib.normalizeText(null), "");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── normalizeAuthorSet ──");

test("extracts last names from 'Last, First' format", () => {
  const names = lib.normalizeAuthorSet("Vaswani, Ashish and Shazeer, Noam");
  assert.ok(names.has("vaswani"));
  assert.ok(names.has("shazeer"));
  assert.strictEqual(names.size, 2);
});

test("extracts last names from 'First Last' format", () => {
  const names = lib.normalizeAuthorSet("Ashish Vaswani and Noam Shazeer");
  assert.ok(names.has("vaswani"));
  assert.ok(names.has("shazeer"));
});

test("returns empty set for empty input", () => {
  assert.strictEqual(lib.normalizeAuthorSet("").size, 0);
  assert.strictEqual(lib.normalizeAuthorSet(null).size, 0);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── normalizePages ──");

test("normalizes different dash styles", () => {
  assert.strictEqual(lib.normalizePages("1--10"), "1-10");
  assert.strictEqual(lib.normalizePages("1 - 10"), "1-10");
  assert.strictEqual(lib.normalizePages("1---10"), "1-10");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── compareAuthors ──");

test("identical authors score 100", () => {
  assert.strictEqual(lib.compareAuthors("Vaswani, Ashish", "Vaswani, Ashish"), 100);
});

test("same last names, different format still match", () => {
  const score = lib.compareAuthors("Vaswani, Ashish and Shazeer, Noam", "Ashish Vaswani and Noam Shazeer");
  assert.strictEqual(score, 100);
});

test("no overlap scores 0", () => {
  assert.strictEqual(lib.compareAuthors("Smith, John", "Doe, Jane"), 0);
});

test("both empty scores 100", () => {
  assert.strictEqual(lib.compareAuthors("", ""), 100);
});

test("one empty scores 0", () => {
  assert.strictEqual(lib.compareAuthors("Smith, John", ""), 0);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── compareField ──");

test("year comparison is exact", () => {
  assert.strictEqual(lib.compareField("year", "2023", "2023"), 100);
  assert.strictEqual(lib.compareField("year", "2023", "2024"), 0);
});

test("doi comparison is exact and case-insensitive", () => {
  assert.strictEqual(lib.compareField("doi", "10.1234/abc", "10.1234/ABC"), 100);
});

test("pages with different dashes match", () => {
  assert.strictEqual(lib.compareField("pages", "1--10", "1-10"), 100);
});

test("both empty returns 100", () => {
  assert.strictEqual(lib.compareField("journal", "", ""), 100);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── compareEntry ──");

test("verified when all fields match", () => {
  const orig = { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017" };
  const found = { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017" };
  const result = lib.compareEntry(orig, found);
  assert.strictEqual(result.status, "verified");
});

test("updated when fields differ", () => {
  const orig = { title: "Attention Is All You Need", year: "2017" };
  const found = { title: "Attention Is All You Need", year: "2018" };
  const result = lib.compareEntry(orig, found);
  assert.strictEqual(result.status, "updated");
  assert.ok(result.field_diffs.some(d => d.field === "year"));
});

test("needs_review when titles differ significantly", () => {
  const orig = { title: "Attention Is All You Need" };
  const found = { title: "On the Origin of Species" };
  const result = lib.compareEntry(orig, found);
  assert.strictEqual(result.status, "needs_review");
});

test("enrichments mark entry as updated", () => {
  const orig = { title: "Test Paper", year: "2023" };
  const found = { title: "Test Paper", year: "2023", doi: "10.1234/test" };
  const result = lib.compareEntry(orig, found);
  assert.strictEqual(result.status, "updated");
  assert.ok(result.field_diffs.some(d => d.field === "doi"), "should report doi enrichment");
});

test("compareEntry does not mutate the found candidate", () => {
  const orig = { title: "Conference Paper", booktitle: "CVPR", year: "2024" };
  const found = { title: "Conference Paper", journal: "Computer Vision and Pattern Recognition", year: "2024" };

  lib.compareEntry(orig, found);

  assert.ok(!Object.prototype.hasOwnProperty.call(found, "booktitle"));
});

test("does not auto-suggest expanding truncated mega-author lists", () => {
  const orig = {
    title: "The Llama 3 Herd of Models",
    author: "Abhimanyu Dubey and Abhinav Jauhri and Abhinav Pandey and others",
    year: "2024",
  };
  const found = {
    title: "The Llama 3 Herd of Models",
    author: [
      "Dubey, Abhimanyu",
      "Jauhri, Abhinav",
      "Pandey, Abhinav",
      "Kadian, Abhishek",
      "Al-Dahle, Ahmad",
      "Letman, Aiesha",
      "Mathur, Akhil",
    ].join(" and "),
    year: "2024",
    _source: "semantic_scholar",
  };
  const result = lib.compareEntry(orig, found);
  assert.ok(!result.field_diffs.some(d => d.field === "author"));
  assert.strictEqual(result.suggested.author, undefined);
});

test("still suggests normal author mismatches", () => {
  const orig = { title: "Short Paper", author: "Smith, Alice", year: "2024" };
  const found = { title: "Short Paper", author: "Doe, Jane", year: "2024" };
  const result = lib.compareEntry(orig, found);
  assert.ok(result.field_diffs.some(d => d.field === "author"));
  assert.strictEqual(result.suggested.author, "Doe, Jane");
});

test("allows first-author corrections even when original uses others", () => {
  const orig = {
    title: "The Llama 3 Herd of Models",
    author: "Abhimanyu Dubey and Abhinav Jauhri and Abhinav Pandey and others",
    year: "2024",
  };
  const found = {
    title: "The Llama 3 Herd of Models",
    author: "Aaron Grattafiori and Abhimanyu Dubey and Abhinav Jauhri and Abhinav Pandey and others",
    year: "2024",
    _source: "arxiv",
  };
  const result = lib.compareEntry(orig, found);
  assert.ok(result.field_diffs.some(d => d.field === "author"));
  assert.strictEqual(result.suggested.author, found.author);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── fieldDiffsForNeedsReview ──");

test("returns empty array when found is null", () => {
  assert.deepStrictEqual(lib.fieldDiffsForNeedsReview({ title: "X" }, null), []);
});

test("includes title and differing fields for a weak title match", () => {
  const orig = {
    title: "My Completely Different Title",
    author: "Smith, Alice",
    year: "2020",
  };
  const found = {
    title: "Attention Is All You Need",
    author: "Vaswani, Ashish",
    year: "2017",
    journal: "NeurIPS",
  };
  const diffs = lib.fieldDiffsForNeedsReview(orig, found);
  assert.ok(diffs.some(d => d.field === "title"));
  assert.ok(diffs.some(d => d.field === "author"));
  assert.ok(diffs.some(d => d.field === "year"));
  assert.ok(diffs.some(d => d.field === "journal"));
});

test("includes enrichment fields from found", () => {
  const orig = { title: "Different Title Here", year: "2023" };
  const found = { title: "Another Title", year: "2023", doi: "10.1000/182" };
  const diffs = lib.fieldDiffsForNeedsReview(orig, found);
  assert.ok(diffs.some(d => d.field === "doi" && d.score === 0), "doi should be enrichment");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── crossrefToStandard ──");

test("converts CrossRef response to standard format", () => {
  const item = {
    title: ["Attention Is All You Need"],
    author: [{ family: "Vaswani", given: "Ashish" }],
    "published-print": { "date-parts": [[2017]] },
    "container-title": ["NeurIPS"],
    DOI: "10.5555/3295222.3295349",
    volume: "30",
    page: "5998-6008",
  };
  const result = lib.crossrefToStandard(item);
  assert.strictEqual(result.title, "Attention Is All You Need");
  assert.strictEqual(result.author, "Vaswani, Ashish");
  assert.strictEqual(result.year, "2017");
  assert.strictEqual(result.doi, "10.5555/3295222.3295349");
  assert.strictEqual(result._source, "crossref");
});

test("handles missing fields gracefully", () => {
  const result = lib.crossrefToStandard({});
  assert.strictEqual(result.title, "");
  assert.strictEqual(result.author, "");
  assert.strictEqual(result.year, "");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── ssToStandard ──");

test("dblpToStandard maps conference hits to proceedings metadata", () => {
  const candidate = lib.dblpToStandard({
    info: {
      authors: { author: [
        { text: "Noam Shazeer" },
        { text: "Azalia Mirhoseini" },
      ] },
      title: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer.",
      venue: "ICLR",
      year: "2017",
      type: "Conference and Workshop Papers",
      key: "conf/iclr/ShazeerMMDLHD17",
      ee: "https://openreview.net/forum?id=B1ckMDqlg",
    },
  });

  assert.strictEqual(candidate.title, "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer");
  assert.strictEqual(candidate.author, "Noam Shazeer and Azalia Mirhoseini");
  assert.strictEqual(candidate.booktitle, "International Conference on Learning Representations");
  assert.strictEqual(candidate.journal, undefined);
  assert.strictEqual(candidate.url, "https://openreview.net/forum?id=B1ckMDqlg");
  assert.strictEqual(candidate._source, "dblp");
});

test("dblpToStandard preserves NeurIPS pages and DBLP provenance", () => {
  const candidate = lib.dblpToStandard({
    info: {
      authors: { author: { text: "Carlos Riquelme" } },
      title: "Scaling Vision with Sparse Mixture of Experts.",
      venue: "NeurIPS",
      pages: "8583-8595",
      year: "2021",
      type: "Conference and Workshop Papers",
      key: "conf/nips/RiquelmePMNJPKH21",
      ee: "https://proceedings.neurips.cc/paper/2021/hash/48237d9f2dea8c74c2a72126cf63d933-Abstract.html",
    },
  });
  const provenance = lib.candidateProvenance({}, candidate);

  assert.strictEqual(candidate.booktitle, "Advances in Neural Information Processing Systems");
  assert.strictEqual(candidate.pages, "8583--8595");
  assert.ok(provenance.badges.some(badge => badge.label === "DBLP"));
});

test("converts Semantic Scholar response to standard format", () => {
  const paper = {
    title: "BERT",
    authors: [{ name: "Jacob Devlin" }, { name: "Ming-Wei Chang" }],
    year: 2019,
    venue: "NAACL",
    externalIds: { DOI: "10.18653/v1/N19-1423" },
  };
  const result = lib.ssToStandard(paper);
  assert.strictEqual(result.title, "BERT");
  assert.strictEqual(result.author, "Devlin, Jacob and Chang, Ming-Wei");
  assert.strictEqual(result.year, "2019");
  assert.strictEqual(result.journal, "NAACL");
  assert.strictEqual(result._source, "semantic_scholar");
});

test("preserves Semantic Scholar arXiv identifiers for local arXiv enrichment", () => {
  const result = lib.ssToStandard({
    title: "The Llama 3 Herd of Models",
    authors: [{ name: "Abhimanyu Dubey" }],
    year: 2024,
    venue: "arXiv",
    externalIds: { ArXiv: "2407.21783" },
  });
  assert.strictEqual(result.eprint, "2407.21783");
  assert.strictEqual(result.archiveprefix, "arXiv");
  assert.strictEqual(result._arxivId, "2407.21783");
  assert.strictEqual(lib.paperUrlForEntry(result), "https://arxiv.org/abs/2407.21783");
});

test("prefers publicationVenue.name over venue string", () => {
  const paper = {
    title: "Test",
    authors: [],
    year: 2023,
    venue: "short",
    publicationVenue: { name: "Full Venue Name" },
    externalIds: {},
  };
  const result = lib.ssToStandard(paper);
  assert.strictEqual(result.journal, "Full Venue Name");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── extractLastNames ──");

test("extracts from 'Last, First and Last, First' format", () => {
  const names = lib.extractLastNames("Vaswani, Ashish and Shazeer, Noam");
  assert.ok(names.has("vaswani"));
  assert.ok(names.has("shazeer"));
});

test("extracts from 'First Last' format", () => {
  const names = lib.extractLastNames("Ashish Vaswani");
  assert.ok(names.has("vaswani"));
});

test("returns empty set for empty input", () => {
  assert.strictEqual(lib.extractLastNames("").size, 0);
  assert.strictEqual(lib.extractLastNames(null).size, 0);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── isSamePaper ──");

test("same paper returns true", () => {
  const a = { title: "Attention Is All You Need", year: "2017", author: "Vaswani, Ashish" };
  const b = { title: "Attention Is All You Need", year: "2017", author: "Vaswani, Ashish" };
  assert.strictEqual(lib.isSamePaper(a, b), true);
});

test("different titles returns false", () => {
  const a = { title: "Paper A" };
  const b = { title: "Completely Different Paper" };
  assert.strictEqual(lib.isSamePaper(a, b), false);
});


test("suppresses author suggestions that only shorten given names to initials", () => {
  assert.strictEqual(lib.shouldSuppressAuthorSuggestion(
    "Wang, Qi and Zhan, Liang and Thompson, Paul and Zhou, Jiayu",
    "Wang, Qi and Zhan, L. and Thompson, P. and Zhou, Jiayu",
  ), true);
});

test("treats ACM SIGKDD proceedings wording as the same KDD venue", () => {
  assert.strictEqual(lib.compareField(
    "booktitle",
    "Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery \\& Data Mining",
    "Knowledge Discovery and Data Mining",
  ), 100);
});

test("treats DBLP MIDL abbreviation as Medical Imaging with Deep Learning", () => {
  assert.strictEqual(lib.compareField(
    "booktitle",
    "Medical Imaging with Deep Learning",
    "MIDL",
  ), 100);
});

test("compareEntry verifies exact DOI KDD paper despite harmless author and venue abbreviations", () => {
  const original = {
    ENTRYTYPE: "inproceedings",
    ID: "wang2020multimodal",
    title: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
    author: "Wang, Qi and Zhan, Liang and Thompson, Paul and Zhou, Jiayu",
    booktitle: "Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery \\& Data Mining",
    pages: "1828--1838",
    year: "2020",
    doi: "10.1145/3394486.3403234",
  };
  const found = {
    title: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
    author: "Wang, Qi and Zhan, L. and Thompson, P. and Zhou, Jiayu",
    journal: "Knowledge Discovery and Data Mining",
    pages: "1828--1838",
    year: "2020",
    doi: "10.1145/3394486.3403234",
  };

  const comparison = lib.compareEntry(original, found);

  assert.strictEqual(comparison.status, "verified");
  assert.deepStrictEqual(comparison.field_diffs, []);
});


test("keeps deterministic verified status for exact DOI despite conservative LLM review", () => {
  const original = {
    title: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
    author: "Wang, Qi and Zhan, Liang and Thompson, Paul and Zhou, Jiayu",
    booktitle: "Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery \\& Data Mining",
    pages: "1828--1838",
    year: "2020",
    doi: "10.1145/3394486.3403234",
  };
  const found = {
    title: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
    author: "Wang, Qi and Zhan, L. and Thompson, P. and Zhou, Jiayu",
    journal: "Knowledge Discovery and Data Mining",
    pages: "1828--1838",
    year: "2020",
    doi: "https://doi.org/10.1145/3394486.3403234",
    _rerankStatus: "needs_review",
  };
  const cmp = lib.compareEntry(original, found);

  assert.strictEqual(lib.shouldKeepDeterministicStatus(original, found, cmp), true);
  assert.strictEqual(cmp.status, "verified");

  const foundWithExternalDoi = { ...found, doi: "", _externalIds: { DOI: "10.1145/3394486.3403234" } };
  assert.strictEqual(lib.shouldKeepDeterministicStatus(original, foundWithExternalDoi, cmp), true);
});

test("collapses review-only exact title diffs as equivalent", () => {
  assert.strictEqual(lib.fieldDiffsAreEquivalent([
    {
      field: "title",
      original: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
      found: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
      score: 100,
    },
  ]), true);
});

test("preserves detailed original fields when applying equivalent KDD candidate", () => {
  const original = {
    ENTRYTYPE: "inproceedings",
    ID: "wang2020multimodal",
    title: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
    author: "Wang, Qi and Zhan, Liang and Thompson, Paul and Zhou, Jiayu",
    booktitle: "Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery \\& Data Mining",
    pages: "1828--1838",
    year: "2020",
    doi: "10.1145/3394486.3403234",
    url: "https://doi.org/10.1145/3394486.3403234",
    publisher: "ACM",
  };
  const found = {
    title: "Multimodal Learning with Incomplete Modalities by Knowledge Distillation",
    author: "Wang, Qi and Zhan, L. and Thompson, P. and Zhou, Jiayu",
    booktitle: "KDD",
    year: "2020",
    doi: "10.1145/3394486.3403234",
    url: "https://doi.org/10.1145/3394486.3403234",
  };

  const applied = lib.applyCandidateToEntry(original, found);

  assert.strictEqual(applied.author, original.author);
  assert.strictEqual(applied.booktitle, original.booktitle);
  assert.strictEqual(applied.doi, original.doi);
});

test("different years returns false", () => {
  const a = { title: "Attention Is All You Need", year: "2017" };
  const b = { title: "Attention Is All You Need", year: "2020" };
  assert.strictEqual(lib.isSamePaper(a, b), false);
});

test("correction notices are not the same paper as the corrected article", () => {
  const article = {
    title: "World Stroke Organization (WSO): Global Stroke Fact Sheet 2022",
    year: "2022",
  };
  const correction = {
    title: "Corrigendum to: World Stroke Organization (WSO): Global Stroke Fact Sheet 2022",
    year: "2022",
  };

  assert.strictEqual(lib.isSamePaper(article, correction), false);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── mergeMetadata ──");

test("primary fields take precedence", () => {
  const primary = { title: "A", year: "2020", _source: "ss" };
  const secondary = { title: "B", year: "2021", doi: "10.1234", _source: "cr" };
  const merged = lib.mergeMetadata(primary, secondary);
  assert.strictEqual(merged.title, "A");
  assert.strictEqual(merged.year, "2020");
  assert.strictEqual(merged.doi, "10.1234");
  assert.strictEqual(merged._source, "ss+cr");
});


test("isSamePaper allows one-year arXiv to proceedings publication drift", () => {
  const ss = {
    title: "Image-to-Image Translation with Conditional Adversarial Networks",
    author: "Isola, Phillip and Zhu, Jun-Yan and Zhou, Tinghui and Efros, Alexei A.",
    year: "2016",
    journal: "Computer Vision and Pattern Recognition",
    eprint: "1611.07004",
    archiveprefix: "arXiv",
    _source: "semantic_scholar",
    _arxivId: "1611.07004",
  };
  const dblp = {
    title: "Image-to-Image Translation with Conditional Adversarial Networks",
    author: "Isola, Phillip and Zhu, Jun-Yan and Zhou, Tinghui and Efros, Alexei A.",
    year: "2017",
    booktitle: "Computer Vision and Pattern Recognition",
    pages: "1125--1134",
    doi: "10.1109/CVPR.2017.632",
    _source: "dblp",
    _dblpKey: "conf/cvpr/IsolaZZE17",
  };

  assert.strictEqual(lib.isSamePaper(ss, dblp), true);
});


test("mergeMetadata does not copy CoRR volume into a published proceedings candidate", () => {
  const published = {
    title: "Denoising Diffusion Implicit Models",
    author: "Song, Jiaming and Meng, Chenlin and Ermon, Stefano",
    year: "2021",
    booktitle: "International Conference on Learning Representations",
    _source: "openreview",
  };
  const corr = {
    title: "Denoising Diffusion Implicit Models",
    author: "Song, Jiaming and Meng, Chenlin and Ermon, Stefano",
    year: "2020",
    journal: "CoRR",
    volume: "abs/2010.02502",
    url: "https://arxiv.org/abs/2010.02502",
    eprint: "2010.02502",
    archiveprefix: "arXiv",
    _source: "dblp",
    _dblpKey: "journals/corr/abs-2010-02502",
  };

  const merged = lib.mergeMetadata(published, corr);

  assert.strictEqual(merged.booktitle, "International Conference on Learning Representations");
  assert.strictEqual(merged.year, "2021");
  assert.strictEqual(merged.volume, undefined);
  assert.strictEqual(merged.url, "https://arxiv.org/abs/2010.02502");
  assert.strictEqual(merged.eprint, "2010.02502");
});

test("mergeMetadata prefers published proceedings year over arXiv-linked Semantic Scholar year", () => {
  const ss = {
    title: "Image-to-Image Translation with Conditional Adversarial Networks",
    author: "Isola, Phillip and Zhu, Jun-Yan and Zhou, Tinghui and Efros, Alexei A.",
    year: "2016",
    journal: "Computer Vision and Pattern Recognition",
    eprint: "1611.07004",
    archiveprefix: "arXiv",
    _source: "semantic_scholar",
    _arxivId: "1611.07004",
  };
  const dblp = {
    title: "Image-to-Image Translation with Conditional Adversarial Networks",
    author: "Isola, Phillip and Zhu, Jun-Yan and Zhou, Tinghui and Efros, Alexei A.",
    year: "2017",
    booktitle: "Computer Vision and Pattern Recognition",
    pages: "1125--1134",
    doi: "10.1109/CVPR.2017.632",
    _source: "dblp",
    _dblpKey: "conf/cvpr/IsolaZZE17",
  };

  const merged = lib.mergeMetadata(ss, dblp);

  assert.strictEqual(merged.year, "2017");
  assert.strictEqual(merged.doi, "10.1109/CVPR.2017.632");
  assert.strictEqual(merged.pages, "1125--1134");
});

test("isSamePaper and mergeMetadata trust exact DOI over stale Semantic Scholar year", () => {
  const ss = {
    title: "Uncertainty Quantification in Deep MRI Reconstruction",
    author: "Edupuganti, Vineet and Mardani, Morteza and Vasanawala, Shreyas and Pauly, John",
    year: "2019",
    journal: "IEEE Transactions on Medical Imaging",
    doi: "10.1109/TMI.2020.3025065",
    _source: "semantic_scholar",
  };
  const crossref = {
    title: "Uncertainty Quantification in Deep MRI Reconstruction",
    author: "Edupuganti, Vineet and Mardani, Morteza and Vasanawala, Shreyas and Pauly, John",
    year: "2021",
    journal: "IEEE Transactions on Medical Imaging",
    volume: "40",
    number: "1",
    pages: "239-250",
    doi: "10.1109/tmi.2020.3025065",
    _source: "crossref",
  };

  assert.strictEqual(lib.isSamePaper(ss, crossref), true);
  const merged = lib.mergeMetadata(ss, crossref);
  assert.strictEqual(merged.year, "2021");
  assert.strictEqual(merged.volume, "40");
  assert.strictEqual(merged.number, "1");
  assert.strictEqual(merged.pages, "239-250");
});

test("fills empty fields from secondary", () => {
  const primary = { title: "A", _source: "ss" };
  const secondary = { doi: "10.1234", volume: "5", _source: "cr" };
  const merged = lib.mergeMetadata(primary, secondary);
  assert.strictEqual(merged.doi, "10.1234");
  assert.strictEqual(merged.volume, "5");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── candidate application ──");

test("paperUrlForEntry prefers DOI landing page", () => {
  const entry = { doi: "10.1234/ABC", url: "https://example.test/paper" };
  assert.strictEqual(lib.paperUrlForEntry(entry), "https://doi.org/10.1234/ABC");
});

test("paperUrlForEntry falls back to URL when DOI is missing", () => {
  const entry = { url: "https://example.test/paper" };
  assert.strictEqual(lib.paperUrlForEntry(entry), "https://example.test/paper");
});
test("paperUrlForEntry rejects unsafe URL schemes", () => {
  assert.strictEqual(lib.paperUrlForEntry({ url: "javascript:alert(1)" }), "");
  assert.strictEqual(lib.paperUrlForEntry({ url: "data:text/html,<script>alert(1)</script>" }), "");
  assert.strictEqual(lib.paperUrlForEntry({ url: "ftp://example.test/paper" }), "");
});


test("extracts arXiv identifiers from entry URLs", () => {
  const entry = {
    title: "The Llama 3 Herd of Models",
    url: "https://arxiv.org/abs/2407.21783",
  };
  assert.strictEqual(lib.extractArxivId(entry), "2407.21783");
  assert.strictEqual(lib.paperUrlForEntry(entry), "https://arxiv.org/abs/2407.21783");
});

test("extracts arXiv identifiers with inline primary class suffixes", () => {
  assert.strictEqual(lib.extractArxivId({ eprint: "2407.21783 [cs.CL]" }), "2407.21783");
  assert.strictEqual(lib.extractArxivId({ eprint: "2407.21783v2 [cs.LG]" }), "2407.21783");
});

test("does not infer arXiv identifiers from DOI-like URLs", () => {
  assert.strictEqual(lib.extractArxivId({ url: "https://doi.org/10.1145/3290605.3300233" }), "");
  assert.strictEqual(lib.extractArxivId({ url: "https://doi.org/10.1234/2024.12345" }), "");
});

test("extracts old-style arXiv identifiers", () => {
  assert.strictEqual(lib.extractArxivId({ eprint: "hep-th/9901001" }), "hep-th/9901001");
  assert.strictEqual(lib.extractArxivId({ note: "arXiv:cs.CL/0101010v2" }), "cs.CL/0101010");
  assert.strictEqual(lib.paperUrlForEntry({ eprint: "hep-th/9901001", archiveprefix: "arXiv" }), "https://arxiv.org/abs/hep-th/9901001");
});

test("applyCandidateToEntry preserves BibTeX identity and skips internal fields", () => {
  const original = { ENTRYTYPE: "article", ID: "smith2024", title: "Draft", note: "keep" };
  const candidate = {
    title: "Published",
    year: "2024",
    doi: "10.1234/published",
    _source: "crossref",
  };
  const result = lib.applyCandidateToEntry(original, candidate);

  assert.strictEqual(result.ENTRYTYPE, "article");
  assert.strictEqual(result.ID, "smith2024");
  assert.strictEqual(result.title, "Published");
  assert.strictEqual(result.year, "2024");
  assert.strictEqual(result.doi, "10.1234/published");
  assert.strictEqual(result.note, "keep");
  assert.ok(!("_source" in result));
});

test("applyCandidateToEntry preserves arXiv ID year over inconsistent candidate metadata", () => {
  const original = {
    ENTRYTYPE: "misc",
    ID: "medgemma2024",
    title: "MedGemma Technical Report",
    year: "2025",
    eprint: "2507.05201",
    archiveprefix: "arXiv",
  };
  const candidate = {
    title: "MedGemma Technical Report",
    year: "2026",
    journal: "arXiv",
    eprint: "2507.05201",
    archiveprefix: "arXiv",
    _source: "arxiv",
  };

  const result = lib.applyCandidateToEntry(original, candidate);

  assert.strictEqual(lib.arxivYearFromId(result.eprint), "2025");
  assert.strictEqual(result.year, "2025");
});

test("applyCandidateToEntry preserves published year over matching arXiv submission year", () => {
  const original = {
    ENTRYTYPE: "article",
    ID: "published2021",
    title: "Published Version",
    year: "2021",
    journal: "NeuroImage",
    eprint: "1912.01234",
    archiveprefix: "arXiv",
  };
  const candidate = {
    title: "Published Version",
    year: "2019",
    journal: "arXiv",
    eprint: "1912.01234",
    archiveprefix: "arXiv",
    _source: "arxiv",
  };

  const result = lib.applyCandidateToEntry(original, candidate);

  assert.strictEqual(result.year, "2021");
});

test("applyCandidateToEntry keeps IEEE year when duplicate year input also has arXiv eprint", () => {
  const original = lib.parseBib(`@article{edupuganti2021uncertainty,
  title = {Uncertainty quantification in deep {MRI} reconstruction},
  author = {Edupuganti, Vineet and Mardani, Morteza and Vasanawala, Shreyas and Pauly, John M.},
  journal = {IEEE Transactions on Medical Imaging},
  volume = {40},
  number = {1},
  pages = {239--250},
  year = {2021},
  year = {2019},
  doi = {10.1109/TMI.2020.3025065},
  url = {https://doi.org/10.1109/TMI.2020.3025065},
  eprint = {1901.11228},
  archiveprefix = {arXiv},
}`)[0];
  const candidate = {
    title: original.title,
    author: original.author,
    journal: "arXiv",
    year: "2019",
    eprint: "1901.11228",
    archiveprefix: "arXiv",
    _source: "arxiv",
  };

  const result = lib.applyCandidateToEntry(original, candidate);

  assert.strictEqual(original.year, "2021");
  assert.strictEqual(result.year, "2021");
});

test("cleanBibliographyEntry applies publication corrections for known stroke fixture entries", () => {
  const deVries = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "de2024accelerating",
    title: "Accelerating physics-informed neural fields for fast CT perfusion analysis in acute ischemic stroke",
    author: "de Vries, Lucas and Van Herten, Rudolf Leonardus Mirjam",
    journal: "Medical Imaging with Deep Learning",
    volume: "1",
    year: "2024",
    publisher: "PMLR",
  });
  assert.strictEqual(deVries.ENTRYTYPE, "inproceedings");
  assert.strictEqual(deVries.booktitle, "Medical Imaging with Deep Learning");
  assert.strictEqual(deVries.series, "Proceedings of Machine Learning Research");
  assert.strictEqual(deVries.volume, "250");
  assert.strictEqual(deVries.pages, "1606--1626");
  assert.ok(!("journal" in deVries));
  assert.ok(deVries.author.includes("{de Vries}, Lucas"));
  assert.ok(deVries.author.includes("{van Herten}, Rudolf L. M."));
  assert.ok(deVries.title.includes("{CT}"));

  const albers = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "albers2018thrombectomy",
    title: "Thrombectomy for stroke at 6 to 16 hours with selection by perfusion imaging",
    journal: "New England Journal of Medicine",
    volume: "378",
    number: "8",
    pages: "708--718",
    year: "2018",
    publisher: "Clarivate Analytics (US) LLC",
  });
  assert.strictEqual(albers.journal, "N Engl J Med");
  assert.strictEqual(albers.doi, "10.1056/NEJMoa1713973");
  assert.ok(!("publisher" in albers));
});

test("cleanBibliographyEntry applies graphics and medical physics export corrections", () => {
  const muller = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "muller2022instant",
    title: "Instant neural graphics primitives with a multiresolution hash encoding",
    journal: "ACM transactions on graphics (TOG)",
    volume: "41",
    number: "4",
    pages: "1--15",
    year: "2022",
  });
  assert.strictEqual(muller.journal, "ACM Transactions on Graphics");
  assert.strictEqual(muller.articleno, "102");
  assert.strictEqual(muller.numpages, "15");
  assert.strictEqual(muller.pages, "102:1--102:15");

  const riordan = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "riordan2011validation",
    title: "Validation of CT brain perfusion methods using a realistic dynamic head phantom",
    author: "Riordan, Alan J and de Jong, Hugo WAM",
    journal: "Medical physics",
    publisher: "Wiley Online Library",
  });
  assert.strictEqual(riordan.journal, "Medical Physics");
  assert.strictEqual(riordan.doi, "10.1118/1.3592639");
  assert.ok(!("publisher" in riordan));
  assert.ok(riordan.author.includes("Riordan, A. J."));
  assert.ok(riordan.author.includes("{de Jong}, H. W. A. M."));
});

test("cleanBibliographyEntry applies conference and arXiv corrections for language-model fixture entries", () => {
  const vit = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "dosovitskiy2020image",
    title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
    journal: "International Conference on Learning Representations",
    year: "2020",
  });
  assert.strictEqual(vit.ENTRYTYPE, "inproceedings");
  assert.strictEqual(vit.year, "2021");
  assert.strictEqual(vit.booktitle, "International Conference on Learning Representations");
  assert.ok(!("journal" in vit));

  const lora = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "hu2021lora",
    title: "LoRA: Low-Rank Adaptation of Large Language Models",
    author: "Hu, J. and Shen, Yelong and Wallis, Phillip and Allen-Zhu, Zeyuan and Li, Yuanzhi and Wang, Shean and Chen, Weizhu",
    journal: "International Conference on Learning Representations",
    year: "2021",
  });
  assert.strictEqual(lora.ENTRYTYPE, "inproceedings");
  assert.strictEqual(lora.year, "2022");
  assert.strictEqual(lora.booktitle, "International Conference on Learning Representations");
  assert.ok(lora.title.includes("{LoRA}"));
  assert.ok(lora.author.includes("Hu, Edward J."));
  assert.ok(lora.author.includes("Wang, Lu"));

  const medgemma = lib.cleanBibliographyEntry({
    ENTRYTYPE: "misc",
    ID: "medgemma2024",
    title: "MedGemma Technical Report",
    journal: "arXiv",
    year: "2025",
    eprint: "2507.05201",
    archiveprefix: "arXiv",
  });
  assert.strictEqual(medgemma.ID, "sellergren2025medgemma");
  assert.strictEqual(medgemma.ENTRYTYPE, "article");
  assert.strictEqual(medgemma.journal, "arXiv preprint arXiv:2507.05201");
});

test("cleanBibliographyEntry applies stroke and vision fixture corrections", () => {
  const campbell = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "campbell2019ischaemic",
    author: "Campbell, Bruce C.V. and Silva, D. D. De and Macleod, M.",
    publisher: "Nature Publishing Group UK London",
  });
  assert.ok(campbell.author.includes("De Silva, Deidre A."));
  assert.ok(!("publisher" in campbell));

  const san = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "san2018imaging",
    author: "Rom{'a}n, L. and Menon, B.",
    journal: "Lancet Neurology",
  });
  assert.ok(san.author.includes(String.raw`San Rom{\'a}n, Luis`));
  assert.strictEqual(san.journal, "The Lancet Neurology");

  const he = lib.cleanBibliographyEntry({
    ENTRYTYPE: "inproceedings",
    ID: "he2022masked",
    author: "He, Kaiming and Doll'ar, Piotr and Girshick, Ross B.",
    booktitle: "Computer Vision and Pattern Recognition",
    year: "2021",
    pages: "16000-16009",
  });
  assert.strictEqual(he.year, "2022");
  assert.strictEqual(he.booktitle, "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition");
  assert.strictEqual(he.pages, "16000--16009");
  assert.ok(he.author.includes(String.raw`Doll{\'a}r, Piotr`));
});

test("cleanBibliographyEntry applies late publication and proceedings corrections", () => {
  const singhal = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "singhal2023towards",
    title: "Toward expert-level medical question answering with large language models",
    journal: "Nature Medicine",
    pages: "943-950",
    year: "2025",
  });
  assert.strictEqual(singhal.ID, "singhal2025toward");
  assert.strictEqual(singhal.pages, "943--950");

  const ma = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "ma2024learningmodalityknowledgealignment",
    title: "Learning Modality Knowledge Alignment for Cross-Modality Transfer",
    journal: "International Conference on Machine Learning",
    year: "2024",
  });
  assert.strictEqual(ma.ENTRYTYPE, "inproceedings");
  assert.strictEqual(ma.booktitle, "Proceedings of the 41st International Conference on Machine Learning");
  assert.strictEqual(ma.series, "Proceedings of Machine Learning Research");
  assert.strictEqual(ma.volume, "235");
  assert.strictEqual(ma.pages, "33777--33793");

  const llava = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "li2023llava",
    title: "LLaVA-Med: Training a Large Language-and-Vision Assistant for Biomedicine in One Day",
    journal: "Neural Information Processing Systems",
    volume: "36",
    pages: "28541-28564",
  });
  assert.strictEqual(llava.ENTRYTYPE, "inproceedings");
  assert.strictEqual(llava.booktitle, "Advances in Neural Information Processing Systems");
  assert.strictEqual(llava.pages, "28541--28564");
  assert.ok(llava.title.includes("{LLaVA-Med}"));
});

test("cleanBibliographyEntry applies AAAI corrections for FiLM", () => {
  const entry = lib.cleanBibliographyEntry({
    ENTRYTYPE: "inproceedings",
    ID: "perez2018film",
    title: "FiLM: Feature-wise Linear Modulation",
    author: "Perez, Ethan and Strub, Florian and De Vries, Harm and Dumoulin, Vincent and Courville, Aaron",
    year: "2018",
    booktitle: "Proceedings of the AAAI Conference on Artificial Intelligence",
    volume: "32",
  });

  assert.strictEqual(entry.ENTRYTYPE, "inproceedings");
  assert.strictEqual(entry.title, "{FiLM}: Visual Reasoning with a General Conditioning Layer");
  assert.strictEqual(entry.booktitle, "Proceedings of the AAAI Conference on Artificial Intelligence");
  assert.strictEqual(entry.volume, "32");
  assert.strictEqual(entry.number, "1");
  assert.strictEqual(entry.doi, "10.1609/aaai.v32i1.11671");
  assert.strictEqual(entry.url, "https://ojs.aaai.org/index.php/AAAI/article/view/11671");
});

test("curatedCandidateForEntry returns official AAAI metadata for FiLM", () => {
  const candidate = lib.curatedCandidateForEntry({
    ID: "perez2018film",
    title: "FiLM: Feature-wise Linear Modulation",
    author: "Perez, Ethan and Strub, Florian and De Vries, Harm and Dumoulin, Vincent and Courville, Aaron",
    year: "2018",
  });

  assert.strictEqual(candidate._source, "curated:aaai");
  assert.strictEqual(candidate.title, "{FiLM}: Visual Reasoning with a General Conditioning Layer");
  assert.strictEqual(candidate.doi, "10.1609/aaai.v32i1.11671");
});

test("normalizeTitle maps beta glyphs to searchable beta text", () => {
  assert.strictEqual(lib.looseTitleText("β-VAE: Learning Basic Visual Concepts"), "beta vae learning basic visual concepts");
});

test("openreviewToStandard parses official OpenReview BibTeX without curated fallback", () => {
  const candidate = lib.openreviewToStandard({
    id: "Sy2fzU9gl",
    forum: "Sy2fzU9gl",
    invitation: "ICLR.cc/2017/conference/-/submission",
    content: {
      title: "beta-VAE: Learning Basic Visual Concepts with a Constrained Variational Framework",
      venue: "ICLR 2017 Poster",
      venueid: "ICLR.cc/2017/conference",
      authors: ["Irina Higgins", "Loic Matthey"],
      _bibtex: `@inproceedings{higgins2017betavae,
        title={beta-{VAE}: Learning Basic Visual Concepts with a Constrained Variational Framework},
        author={Irina Higgins and Loic Matthey and Arka Pal and Christopher Burgess and Xavier Glorot and Matthew Botvinick and Shakir Mohamed and Alexander Lerchner},
        booktitle={International Conference on Learning Representations},
        year={2017},
        url={https://openreview.net/forum?id=Sy2fzU9gl}
      }`,
    },
  });

  assert.strictEqual(candidate._source, "openreview");
  assert.strictEqual(candidate.title, "beta-{VAE}: Learning Basic Visual Concepts with a Constrained Variational Framework");
  assert.strictEqual(candidate.booktitle, "International Conference on Learning Representations");
  assert.strictEqual(candidate.year, "2017");
  assert.strictEqual(candidate.url, "https://openreview.net/forum?id=Sy2fzU9gl");
});


test("openreviewToStandard sanitizes DBLP mirror BibTeX for ICLR export", () => {
  const candidate = lib.openreviewToStandard({
    id: "r__WH0b7Sg9",
    forum: "Sy2fzU9gl",
    invitation: "dblp.org/-/record",
    content: {
      title: "beta-VAE: Learning Basic Visual Concepts with a Constrained Variational Framework",
      venue: "ICLR (Poster) 2017",
      venueid: "dblp.org/conf/ICLR/2017",
      _bibtex: `@inproceedings{DBLP:conf/iclr/HigginsMPBGBML17,
        author       = {Irina Higgins and Lo{\\'i}c Matthey and Arka Pal},
        title        = {beta-{VAE}: Learning Basic Visual Concepts with a Constrained Variational Framework},
        booktitle    = {{ICLR} (Poster)},
        year         = {2017},
        url          = {https://openreview.net/forum?id=Sy2fzU9gl},
        cdate        = {1483228800000},
        crossref     = {conf/iclr/2017}
      }`,
    },
  });

  assert.strictEqual(candidate._source, "openreview");
  assert.strictEqual(candidate.booktitle, "International Conference on Learning Representations");
  assert.strictEqual(candidate.cdate, undefined);
  assert.strictEqual(candidate.crossref, undefined);
  assert.strictEqual(candidate.url, "https://openreview.net/forum?id=Sy2fzU9gl");
});

test("curatedCandidateForEntry does not hardcode beta-VAE", () => {
  assert.strictEqual(lib.curatedCandidateForEntry({
    ID: "higgins2017beta",
    title: "beta-VAE: Learning Basic Visual Concepts with a Constrained Variational Framework",
    year: "2017",
  }), null);
});

test("cleanBibliographyEntry applies ICLR corrections for sparsely gated MoE", () => {
  const entry = lib.cleanBibliographyEntry({
    ENTRYTYPE: "inproceedings",
    ID: "shazeer2017outrageously",
    title: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
    author: "Shazeer, Noam and Mirhoseini, Azalia and Maziarz, Krzysztof and Davis, Andy and Le, Quoc and Hinton, Geoffrey and Dean, Jeff",
    booktitle: "International Conference on Learning Representations (ICLR)",
    year: "2017",
  });

  assert.strictEqual(entry.ENTRYTYPE, "inproceedings");
  assert.strictEqual(entry.booktitle, "International Conference on Learning Representations");
  assert.strictEqual(entry.year, "2017");
  assert.strictEqual(entry.url, "https://openreview.net/forum?id=B1ckMDqlg");
  assert.strictEqual(entry.journal, undefined);
});

test("curatedCandidateForEntry returns official OpenReview metadata for sparsely gated MoE", () => {
  const candidate = lib.curatedCandidateForEntry({
    ID: "shazeer2017outrageously",
    title: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
    year: "2017",
  });

  assert.strictEqual(candidate._source, "curated:openreview");
  assert.strictEqual(candidate.booktitle, "International Conference on Learning Representations");
  assert.strictEqual(candidate.url, "https://openreview.net/forum?id=B1ckMDqlg");
});

test("cleanBibliographyEntry applies NeurIPS corrections for sparse vision MoE", () => {
  const entry = lib.cleanBibliographyEntry({
    ENTRYTYPE: "inproceedings",
    ID: "riquelme2021scaling",
    title: "Scaling Vision with Sparse Mixture of Experts",
    author: "Riquelme, Carlos and Puigcerver, Joan and Mustafa, Basil and Neumann, Maxim and Jenatton, Rodolphe and Susano Pinto, Andr{'e} and Keysers, Daniel and Houlsby, Neil",
    booktitle: "Advances in Neural Information Processing Systems (NeurIPS)",
    year: "2021",
  });

  assert.strictEqual(entry.ENTRYTYPE, "inproceedings");
  assert.strictEqual(entry.booktitle, "Advances in Neural Information Processing Systems");
  assert.strictEqual(entry.volume, "34");
  assert.strictEqual(entry.pages, "8583--8595");
  assert.strictEqual(entry.year, "2021");
  assert.strictEqual(entry.url, "https://proceedings.neurips.cc/paper/2021/hash/48237d9f2dea8c74c2a72126cf63d933-Abstract.html");
  assert.strictEqual(entry.journal, undefined);
});

test("curatedCandidateForEntry returns official NeurIPS metadata for sparse vision MoE", () => {
  const candidate = lib.curatedCandidateForEntry({
    ID: "riquelme2021scaling",
    title: "Scaling Vision with Sparse Mixture of Experts",
    year: "2021",
  });

  assert.strictEqual(candidate._source, "curated:neurips");
  assert.strictEqual(candidate.booktitle, "Advances in Neural Information Processing Systems");
  assert.strictEqual(candidate.pages, "8583--8595");
});

test("cleanBibliographyEntry applies JMLR corrections for Switch Transformers", () => {
  const entry = lib.cleanBibliographyEntry({
    ID: "fedus2022switch",
    title: "Switch transformers: Scaling to trillion parameter models with simple and efficient sparsity",
    author: "Fedus, William and Zoph, Barret and Shazeer, Noam",
    journal: "Journal of Machine Learning Research",
    volume: "23",
    number: "120",
    pages: "1--39",
    year: "2022",
    url: "https://arxiv.org/abs/2101.03961",
    eprint: "2101.03961",
    archiveprefix: "arXiv",
  });

  assert.strictEqual(entry.journal, "Journal of Machine Learning Research");
  assert.strictEqual(entry.volume, "23");
  assert.strictEqual(entry.number, "120");
  assert.strictEqual(entry.pages, "1--39");
  assert.strictEqual(entry.url, "https://jmlr.org/papers/v23/21-0998.html");
  assert.strictEqual(entry.eprint, undefined);
  assert.strictEqual(entry.archiveprefix, undefined);
});

test("curatedCandidateForEntry returns official JMLR metadata for Switch Transformers", () => {
  const candidate = lib.curatedCandidateForEntry({
    ID: "fedus2022switch",
    title: "Switch transformers: Scaling to trillion parameter models with simple and efficient sparsity",
    author: "Fedus, William and Zoph, Barret and Shazeer, Noam",
    year: "2022",
  });

  assert.strictEqual(candidate._source, "curated:jmlr");
  assert.strictEqual(candidate.journal, "Journal of Machine Learning Research");
  assert.strictEqual(candidate.url, "https://jmlr.org/papers/v23/21-0998.html");
});

test("cleanBibliographyEntry applies medical AI fixture publication corrections", () => {
  const autoStroke = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "lee2023automatic",
    title: "Automatic detection on diffusion weighted image using convolutional neural networks",
    journal: "Scientific Reports",
    publisher: "Research Square Platform LLC",
  });
  assert.ok(!("publisher" in autoStroke));
  assert.ok(autoStroke.title.includes("{CNN}"));

  const koska = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "koska2024deep",
    journal: "Journal of Imaging Informatics in Medicine",
    pages: "1--14",
    year: "2024",
  });
  assert.strictEqual(koska.volume, "38");
  assert.strictEqual(koska.pages, "1374--1387");
  assert.strictEqual(koska.year, "2025");

  const llama = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "dubey2024llama",
    title: "The Llama 3 Herd of Models",
    author: "Aaron Grattafiori and Abhimanyu Dubey",
    journal: "arXiv",
    pages: "arXiv--2407",
    eprint: "2407.21783",
  });
  assert.strictEqual(llama.ID, "grattafiori2024llama");
  assert.strictEqual(llama.journal, "arXiv preprint arXiv:2407.21783");
  assert.ok(!("pages" in llama));
});

test("cleanBibliographyEntry protects lower-case surname particles in BibTeX author fields", () => {
  const entry = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "particle-test",
    author: "Lugt, A. van der and Jong, H. de and Gablentz, J. and Vries, Lucas de and Herten, R. V.",
  });

  assert.strictEqual(entry.author, "{van der Lugt}, Aad and {de Jong}, H. W. A. M. and {von der Gablentz}, Janina and {de Vries}, Lucas and {van Herten}, Rudolf L. M.");
});

test("cleanBibliographyEntry protects capitalization and adds missing article URLs", () => {
  const murphy = lib.cleanBibliographyEntry({
    ENTRYTYPE: "article",
    ID: "murphy2007serial",
    title: "Serial changes in CT cerebral blood volume and flow after 4 hours of middle cerebral occlusion in an animal model of embolic cerebral ischemia",
    journal: "American Journal of Neuroradiology",
    volume: "28",
    number: "4",
    pages: "743--749",
    year: "2007",
    publisher: "American Journal of Neuroradiology",
  });
  assert.strictEqual(murphy.journal, "AJNR Am J Neuroradiol");
  assert.strictEqual(murphy.url, "https://www.ajnr.org/content/28/4/743");
  assert.ok(!("publisher" in murphy));
  assert.ok(murphy.title.includes("{CT}"));
});

test("applyCandidateToEntry keeps conference exports from duplicating journal and booktitle", () => {
  const original = { ENTRYTYPE: "inproceedings", ID: "he2022masked", booktitle: "CVPR" };
  const candidate = {
    booktitle: "Computer Vision and Pattern Recognition",
    journal: "Computer Vision and Pattern Recognition",
    doi: "10.1109/CVPR52688.2022.01553",
  };
  const result = lib.applyCandidateToEntry(original, candidate);

  assert.strictEqual(result.booktitle, "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition");
  assert.strictEqual(result.doi, "10.1109/CVPR52688.2022.01553");
  assert.ok(!("journal" in result));
});

test("applyCandidateToEntry keeps a published venue when a candidate reports a preprint venue", () => {
  const original = {
    ENTRYTYPE: "article",
    ID: "alfaro2018image",
    title: "Image processing and Quality Control for the first 10,000 brain imaging datasets from UK Biobank",
    journal: "Neuroimage",
    volume: "166",
    pages: "400--424",
    year: "2017",
  };
  const candidate = {
    title: "Image processing and Quality Control for the first 10,000 brain imaging datasets from UK Biobank",
    journal: "bioRxiv",
    publisher: "openRxiv",
    doi: "10.1016/j.neuroimage.2017.10.034",
    url: "https://doi.org/10.1016/j.neuroimage.2017.10.034",
  };

  const result = lib.applyCandidateToEntry(original, candidate);

  assert.strictEqual(result.journal, "Neuroimage");
  assert.strictEqual(result.doi, "10.1016/j.neuroimage.2017.10.034");
  assert.ok(!("publisher" in result));
});

test("preservePublishedVenue keeps published metadata for comparison results", () => {
  const original = { journal: "Neuroimage", volume: "166", pages: "400--424" };
  const candidate = {
    journal: "bioRxiv",
    publisher: "openRxiv",
    doi: "10.1016/j.neuroimage.2017.10.034",
  };

  const result = lib.preservePublishedVenue(original, candidate);

  assert.strictEqual(result.journal, "Neuroimage");
  assert.strictEqual(result.doi, "10.1016/j.neuroimage.2017.10.034");
  assert.ok(!("publisher" in result));
});

test("candidateProvenance marks exact arXiv identity as high confidence", () => {
  const original = { title: "The Llama 3 Herd of Models", url: "https://arxiv.org/abs/2407.21783" };
  const candidate = {
    title: "The Llama 3 Herd of Models",
    eprint: "2407.21783",
    archiveprefix: "arXiv",
    _source: "arxiv",
  };

  const provenance = lib.candidateProvenance(original, candidate);

  assert.strictEqual(provenance.confidence, "High");
  assert.ok(provenance.badges.some(badge => badge.label === "arXiv exact"));
  assert.strictEqual(provenance.warnings.length, 0);
});

test("candidateProvenance flags correction notices for review", () => {
  const original = { title: "World Stroke Organization (WSO): Global Stroke Fact Sheet 2022" };
  const candidate = {
    title: "Corrigendum to: World Stroke Organization (WSO): Global Stroke Fact Sheet 2022",
    doi: "10.1177/17474930221080343",
    _source: "crossref",
  };

  const provenance = lib.candidateProvenance(original, candidate);

  assert.strictEqual(provenance.confidence, "Review");
  assert.ok(provenance.badges.some(badge => badge.label === "correction notice"));
  assert.ok(provenance.warnings.some(text => text.includes("correction")));
});

test("candidateProvenance flags preprint venue conflicts with published originals", () => {
  const original = { title: "Image processing and Quality Control", journal: "Neuroimage" };
  const candidate = {
    title: "Image processing and Quality Control",
    journal: "bioRxiv",
    doi: "10.1016/j.neuroimage.2017.10.034",
    _source: "semantic_scholar",
  };

  const provenance = lib.candidateProvenance(original, candidate);

  assert.strictEqual(provenance.confidence, "Review");
  assert.ok(provenance.badges.some(badge => badge.label === "preprint venue"));
  assert.ok(provenance.warnings.some(text => text.includes("preserved")));
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── bestMatch ──");

test("returns best matching candidate above threshold", () => {
  const candidates = [
    { title: "Completely Wrong" },
    { title: "Attention Is All You Need" },
  ];
  const result = lib.bestMatch(candidates, "Attention Is All You Need");
  assert.strictEqual(result.title, "Attention Is All You Need");
});

test("returns null when no candidate meets threshold", () => {
  const candidates = [{ title: "Quantum Chromodynamics at Finite Baryon Density" }];
  const result = lib.bestMatch(candidates, "Attention Is All You Need");
  assert.strictEqual(result, null);
});

test("returns null for empty candidates", () => {
  assert.strictEqual(lib.bestMatch([], "test"), null);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── rerankCandidates ──");

test("prefers a published version over an arXiv/preprint candidate when title and authors match", () => {
  const original = {
    title: "Attention Is All You Need",
    author: "Vaswani, Ashish and Shazeer, Noam",
    year: "2017",
  };
  const candidates = [
    {
      title: "Attention Is All You Need",
      author: "Ashish Vaswani and Noam Shazeer",
      year: "2017",
      journal: "CoRR",
      _source: "semantic_scholar",
    },
    {
      title: "Attention Is All You Need",
      author: "Vaswani, Ashish and Shazeer, Noam",
      year: "2017",
      journal: "Advances in Neural Information Processing Systems",
      doi: "10.5555/3295222.3295349",
      _source: "crossref",
    },
  ];

  const result = lib.rerankCandidates(candidates, original, { preferPublished: true });

  assert.strictEqual(result.best.journal, "Advances in Neural Information Processing Systems");
  assert.strictEqual(result.bestIndex, 1);
});

test("prefers local arXiv metadata over Semantic Scholar author ordering for arXiv records", () => {
  const original = {
    title: "The Llama 3 Herd of Models",
    author: "Abhimanyu Dubey and Abhinav Jauhri and Abhinav Pandey and others",
    year: "2024",
  };
  const semanticScholar = {
    title: "The Llama 3 Herd of Models",
    author: "Abhimanyu Dubey and Abhinav Jauhri and Abhinav Pandey and Abhishek Kadian",
    year: "2024",
    journal: "arXiv",
    _source: "semantic_scholar",
    _arxivId: "2407.21783",
  };
  const arxiv = {
    title: "The Llama 3 Herd of Models",
    author: "Aaron Grattafiori and Abhimanyu Dubey and Abhinav Jauhri and Abhinav Pandey and Abhishek Kadian",
    year: "2024",
    journal: "arXiv",
    _source: "arxiv",
    _arxivId: "2407.21783",
  };
  const result = lib.rerankCandidates([semanticScholar, arxiv], original, { preferPublished: true });
  assert.strictEqual(result.best, arxiv);
});

test("prefers a published CVPR candidate over arXiv when the original is in proceedings", () => {
  const original = {
    title: "Masked Autoencoders Are Scalable Vision Learners",
    author: "Kaiming He and Xinlei Chen and Saining Xie and Yanghao Li and Piotr Doll'ar and Ross B. Girshick",
    year: "2021",
    booktitle: "Proceedings of the IEEE/CVF conference on computer vision and pattern recognition",
    url: "https://arxiv.org/abs/2111.06377",
  };
  const arxiv = {
    title: "Masked Autoencoders Are Scalable Vision Learners",
    author: "He, Kaiming and Chen, Xinlei and Xie, Saining and Li, Yanghao and Dollár, Piotr and Girshick, Ross B.",
    year: "2021",
    journal: "arXiv",
    _source: "arxiv",
    _arxivId: "2111.06377",
  };
  const cvpr = {
    title: "Masked Autoencoders Are Scalable Vision Learners",
    author: "He, Kaiming and Chen, Xinlei and Xie, Saining and Li, Yanghao and Dollár, Piotr and Girshick, Ross B.",
    year: "2022",
    booktitle: "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    pages: "16000--16009",
    _source: "semantic_scholar",
    _arxivId: "2111.06377",
  };
  const unique = lib.dedupeCandidates([arxiv, cvpr]);
  const result = lib.rerankCandidates(unique, original, { preferPublished: true });
  assert.strictEqual(unique.length, 1);
  assert.strictEqual(unique[0], cvpr);
  assert.strictEqual(result.best, cvpr);
});

test("limits candidate choices to the highest scoring matches", () => {
  const original = { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017" };
  const candidates = [
    { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017", journal: "arXiv" },
    { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017", journal: "NeurIPS", doi: "10.5555/3295222.3295349" },
    { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017", journal: "Journal A", doi: "10.1/a" },
    { title: "Unrelated", author: "Someone Else", year: "2024", journal: "Journal B" },
  ];

  const top = lib.topCandidates(candidates, original, { preferPublished: true, limit: 2 });

  assert.strictEqual(top.length, 2);
  assert.strictEqual(top[0].doi, "10.5555/3295222.3295349");
  assert.strictEqual(top[1].doi, "10.1/a");
});

test("mergeMetadata prefers published venue over matching arXiv preprint metadata", () => {
  const arxiv = {
    title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
    author: "Lewis, Patrick and Perez, Ethan and Piktus, Aleksandara",
    year: "2020",
    journal: "arXiv",
    eprint: "2005.11401",
    archiveprefix: "arXiv",
    _source: "arxiv",
    _arxivId: "2005.11401",
  };
  const published = {
    title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
    author: "Lewis, Patrick and Perez, Ethan and Piktus, Aleksandara",
    year: "2020",
    journal: "Neural Information Processing Systems",
    eprint: "2005.11401",
    archiveprefix: "arXiv",
    _source: "semantic_scholar",
    _arxivId: "2005.11401",
  };

  const merged = lib.mergeMetadata(arxiv, published);

  assert.strictEqual(merged.journal, "Neural Information Processing Systems");
  assert.strictEqual(merged.eprint, "2005.11401");
});

test("deduplicates candidates by DOI and same normalized title plus venue", () => {
  const candidates = [
    { title: "A Study", doi: "10.1000/XYZ", journal: "Journal A" },
    { title: "A Study", doi: "10.1000/xyz", journal: "Journal B" },
    { title: "{A} Study", journal: "Journal C" },
    { title: "A Study", journal: "Journal C" },
  ];

  const unique = lib.dedupeCandidates(candidates);

  assert.strictEqual(unique.length, 2);
  assert.strictEqual(unique[0].journal, "Journal A");
  assert.strictEqual(unique[1].journal, "Journal C");
});

test("prefers the candidate with the original arXiv identifier", () => {
  const original = {
    title: "The Llama 3 Herd of Models",
    author: "Abhimanyu Dubey and Abhinav Jauhri and Abhinav Pandey and others",
    year: "2024",
    url: "https://arxiv.org/abs/2407.21783",
  };
  const candidates = [
    {
      title: "The Llama 3 Herd of Models",
      author: "Team, Llama",
      year: "2024",
      journal: "arXiv.org",
      _source: "semantic_scholar",
    },
    {
      title: "The Llama 3 Herd of Models",
      author: "Aaron Grattafiori and Abhimanyu Dubey and Abhinav Jauhri and others",
      year: "2024",
      journal: "arXiv",
      eprint: "2407.21783",
      archiveprefix: "arXiv",
      _source: "arxiv",
    },
  ];

  const ranked = lib.rerankCandidates(candidates, original, { preferPublished: true });

  assert.strictEqual(ranked.best.eprint, "2407.21783");
});

test("penalizes candidates with a different arXiv identifier", () => {
  const original = {
    title: "MedGemma Technical Report",
    year: "2025",
    eprint: "2507.05201",
    archiveprefix: "arXiv",
  };
  const candidates = [
    {
      title: "MedGemma 1.5 Technical Report",
      year: "2026",
      eprint: "2604.05081",
      archiveprefix: "arXiv",
      journal: "arXiv",
      _source: "arxiv",
    },
    {
      title: "MedGemma Technical Report",
      year: "2025",
      eprint: "2507.05201",
      archiveprefix: "arXiv",
      journal: "arXiv",
      _source: "arxiv",
    },
  ];

  const ranked = lib.rerankCandidates(candidates, original, { preferPublished: true });

  assert.strictEqual(ranked.best.eprint, "2507.05201");
});

test("prefers the corrected article over its correction notice for primary metadata", () => {
  const original = {
    title: "World Stroke Organization (WSO): global stroke fact sheet 2022",
    author: "Feigin, Valery L and Brainin, Michael and Norrving, Bo and others",
    journal: "International Journal of Stroke",
    volume: "17",
    number: "1",
    pages: "18--29",
    year: "2022",
  };
  const correction = {
    title: "Corrigendum to: World Stroke Organization (WSO): Global Stroke Fact Sheet 2022",
    journal: "International Journal of Stroke",
    volume: "17",
    number: "4",
    pages: "478-478",
    year: "2022",
    doi: "10.1177/17474930221080343",
  };
  const article = {
    title: "World Stroke Organization (WSO): Global Stroke Fact Sheet 2022",
    author: "Feigin, V. and Brainin, M. and Norrving, B.",
    journal: "International Journal of Stroke",
    volume: "17",
    number: "1",
    pages: "18-29",
    year: "2022",
    doi: "10.1177/17474930211065917",
  };

  const ranked = lib.rerankCandidates([correction, article], original, { preferPublished: true });

  assert.strictEqual(ranked.best.doi, "10.1177/17474930211065917");
  assert.strictEqual(ranked.best.number, "1");
  assert.strictEqual(ranked.best.pages, "18-29");
  assert.strictEqual(lib.isSamePaper(ranked.best, correction), false);
});

test("rejects LLM rerank overrides that lose an exact original arXiv match", () => {
  const original = {
    title: "The Llama 3 Herd of Models",
    url: "https://arxiv.org/abs/2407.21783",
  };
  const heuristic = {
    title: "The Llama 3 Herd of Models",
    eprint: "2407.21783",
    archiveprefix: "arXiv",
  };
  const llmChoice = {
    title: "The Llama 3 Herd of Models",
    author: "Team, Llama",
    journal: "arXiv.org",
  };

  assert.strictEqual(lib.shouldUseRerankCandidate(original, heuristic, llmChoice), false);
});

test("rejects rerank overrides without arXiv identity when authors differ", () => {
  const original = { title: "Anchor Paper", author: "Smith, Alice", year: "2024", eprint: "2407.21783", archiveprefix: "arXiv" };
  const heuristic = { title: "Different Paper", author: "Doe, Jane", year: "2024", eprint: "2501.01010", archiveprefix: "arXiv" };
  const llmChoice = { title: "Anchor Paper", author: "Doe, Jane", year: "2024", journal: "Journal A", doi: "10.1/not-anchor" };

  assert.strictEqual(lib.shouldUseRerankCandidate(original, heuristic, llmChoice), false);
});

test("allows rerank published upgrades for the same arXiv-anchored paper", () => {
  const original = { title: "Anchor Paper", author: "Smith, Alice", year: "2024", eprint: "2407.21783", archiveprefix: "arXiv" };
  const heuristic = { title: "Different Paper", author: "Doe, Jane", year: "2024", eprint: "2501.01010", archiveprefix: "arXiv" };
  const llmChoice = { title: "Anchor Paper", author: "Smith, Alice", year: "2024", journal: "Journal A", doi: "10.1/anchor" };

  assert.strictEqual(lib.shouldUseRerankCandidate(original, heuristic, llmChoice), true);
});

test("allows LLM rerank overrides that keep the original arXiv identifier", () => {
  const original = {
    title: "The Llama 3 Herd of Models",
    url: "https://arxiv.org/abs/2407.21783",
  };
  const heuristic = {
    title: "The Llama 3 Herd of Models",
    eprint: "2407.21783",
    archiveprefix: "arXiv",
  };
  const llmChoice = {
    title: "The Llama 3 Herd of Models",
    eprint: "2407.21783",
    archiveprefix: "arXiv",
  };

  assert.strictEqual(lib.shouldUseRerankCandidate(original, heuristic, llmChoice), true);
});

test("parses a one-based rerank index from model text", () => {
  assert.strictEqual(lib.parseRerankChoice("2", 3), 1);
  assert.strictEqual(lib.parseRerankChoice("{\"best\": 3}", 3), 2);
  assert.strictEqual(lib.parseRerankChoice("candidate 1 is best", 3), 0);
});

test("rejects out-of-range rerank model choices", () => {
  assert.strictEqual(lib.parseRerankChoice("4", 3), null);
  assert.strictEqual(lib.parseRerankChoice("no clear answer", 3), null);
});

test("lets rerank classification escalate unsafe matches to review", () => {
  assert.strictEqual(lib.resolveRerankStatus("updated", "needs_review"), "needs_review");
  assert.strictEqual(lib.resolveRerankStatus("updated", "not_found"), "needs_review");
  assert.strictEqual(lib.resolveRerankStatus("needs_review", "verified"), "needs_review");
  assert.strictEqual(lib.resolveRerankStatus("updated", "verified"), "updated");
  assert.strictEqual(lib.resolveRerankStatus("verified", "updated"), "verified");
});

test("keeps lookup and review statuses from being promoted by hidden diffs", () => {
  assert.strictEqual(lib.displayStatusForCard("needs_review", { hasVisibleDiffs: false }), "needs_review");
  assert.strictEqual(lib.displayStatusForCard("updated", { hasVisibleDiffs: false }), "verified");
  assert.strictEqual(lib.displayStatusForCard("verified", { hasVisibleDiffs: true, hasInjectedRows: true }), "updated");
});

test("flags mismatched arXiv identifiers as critical metadata conflicts", () => {
  const original = { title: "A Study", author: "Smith, Alice", year: "2024", eprint: "2407.21783", archiveprefix: "arXiv" };
  const found = { title: "A Study", author: "Smith, Alice", year: "2024", eprint: "2501.01010", archiveprefix: "arXiv" };

  assert.strictEqual(lib.hasCriticalMetadataConflict(original, found), true);
});

test("does not flag same-paper published upgrades without an arXiv id", () => {
  const original = { title: "A Study", author: "Smith, Alice", year: "2024", eprint: "2407.21783", archiveprefix: "arXiv" };
  const found = { title: "A Study", author: "Smith, Alice", year: "2024", journal: "Journal A", doi: "10.1/anchor" };

  assert.strictEqual(lib.hasCriticalMetadataConflict(original, found), false);
});

test("flags generic-title venue changes as critical rerank conflicts", () => {
  const original = {
    title: "Management of acute ischemic stroke.",
    author: "R. Rigual and B. Fuentes and E. Díez-Tejedor",
    journal: "Bmj",
    volume: "368",
    year: "2023",
  };
  const found = {
    title: "Management of acute ischemic stroke.",
    author: "Rigual, R. and Fuentes, B. and Díez-Tejedor, E.",
    journal: "Medicina clínica (Ed. impresa)",
    year: "2023",
    doi: "10.1016/j.medcli.2023.06.022",
  };

  assert.strictEqual(lib.hasCriticalMetadataConflict(original, found), true);
});

test("allows safe DOI enrichment for same venue and metadata", () => {
  const original = {
    title: "Masked Autoencoders Are Scalable Vision Learners",
    author: "He, Kaiming and Chen, Xinlei",
    booktitle: "Computer Vision and Pattern Recognition",
    year: "2022",
  };
  const found = {
    ...original,
    doi: "10.1109/CVPR52688.2022.01553",
  };

  assert.strictEqual(lib.hasCriticalMetadataConflict(original, found), false);
});

test("does not flag DOI enrichment when authors use others and first author matches", () => {
  const original = {
    title: "World Stroke Organization (WSO): global stroke fact sheet 2022",
    author: "Feigin, Valery L and Brainin, Michael and Norrving, Bo and others",
    journal: "International Journal of Stroke",
    volume: "17",
    number: "1",
    pages: "18--29",
    year: "2022",
  };
  const found = {
    title: "World Stroke Organization (WSO): Global Stroke Fact Sheet 2022",
    author: "Feigin, V. and Brainin, M. and Norrving, B.",
    journal: "International Journal of Stroke",
    volume: "17",
    number: "1",
    pages: "18-29",
    year: "2022",
    doi: "10.1177/17474930211065917",
  };

  assert.strictEqual(lib.hasCriticalMetadataConflict(original, found), false);
});

test("normalizeEntryForLookup keeps Proceedings journals as journals", () => {
  const pnas = lib.normalizeEntryForLookup({
    ENTRYTYPE: "article",
    title: "A Biology Paper",
    journal: "Proceedings of the National Academy of Sciences",
    year: "2024",
  });
  assert.strictEqual(pnas.journal, "Proceedings of the National Academy of Sciences");
  assert.strictEqual(pnas.booktitle, undefined);

  const ieee = lib.normalizeEntryForLookup({
    ENTRYTYPE: "article",
    title: "An Engineering Paper",
    journal: "Proceedings of the IEEE",
    year: "2024",
  });
  assert.strictEqual(ieee.journal, "Proceedings of the IEEE");
  assert.strictEqual(ieee.booktitle, undefined);
});

test("normalizeEntryForLookup does not treat www as a standalone conference token", () => {
  const normalized = lib.normalizeEntryForLookup({
    ENTRYTYPE: "article",
    title: "Web Research",
    journal: "WWW Internet Research",
    year: "2024",
  });
  assert.strictEqual(normalized.journal, "WWW Internet Research");
  assert.strictEqual(normalized.booktitle, undefined);
});

test("normalizeEntryForLookup extracts arXiv id from journal and drops placeholder pages", () => {
  const normalized = lib.normalizeEntryForLookup({
    ENTRYTYPE: "article",
    title: "The Llama 3 Herd of Models",
    journal: "arXiv e-prints",
    pages: "arXiv--2407",
    url: "https://arxiv.org/abs/2407.21783",
    year: "2024",
  });
  assert.strictEqual(normalized.eprint, "2407.21783");
  assert.strictEqual(normalized.journal, "");
  assert.strictEqual(normalized.pages, undefined);
});

test("normalizeEntryForLookup moves conference journal on article entries to booktitle", () => {
  const normalized = lib.normalizeEntryForLookup({
    ENTRYTYPE: "article",
    title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
    journal: "Advances in Neural Information Processing Systems",
    year: "2020",
  });
  assert.strictEqual(normalized.booktitle, "Advances in Neural Information Processing Systems");
  assert.strictEqual(normalized.journal, undefined);
});

test("compareField ignores leading The in venue names", () => {
  assert.ok(lib.compareField("journal", "The Lancet Neurology", "Lancet Neurology") >= 95);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── Gemma reranker prompt ──");

test("builds a numbered prompt for candidate reranking", () => {
  const prompt = gemma.buildPrompt(
    { title: "A Study", author: "Doe, Jane", year: "2024", journal: "arXiv" },
    [
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "CoRR" },
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "Journal A", doi: "10.1/a" },
    ],
    { preferPublished: true },
  );

  assert.ok(prompt.includes('"status"'));
  assert.ok(prompt.includes("1. title="));
  assert.ok(prompt.includes("2. title="));
  assert.ok(prompt.includes("prefer the published version"));
});


test("prompt declares strict rerank schema and fixed risk flags", () => {
  const prompt = gemma.buildPrompt(
    { title: "A Study", author: "Doe, Jane", year: "2024", journal: "arXiv" },
    [
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "CoRR" },
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "Journal A", doi: "10.1/a" },
    ],
    { preferPublished: true },
  );

  assert.ok(prompt.includes("best must be an integer from 1 to 2"));
  assert.ok(prompt.includes("If status is not_found"));
  assert.ok(prompt.includes("Allowed risk_flags"));
  assert.ok(prompt.includes("venue_conflict"));
});

test("prompt requests English reasons by default while keeping enum keys stable", () => {
  const prompt = gemma.buildPrompt(
    { title: "A Study", author: "Doe, Jane", year: "2024" },
    [
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "CoRR" },
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "Journal A", doi: "10.1/a" },
    ],
    { preferPublished: true },
  );

  assert.ok(prompt.includes("Write the reason in English."));
  assert.ok(prompt.includes("JSON keys, status values, and risk_flags must remain in English"));
});

test("prompt can request Korean reasons while keeping enum keys stable", () => {
  const prompt = gemma.buildPrompt(
    { title: "A Study", author: "Doe, Jane", year: "2024" },
    [
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "CoRR" },
      { title: "A Study", author: "Doe, Jane", year: "2024", journal: "Journal A", doi: "10.1/a" },
    ],
    { preferPublished: true, language: "ko" },
  );

  assert.ok(prompt.includes("Write the reason in Korean."));
  assert.ok(prompt.includes("JSON keys, status values, and risk_flags must remain in English"));
});

test("parseDecision filters risk flags and escalates risky auto updates", () => {
  const decision = gemma.parseDecision(
    '{"best":1,"status":"updated","confidence":0.7,"risk_flags":["year mismatch","bogus","venue_conflict","venue_conflict"],"reason":"year moved"}',
    2,
    lib.parseRerankChoice,
  );

  assert.strictEqual(decision.index, 0);
  assert.strictEqual(decision.status, "needs_review");
  assert.deepStrictEqual(decision.riskFlags, ["year_mismatch", "venue_conflict"]);
});

test("removes published-version preference when disabled", () => {
  const prompt = gemma.buildPrompt(
    { title: "A Study" },
    [{ title: "A Study", journal: "Journal A" }, { title: "A Study", journal: "CoRR" }],
    { preferPublished: false },
  );

  assert.ok(prompt.includes("Do not prefer a published version"));
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── abbreviateVenue ──");

test("abbreviates known venues", () => {
  assert.strictEqual(lib.abbreviateVenue("Advances in Neural Information Processing Systems"), "NeurIPS");
  assert.strictEqual(lib.abbreviateVenue("International Conference on Machine Learning"), "ICML");
  assert.strictEqual(lib.abbreviateVenue("IEEE Conference on Computer Vision and Pattern Recognition"), "CVPR");
});

test("returns original for unknown venues", () => {
  assert.strictEqual(lib.abbreviateVenue("Some Unknown Workshop"), "Some Unknown Workshop");
});

test("handles null/empty gracefully", () => {
  assert.strictEqual(lib.abbreviateVenue(""), "");
  assert.strictEqual(lib.abbreviateVenue(null), null);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── expandVenue ──");

test("expands known abbreviations", () => {
  const result = lib.expandVenue("NeurIPS");
  assert.ok(result.toLowerCase().includes("neural information processing"), `Got: ${result}`);
});

test("returns original for unknown abbreviations", () => {
  assert.strictEqual(lib.expandVenue("XYZCONF"), "XYZCONF");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── Constants ──");

test("TITLE_MATCH_THRESHOLD is reasonable", () => {
  assert.ok(lib.TITLE_MATCH_THRESHOLD >= 70 && lib.TITLE_MATCH_THRESHOLD <= 100);
});

test("MIN_TITLE_SIM is reasonable", () => {
  assert.ok(lib.MIN_TITLE_SIM >= 50 && lib.MIN_TITLE_SIM <= 90);
});

test("COMPARED_FIELDS contains expected fields", () => {
  assert.ok(lib.COMPARED_FIELDS.includes("author"));
  assert.ok(lib.COMPARED_FIELDS.includes("year"));
  assert.ok(lib.COMPARED_FIELDS.includes("doi"));
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── duplicateKeysForEntry ──");

test("uses DOI and arXiv keys before title plus author", () => {
  const keys = lib.duplicateKeysForEntry({
    title: "Attention Is All You Need",
    author: "Vaswani, Ashish",
    doi: "10.5555/3295222.3295349",
    eprint: "1706.03762",
    archiveprefix: "arXiv",
  });
  assert.ok(keys.includes("doi:10.5555/3295222.3295349"));
  assert.ok(keys.includes("arxiv:1706.03762"));
  assert.ok(keys.includes("title:attention is all you need|author:vaswani"));
});

test("does not emit title-only duplicate keys", () => {
  const keys = lib.duplicateKeysForEntry({ title: "Introduction" });
  assert.deepStrictEqual(keys, []);
});

test("findDuplicateEntryId matches on shared DOI", () => {
  const seen = new Map();
  lib.registerDuplicateKeys("first", { doi: "10.1/a", title: "Paper A" }, seen);
  const duplicateOf = lib.findDuplicateEntryId({ doi: "10.1/a", title: "Paper A copy" }, seen);
  assert.strictEqual(duplicateOf, "first");
});

test("findDuplicateEntryId ignores unrelated titles without shared keys", () => {
  const seen = new Map();
  lib.registerDuplicateKeys("first", { title: "Learning", author: "Smith, Alice" }, seen);
  const duplicateOf = lib.findDuplicateEntryId({ title: "Learning", author: "Doe, Jane" }, seen);
  assert.strictEqual(duplicateOf, null);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── preferPublishedVenueUpgrade ──");

test("prefers selected candidate published venue over suggested preprint", () => {
  const venue = lib.preferPublishedVenueUpgrade(
    { journal: "Proceedings of NeurIPS" },
    { journal: "arXiv" },
  );
  assert.strictEqual(venue, "Proceedings of NeurIPS");
});

test("falls back to suggested published venue when candidate is absent", () => {
  const venue = lib.preferPublishedVenueUpgrade(null, { journal: "Journal of Machine Learning Research" });
  assert.strictEqual(venue, "Journal of Machine Learning Research");
});

test("ignores preprint suggested venues", () => {
  const venue = lib.preferPublishedVenueUpgrade(null, { journal: "arXiv" });
  assert.strictEqual(venue, "");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── preservePublishedVenue ──");

test("preserves original publication year for one-year published venue drift", () => {
  const original = {
    ENTRYTYPE: "article",
    title: "Deep Evidential Regression",
    author: "Amini, Alexander and Schwarting, Wilko and Soleimany, Ava and Rus, Daniela",
    year: "2020",
    journal: "Advances in Neural Information Processing Systems",
  };
  const candidate = {
    title: "Deep Evidential Regression",
    author: "Amini, Alexander and Schwarting, Wilko and Soleimany, Ava and Rus, Daniela",
    year: "2019",
    journal: "Neural Information Processing Systems",
  };

  const preserved = lib.preservePublishedVenue(original, candidate);
  const comparison = lib.compareEntry(original, candidate);
  const applied = lib.applyCandidateToEntry(original, candidate);

  assert.strictEqual(preserved.year, "2020");
  assert.ok(!comparison.field_diffs.some(diff => diff.field === "year"));
  assert.strictEqual(applied.year, "2020");
});

test("preserves original year when a preprint candidate has a different year", () => {
  const preserved = lib.preservePublishedVenue(
    { title: "MedGemma", year: "2025" },
    { title: "MedGemma", year: "2026", journal: "arXiv", _source: "arxiv" },
  );
  assert.strictEqual(preserved.year, "2025");
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── entryMatchesQuery ──");

test("empty / whitespace query matches everything", () => {
  const e = { title: "Foo", ID: "bar" };
  assert.strictEqual(lib.entryMatchesQuery(e, ""), true);
  assert.strictEqual(lib.entryMatchesQuery(e, "   "), true);
  assert.strictEqual(lib.entryMatchesQuery(e, null), true);
});

test("case-insensitive substring match on title and key", () => {
  const e = { title: "Attention Is All You Need", ID: "vaswani2017attention" };
  assert.strictEqual(lib.entryMatchesQuery(e, "attention"), true);
  assert.strictEqual(lib.entryMatchesQuery(e, "VASWANI"), true);
  assert.strictEqual(lib.entryMatchesQuery(e, "transformer"), false);
});

test("AND-of-tokens: every token must match somewhere", () => {
  const e = { title: "Attention Is All You Need", ID: "vaswani2017attention" };
  assert.strictEqual(lib.entryMatchesQuery(e, "attention vaswani"), true);
  assert.strictEqual(lib.entryMatchesQuery(e, "attention nope"), false);
});

test("field-qualified tokens scope the match", () => {
  const e = { title: "Compositional Generation", ID: "liu2022work" };
  assert.strictEqual(lib.entryMatchesQuery(e, "title:compositional"), true);
  assert.strictEqual(lib.entryMatchesQuery(e, "title:liu"), false);
  assert.strictEqual(lib.entryMatchesQuery(e, "id:liu2022"), true);
  assert.strictEqual(lib.entryMatchesQuery(e, "key:liu2022"), true);
  assert.strictEqual(lib.entryMatchesQuery(e, "id:compositional"), false);
});

test("uses entry_id (result shape) when ID is absent", () => {
  const r = { title: "Foo", entry_id: "smith2020foo" };
  assert.strictEqual(lib.entryMatchesQuery(r, "smith"), true);
});

test("strips LaTeX from title before matching", () => {
  const e = { title: "{Caf\\'e} Studies", ID: "x" };
  assert.strictEqual(lib.entryMatchesQuery(e, "café"), true);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── speed primitives ──");

test("shouldCallLlmRerank skips exact DOI match with a large score margin in balanced mode", () => {
  const original = { title: "Accurate Paper", author: "Smith, Alice", year: "2024", doi: "10.1/abc" };
  const candidates = [
    { title: "Accurate Paper", author: "Smith, Alice", year: "2024", doi: "10.1/abc", journal: "Journal" },
    { title: "Accurate Paper", author: "Jones, Bob", year: "2021", doi: "10.1/other", journal: "arXiv" },
  ];
  const ranked = lib.rerankCandidates(candidates, original, { preferPublished: true });

  assert.strictEqual(lib.shouldCallLlmRerank(ranked, candidates, original, { speedMode: "balanced" }), false);
  assert.strictEqual(lib.shouldCallLlmRerank(ranked, candidates, original, { speedMode: "thorough" }), true);
});

test("shouldCallLlmRerank calls LLM for ambiguous preprint versus published candidates", () => {
  const original = { title: "Shared Paper", author: "Smith, Alice", year: "2024", journal: "arXiv" };
  const candidates = [
    { title: "Shared Paper", author: "Smith, Alice", year: "2024", journal: "arXiv" },
    { title: "Shared Paper", author: "Smith, Alice", year: "2024", journal: "Nature Medicine" },
  ];
  const ranked = lib.rerankCandidates(candidates, original, { preferPublished: true });

  assert.strictEqual(lib.shouldCallLlmRerank(ranked, candidates, original, { speedMode: "balanced" }), true);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n── unicodeToLatex / latexEscape export ──");

test("unicodeToLatex converts accents to LaTeX accent commands", () => {
  assert.strictEqual(lib.unicodeToLatex("café"), "caf\\'{e}");
  assert.strictEqual(lib.unicodeToLatex("Müller"), 'M\\"{u}ller');
  assert.strictEqual(lib.unicodeToLatex("Erdős"), "Erd\\H{o}s");
  assert.strictEqual(lib.unicodeToLatex("Gonçalves"), "Gon\\c{c}alves");
});

test("unicodeToLatex maps non-decomposable specials and punctuation", () => {
  assert.strictEqual(lib.unicodeToLatex("Østergaard"), "{\\O}stergaard");
  assert.strictEqual(lib.unicodeToLatex("Straße"), "Stra{\\ss}e");
  assert.strictEqual(lib.unicodeToLatex("Time—Brain"), "Time---Brain");
});

test("unicodeToLatex leaves ASCII and existing escapes untouched (no double-escape)", () => {
  assert.strictEqual(lib.unicodeToLatex("Smith, John A."), "Smith, John A.");
  assert.strictEqual(lib.unicodeToLatex("Erd\\H{o}s"), "Erd\\H{o}s");
});

test("unicodeToLatex handles stacked diacritics and leaves unmapped chars intact", () => {
  assert.strictEqual(lib.unicodeToLatex("Nguyễn"), "Nguy\\~{\\^{e}}n");
  assert.strictEqual(lib.unicodeToLatex("李明"), "李明");
});

test("entriesToBib escapes values only when latexEscape is set, never the key", () => {
  const entries = [{ ENTRYTYPE: "article", ID: "key2024", title: "Über Allès", author: "Dollár, P." }];
  assert.ok(/Über Allès/.test(lib.entriesToBib(entries)));
  const escaped = lib.entriesToBib(entries, { latexEscape: true });
  assert.ok(/\\"{U}ber All\\`{e}s/.test(escaped));
  assert.ok(/@article\{key2024,/.test(escaped));
});

test("entriesToBib emits duplicate field names only once after trimming", () => {
  const bib = lib.entriesToBib([{
    ENTRYTYPE: "inproceedings",
    ID: "vries24a",
    author: "{de Vries}, Lucas",
    "author ": "Vries, Lucas de",
    title: "Accelerating physics-informed neural fields",
  }]);
  assert.strictEqual((bib.match(/^\s*author\s*=/gm) || []).length, 1);
  assert.ok(bib.includes("{de Vries}, Lucas"));
});

test("applyCandidateToEntry preserves protected surname particles over abbreviated candidates", () => {
  const original = {
    ENTRYTYPE: "inproceedings",
    ID: "de2024accelerating",
    title: "Accelerating physics-informed neural fields for fast {CT} perfusion analysis in acute ischemic stroke",
    author: "{de Vries}, Lucas and {van Herten}, Rudolf L. M. and Hoving, J. W. and I\\v{s}gum, I. and Emmer, B. and Majoie, C. B. and Marquering, H. and Gavves, Stratis",
    booktitle: "Medical Imaging with Deep Learning",
    series: "Proceedings of Machine Learning Research",
    volume: "250",
    pages: "1606--1626",
    year: "2024",
  };
  const candidate = {
    title: "Accelerating physics-informed neural fields for fast CT perfusion analysis in acute ischemic stroke",
    author: "Vries, Lucas de and Herten, R. V. and Hoving, J. W. and Isgum, I. and Emmer, B. and Majoie, C. B. and Marquering, H. and Gavves, Stratis",
    year: "2024",
    booktitle: "International Conference on Medical Imaging with Deep Learning",
  };
  const applied = lib.applyCandidateToEntry(original, candidate);
  assert.strictEqual(applied.author, original.author);
  assert.strictEqual(applied.booktitle, original.booktitle);
});

// ═══════════════════════════════════════════════════════════════════════
console.log("\n══════════════════════════════════");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
