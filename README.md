# Local Citation Verifier

Checks BibTeX references against Crossref, PubMed, arXiv, DBLP and OpenReview, and never lets an unconfirmed reference through silently.

[Open the web app](https://jhlee0619.github.io/local-citation-verifier/) · [Reference](docs/reference.md) · MIT

## What it does

- Looks up every entry of a `.bib` file (also RIS and MEDLINE `.nbib`) in public databases.
- **Verified** only when the entry's own DOI, PMID or arXiv ID, or a strong title–author–year–venue match, confirms it. An entry is never replaced by a different paper; anything uncertain waits for your decision before export.
- Flags likely fabricated references, wrong authors or years, identifier mismatches and retracted works.
- Exports untouched entries byte for byte; applied fixes are LaTeX-safe.
- Citation audit: checks that each `\cite` points to a real entry and whether the cited abstract states the claim.

| State | Meaning |
| --- | --- |
| Verified | Confirmed by an authoritative record |
| Auto-updated | Same work: only missing fields added, or the entry's own identifier record applied |
| Needs review | Conflicting metadata, wrong authors or year, another version, unconfirmed source — you choose |
| Not found | No record of this work; possibly fabricated (export asks for confirmation) |
| Lookup failed | A database did not answer; retry |

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

The `citation-guard` skill makes the agent take references only from `lcv resolve`, and a Stop hook keeps it working until `lcv check --strict` passes. References outside database coverage (books, reports) need your approval with `lcv allow`. It verifies that references exist and are described correctly, not that a paper supports a claim.

## Privacy

Titles, first authors and identifiers are sent to the public databases; nothing else leaves your browser or machine, and no e-mail address or account is used. The optional AI judge runs only on your own vLLM server.

## License

[MIT](LICENSE). A fork of [BibTeX Verifier](https://github.com/merfanian/Bibtex-Verifier) by merfanian.
