# Local Citation Verifier: reference

Detailed behaviour, configuration and layout. The short overview is in the [README](../README.md).

## Running it

### GitHub Pages

Open <https://jhlee0619.github.io/local-citation-verifier/>. There is no server behind the published site, so:

- Only Crossref, PubMed, Semantic Scholar and DataCite are queried, directly from the browser.
- DBLP and OpenReview cannot be queried from a browser (CORS), and arXiv BibTeX enrichment needs the proxy. Records that only those sources carry, such as many ICLR papers, are missing as candidates. Since Semantic Scholar alone never confirms an entry, more entries end up as Needs Review (`unconfirmed_source`) here than with the local proxy.
- Crossref's public pool allows about one search per second, so lookups are paced. A browser cannot read Crossref's rate-limit headers, so the observed limits are used: 1 search/s and 5 DOI lookups/s, one request at a time. A 100-entry file needs roughly 2–3 minutes of Crossref time.
- PubMed (NCBI E-utilities) allows 3 requests per second without an API key. Its requests are paced one at a time, 334 ms apart until a response's `X-RateLimit-Limit` says otherwise, with a pause on HTTP 429 (`Retry-After`). This is the same on every origin.
- The AI judge is unavailable, and no `/api/*` path is ever requested.

### Locally, with the proxy (recommended)

```bash
git clone https://github.com/jhlee0619/local-citation-verifier.git
cd local-citation-verifier
HOST=127.0.0.1 PORT=18088 python3 server/vllm_proxy_server.py
```

Open `http://127.0.0.1:18088/`. `server/vllm_proxy_server.py` uses only the Python standard library. It serves `docs/` and forwards `/api/*` requests to Crossref, Semantic Scholar, DBLP, OpenReview and arXiv. PubMed has no proxy route: the page asks NCBI E-utilities directly on every origin (NCBI allows any origin, `Access-Control-Allow-Origin: *`). It also passes Crossref's rate-limit headers to the page, so pacing follows the live limits. Without a vLLM server the AI endpoints answer "not ready", and nothing else depends on them.

On Windows, `run-local.cmd` does the same through `scripts/run_local.py`:

- It starts the proxy on `127.0.0.1:18088` and opens the browser.
- If an SSH host alias that forwards a vLLM server is configured (`LCV_SSH_HOST`, or the first line of the ignored file `local/ssh-host.txt`; forwarding local port `LCV_TUNNEL_PORT`, default 18000), it opens that tunnel and points the proxy at it. Otherwise the AI judge is simply unavailable.
- If the port is already in use, it asks `/api/health`. If this app is already running there, it opens it. Otherwise it exits with a message.

At startup the page asks `GET /api/health` once and expects `{"app": "local-citation-verifier", "ok": true}`. If anything else answers, the page shows a banner and every lookup ends as **Lookup failed** (`proxy_missing`) without asking any database. This happens, for example, when `docs/` is served by a plain static server such as `npx serve docs`. A 404 from such a server therefore never turns into "Not Found".

