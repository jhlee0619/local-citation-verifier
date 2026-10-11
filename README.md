# Local Citation Verifier

Checks BibTeX references against Crossref, PubMed, arXiv, DBLP and OpenReview, and never lets an unconfirmed reference through silently.

[Open the web app](https://jhlee0619.github.io/local-citation-verifier/) · [Reference](docs/reference.md) · MIT

## What it does

- Looks up every entry of a `.bib` file (also RIS and MEDLINE `.nbib`) in public databases.
- **Verified** only when the entry's own DOI, PMID or arXiv ID, or a strong title–author–year–venue match, confirms it, and every identifier in the entry exists (Crossref, DataCite, arXiv, PubMed). Titles compare in any script; different full given names are different people. An entry is never replaced by a different paper; anything uncertain waits for your decision before export.
- Applying a record (an auto-update or your choice) replaces the bibliographic fields as one whole record and keeps your own fields that the record does not define: `note`, `annote`, `keywords`, `abstract`, `file`, `groups`, `owner`, `timestamp`, `x-*` and other custom fields.
- Flags likely fabricated references, wrong authors or years, identifier mismatches and retracted works.
- Exports untouched entries byte for byte; applied fixes are LaTeX-safe.
- Citation audit: checks that each `\cite` points to a real entry and whether the cited abstract states the claim. A sentence counts as supported only if at least one cited abstract supports it; partial support alone stays partial.

| State | Meaning |
| --- | --- |
| Verified | Confirmed by an authoritative record; kept exactly as written (missing fields are only offered) |
| Auto-updated | The record the entry's own identifier names corrects it, as one whole record |
| Needs review | Conflicting metadata, wrong authors or year, another version, unconfirmed source, an identifier that cannot be found — you choose |
| Not found | No record of this work in any database, and every database it depends on answered; possibly fabricated (export asks for confirmation) |
| Lookup failed | A database did not answer (for example DBLP rate-limited), so no verdict was reached; retry. Never evidence against the entry |

## Run locally

The web app works as is. For all databases (DBLP, OpenReview, arXiv BibTeX) and the optional local AI judge, run the proxy (Python standard library only):

```bash
HOST=127.0.0.1 PORT=18088 python3 server/vllm_proxy_server.py   # open http://127.0.0.1:18088/
```

On Windows, `run-local.cmd` does the same and opens the browser.

## Command line

```bash
npx -y --package=github:jhlee0619/local-citation-verifier lcv check refs.bib --strict
lcv resolve --doi 10.1109/cvpr.2016.90 --bibtex   # canonical BibTeX from an authoritative record
lcv fix refs.bib --in-place                       # apply only safe automatic updates
```

Exit code 0 means every entry is verified. See [cli/README.md](cli/README.md).

## Claude Code and Codex

```text
/plugin marketplace add jhlee0619/local-citation-verifier
/plugin install citation-guard@local-citation-verifier
```

Codex: `codex plugin marketplace add jhlee0619/local-citation-verifier`, then `codex plugin add citation-guard@local-citation-verifier` and trust its hooks in `/hooks`.

The `citation-guard` skill makes the agent take references only from `lcv resolve`. A Stop hook blocks finishing while `lcv check --strict` or `lcv keys --strict` reports a problem (also when a changed manuscript cites but no bibliography file exists): up to 3 consecutive times for the same unresolved set, then it lets the agent stop with a visible warning listing what is still unverified. It does not guarantee that the agent makes every fix. References outside database coverage (books, reports) need your approval with `lcv allow`. It verifies that references exist and are described correctly, not that a paper supports a claim.

## Privacy

Sent to the public databases (Crossref, Semantic Scholar, PubMed, and through the proxy DBLP, OpenReview and arXiv): titles, the first three authors' surnames, venue, year and the DOI, PMID, PMCID and arXiv IDs; for PubMed citation matching also the journal, volume, first page and the first author's initials. DataCite gets DOIs (an arXiv ID as its DOI) that no other record confirms. Nothing else leaves your browser or machine (no citation keys, notes or manuscript text, no e-mail address or account). The optional AI judge runs only on your own vLLM server.

## Development

`npm test` runs the public verdict regression suite ([regression/](regression/README.md), no network).

## License

[MIT](LICENSE). A fork of [BibTeX Verifier](https://github.com/merfanian/Bibtex-Verifier) by merfanian.
