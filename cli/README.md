# lcv — the verifier on the command line

`lcv` runs the web app's bibliography pipeline in Node, so scripts and coding agents (Claude Code, Codex, …) can check references and obtain real ones instead of writing them from memory. It is the single source of truth an agent or a hook calls: it imports `docs/core/` unchanged (same providers, matching, status policy, export writer) and adds only the command line, the network mapping and a disk cache.

```bash
node cli/lcv.mjs check refs.bib --strict          # gate: exit 0 only if every entry passes
node cli/lcv.mjs fix refs.bib --in-place          # apply the system auto-updates
node cli/lcv.mjs resolve --doi 10.1109/cvpr.2016.90 --bibtex
node cli/lcv.mjs keys paper.tex refs.bib          # \cite keys vs. bibliography keys
```

Node ≥ 22.15, no npm dependencies. `npm link` (or `npm install -g .`) in the repository puts `lcv` on the `PATH` (`package.json` `bin`). The AI judge is always off.

## Commands

Every command accepts `--json` (one JSON object on stdout), `--no-cache`, `--cache-dir <dir>`, `-v/--verbose` and `-h/--help`.

### `lcv check <file>... [--strict] [--allow <path>]`

Verifies `.bib`, `.ris` and `.nbib` files (RIS and MEDLINE are converted to BibTeX first, as in the app; their keys are generated). For each entry it reports the key, the status (Verified, Auto-Updated, Needs Review, Not Found, Lookup Failed) with the review reasons, lint notes, notices (retraction, correction, …), the record the status rests on (source, record id, DOI / PMID / arXiv ID), the proposed fix and the candidate records. Unparsed entries are reported as `invalid`.

