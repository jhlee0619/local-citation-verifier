# Verdict regression suite

What "Verified" means, checked without network access:

```bash
npm test        # in the public repository: node --test "regression/*.test.mjs"
```

Node ≥ 22.15, no npm install needed. Each case is a synthetic bibliography (`fixtures/<case>.bib`) and the answers of the metadata services for it (`fixtures/<case>.json`: Crossref, DataCite, DBLP, arXiv; everything else knows nothing). The real path runs in process: `lcv check --strict --json` with those answers instead of the network, and the web page's export readiness on the same verification.

| Group | Cases | Must hold |
| --- | --- | --- |
| Reviewer counterexamples | another Korean title under the same DOI, authors, year and venue; "Smith, John" vs "Smith, James"; a DOI Crossref and DataCite do not know while a DOI-less DBLP record matches; the same with DataCite unreachable | never Verified; the unreachable lookup is `lookup_failed`, not unconfirmed |
| Fabricated references | invented title; wrong first author; year moved by 3; another paper's DOI; another paper's arXiv ID; nonexistent DOI; nonexistent PMID; chimera of two works; wrong journal; invented author list | blocked by `--strict` and held at export |
| Positive controls | entry confirmed by its own DOI; entry missing only its DOI; preprint arXiv ID with the published version's year | Verified; Auto-updated until `lcv fix`, then Verified; review offering both versions |

The audit rules are checked too: weak support from several references never adds up to "supported", and "supported" without an evidence quote becomes weak. The run ends with a table and two counts: fabricated references accepted (must be 0) and controls wrongly blocked.

The larger unit, browser and server suites and the live fabricated-reference evaluation are maintained outside this repository.
