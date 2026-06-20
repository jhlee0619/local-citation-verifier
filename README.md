# Local Citation Verifier

An in-browser citation QA desk for BibTeX files.

[Open the app](https://jhlee0619.github.io/local-citation-verifier/) · [Source](https://github.com/jhlee0619/local-citation-verifier) · MIT

Local Citation Verifier checks bibliography entries against CrossRef and Semantic Scholar, highlights suspicious metadata, and can rerank ambiguous preprint vs. journal or conference matches with either browser WebGPU or a local vLLM server.

## What Makes This Fork Different

This project keeps the original BibTeX verification workflow, then adds a local reranking pass for cases where academic search returns multiple near-identical records.

The reranker loads Gemma WebGPU code from Hugging Face in the visitor's browser:

`https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels`

That means GitHub Pages hosts the static app, while model inference runs on the visitor's own WebGPU-capable browser and GPU. If WebGPU is unavailable or model loading fails, the app falls back to the built-in heuristic ranking.

For workstation or lab-server use, the same UI can call a local vLLM OpenAI-compatible server through `server/vllm_proxy_server.py`. The proxy serves `docs/` and forwards only rerank prompts to vLLM on `127.0.0.1`.

## Use It

Online:

`https://jhlee0619.github.io/local-citation-verifier/`

Local:

```bash
git clone https://github.com/jhlee0619/local-citation-verifier.git
cd local-citation-verifier
npx serve docs
```

Server with vLLM:

```bash
git clone https://github.com/jhlee0619/local-citation-verifier.git
cd local-citation-verifier

python3 -m venv .venv-vllm
. .venv-vllm/bin/activate
pip install vllm

vllm serve google/gemma-2-2b-it --host 127.0.0.1 --port 8000
PORT=8088 VLLM_BASE_URL=http://127.0.0.1:8000 python3 server/vllm_proxy_server.py
```

Then open `http://<server-host>:8088/` and choose `vLLM server` in the rerank engine menu. When the proxy health check succeeds, the app selects vLLM automatically.

## Workflow

1. Upload a `.bib` file or paste BibTeX from Overleaf.
2. The browser parses entries locally.
3. Titles are queried against Semantic Scholar and CrossRef.
4. Candidate records are deduplicated and ranked.
5. WebGPU Gemma or server-side vLLM reranks ambiguous candidate sets when enabled.
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
- Gemma WebGPU assets loaded by the visitor's browser when WebGPU rerank is enabled,
- rerank prompts sent to your own vLLM proxy when server rerank is selected.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `docs/` | Static GitHub Pages app |
| `docs/app.js` | Browser UI and verification flow |
| `docs/lib.js` | BibTeX parsing, comparison, deduping, ranking helpers |
| `docs/gemma-reranker.js` | Optional Gemma WebGPU rerank bridge |
| `docs/vllm-reranker.js` | Optional local vLLM rerank bridge |
| `server/vllm_proxy_server.py` | Static file server and vLLM OpenAI API proxy |
| `tests/test_lib.js` | Node tests for parsing and ranking helpers |

## Development

Run the lightweight checks:

```bash
node -c docs/lib.js
node -c docs/gemma-reranker.js
node -c docs/vllm-reranker.js
node -c docs/app.js
node tests/test_lib.js
node tests/test_vllm_reranker.js
python3 -m py_compile server/vllm_proxy_server.py
python3 tests/test_vllm_proxy.py
```

## Attribution

Local Citation Verifier is based on [BibTeX Verifier](https://github.com/merfanian/Bibtex-Verifier) by merfanian, licensed under MIT.

This fork changes branding, UI direction, GitHub Pages publishing, and adds local WebGPU or vLLM reranking for ambiguous candidate records.

## License

[MIT](LICENSE)
