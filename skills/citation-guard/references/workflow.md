# citation-guard workflow details

## Adding a reference

1. Resolve it: `lcv resolve <identifier or title/author/year or free text> --json`.
2. Read `records[0].match.confidence`:
   - `identifier`: the record the DOI/PMID/PMCID/arXiv ID names. Usable.
   - `same_work`: title, first author and a compatible year agree. Usable.
   - `title`: same title, no author given to confirm it. Usable only if the user gave that exact title; otherwise rerun with `--author` and `--year`.
   - `weak`: not confirmed. Not usable.
   - `discovery_only` (Semantic Scholar): never usable as a reference.
3. Check `records[0].notices` for `serious: true` (retraction, withdrawal, removal, expression of concern). Do not cite such a work unless the text is about the retraction.
4. Print it: `lcv resolve … --bibtex --key <key>` and paste the output unchanged.
5. Cite it, then run `lcv check --strict` and `lcv keys` (below).

## Gate

```bash
lcv check --strict refs.bib other.ris    # exit 0 = every entry Verified (or approved by a human)
lcv keys paper.tex refs.bib other.bib    # exit 0 = every cited key exists
```

`lcv check --strict --json` gives `files[].entries[]` with `key`, `status`, `blocking`, `block` (codes), `action` (what to do) and `record` (the authoritative record the status rests on). Act on every entry with `blocking: true`.

`lcv fix refs.bib --in-place` applies only the system auto-updates (`updated`): the record the entry's own DOI or arXiv ID names, or fields an exact match adds. It never applies a review candidate and keeps every other byte of the file.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | pass |
| 1 | blocking findings (`resolve`: no confirmed record) |
| 2 | usage error, unreadable file, internal error |
| 3 | a lookup failed, so there is no verdict: rerun |

## Works outside database coverage

Books, national reports, clinical guidelines, standards and some regional journals may be `not_found` although they exist. Do not approve them yourself. Tell the user which keys need a decision; the user can run, in a terminal:

```bash
lcv allow <key> --file refs.bib --reason "WHO report, not indexed"
```

The approval is stored in `references.allow` next to the bibliography, bound to a fingerprint of the entry's core fields. Any later edit of the entry's type, title, authors, year, venue or identifiers makes it stale, and `lcv check --strict` blocks the entry again.

## Hooks (Claude Code and Codex plugins)

- **Stop**: when the session's git working tree has changed or new `.bib`/`.ris`/`.nbib` files, or changed `.tex`/`.md` files with citation commands, the hook runs `lcv check --strict` (and `lcv keys --strict` for the changed manuscripts) and blocks the end of the turn with a list of `KEY — status — action`, also for unparsable citation commands and for a citing manuscript without any bibliography file. Fix the entries as above; do not try to get around the hook. It blocks at most three consecutive times for the same unresolved set; then it lets the turn end with a visible warning listing what is still unverified. That is not a pass: finish the fixes or report what is left.
- **PreToolUse**: edits of `references.allow` and `lcv allow` commands are denied.
- The human can turn the Stop hook off with `LCV_HOOK=off`; an agent must not.

## Limits

- `lcv keys` checks `\cite`-family commands. Pandoc `[@key]` citations and naming commands (`\citeauthor`, `\nocite`) are not checked.
- Existence and metadata only: a verified reference can still be cited for a claim it does not support.
