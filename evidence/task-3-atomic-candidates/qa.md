# Task 3 QA

## Automated

- `npm test`: library 192 passed; atomic candidate 14 passed; application contract passed; Python 20 passed; all auxiliary suites passed.
- Candidate permutations select the same whole preprint or published record regardless of input order.
- Generic-title, exact-core-conflict, incomplete, local-curation, and non-transitive bridge probes preserve the original.
- Candidate application drops original publication and custom fields absent from the selected provider record; stable decision identity fails closed; multiword surname particles normalize across BibTeX name forms.

## Browser

- Generic `Introduction` candidate: `Needs Review`, zero warning before user action, and downloaded title/author/year remained the original.
- Explicit suggested-author selection: card and preview each showed one mixed-source warning; download contained the chosen author once and retained the original title/year.
- Direct DOI update: `Auto-Updated`, zero mixed-source warnings, and download contained CrossRef title/author/year plus one atomic publication block.
- Immutable preference: verification started with `preferPublished=true`, the control changed to `false` while the Semantic Scholar response was delayed, and the run still selected the published 2024 record from its start snapshot.
- Post-review deterministic DOI rerun: `Auto-Updated 1`, the selected core and publication fields all showed `crossref_doi · 10.1234/atomic`, and the live preview marked the original-only `note` for removal.
- The in-app browser did not emit a download event on the post-review rerun; the final exported-field assertion is covered by the green candidate-application and application-contract tests instead.

## Debug cleanup receipt

- No debugger statements, debug logging, Playwright traces, screenshots, or temporary fixtures were added to the repository.
- The local HTTP server, Playwright browser, debug journal, and local ignore entry are removed during the final Task 3 cleanup gate.
