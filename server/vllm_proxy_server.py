#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# ///
from __future__ import annotations

import json
import os
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import AF_INET6
from typing import Final
from urllib.parse import parse_qs, urlparse

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "server"

from .bind_policy import RemoteBindDeniedError, enforce_bind_policy
from .proxy_core import (
    METADATA_RESPONSE_CACHE,
    AppConfig,
    BadRequestError,
    JsonObject,
    RerankRequest,
    TtlByteCache,
    UpstreamError,
    canonical_cache_key,
    env_int,
    extract_chat_output,
    fetch_arxiv_bibtex,
    fetch_upstream,
    first_model_id,
    get_json,
    make_chat_payload,
    parse_arxiv_id,
    parse_json_object,
    parse_rerank_request,
    post_json,
    validate_proxy_path,
)

DEFAULT_HOST: Final = "127.0.0.1"
DEFAULT_PORT: Final = 8088
DEFAULT_VLLM_BASE_URL: Final = "http://127.0.0.1:8000"
MAX_BODY_BYTES: Final = 64 * 1024
SEMANTIC_SCHOLAR_BASE: Final = "https://api.semanticscholar.org/"
CROSSREF_BASE: Final = "https://api.crossref.org/"
DBLP_BASE: Final = "https://dblp.org/"
OPENREVIEW_BASE: Final = "https://api.openreview.net/"
SEMANTIC_SCHOLAR_ALLOWED_PREFIXES: Final = (
    "graph/v1/paper/search",
    "graph/v1/paper/search/match",
    "graph/v1/paper/",
)
CROSSREF_ALLOWED_PREFIXES: Final = ("works",)
DBLP_ALLOWED_PREFIXES: Final = ("search/publ/api",)
OPENREVIEW_ALLOWED_PREFIXES: Final = ("notes/search",)
CSP_POLICY: Final = (
    "default-src 'self'; "
    "base-uri 'none'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://huggingface.co; "
    "connect-src 'self' https://api.crossref.org https://api.semanticscholar.org "
    "https://huggingface.co https://*.huggingface.co https://*.hf.co https://cas-bridge.xethub.hf.co https://cas-server.xethub.hf.co https://transfer.xethub.hf.co; "
    "img-src 'self' data: https:; "
    "style-src 'self' 'unsafe-inline'; "
    "worker-src 'self' blob:; "
    "font-src 'self' data:"
)
X_FRAME_OPTIONS: Final = "DENY"


class ThreadingHTTPServerV6(ThreadingHTTPServer):
    address_family = AF_INET6


