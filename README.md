# Local Citation Verifier

An in-browser citation QA desk for BibTeX files.

[Open the app](https://jhlee0619.github.io/local-citation-verifier/) · [Source](https://github.com/jhlee0619/local-citation-verifier) · MIT

Local Citation Verifier checks bibliography entries against CrossRef and Semantic Scholar, highlights suspicious metadata, and can rerank ambiguous preprint vs. journal or conference matches with either browser WebGPU or a local vLLM server. It also includes a same-level citation support audit for checking whether cited manuscript sentences are supported by the referenced papers.

## What Makes This Fork Different

This project keeps the original BibTeX verification workflow, then adds local LLM passes for cases where academic search returns multiple near-identical records and for manuscript sentences that need citation support review.

The reranker loads Gemma WebGPU code from Hugging Face in the visitor's browser:

`https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels`

That means GitHub Pages hosts the static app, while model inference runs on the visitor's own WebGPU-capable browser and GPU. If WebGPU is unavailable or model loading fails, the app falls back to the built-in heuristic ranking.

For workstation or lab-server use, the same UI can call a local vLLM OpenAI-compatible server through `server/vllm_proxy_server.py`. The proxy serves `docs/` and forwards only rerank prompts to vLLM on `127.0.0.1`.

## Use It

Online:

`https://jhlee0619.github.io/local-citation-verifier/`

Local static app:

```bash
git clone https://github.com/jhlee0619/local-citation-verifier.git
cd local-citation-verifier
npx serve docs -l 18088
```

Open `http://127.0.0.1:18088/`. In this mode, WebGPU rerank runs in your browser on your local GPU when supported.

On GitHub Pages alone, the optional `/api/arxiv/bibtex` lookup and metadata API proxies are unavailable because there is no backend server. Verification still works through direct CrossRef and Semantic Scholar requests from the published site; local proxy use adds arXiv BibTeX enrichment and avoids Semantic Scholar CORS blocks on `localhost`.

Server with vLLM:

```bash
git clone https://github.com/jhlee0619/local-citation-verifier.git
cd local-citation-verifier

python3 -m venv .venv-vllm
. .venv-vllm/bin/activate
pip install vllm

vllm serve google/gemma-4-E2B-it --host 127.0.0.1 --port 8000 --max-model-len 8192
HOST=127.0.0.1 PORT=8088 VLLM_BASE_URL=http://127.0.0.1:8000 python3 server/vllm_proxy_server.py
```

Use `HOST=127.0.0.1` when you only need local access. The proxy defaults to `0.0.0.0`, which exposes the static app and rerank endpoint on your LAN without authentication.

Then open one of these addresses and choose `vLLM server` in the rerank engine menu:

- Same machine as the proxy: `http://127.0.0.1:8088/`
- LAN access: `http://<server-host>:8088/`
- SSH tunnel from your laptop: `ssh -L 18088:127.0.0.1:8088 aicon_spark`, then open `http://127.0.0.1:18088/`

When the proxy health check succeeds, the app selects vLLM automatically. In this mode, rerank inference runs on the server GPU, while the UI still runs in your browser.

## Workflow

1. Choose `Bibliography verifier` or `Citation support audit`.
2. Upload a `.bib` file or paste BibTeX from Overleaf.
3. The browser parses entries locally.
4. Titles are queried against Semantic Scholar and CrossRef.
5. Candidate records are deduplicated and ranked.
6. WebGPU Gemma or server-side vLLM reranks ambiguous candidate sets when enabled.
7. You review field-level differences and export a corrected `.bib`.

## Citation Support Audit

The `Citation support audit` workbench is separate from the bibliography verifier. Paste or upload:

- a `.bib` file,
- manuscript text, Markdown, or LaTeX containing citation commands such as `\cite{key}`, `\citep{key}`, or `\citet{key}`.

For each cited sentence, the app maps the citation key to the BibTeX entry, fetches Semantic Scholar abstract/TLDR evidence by DOI or title, then asks the local LLM to classify the citation as:

- `Supported` - the cited paper directly supports the sentence,
- `Weak` - the paper is related but only broadly supports the claim,
- `Unsupported` - the evidence appears unrelated, contradictory, or much weaker than the sentence,
- `Insufficient evidence` - no abstract/TLDR or enough evidence was available.

On GitHub Pages the judgement runs in the visitor's WebGPU-capable browser. On the local vLLM server, choose `Auto` or `vLLM server GPU` so judgement prompts run on the server GPU through `server/vllm_proxy_server.py`.

Model answers with risk flags are escalated conservatively before display: for example, `topic_mismatch` downgrades `supported`/`weak` to `unsupported`, and `broad_claim` or `specific_result_claim` downgrades an overconfident `supported` answer to `weak`.

## Rerank Guardrails

Ambiguous matches are limited to the top three candidates before LLM reranking. The model must return strict JSON with one of `verified`, `updated`, `needs_review`, or `not_found`, plus a fixed risk flag vocabulary. Any risky `updated` or `verified` answer is escalated to `needs_review` during verification, before you review or export the file. Export is not blocked automatically; the UI keeps the escalated status visible so you can accept, revert, or exclude entries deliberately.

## Result States

| State | Meaning |
| --- | --- |
| Verified | The entry matches the selected publication record. |
| Auto-updated | The paper matches, but metadata can be improved. |
| Needs Review | The match is weak or important fields disagree. |
| Not Found | No convincing indexed publication was found. |
| Duplicate | Another entry appears to cite the same paper (matched by DOI, arXiv ID, or normalized title plus first author). |

## Privacy Model

The `.bib` file is parsed in the browser. The app does not run an application server and does not upload the complete bibliography.

Network activity is limited to:

- title lookups to public academic APIs,
- static JavaScript assets served by GitHub Pages,
- Gemma WebGPU assets loaded by the visitor's browser when WebGPU rerank is enabled,
- rerank prompts sent to your own vLLM proxy when server rerank is selected.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `docs/` | Static GitHub Pages app |
| `docs/app.js` | Browser UI and verification flow |
| `docs/lib.js` | BibTeX parsing, comparison, deduping, ranking helpers |
| `docs/citation-audit.js` | Citation context extraction, evidence lookup, and support judgement |
| `docs/gemma-reranker.js` | Optional Gemma WebGPU rerank and judgement bridge |
| `docs/vllm-reranker.js` | Optional local vLLM rerank bridge |
| `server/vllm_proxy_server.py` | Static file server, metadata API proxy, and vLLM OpenAI API proxy |
| `tests/test_lib.js` | Node tests for parsing and ranking helpers |

## Development

Run the lightweight checks:

```bash
node -c docs/lib.js
node -c docs/gemma-reranker.js
node -c docs/vllm-reranker.js
node -c docs/citation-audit.js
node -c docs/app.js
node tests/test_lib.js
node tests/test_vllm_reranker.js
node tests/test_citation_audit.js
python3 -m py_compile server/vllm_proxy_server.py
python3 tests/test_vllm_proxy.py
```

## Attribution

Local Citation Verifier is based on [BibTeX Verifier](https://github.com/merfanian/Bibtex-Verifier) by merfanian, licensed under MIT.

This fork changes branding, UI direction, GitHub Pages publishing, and adds local WebGPU or vLLM reranking for ambiguous candidate records.

## License

[MIT](LICENSE)
