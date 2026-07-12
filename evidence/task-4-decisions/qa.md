# Task 4 decision-policy QA

Date: 2026-07-12

## Automated verification

- `node tests/test_decision_policy.js`: 11 passed, 0 failed.
- `node tests/test_atomic_app_contract.js`: passed.
- `git diff --check`: passed.
- `docs/decision-policy.js`: 185 lines (250-line limit satisfied).

## Browser verification

The app ran against deterministic local CrossRef, Semantic Scholar, and delayed
Gemma fixtures. Input:

```bibtex
@article{decision2022,
  title={Decision Paper},
  author={Original, Olivia},
  year={2022},
  note={original-note}
}
```

### Explicit candidate plus field override

1. The initial `needs_review` result selected **Keep original** and the live
   preview retained the input byte-for-byte at the field level.
2. Selected the complete CrossRef DOI candidate (`crossref_doi`,
   `10.1234/decision`).
3. Explicitly selected the original `year` value.
4. The preview used candidate author `Candidate, Carol`, original year `2022`,
   and displayed the mixed-source provenance warning. Candidate-only venue,
   DOI, and URL fields were projected; the original-only note was removed.

### Delayed rerank retention

1. Started a fresh verification run and clicked **Keep original** before the
   delayed Gemma rerank completed.
2. Waited beyond the 3.5-second fixture delay.
3. Suggestions reranked to the Semantic Scholar record and displayed
   `delayed fixture`, while the selected decision and preview remained the
   original title, author, year, and note.

Result: PASS.