**Strict pass** is an entry that is *Verified* with no serious notice, or an entry with a valid human approval (see [Allowlist](#allowlist)). Everything else blocks:

| Block code | Meaning | What to do |
| --- | --- | --- |
| `updated` | Auto-Updated: the record the entry's own DOI or arXiv ID names corrects it | `lcv fix <file> --in-place`, then check again |
| `needs_review` | every review reason (`wrong_authors`, `wrong_year`, `id_title_mismatch`, `id_conflict`, `doi_unconfirmed`, `arxiv_unconfirmed`, `pmid_unconfirmed`, `unconfirmed_source`, `integrity`, `core_change_without_id`, `core_conflict`, `identifier_record_changes_type_or_venue`, …) | replace the entry with the whole record (`lcv resolve … --bibtex`), fix the identifier or the entry's own fields, or delete it. `lcv fix` never removes an identifier by itself |
| `not_found` | no database lists the work | replace it with a record from `lcv resolve`, delete it, or have a human approve it (books, reports, guidelines) |
| `lookup_failed` | the databases did not answer, an identifier lookup failed (`identifier_lookup_failed`), or a database the verdict depends on did not answer (`provider_unavailable`, listed in `unavailable_providers`: never evidence against the entry; `blocked_providers` lists those that answered with a bot check, such as DBLP's) | rerun later (a blocking database gives the same answer for a while); do not change the entry because of it |
| `invalid` | the entry could not be parsed | fix the BibTeX syntax |
| `serious_notice` | retraction, partial retraction, withdrawal, removal or expression of concern | remove the citation, or a human approves citing it |
| `stale_approval` | the entry changed after its approval | restore it, or a human approves it again |

A Verified entry is never changed: fields an authoritative record would add (a DOI, pages, a publisher) are listed as `suggested_fields` (text output with `-v`: `could add …`), for you to take with `lcv resolve` if you want them.

Text output prints one line per blocking entry, `KEY — STATUS (reasons) — what to do — record`, then the totals. Without `--strict` the same entries are listed as "would block", and the command only reports.

### `lcv fix <file.bib> [-o <out> | -o - | --in-place] [--allow <path>]`

Verifies the file and applies **only** the system auto-updates (the record the entry's own DOI or arXiv ID names). Verified entries are never changed. It never applies a review candidate. The file is written through the app's span-preserving writer: every other entry, `@string`, `@comment` and free text keeps its bytes. Without `-o` or `--in-place` it is a dry run. `-o -` writes the BibTeX to stdout and the report to stderr. The report lists what changed and what still needs a human or agent decision; the exit code is the one `check --strict` would give after the fix.

### `lcv resolve [<free text>] [--doi X] [--pmid X] [--pmcid X] [--arxiv X] [--title T --author A --year Y] [--pick N] [--bibtex] [--key K]`

Looks a work up with the verifier's providers: the records its identifiers name (Crossref by DOI, PubMed by PMID/PMCID, arXiv by ID), then the full provider search seeded with the title (or with the identifier's record). Free text may be a whole reference string; identifiers are read with the core extractors, and title, authors and year with simple heuristics (a quoted title, APA `(year). Title.`, Vancouver and IEEE author lists). Explicit options override the free text.

Only authoritative records are listed (Crossref, PubMed, arXiv, DBLP, OpenReview, official proceedings pages), best first, each with how it matches: `identifier` (named by the query's DOI/PMID/PMCID/arXiv ID), `same_work` (title, first author and compatible year), `title` (the same title when no author was given) or `weak` (a similar title, not confirmed). Semantic Scholar hits are listed apart as *discovery only — not usable as a reference*.

`--bibtex` prints one record as BibTeX: that record's own fields only (never merged with another record), LaTeX-safe through the core writer, the key from `--key` or surname + year + first significant title word (`he2016deep`). Without `--pick`, only a record that is not `weak` is printed; otherwise the list is shown on stderr and the exit code is 1.

### `lcv keys <manuscript> <refs.bib>... [--strict]`

Scans the manuscript (LaTeX, Markdown or plain text) with the citation audit's scanner (`core/audit.js`): `\cite`, `\citep`, `\citet`, `\parencite`, `\textcite`, `\autocite`, `\footcite`, `\citeA`, the multi-cite forms, starred and capitalised variants; `%` comments are skipped. It reports cited keys missing from every bibliography (blocking; a key that exists with other capitalisation is named), unparsable citation commands (blocking with `--strict`), uncited entries and keys defined in several files (information). Naming commands (`\citeauthor`, `\citeyear`, `\nocite`, …) and Pandoc `[@key]` citations are not checked.

### `lcv allow <key> --file <refs.bib> --reason "<text>" [--allow <path>]` (humans only)

Records a human approval for a reference outside database coverage (books, reports, guidelines, national journals). It needs an interactive terminal and asks the person to type the key back; without a terminal it refuses (exit 2). **Coding agents must never run it**; a hook can deny the command outright.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | pass (`check` without `--strict`: report produced) |
| 1 | blocking findings (`resolve`: no confirmed authoritative record) |
| 2 | usage error (also: an unreadable file, `allow` without a terminal or not confirmed, an internal error) |
| 3 | a network or lookup failure prevented a verdict: the only blocking entries are `lookup_failed` (`check` without `--strict`: any failed lookup; `resolve`: nothing found and a lookup failed) |

## Allowlist

`references.allow` next to the `.bib` file (or `--allow <path>`), one approval per line, tab-separated:

```
key<TAB>fingerprint<TAB>reason<TAB>date
```

The fingerprint is the first 16 hex digits of SHA-256 over the entry's normalised core fields: entry type, title, authors, year, venue (journal or booktitle, else publisher, institution, school, organization or howpublished) and identifiers (DOI, arXiv ID, PMID, PMCID, ISBN). Case, spacing, braces and LaTeX accents do not count, so any real edit of those fields makes the approval stale, and `check --strict` blocks the entry until a human approves it again. Fields outside the core (`note`, `url`, `keywords`, …) can change freely. Lines starting with `#` are comments; an approval whose key matches no entry is reported as a note.

## JSON output

Each command prints one JSON object with a `schema` name and `exit_code`. Fields are always present (empty string, empty list or `null` when unknown).

`lcv.check/1`

```text
{ schema, command: "check", strict, exit_code,
  summary: { entries, invalid, by_status: { <status>: n }, blocking, blocking_network_only, approved },
  files: [ { file, format: "bibtex"|"ris"|"medline", converted, allowlist, allowlist_malformed_lines,
             unused_approvals: [key], entries: [Entry] } ],
  network: { upstream_requests, cache_hits, hosts: { <host>: n }, cache_dir,
             provider_alerts: [{ provider, message }],   // a bot challenge, reported once (the provider is not asked again)
             runtime_ms } }

Entry = { file, key, index, type, title,
  status: "verified"|"updated"|"needs_review"|"not_found"|"lookup_failed"|"invalid",
  reasons: [string],                 // decide() reasons, e.g. "core_fields_match", "wrong_year"
  blocking, network_only, block: [code], action,   // strict verdict and what to do ("" when passing)
  record: Record|null,               // the record the status rests on
  fix: { kind: "identifier", record: Record, changes: [{ field, from, to }] } | null,
  suggested_fields: [string],        // verified: fields the record would add, never applied
  diffs: [{ field, entry, record }], // field differences against record
  detail,                            // needs_review: the records and fields behind it when diffs do not show them ("" otherwise)
  candidates: [Record & { same_work, recommended }],
  lint: [{ code, ... }],             // key_year_mismatch, inproceedings_arxiv_venue, author_placeholder, missing_identifier, missing_venue
  notices: [{ type, label, doi, pmid, source, date, serious }],
  integrity: [{ code, field, message, blocking }],
  duplicate_of, source_warnings: [string], lookup_error,
  unavailable_providers: [string],   // lookup_failed (provider_unavailable): the databases that did not answer
  blocked_providers: [string],       // those of them that answered with a bot check
  fingerprint, approval: { state: "approved"|"stale", fingerprint, approved_fingerprint, reason, date } | null }
// invalid items: { file, key, index: null, status: "invalid", reasons: [parser reason], line, column, message, blocking, block, action }

Record = { source, id, authoritative, type, title, authors, year, venue, doi, pmid, pmcid, arxiv, url }
// source: crossref_doi, crossref_search, pubmed, dblp, openreview, local_arxiv, proceedings (authoritative);
//         semantic_scholar_match, semantic_scholar_search (discovery only)
```

`lcv.fix/1`: `{ schema, command, file, written, dry_run, changed, applied: [{ key, kind, record, changes }], remaining: [Entry], exit_code, network }` (`network` as in `check`)

`lcv.resolve/1`: `{ schema, command, query: { title, author, year, doi, pmid, pmcid, arxiv }, records: [Record & { rank, match: { confidence, identifiers, same_work, strong, title_similarity }, notices }], discovery_only: [… & { note }], picked, confident, bibtex, warnings, failures, exit_code, network }`

`lcv.keys/1`: `{ schema, command, manuscript, bibliographies: [{ file, entries, invalid }], strict, cited, missing: [{ key, count, command, sentence, case_mismatch? }], unparsable: [{ citation, key, sentence }], uncited: [key], duplicates: [{ key, files }], exit_code }`

`lcv.allow/1`: `{ schema, command, key, fingerprint, allowlist, reason, date, exit_code }`

## Network, cache and environment

The providers in `docs/core/providers.js` ask the local proxy's `/api/*` paths. `cli/lib/network.mjs` answers them in Node exactly as `server/proxy_core.py` maps them: Crossref (`/works`), Semantic Scholar (`graph/v1/paper/…`), DBLP (`search/publ/api`), OpenReview (`notes/search`) and arXiv BibTeX (`arxiv.org/bibtex/<id>`, returned as `{ id, bibtex }`), with the same allowed path prefixes and Crossref's rate-limit headers passed through, so the app's pacers (Crossref ~1 search/s, PubMed 3 requests/s) follow the live limits. DBLP and OpenReview are paced to one request at a time, one per second (a 429 pauses them for `Retry-After`). An HTML page in place of JSON (DBLP's "Making sure you're not a bot!" answers HTTP 200) is a rate-limit failure, never an empty result: that provider is not asked again for the rest of the run, the run reports it once (`network.provider_alerts`, a `note:` line), and every entry that needed it ends as `lookup_failed` (`provider_unavailable`, exit 3). PubMed (NCBI E-utilities) and DataCite (`api.datacite.org/dois/`, which confirms DOIs and arXiv IDs no other record confirms) are asked directly. Requests to any other host are refused.

Successful GET answers (HTTP 200 with a data body, never an error or an HTML page) are cached on disk for 7 days, keyed by the canonical upstream URL. `--no-cache` turns the cache off for one run; deleting the directory clears it.

| Variable | Meaning |
| --- | --- |
| `SEMANTIC_SCHOLAR_API_KEY` | Sent as `x-api-key`, only to `api.semanticscholar.org`. Anonymous access is heavily rate limited |
| `LCV_CACHE_DIR` | Disk cache directory (default `~/.cache/lcv`; `--cache-dir` overrides it) |

## Privacy

Nothing is sent anywhere except the lookups below. No request carries an e-mail address, a `mailto` parameter, cookies, a citation key, notes or the bibliography as a whole. Requests identify themselves as `local-citation-verifier/1.0`; PubMed requests also name the tool (`tool=local-citation-verifier`).

| Data | To |
| --- | --- |
| Title, first three author surnames, venue, year; DOIs; arXiv IDs | `api.crossref.org`, `api.semanticscholar.org`, `dblp.org`, `api2.openreview.net`, `arxiv.org` |
| Significant title words, first-author surname; DOI, PMID, PMCID; for citation matching (ECitMatch) also journal, year, volume, first page and the first author's initials, with the neutral token `q1` in place of the citation key | `eutils.ncbi.nlm.nih.gov` (PubMed) |
| DOIs (an arXiv ID as its DOI `10.48550/arXiv.<id>`) that no other record confirms | `api.datacite.org` (DataCite) |

`resolve` sends the same kinds of data for the work it looks up. `keys` and `allow` work offline. The disk cache holds the providers' answers, not your files.

## For agents and hooks

- Obtain references with `lcv resolve … --bibtex`; never write a reference from memory.
- Gate with `lcv check <file> --strict`; when it exits 1, follow each line's action (`lcv fix` for auto-updates, replacement records for reviews), then check again. Exit 3 means rerun later, not pass.
- Never edit an entry to silence a finding without a record that supports the change, and never run `lcv allow`.
- Parse `--json` rather than the text; the schema names are versioned.
