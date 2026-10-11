---
name: citation-guard
description: Use whenever you write, edit, add, fix or cite references - BibTeX/RIS/MEDLINE files (.bib, .ris, .nbib), a paper's reference list or bibliography, LaTeX \cite commands, Markdown citations, DOIs, PMIDs or arXiv IDs. Obtains every reference from authoritative databases with the lcv command line (never from memory) and gates the result with lcv check --strict and lcv keys.
license: MIT
---

# citation-guard

References written from memory are often fabricated: a real-looking title with the wrong authors, a DOI that belongs to another paper, a journal that never published it. This skill makes every reference you leave in a bibliography come from an authoritative record (Crossref, PubMed, arXiv, DBLP, OpenReview) or carry a human approval.

`lcv` (Local Citation Verifier) checks existence and metadata only. It does **not** tell you whether a paper supports a claim.

## Running lcv

Use the first form that works and keep using it:

1. `lcv …` if `lcv` is on the PATH.
2. Claude Code plugin: `node "${CLAUDE_SKILL_DIR}/../../cli/lcv.mjs" …` (Claude Code substitutes the skill directory).
3. Codex plugin, or any other host: `node "<directory of this SKILL.md>/../../cli/lcv.mjs" …`. Codex lists the path of this file in its skills list; the plugin root two levels up contains `cli/lcv.mjs`.
4. Anywhere with Node >= 22.15 and network: `npx -y --package=github:jhlee0619/local-citation-verifier lcv …`.

Below, `lcv` means whichever form you resolved. Add `--json` when you parse output. Exit codes: 0 pass, 1 blocking findings, 2 usage error, 3 a lookup failed (rerun; never treat 3 as a pass).

## Rules

### 1. Never write a reference from memory

Do not type a title, author list, year, venue, DOI, PMID or arXiv ID from memory, not even "well-known" ones. Obtain every new entry with `lcv resolve`:

```bash
lcv resolve --doi 10.1109/cvpr.2016.90 --bibtex --key he2016deep
lcv resolve --pmid 33288961 --bibtex
lcv resolve --arxiv 1706.03762 --bibtex
lcv resolve --title "Deep residual learning for image recognition" --author "He, Kaiming" --year 2016 --bibtex
lcv resolve "He K, Zhang X, Ren S, Sun J. Deep residual learning for image recognition. CVPR 2016." --bibtex
```

- Prefer an identifier when the user gave one; otherwise title + first author + year, or the user's free-text reference.
- Paste the `--bibtex` output unchanged. You may change only the citation key (`--key`).
- Use only records whose match confidence is `identifier` or `same_work` (`--json`: `records[].match.confidence`). A `title` match without an author is acceptable only when the user named that exact title. Never use a `weak` record, and never use the "discovery only" (Semantic Scholar) list.
- Do not pass `--pick` to force a record that `lcv` did not confirm, unless the user chose that exact record.
- If `lcv resolve` exits 1 or 3, the work was not confirmed. Do not invent it: tell the user, and leave a visible `TODO(citation)` marker instead of a citation.

### 2. Check after every change to references or citations

After you touch a bibliography or citation commands, run both:

```bash
lcv check --strict refs.bib            # every .bib/.ris/.nbib you changed
lcv keys paper.tex refs.bib --strict   # each manuscript you changed, against its bibliographies
```

Clear every blocking line (`KEY — STATUS — action — record`):

| Status / code | What to do |
| --- | --- |
| `updated` (Auto-Updated) | `lcv fix refs.bib --in-place`, then check again. |
| `needs_review` | If you are certain which work was intended, replace the **whole** entry with `lcv resolve … --bibtex --key KEY` (the action line names the command). Otherwise remove the citation, and either remove the claim that depends on it or leave a visible `TODO(citation)` marker; tell the user. |
| `doi_unconfirmed`, `arxiv_unconfirmed`, `pmid_unconfirmed` | The work exists but the identifier in the entry does not. Replace the whole entry with `lcv resolve` output; never invent or guess an identifier. |
| `not_found` | Treat it as possibly fabricated. Replace it with a resolved real work, or remove it. Books, reports, guidelines and other works outside database coverage need the **user** to approve them with `lcv allow` (you must not). |
| `serious_notice` (retracted, withdrawn, removed, expression of concern) | Do not cite it unless the text discusses the retraction itself. Tell the user. |
| `lookup_failed` / exit 3 | Rerun later. Never assume the entry is valid. `provider_unavailable` means a database (often DBLP) did not answer: it is no evidence against the entry, so do not replace, remove or edit the entry because of it. |
| `invalid` | Fix the BibTeX syntax at the reported line. |
| `stale_approval` | The entry changed after a human approved it: restore it, or ask the user to approve again. |
| `lcv keys`: missing key | Add the entry with `lcv resolve`, or correct the key in the citation. |
| `lcv keys`: unparsable citation command | Write it as `\cite{key1,key2}` with existing keys. |

### 3. Never weaken or bypass the checks

- Never edit, create or delete `references.allow`, and never run `lcv allow`. Approvals are for humans only; the plugin's hooks deny both.
- Never hand-edit an entry's fields (title, authors, year, venue, identifiers) to make a check pass. Replace the whole entry with a resolved record instead.
- Never remove `--strict`, skip files, disable hooks, or silence findings. Never report success while a check is red.

### 4. Definition of done

You are done with references only when `lcv check --strict` exits 0 for every bibliography you changed and `lcv keys --strict` exits 0 for every manuscript you changed. In your final message, list anything left for the user: entries that need a human approval, removed citations, `TODO(citation)` markers, retracted works, failed lookups.

The plugin's Stop hook blocks finishing while those checks fail, at most three consecutive times for the same unresolved set; then it lets you stop and shows the user a warning listing what is still unverified. Being let through is not a pass, and the hook does not guarantee that every fix is made: this definition of done does.

### 5. Existence is not support

`lcv` confirms that a reference exists and that its metadata matches an authoritative record. It does not read the paper. Cite a work for a claim only if you retrieved its record or abstract and it plausibly supports the claim; if support is uncertain, say so to the user rather than citing it as evidence.

## More

- Command details, the JSON schema and exit codes: `references/workflow.md` in this skill, and `cli/README.md` at the plugin root.
