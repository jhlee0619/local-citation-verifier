# Verdict regression suite

What "Verified" means, checked without network access:

```bash
npm test        # in the public repository: node --test "regression/*.test.mjs"
```

Node ≥ 22.15, no npm install needed. Each case is a synthetic bibliography (`fixtures/<case>.bib`) and the answers of the metadata services for it (`fixtures/<case>.json`: Crossref, DataCite, DBLP, arXiv, Semantic Scholar; everything else knows nothing; a case may take a service down or have DBLP serve its bot-challenge page). The real path runs in process: `lcv check --strict --json` with those answers instead of the network, and the web page's export readiness on the same verification.

| Group | Cases | Must hold |
| --- | --- | --- |
| Reviewer counterexamples | another Korean title under the same DOI, authors, year and venue; "Smith, John" vs "Smith, James"; a DOI Crossref and DataCite do not know while a DOI-less DBLP record matches; the same with DataCite unreachable | never Verified; the unreachable lookup is `lookup_failed`, not unconfirmed |
| Fabricated references | invented title; wrong first author; year moved by 3; another paper's DOI; another paper's arXiv ID; nonexistent DOI; nonexistent PMID; chimera of two works; wrong journal; invented author list | blocked by `--strict` and held at export |
| Provider outages | a paper only DBLP lists while DBLP is down; DBLP's bot challenge while elsewhere only the arXiv preprint is listed | `lookup_failed` (`provider_unavailable`, DBLP named), exit 3: rerun, never Not Found or "replace with the preprint"; the challenge is reported once |
| Positive controls | entry confirmed by its own DOI; entry missing only its DOI; preprint arXiv ID with the published version's year; the two outage papers with DBLP answering | Verified; Auto-updated until `lcv fix`, then Verified; review offering both versions; Verified |

The audit rules are checked too: weak support from several references never adds up to "supported", and "supported" without an evidence quote becomes weak. The run ends with a table and three counts: fabricated references accepted (must be 0), controls wrongly blocked, and provider outages turned into a verdict (must be 0).

The larger unit, browser and server suites and the live fabricated-reference evaluation are maintained outside this repository.
