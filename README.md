# Local Citation Verifier

An in-browser citation QA desk for BibTeX files.

[Open the app](https://jhlee0619.github.io/local-citation-verifier/) · [Source](https://github.com/jhlee0619/local-citation-verifier) · MIT

Local Citation Verifier checks bibliography entries against CrossRef and Semantic Scholar, highlights suspicious metadata, and uses a Gemma WebGPU reranker for ambiguous preprint vs. journal or conference matches.

## What Makes This Fork Different

This project keeps the original BibTeX verification workflow, then adds a local reranking pass for cases where academic search returns multiple near-identical records.

The reranker loads Gemma WebGPU code from Hugging Face in the visitor's browser:

`https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels`

That means GitHub Pages hosts the static app, while model inference runs on the visitor's own WebGPU-capable browser and GPU. If WebGPU is unavailable or model loading fails, the app falls back to the built-in heuristic ranking.

## Use It

Online:

`https://jhlee0619.github.io/local-citation-verifier/`

Local:

```bash
git clone https://github.com/jhlee0619/local-citation-verifier.git
cd local-citation-verifier
npx serve docs
```

## Workflow

1. Upload a `.bib` file or paste BibTeX from Overleaf.
2. The browser parses entries locally.
3. Titles are queried against Semantic Scholar and CrossRef.
4. Candidate records are deduplicated and ranked.
5. Gemma WebGPU reranks ambiguous candidate sets when enabled.
6. You review field-level differences and export a corrected `.bib`.

## Result States

| State | Meaning |
| --- | --- |
| Verified | The entry matches the selected publication record. |
| Auto-updated | The paper matches, but metadata can be improved. |
| Needs Review | The match is weak or important fields disagree. |
| Not Found | No convincing indexed publication was found. |
| Duplicate | Another entry appears to cite the same paper. |

## Privacy Model

The `.bib` file is parsed in the browser. The app does not run an application server and does not upload the complete bibliography.

Network activity is limited to:

- title lookups to public academic APIs,
- static JavaScript assets served by GitHub Pages,
- Gemma WebGPU assets loaded by the visitor's browser when local rerank is enabled.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `docs/` | Static GitHub Pages app |
| `docs/app.js` | Browser UI and verification flow |
| `docs/lib.js` | BibTeX parsing, comparison, deduping, ranking helpers |
| `docs/gemma-reranker.js` | Optional Gemma WebGPU rerank bridge |
| `tests/test_lib.js` | Node tests for parsing and ranking helpers |

## Development

Run the lightweight checks:

```bash
node -c docs/lib.js
node -c docs/gemma-reranker.js
node -c docs/app.js
node tests/test_lib.js
```

## Attribution

Local Citation Verifier is based on [BibTeX Verifier](https://github.com/merfanian/Bibtex-Verifier) by merfanian, licensed under MIT.

This fork changes branding, UI direction, GitHub Pages publishing, and adds local WebGPU reranking for ambiguous candidate records.

## License

[MIT](LICENSE)