class CitationRequestHandler(SimpleHTTPRequestHandler):
    config: AppConfig

    def __init__(self, *args: object, **kwargs: object) -> None:  # noqa: OBJECT_OK
        super().__init__(*args, directory=str(self.config.docs_dir), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CSP_POLICY)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", X_FRAME_OPTIONS)
        super().end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/rerank/vllm/health":
            self.handle_health()
            return
        if self.path.startswith("/api/arxiv/bibtex"):
            self.handle_arxiv_bibtex()
            return
        if self.path.startswith("/api/semanticscholar/"):
            self.handle_semanticscholar_proxy()
            return
        if self.path.startswith("/api/crossref/"):
            self.handle_crossref_proxy()
            return
        if self.path.startswith("/api/dblp/"):
            self.handle_dblp_proxy()
            return
        if self.path.startswith("/api/openreview/"):
            self.handle_openreview_proxy()
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/rerank/vllm":
            self.handle_rerank()
            return
        self.write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def handle_health(self) -> None:
        try:
            model = self.resolve_model(timeout_seconds=1.2)
            self.write_json(HTTPStatus.OK, {"ready": True, "model": model})
        except UpstreamError as exc:
            self.write_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ready": False, "error": exc.message})

    def handle_arxiv_bibtex(self) -> None:
        try:
            query = parse_qs(urlparse(self.path).query)
            arxiv_id = parse_arxiv_id(query.get("id", [""])[0])
            bibtex = fetch_arxiv_bibtex(arxiv_id, timeout_seconds=8.0)
            self.write_json(HTTPStatus.OK, {"id": arxiv_id, "bibtex": bibtex})
        except BadRequestError as exc:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": exc.message})
        except UpstreamError as exc:
            self.write_json(HTTPStatus.BAD_GATEWAY, {"error": exc.message})

    def handle_semanticscholar_proxy(self) -> None:
        self.handle_metadata_proxy(
            upstream_base=SEMANTIC_SCHOLAR_BASE,
            allowed_prefixes=SEMANTIC_SCHOLAR_ALLOWED_PREFIXES,
            route_prefix="/api/semanticscholar/",
        )

    def handle_crossref_proxy(self) -> None:
        self.handle_metadata_proxy(
            upstream_base=CROSSREF_BASE,
            allowed_prefixes=CROSSREF_ALLOWED_PREFIXES,
            route_prefix="/api/crossref/",
        )

    def handle_dblp_proxy(self) -> None:
        self.handle_metadata_proxy(
            upstream_base=DBLP_BASE,
            allowed_prefixes=DBLP_ALLOWED_PREFIXES,
            route_prefix="/api/dblp/",
        )

    def handle_openreview_proxy(self) -> None:
        self.handle_metadata_proxy(
            upstream_base=OPENREVIEW_BASE,
            allowed_prefixes=OPENREVIEW_ALLOWED_PREFIXES,
            route_prefix="/api/openreview/",
        )

    def handle_metadata_proxy(
        self,
        *,
        upstream_base: str,
        allowed_prefixes: tuple[str, ...],
        route_prefix: str,
    ) -> None:
        try:
            parsed = urlparse(self.path)
            suffix = validate_proxy_path(parsed.path[len(route_prefix):], allowed_prefixes)
            upstream_url = f"{upstream_base}{suffix}"
            if parsed.query:
                upstream_url = f"{upstream_url}?{parsed.query}"
            key = canonical_cache_key(upstream_url)
            cached = METADATA_RESPONSE_CACHE.get(key)
            if cached is None:
                status, body = fetch_upstream(upstream_url, timeout_seconds=12.0)
                if status == HTTPStatus.OK:
                    METADATA_RESPONSE_CACHE.set(key, status, body)
            else:
                status, body = cached
            self.write_upstream(HTTPStatus(status), body)
        except BadRequestError as exc:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": exc.message})
        except UpstreamError as exc:
            self.write_json(HTTPStatus.BAD_GATEWAY, {"error": exc.message})
        except ValueError as exc:
            self.write_json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})

    def handle_rerank(self) -> None:
        try:
            length = env_int("CONTENT_LENGTH_LIMIT", MAX_BODY_BYTES)
            body = self.read_body(length)
            rerank = parse_rerank_request(parse_json_object(body))
            model = self.resolve_model(timeout_seconds=2.0)
            payload = make_chat_payload(model, rerank)
            response = post_json(f"{self.config.vllm_base_url}/v1/chat/completions", payload, 90.0)
            self.write_json(HTTPStatus.OK, {"output": extract_chat_output(response), "model": model})
        except BadRequestError as exc:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": exc.message})
        except UpstreamError as exc:
            self.write_json(HTTPStatus.BAD_GATEWAY, {"error": exc.message})

    def resolve_model(self, timeout_seconds: float) -> str:
        if self.config.vllm_model:
            return self.config.vllm_model
        models = get_json(f"{self.config.vllm_base_url}/v1/models", timeout_seconds)
        model = first_model_id(models)
        if model is None:
            raise UpstreamError("vLLM did not report a model")
        return model

    def read_body(self, limit: int) -> bytes:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise BadRequestError("Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise BadRequestError("Content-Length must be an integer") from exc
        if length > limit:
            raise BadRequestError("request body is too large")
        return self.rfile.read(length)

    def write_json(self, status: HTTPStatus, body: JsonObject) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def write_upstream(self, status: HTTPStatus, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def build_config() -> AppConfig:
    repo_root = Path(__file__).resolve().parents[1]
    docs_dir = Path(os.environ.get("DOCS_DIR", repo_root / "docs")).resolve()
    return AppConfig(
        docs_dir=docs_dir,
        vllm_base_url=os.environ.get("VLLM_BASE_URL", DEFAULT_VLLM_BASE_URL).rstrip("/"),
        vllm_model=os.environ.get("VLLM_MODEL") or None,
    )


def main() -> int:
    host = os.environ.get("HOST", DEFAULT_HOST)
    try:
        bind_decision = enforce_bind_policy(host, os.environ.get("ALLOW_REMOTE"))
    except RemoteBindDeniedError as error:
        print(error, file=sys.stderr)
        return 2
    if bind_decision.warning is not None:
        print(bind_decision.warning, file=sys.stderr)
    CitationRequestHandler.config = build_config()
    port = env_int("PORT", DEFAULT_PORT)
    server_class = ThreadingHTTPServerV6 if ":" in host else ThreadingHTTPServer
    server = server_class((host, port), CitationRequestHandler)
    print(f"Serving {CitationRequestHandler.config.docs_dir} on http://{host}:{port}")
    print(f"Proxying vLLM at {CitationRequestHandler.config.vllm_base_url}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
