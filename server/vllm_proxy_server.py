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

from .bind_policy import (
    HostPolicy,
    InvalidAllowedHostsError,
    RemoteBindDeniedError,
    build_host_policy,
    enforce_bind_policy,
    same_origin,
)
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
    is_cacheable_metadata,
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
OPENREVIEW_BASE: Final = "https://api2.openreview.net/"
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
    "script-src 'self'; "
    "connect-src 'self' https://api.crossref.org https://api.semanticscholar.org https://dblp.org https://eutils.ncbi.nlm.nih.gov https://api.datacite.org; "
    "img-src 'self' data:; "
    "style-src 'self' 'unsafe-inline'; "
    "font-src 'self' data:"
)
X_FRAME_OPTIONS: Final = "DENY"
# Explicit static MIME types. SimpleHTTPRequestHandler otherwise falls back to
# the OS registry, which on Windows can map .js to text/plain; with nosniff the
# browser then refuses to run the app's ES modules.
STATIC_CONTENT_TYPES: Final = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
}
# Static files must be revalidated so a page never mixes module versions.
STATIC_CACHE_CONTROL: Final = "no-cache"
# GET /api/health: the signature the app (docs/core/providers.js
# checkProxyHealth) and scripts/run_local.py look for. A plain static server
# 404s this path, so the app can tell it apart from this proxy.
APP_SIGNATURE: Final = {"app": "local-citation-verifier", "ok": True}


def is_static_request(path: str) -> bool:
    return not urlparse(path).path.startswith("/api/")


class ThreadingHTTPServerV6(ThreadingHTTPServer):
    address_family = AF_INET6


class CitationRequestHandler(SimpleHTTPRequestHandler):
    config: AppConfig
    # Set by main() from HOST, ALLOW_REMOTE and ALLOWED_HOSTS; loopback names only by default.
    host_policy: HostPolicy = HostPolicy()

    def __init__(self, *args: object, **kwargs: object) -> None:  # noqa: OBJECT_OK
        super().__init__(*args, directory=str(self.config.docs_dir), **kwargs)

    def parse_request(self) -> bool:
        # Every method and route: a Host this server does not answer to (DNS
        # rebinding) gets 403 before any handler runs.
        if not super().parse_request():
            return False
        if self.host_policy.allows(self.headers.get("Host"), self.server.server_address[1]):
            return True
        self.reject(HTTPStatus.FORBIDDEN, "host not allowed")
        return False

    def reject(self, status: HTTPStatus, error: str) -> None:
        """A JSON error for a request whose body no handler reads.

        A small body is read first: closing a socket with unread input resets
        the connection, and the client would see a reset instead of the answer.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if 0 < length <= MAX_BODY_BYTES:
            self.rfile.read(length)
        self.write_json(status, {"error": error})

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CSP_POLICY)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", X_FRAME_OPTIONS)
        if is_static_request(getattr(self, "path", "")):
            self.send_header("Cache-Control", STATIC_CACHE_CONTROL)
        super().end_headers()

    def guess_type(self, path: str) -> str:
        content_type = STATIC_CONTENT_TYPES.get(Path(path).suffix.lower())
        return content_type or super().guess_type(path)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/api/health":
            self.write_json(HTTPStatus.OK, dict(APP_SIGNATURE), cache_control="no-store")
            return
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
        # A POST must come from a page this server served (CSRF defence).
        if not same_origin(self.headers.get("Origin"), self.headers.get("Host")):
            self.reject(HTTPStatus.FORBIDDEN, "cross-origin request refused")
            return
        if self.path == "/api/rerank/vllm":
            self.handle_rerank()
            return
        self.reject(HTTPStatus.NOT_FOUND, "not found")

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
            # A cached answer asked no upstream, so it carries no rate-limit headers.
            headers: dict[str, str] = {}
            if cached is None:
                status, body, headers = fetch_upstream(upstream_url, timeout_seconds=12.0)
                if status == HTTPStatus.OK and is_cacheable_metadata(body):
                    METADATA_RESPONSE_CACHE.set(key, status, body)
            else:
                status, body = cached
            self.write_upstream(HTTPStatus(status), body, headers)
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
        if length < 0:
            raise BadRequestError("Content-Length must be non-negative")
        if length > limit:
            raise BadRequestError("request body is too large")
        return self.rfile.read(length)

    def write_json(self, status: HTTPStatus, body: JsonObject, cache_control: str | None = None) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        if cache_control is not None:
            self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(encoded)

    def write_upstream(self, status: HTTPStatus, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
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
    port = env_int("PORT", DEFAULT_PORT)
    try:
        bind_decision = enforce_bind_policy(host, os.environ.get("ALLOW_REMOTE"))
        policy, host_warning = build_host_policy(bind_decision, os.environ.get("ALLOWED_HOSTS"), port)
    except (RemoteBindDeniedError, InvalidAllowedHostsError) as error:
        print(error, file=sys.stderr)
        return 2
    for warning in (bind_decision.warning, host_warning):
        if warning is not None:
            print(warning, file=sys.stderr)
    CitationRequestHandler.config = build_config()
    CitationRequestHandler.host_policy = policy
    server_class = ThreadingHTTPServerV6 if ":" in host else ThreadingHTTPServer
    server = server_class((host, port), CitationRequestHandler)
    print(f"Serving {CitationRequestHandler.config.docs_dir} on http://{host}:{port}")
    print(f"Proxying vLLM at {CitationRequestHandler.config.vllm_base_url}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