Proxy settings (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8088` | Bind address |
| `ALLOW_REMOTE` | unset | Must be exactly `1` to bind a non-loopback `HOST` |
| `ALLOWED_HOSTS` | empty | Extra accepted `Host` values with `ALLOW_REMOTE=1` (see below) |
| `VLLM_BASE_URL`, `VLLM_MODEL` | `http://127.0.0.1:8000`, first served model | The vLLM OpenAI-compatible server |
| `SEMANTIC_SCHOLAR_API_KEY` | unset | Sent only to `api.semanticscholar.org`. Anonymous access is heavily rate limited |
| `DOCS_DIR` | `docs/` | Static directory to serve |

### Access from another machine

The proxy defaults to `127.0.0.1` and needs no flag for `127.0.0.1`, `::1` or `localhost`. Keep the upstream vLLM service bound to `127.0.0.1` too.

Prefer an SSH tunnel that keeps the port number, because the proxy accepts loopback names only with its own port:

```bash
ssh -L 8088:127.0.0.1:8088 user@server.example.com   # then open http://127.0.0.1:8088/
```

A non-loopback `HOST` is refused before binding unless `ALLOW_REMOTE=1` is set exactly:

```bash
ALLOW_REMOTE=1 ALLOWED_HOSTS=citations.lab.example HOST=0.0.0.0 PORT=8088 python3 server/vllm_proxy_server.py
```

`ALLOW_REMOTE=1` provides neither authentication nor TLS. It exposes the static app, the metadata proxy and the AI endpoint to everyone who can reach the port. If a tunnel is unsuitable, put the proxy behind an authenticated HTTPS reverse proxy and a firewall allowlist, and never expose the vLLM port.

Request checks (DNS-rebinding and cross-site defence), applied to every route:

- **Host.** A request whose `Host` header is not accepted gets `403 {"error": "host not allowed"}`. Accepted by default are `127.0.0.1`, `localhost` and `[::1]` with the server's port, and without a port only on port 80.
- **`ALLOWED_HOSTS`.** With `ALLOW_REMOTE=1`, this comma-separated list adds names:
  - `name:port` is accepted exactly;
  - a bare `name` is accepted with the server's port and without a port, as a reverse proxy forwards it;
  - IPv6 addresses are written in brackets, e.g. `[fd00::5]:8088`.
- **No `ALLOWED_HOSTS`.** With `ALLOW_REMOTE=1` and no list, only `HOST:PORT` itself is added, and the proxy warns at startup that LAN names must be listed. Without `ALLOW_REMOTE=1` the list is ignored, with a warning.
- **Origin.** Every POST (the AI endpoint) must carry an `Origin` equal to `http://` or `https://` plus the request's own `Host`, otherwise `403 {"error": "cross-origin request refused"}`. Browsers send it on their own. Other clients must send it themselves, e.g. `curl -H "Origin: http://127.0.0.1:8088"`.
- **Headers.** Responses carry the same Content-Security-Policy as the page (plus `frame-ancestors 'none'`), `X-Frame-Options: DENY` and `nosniff`. Static files are served with `Cache-Control: no-cache` and explicit JavaScript/CSS MIME types.

### Optional vLLM server

```bash
python3 -m venv .venv-vllm && . .venv-vllm/bin/activate && pip install vllm
vllm serve google/gemma-4-E2B-it --host 127.0.0.1 --port 8000 --max-model-len 8192
HOST=127.0.0.1 PORT=8088 VLLM_BASE_URL=http://127.0.0.1:8000 python3 server/vllm_proxy_server.py
```

When the proxy reports a ready model, the settings show it as available. Nothing is sent to it until you opt in (see [AI judge](#ai-judge-optional)).

## Command line

`cli/lcv.mjs` (`lcv` after `npm link`) runs the same pipeline in Node (Node ≥ 22.15, no dependencies, AI judge off), so scripts and coding agents can verify references and obtain real ones instead of writing them from memory:

```bash
node cli/lcv.mjs check refs.bib --strict      # exit 0 only if every entry is Verified (or approved by a human)
node cli/lcv.mjs fix refs.bib --in-place      # apply only the system auto-updates, other bytes unchanged
node cli/lcv.mjs resolve --doi 10.1109/cvpr.2016.90 --bibtex   # authoritative records only
node cli/lcv.mjs keys paper.tex refs.bib      # cited keys missing from the bibliography
```

It maps the providers' `/api/*` paths to the same upstreams as the local proxy, so no proxy is needed, and caches successful answers in `~/.cache/lcv` for 7 days. Exit codes are 0 pass, 1 blocking findings, 2 usage error, 3 a lookup failure prevented a verdict. `--json` gives a versioned schema. References outside database coverage (books, reports, guidelines) pass only with a human approval recorded by `lcv allow`, which agents must not run. See [`cli/README.md`](../cli/README.md) for the commands, the JSON schema, the allowlist and what is sent where.

Without a clone, `npx -y --package=github:jhlee0619/local-citation-verifier lcv check refs.bib --strict` runs the same command line (Node ≥ 22.15).

## Use with Claude Code and Codex

The repository is also a plugin, `citation-guard`, for Claude Code and OpenAI Codex. It bundles an [Agent Skill](../skills/citation-guard/SKILL.md) and two hooks. The goal is that an agent never leaves an unverified reference in a bibliography: every entry must pass `lcv check --strict` (an authoritative record confirms it) or carry a human approval, and the agent obtains references only with `lcv resolve`, never from memory.

What this does and does not guarantee: it covers the **existence and metadata** of the references in the bibliographies that are checked (`.bib`, `.ris`, `.nbib`). It does not check whether a cited paper supports the sentence that cites it; the skill tells the agent to cite only works whose record it retrieved and to flag uncertain support to you.

**Claude Code** (2.1.139 or later):

```text
/plugin marketplace add jhlee0619/local-citation-verifier
/plugin install citation-guard@local-citation-verifier
```

(or `claude plugin marketplace add …` and `claude plugin install …` in a shell).

**Codex CLI:**

```bash
codex plugin marketplace add jhlee0619/local-citation-verifier
codex plugin add citation-guard@local-citation-verifier
```

Then start a new session and open `/hooks` to review and trust the plugin's two hooks: Codex skips plugin hooks until you trust them. Both tools need `node` (≥ 22.15) and `git` on the `PATH`.

What the plugin adds:

- **Skill `citation-guard`.** Loaded whenever the agent works on references, bibliographies or citations. It obtains each reference with `lcv resolve … --bibtex` (identifier or same-work matches only), runs `lcv check --strict` and `lcv keys` after every change, and clears each finding: `lcv fix` for auto-updates, replacement by a resolved record or removal (with a visible `TODO(citation)` and a note to you) for reviews and Not Found entries, no citation of retracted works, reruns for failed lookups. It never edits `references.allow`, never runs `lcv allow` and never hand-edits fields to make a check pass.
- **Stop hook.** When the agent tries to finish, the hook looks at the git working tree. If no `.bib`/`.ris`/`.nbib` file changed and no changed `.tex`/`.md` file contains `\cite` commands, it exits at once without network access. Otherwise it runs `lcv check --strict` on the changed bibliographies and `lcv keys --strict` on the changed manuscripts (against their `\bibliography{}`/`\addbibresource{}` files, else every `.bib` in the repository), and blocks the end of the turn with one line per problem: `KEY — status — what to do`. It blocks on everything those commands block on (missing keys and unparsable citation commands included) and on a citing manuscript when no bibliography file exists. It blocks at most three consecutive times for the same unresolved set; then it lets the turn end and shows you what is still unverified, so it does not guarantee that the agent makes every fix. Failed lookups block once, then warn. Bibliographies ignored by git are not seen.
- **PreToolUse hook.** Denies agent edits of any `references.allow` and any shell command that runs `lcv allow` or writes `references.allow`.

Settings (environment variables, for you, not the agent): `LCV_HOOK=off` turns the Stop hook off; `LCV_HOOK_TIMEOUT` sets its time budget in seconds (default 180, cache warm runs take seconds). Disabling or uninstalling the plugin (`/plugin`, `codex plugin remove`) removes everything.

**Approving references outside database coverage.** Books, reports, guidelines and some regional journals can end as Not Found although they exist. The agent lists them for you; you approve each one in a terminal:

```bash
node cli/lcv.mjs allow who2023 --file refs.bib --reason "WHO report, not indexed"
```

**CI or pre-commit.** The same gate works without an agent:

```yaml
# GitHub Actions step
- run: npx -y --package=github:jhlee0619/local-citation-verifier lcv check refs.bib --strict
```

```bash
# .git/hooks/pre-commit
git diff --cached --name-only --diff-filter=ACM | grep -E '\.(bib|ris|nbib)$' | xargs -r lcv check --strict
```

Exit code 3 means a lookup failed: rerun rather than pass.

## Bibliography verifier

### Lookup

For each entry the verifier gathers candidate records:

- **Crossref.** A `query.bibliographic` search built from the first three author surnames, the title, the venue (left out for preprint servers) and the year, with LaTeX folded to plain ASCII. The builder is `crossrefBibliographicQuery` in `docs/core/providers.js`. A title-only `query.title` search runs only when that search returns nothing usable. DOIs are looked up directly at `/works/{doi}`.
- **PubMed** (NCBI E-utilities, directly from the browser, `tool=local-citation-verifier`, no e-mail address or API key, no cookies). The builders are pure functions in `docs/core/pubmed.js`. In order, stopping at the first step that finds PMIDs:
  1. one ESearch for the entry's identifiers OR-ed with the strict title term: PMID `n[uid]` (the `pmid` field, or `PMID: n` / a PubMed URL in `note` or `url`), PMCID `PMCn[pmc]`, DOI `"doi"[doi]`, and the significant title words (folded, PubMed stopwords and words under 3 characters dropped, each once, at most 10) each `[title]`, joined with AND;
  2. the relaxed term: the first 5 significant title words `[title]` AND the first author's surname `[1au]`;
  3. ECitMatch (`journal|year|volume|first_page|first_author|q1|`) when journal, volume and first page are known. The last field is a neutral token (`q1`) that NCBI echoes with its answer, never the citation key;
  4. one ESummary for at most 5 PMIDs. The normal case is one search and one summary per entry.
- **Semantic Scholar.** Title match and title search.
- **Through the proxy only.** DBLP, OpenReview, and arXiv's own BibTeX for an arXiv ID. DBLP and OpenReview announce no limits, so each is asked one request at a time, one per second, with a pause on HTTP 429 (`Retry-After`). An HTML page in place of JSON (DBLP's "Making sure you're not a bot!" answers HTTP 200) is a rate-limit failure, never an empty result; that provider is then not asked again during the run, and the command line reports it once.
- **Crossref book chapters and proceedings.** A book chapter in a proceedings volume (its title names a conference, workshop or symposium or an event and year, or its series is one that publishes proceedings, such as Lecture Notes in Computer Science, CCIS, LIPIcs or PMLR) is `@inproceedings`; any other book chapter is `@incollection`. The volume title is the `booktitle` and the series goes to `series`. With several container titles, an entry venue that names any of them (or a longer name containing one) matches. A volume number equal to the year is dropped.
- **Identifier existence.** Every DOI, arXiv ID, PMID and PMCID in the entry must exist, independently of which record matches the work. A DOI is confirmed by a Crossref record (by DOI or search), a PubMed record or DataCite; an arXiv ID by arXiv's own record or its DataCite DOI `10.48550/arXiv.<id>`; a PMID or PMCID by PubMed. When no record confirms one, it is looked up: a DOI that Crossref does not know at DataCite (`api.datacite.org/dois/{doi}`, directly from the browser on every origin, paced and cached), an arXiv ID as its DataCite DOI, a PMID by ESummary, a PMCID by ESearch.

**Authoritative and discovery sources.** Crossref, PubMed, arXiv, DBLP, OpenReview and official proceedings pages are authoritative. Semantic Scholar is discovery-only, because some of its records are built from other papers' reference lists rather than from a publisher or primary source. It finds candidates, and its DOI, arXiv and DBLP identifiers fetch the authoritative records. It also feeds the AI judge's ranking and the citation audit's evidence. A Semantic Scholar record alone never verifies, auto-updates or round-trips an entry, never represents a work that an authoritative record also describes, and is never recommended by the rules (only the AI judge may recommend it). Its candidate rows carry the badge "Semantic Scholar only — not confirmed by Crossref, PubMed, arXiv, DBLP or OpenReview".

**Official proceedings pages.** An entry whose `url` is a paper's page on NeurIPS (proceedings.neurips.cc, papers.nips.cc), PMLR (proceedings.mlr.press), JMLR (jmlr.org), the ACL Anthology (aclanthology.org), CVF Open Access (openaccess.thecvf.com) or IJCAI (ijcai.org/proceedings) names that paper the way a DOI does. Through the local proxy or `lcv` (never on GitHub Pages, which cannot read those sites), the page's `citation_*` meta tags (the Highwire Press tags Google Scholar reads) give the publisher's record: title, authors, venue, year, volume, issue and pages. It is the entry's own record: it can verify the entry, and a page that names another title is an `id_title_mismatch`. Only these hosts are ever fetched, and a redirect off them is refused. NeurIPS pages date the proceedings' publication (2026 for NeurIPS 2025), so their year is the conference year in the URL and the page's date is kept as the record's alternative year.

**PubMed records.** Title (closing period removed), authors (`Smith JA` → `Smith, J. A.`; collective names braced), journal (full name; the ISO abbreviation also matches the entry's venue), year from the print date (`pubdate`), volume, issue, pages (`637-41` → `637--641`), DOI, PMID and PMCID. When the online date (`epubdate`) has another year, that year is kept as the online year: an entry citing either year is the same work. A candidate row shows its PMID.

A network failure is never treated as absence. Timeouts, HTTP errors and a missing proxy produce **Lookup failed**, not Not Found. Each entry's lookup records which providers answered and which failed. A verdict that rests on what a provider did not return (Not Found, Semantic Scholar alone, a change or another version without an identifier) needs every applicable authoritative provider to have answered: Crossref and PubMed always; DataCite for a DOI or arXiv ID; arXiv for an arXiv ID; DBLP, when this origin reaches it, for every entry without a PMID/PMCID or a DOI that resolved; OpenReview, likewise, when the venue is one it hosts, a preprint server or missing. Otherwise the entry is **Lookup failed** (`provider_unavailable`, naming the providers).

### Matching

- **Same work.** A shared DOI, PMID, PMCID, arXiv ID, official proceedings page or OpenReview forum; or a title similarity of at least 85, the same first-author surname and a compatible year. Compatible means the same year, the record's online year (PubMed `epubdate`, next to the print year), or one year apart between a preprint and its published version. Retraction and correction notices are never the same work as the article.
- **Strong match.** All of the following:
  - the normalised titles are equal (or token-sort similarity ≥ 97);
  - same first-author surname and compatible author counts;
  - same year, or the record's online year (±1 only between preprint and published version);
  - no venue conflict;
  - no other record of the same version with a different title, author list or year.
- **Plausible.** A looser relation, used only to show nearby records as choices. A plausible record is never applied.
- **Version rules.** Which version of a work to recommend (preprint, conference, journal) is decided by a fixed rule table, R1–R24, in `docs/core/versions.js`. Every pick, including the AI judge's, must pass it. A pick that fails stays pending.

Names are compared after LaTeX/Unicode folding. Particles are handled (`van der Maaten`), the German umlaut spellings are equal (`Sch\"{u}tze` = `Schütze` = `Schuetze`, `ß` = `ss`), and a fully braced name such as `{OpenAI}` is one corporate author. Sources misspell names too (PMLR lists "Emily Alesentzer" for Alsentzer), so one co-author's surname, never the first author's, may differ by a single typo when it has at least five letters, its given names agree and every other author matches. Given names are compared word by word: two full words must be equal (`John` ≠ `James`; `Jean-Pierre` = `Jean Pierre`), an initial matches a word with that first letter (`J.` = `John`), extra middle names or initials on one side are allowed, and so is a left-out first name when the remaining full names appear in order (`Pete` = `Evan Pete`; never through an initial: `John` ≠ `Mary J.`).

Venues are compared without a leading ordinal or year (`The Thirteenth International Conference on Learning Representations` = `International Conference on Learning Representations`). A journal-style name (`Transactions of …`, `Journal of …`, or containing *Journal*, *Transactions*, *Letters* or *Review*) is never a conference name, so `@article` in *Transactions of the Association for Computational Linguistics* is no entry-type mismatch. Neither is an entry whose own DOI record has its entry type (Crossref's journal-article for an `@article`).

A record the entry's own identifier links counts as having the entry's title when its title is the entry's main title, the part before the colon (Crossref titles 10.1145/3442188.3445924 just "BOLD"). Matching without an identifier stays strict.

Titles, surnames and venues are compared in any script: LaTeX and accents are folded for Latin text, while Korean, Chinese, Japanese, Cyrillic or Greek letters are kept (`한국어 연구의 방법 2024` and `중국어 경제의 전망 2024` differ). A title whose key has no letter or fewer than two words (`2024`, `Introduction`, one unbroken run of Chinese characters) is never title evidence on its own: same work, strong match and duplicate detection then need an identifier.

### Result states

| State | When |
| --- | --- |
| **Verified** | An authoritative record agrees with the entry's title, authors, year, venue and entry type: preferably the record the entry's own DOI, arXiv ID, PMID, PMCID, official proceedings page or OpenReview forum identifies, else any authoritative record. Every identifier the entry carries exists (see *Identifier existence*). The entry is kept exactly as written. Fields it lacks (DOI, pages, publisher, …) are shown as optional rows of one strongly matching record whose DOI round-trips through Crossref; nothing is added unless you accept a row. |
| **Auto-updated** | Only one case. The record the entry's own identifier names is complete, the same work, free of integrity issues and passes the version rules, but its core fields differ from the entry's. It replaces the entry as one whole record, unless that would change the entry type, put a series name in the venue or shorten the venue: that is a review (`identifier_record_changes_type_or_venue`). |
| **Needs Review** | Export is blocked until you decide. Reasons include: <ul><li>`unconfirmed_source`: only Semantic Scholar lists the work; its records are shown as explicit choices, never applied;</li><li>a title, author, year, venue or entry-type change without an identifier, or a version change without an identifier;</li><li>`wrong_authors`: no record is the same work, but an authoritative one has the entry's exact title with other authors;</li><li>`wrong_year`: such a record has the same first author but another year;</li><li>`id_title_mismatch`: the entry's DOI or arXiv ID resolves to another title;</li><li>`id_conflict`: the DOI and the arXiv ID resolve to different works;</li><li>`doi_unconfirmed`, `arxiv_unconfirmed`, `pmid_unconfirmed`: the work matches a record, but an identifier in the entry was looked up and does not exist (Crossref and DataCite, arXiv and DataCite, PubMed). Fix or remove it; nothing removes it automatically;</li><li>`integrity`: duplicate fields or citation keys, malformed author lists, an entry type that contradicts the venue, or identifiers that mix preprint and published versions. An authoritative record settles three of these: a conference paper typed `@article` (Google Scholar's export) or a published paper cited with its arXiv DOI, when a published record confirms the entry's core fields (and the arXiv record has its title and first author); and a repeated author name that the work's own record repeats (two authors called Hao Wang);</li><li>`core_conflict`: authoritative records of the entry's identifier disagree (a Semantic Scholar record never takes part in a conflict); the card and the command line name the records and fields;</li><li>`identifier_record_changes_type_or_venue`: see Auto-updated;</li><li>a risk raised by the AI judge.</li></ul> A review whose field rows show no difference names the records and fields behind it. |
| **Not Found** | No record is the same work, and every applicable authoritative provider answered. Nearby plausible records are shown as explicit choices only. |
| **Lookup failed** | The databases did not answer (rate limit, outage, deadline), an applicable authoritative provider failed where the verdict would rest on what it did not return (`provider_unavailable`, naming the providers: never Not Found or "replace with the preprint"), an identifier lookup failed (`identifier_lookup_failed`: a failure never counts as "not found"), or the proxy is missing (`proxy_missing`: nothing was asked). The entry stays pending. Use **Retry failed lookups**, or decide explicitly. A database that answers with a bot check (DBLP's "Making sure you're not a bot!") gives the same answer for a while: the card says so, and Retry waits 10 minutes for the entries that only that database could not check. |
| **Duplicate** | Another entry cites the same paper (same DOI, arXiv ID, or normalised title plus first author). |

**Lint notes.** Small notes on a card point out problems in the entry's own fields. They never change its status (integrity issues do): a four-digit year in the citation key that differs from `year` (`key_year_mismatch`), an `@inproceedings`/`@conference` whose booktitle or journal is an arXiv/preprint server (`inproceedings_arxiv_venue`), "and others" / "et al." in `author` (`author_placeholder`), an `@article`/`@inproceedings`/`@conference` without DOI, PMID, PMCID or arXiv ID (`missing_identifier`), and an `@article` without `journal` or an `@inproceedings` without `booktitle` (`missing_venue`).

A card shows **Updated (your choice)** once you pick a candidate yourself. **Keep original for all pending** resolves every open review at once by keeping the originals.

### Retractions and corrections

Crossref's `updated-by` metadata is attached to the work and to every candidate with that DOI. So is a notice record's `update-to`, and the "RETRACTED:" title stamp, which is removed from the title. PubMed adds its own: the publication type "Retracted Publication" and a record's "Retraction in", "Expression of concern in" and "Erratum in" references (by DOI and by PMID). PubMed notice records ("Retraction Notice", "Published Erratum", …) are never the work.

- **Serious notices** are retraction, partial retraction, withdrawal, removal and expression of concern. They show a red tag and an alert line on the card.
- **Corrections and errata** show a quiet badge.
- A notice never changes the status.

### Review and export (block-first)

Copy and Download run the same preflight, and nothing reaches the clipboard or a file while it fails:

1. **Pending decisions.** Every Needs Review and Lookup failed entry needs an explicit choice: one complete candidate, the original, or exclude. These cannot be confirmed away. The verifier never picks a candidate for you under review.
2. **One confirmation, bound to the exact output.** The rest is acknowledged in one dialog:
   - Not Found entries exported unchanged (an explicitly kept original needs no acknowledgement);
   - works flagged as retracted, withdrawn, removed or under an expression of concern;
   - records only Semantic Scholar lists that you chose (`unconfirmed_ack`);
   - unparsed (invalid) entries, which are exported verbatim;
   - a remaining blocking integrity issue in an entry you resolved.

   Changing any metadata, setting, candidate or run invalidates the confirmation.

### Whole records, never merged fields

When Crossref, PubMed, Semantic Scholar, DBLP, OpenReview or arXiv describe the same work differently, each stays a separate whole record. Choosing one applies its title, authors, year, venue and identifiers together. The verifier never combines a title from one source with authors from another. The only exception is the additive-only update above: it fills fields the entry lacks, from exactly one record, and never replaces a value.

A record that replaces an entry (the identifier auto-update or your choice) brings all bibliographic fields (title, author, editor, year, month, journal, booktitle, volume, number, pages, publisher, address, edition, series, chapter, institution, school, organization, howpublished, type, doi, url, eprint, archiveprefix, primaryclass, eprinttype, pmid, pmcid, isbn, issn, language, urldate, and their biblatex counterparts such as date, journaltitle or location); the entry's own values of those fields are dropped, never mixed in. Your annotation fields that the record does not define stay as they are and show as unchanged lines in the preview: `note`, `annote`, `annotation`, `keywords`, `abstract`, `file`, `comment(s)`, `groups`, `owner`, `timestamp`, `mendeley-tags`, `readstatus`, `priority`, `ranking`, `x-*` and any other custom field.

## BibTeX handling

- **Full grammar.**
  - `@string` macros (including macros of macros) and `#` concatenation;
  - month macros and `@preamble`, `@comment` and free text between entries;
  - `{…}` and `"…"` values, `@Type(…)` and case-insensitive types;
  - `%` comments inside entries, a BOM, and CRLF, LF or lone-CR line endings.
- **Errors are isolated.** A malformed entry becomes an invalid item: it is not verified, it is exported byte for byte, and parsing resumes at the next line-start `@`. All parse errors are listed with line, column and key. Duplicate fields and duplicate citation keys are integrity issues.
- **Untouched entries are exported verbatim.** That is the exact source text, macros, comments and layout included. Only entries you (or an auto-update) changed are re-serialised. They use the file's own line ending and keep their comment lines, and the file ends with a line ending.
- **LaTeX-safe values.** Text that comes from a provider:
  - is unescaped from HTML entities (including JATS/MathML markup);
  - has `& % $ # _ ^` escaped outside math, with `$…$` recognised by pandoc's rule so currency stays text;
  - keeps unbalanced braces neutralised;
  - keeps URL arguments (`\url`, `\href`, `\path`) verbatim.
- **"Escape for pdfLaTeX/BibTeX"** (off by default) also writes accented letters and symbols as LaTeX commands (`M\"{u}ller`, `\ensuremath{\alpha}`). Identifier fields (DOI, URL, eprint) are never touched.
- **RIS and MEDLINE input.** Pasted or uploaded (`.bib`, `.ris`, `.nbib`, `.txt`) RIS (`TY  - ` lines) and MEDLINE/PubMed exports (`PMID- ` lines) are converted to BibTeX before verification, and a notice above the cards says "Converted N RIS records to BibTeX." (or MEDLINE). Entry type from RIS `TY` / MEDLINE `PT`; key = first-author surname + year + first significant title word (`isensee2021nnu`), with `a`, `b`, … for repeats; fields title, author (`Last, First and …`), journal or booktitle, year, volume, number, pages (`SP`–`EP` / `PG`), doi, pmid, pmcid. The export is BibTeX. `pmid` and `pmcid` are identifier fields: never LaTeX-escaped, compared normalised.
- **Export options.** Remove duplicates (by title, key or DOI), remove Not Found entries, and "Max authors" (truncates with `and others`). "Prefer peer-reviewed over arXiv" (on by default) steers which version the rules recommend.

## AI judge (optional)

AI is **off by default**, and every result above is reached without it.

- **Engine.** The only engine is an operator-run vLLM server behind the local proxy (`POST /api/rerank/vllm`). You opt in per tool: "Enable selected AI rerank engine" in the verifier settings, and the "AI judge" selector in the audit panel. A ready server is only shown as available. It is never enabled automatically.
- **Verifier.** The judge sees an entry and up to three candidate records only when the version rules call the choice ambiguous. It answers one strict JSON object: index, status, confidence and risk flags from a fixed vocabulary, all read from that one object. It can only:
  - **recommend** one of the shown candidates (confidence ≥ 0.75, and the pick must pass the version rules), shown as a pending recommendation; or
  - **raise risk**: a `needs_review` or `not_found` answer, or a material risk flag, turns the entry into Needs Review (`judge_risk`).

  It never applies a record, never resolves a review, and never upgrades a status. If the server fails, the deterministic result stands.
- **No in-browser model.** An experimental in-browser WebGPU model was removed in October 2026. Its pinned loader is served by Hugging Face as `text/plain`, which browsers refuse to run as a module script, so it never worked in production. Removing it also lets the page allow scripts from its own origin only (`script-src 'self'`). A small in-browser model may return later.

## Citation support audit

Paste or upload a `.bib` file (or reuse the verifier's) and a manuscript in plain text, Markdown or LaTeX.

- **Citations.** `\cite`, `\citep`, `\citet`, `\parencite`, `\textcite`, `\autocite`, `\footcite`, `\citeA` and the multi-cite forms (`\cites`, …) are found, including starred and capitalised variants, optional arguments and key lists.
  - Only an unescaped `%` starts a comment, so `12\%` keeps the citation after it.
  - Sentences are split with abbreviations, decimals and initials in mind (`et al.`, `e.g.`, `Fig. 2`, `0.85`, `J. Smith`).
  - `\citeauthor`, `\citeyear`, `\nocite` and similar commands are parsed but not audited.
- **Skipped citations.** Unknown keys and unparsable commands are counted and listed, never silently dropped.
- **Evidence identity.** The abstract/TLDR comes from Semantic Scholar: by DOI first, then by title. It is used only if that record is the same work as the BibTeX entry. Otherwise the card shows the rejected record ("Rejected evidence: not the cited work") and the verdict is Insufficient evidence · Evidence mismatch, without asking the model.
- **Verdicts are limited to the abstract.**
  - The labels are **Supported by the abstract**, **Partially supported** and **Not stated in the abstract**.
  - **Insufficient evidence** always comes with a reason: AI off, AI unavailable, lookup failed, no abstract/TLDR, paper not found, evidence mismatch, invalid AI output, abstract too thin, or key not in the BibTeX file.
  - The model's quote must occur verbatim in the abstract. Otherwise it is dropped and "supported" becomes "partially supported" (`unverified_quote`); a "supported" answer without any quote becomes "partially supported" too (`missing_quote`).
  - A sentence citing several papers also gets a combined verdict: supported only if at least one reference supports it; partial support from several references stays partially supported.
- **Report.** The Markdown report escapes all quoted text. The audit has its own engine selector (Off by default) and its own Cancel, independent of verification runs.

## Privacy

There is no account and no server-side application: the local proxy only serves files and forwards requests. The page sets no cookies, and only its settings (theme, export options, AI opt-ins, preview width) are stored in the browser's `localStorage`. The bibliography and the results are not stored.

What leaves the browser:

| Data | To | When |
| --- | --- | --- |
| Static files | The site's own origin (GitHub Pages or your proxy) | Page load |
| Title, first three author surnames, venue, year; DOIs; arXiv IDs | Crossref (`api.crossref.org`), Semantic Scholar (`api.semanticscholar.org`). Through the proxy also `dblp.org`, `api2.openreview.net`, `arxiv.org` | Verification and audit lookups. Directly from the browser on Pages, via `/api/*` locally |
| Significant title words, first-author surname; DOI, PMID, PMCID; for citation matching (ECitMatch) also journal, year, volume, first page and the first author's initials, with the neutral token `q1` in place of the citation key | PubMed (NCBI E-utilities, `eutils.ncbi.nlm.nih.gov`) | Verification lookups, directly from the browser on every origin (no proxy route), without cookies |
| DOIs (an arXiv ID as its DOI `10.48550/arXiv.<id>`) | DataCite (`api.datacite.org`) | Only for an identifier of the entry that no other record confirms; directly from the browser on every origin, without cookies |
| An entry plus up to three candidate records | Your vLLM server, via the proxy | Only with the verifier's AI opt-in, for ambiguous entries |
| The citation key, the cited sentence, the BibTeX metadata of the cited entry and the abstract/TLDR found | Your vLLM server, via the proxy | Only when the audit's AI judge is set to vLLM |

No request carries an e-mail address or `mailto` parameter; PubMed requests name the tool (`tool=local-citation-verifier`) and carry no API key. The proxy identifies itself as `local-citation-verifier/1.0`. A Semantic Scholar API key, if set, stays on the proxy and is sent only to Semantic Scholar. No citation key, note, abstract field or manuscript text goes to a database. The CSP limits the page's connections to its own origin plus `api.crossref.org`, `api.semanticscholar.org`, `dblp.org`, `eutils.ncbi.nlm.nih.gov` and `api.datacite.org`, and allows scripts from its own origin only.

## Repository layout

| Path | Purpose |
| --- | --- |
| `docs/index.html`, `docs/app.css` | The page (meta CSP, markup) and its single stylesheet |
| `docs/boot.js` | Classic script: `file://` notice and the "reload with Ctrl+Shift+R" watchdog |
| `docs/main.js` | Entry module: wires settings, verification, preview and audit |
| `docs/core/text.js` | LaTeX⇄Unicode table, normalisation of titles, names, venues and years, DOI/arXiv parsing, similarity (vendored fuzzball) |
| `docs/core/bibtex.js` | Tokenizer-based parser with source spans, verbatim writer, LaTeX-safe escaping |
| `docs/core/net.js` | Requests with timeouts, retries, deadlines and cancellation; TTL cache; rate pacer |
| `docs/core/providers.js` | Endpoints per origin, proxy health, Crossref/Semantic Scholar/DBLP/OpenReview/arXiv adapters, DBLP/OpenReview pacing and bot-challenge circuit, per-entry provider status, notices |
| `docs/core/pubmed.js` | PubMed query builders, E-utilities client and pacing, ESummary records and notices |
| `docs/core/formats.js` | RIS and MEDLINE (.nbib) detection and conversion to BibTeX |
| `docs/core/records.js` | Whole records, integrity checks, lint notes, comparison, same work / strong match / plausible, version clusters, duplicates |
| `docs/core/versions.js` | Version rule table R1–R24 and pick validation |
| `docs/core/verify.js` | Status policy (`decide`), lookup, DOI round trip, run controller (cancel, retry) |
| `docs/core/output.js` | Preview state, line diff, status labels, export readiness and confirmation token |
| `docs/core/judge.js` | AI judge interface (engines `off`, `vllm`), prompt, strict JSON parsing |
| `docs/core/audit.js` | Citation extraction, sentence splitting, evidence lookup and identity, verdicts, Markdown report |
| `docs/ui/*.js` | DOM layer: `dom.js` (escaping `html` templates; the only `innerHTML`), `cards.js`, `preview.js`, `panels.js` (settings, storage, banners), `audit-view.js` |
| `docs/vendor/` | fuzzball 2.2.3, byte-identical to the locked npm package |
| `cli/` | `lcv.mjs` (command line entry) and `lib/` (commands, the `/api/*` → upstream mapping, disk cache, allowlist); see `cli/README.md`. `hooks/` holds the agent hooks (`stop-check.mjs`, `guard.mjs`) |
| `skills/citation-guard/` | The Agent Skill shared by Claude Code and Codex |
| `.claude-plugin/`, `hooks/hooks.json` | Claude Code plugin manifest, marketplace and hooks |
| `.codex-plugin/`, `.agents/plugins/`, `hooks/codex-hooks.json` | Codex plugin manifest, marketplace and hooks |
| `server/` | `vllm_proxy_server.py` (static files, `/api/*`, Host/Origin checks), `proxy_core.py` (upstream fetch, cache), `bind_policy.py` (bind, Host and Origin policy) |
| `scripts/` | `release-manifest.js` and `post-deploy-smoke.js` (release gate), `run_local.py` |
| `regression/` | The public verdict regression suite (`npm test`): synthetic bibliographies and service answers, `lcv check --strict` and export readiness without network |

## Development

Node ≥ 22.15 and Python ≥ 3.10. No build step: `docs/` is native ES modules. `npm test` runs the public verdict regression suite ([`regression/`](../regression/README.md), no network); the larger test suites and the fabricated-reference evaluation are maintained outside this repository. For a live check of a `.bib` file use `lcv check` (see [`cli/README.md`](../cli/README.md)).

## Release operations

CI and the GitHub Pages deployment call the same reusable release workflow, which runs the public verdict regression suite before packaging (the larger test suites run before publishing, outside this repository):

1. One SHA-named artifact is packaged with a canonical file manifest.
2. The manifest is verified after download, and those exact bytes are deployed.
3. A public smoke checks the published hashes. It reads the CSP from the deployed `index.html` and requires `script-src 'self'`, then loads the page with every off-origin request blocked.

Rollback redeploys a full 40-character commit SHA from `main` through the same gate. See [`docs/operations.md`](operations.md), including the limit on rolling back past the module restructure.
