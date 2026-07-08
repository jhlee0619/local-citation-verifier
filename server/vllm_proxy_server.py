#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# ///
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.client import RemoteDisconnected
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from typing import Callable, Final, TypeAlias
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlunparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

DEFAULT_HOST: Final = "127.0.0.1"
DEFAULT_PORT: Final = 8088
DEFAULT_VLLM_BASE_URL: Final = "http://127.0.0.1:8000"
MAX_BODY_BYTES: Final = 64 * 1024
MAX_PROMPT_CHARS: Final = 24_000
MAX_CANDIDATES: Final = 50
DEFAULT_RERANK_MAX_TOKENS: Final = 160
MAX_COMPLETION_TOKENS: Final = 512
ARXIV_ID_RE: Final = re.compile(r"^\d{4}\.\d{4,5}(?:v\d+)?$")
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
USER_AGENT: Final = "local-citation-verifier/1.0"
CSP_POLICY: Final = (
    "default-src 'self'; "
    "base-uri 'none'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://unpkg.com https://huggingface.co https://dblp.org https://openreview.net; "
    "connect-src 'self' https://api.crossref.org https://api.semanticscholar.org https://dblp.org https://api.openreview.net https://openreview.net "
    "https://export.arxiv.org https://arxiv.org https://huggingface.co https://*.huggingface.co https://*.hf.co https://cas-bridge.xethub.hf.co https://cas-server.xethub.hf.co https://transfer.xethub.hf.co; "
    "img-src 'self' data: https:; "
    "style-src 'self' 'unsafe-inline'; "
    "worker-src 'self' blob:; "
    "font-src 'self' data:"
)
X_FRAME_OPTIONS: Final = "DENY"
METADATA_CACHE_TTL_SECONDS: Final = 24 * 60 * 60
ARXIV_CACHE_TTL_SECONDS: Final = 7 * 24 * 60 * 60




@dataclass(frozen=True, slots=True)
class CachedBytes:
    status: int
    body: bytes
    expires_at: float


class TtlByteCache:
    def __init__(self, ttl_seconds: float, now: Callable[[], float] = time.monotonic) -> None:
        self._ttl_seconds = ttl_seconds
        self._now = now
        self._items: dict[str, CachedBytes] = {}
        self._lock = RLock()

    def get(self, key: str) -> tuple[int, bytes] | None:
        with self._lock:
            cached = self._items.get(key)
            if cached is None:
                return None
            if cached.expires_at <= self._now():
                del self._items[key]
                return None
            return cached.status, cached.body

    def set(self, key: str, status: int, body: bytes) -> None:
        with self._lock:
            self._items[key] = CachedBytes(status=status, body=body, expires_at=self._now() + self._ttl_seconds)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


def canonical_cache_key(url: str) -> str:
    parsed = urlparse(url)
    query = urlencode(sorted(parse_qsl(parsed.query, keep_blank_values=True)))
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", query, ""))


METADATA_RESPONSE_CACHE = TtlByteCache(METADATA_CACHE_TTL_SECONDS)
ARXIV_BIBTEX_CACHE = TtlByteCache(ARXIV_CACHE_TTL_SECONDS)

@dataclass(frozen=True, slots=True)
class RerankRequest:
    prompt: str
    candidate_count: int
    max_tokens: int


@dataclass(frozen=True, slots=True)
class AppConfig:
    docs_dir: Path
    vllm_base_url: str
    vllm_model: str | None


class BadRequestError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class UpstreamError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise BadRequestError(f"{name} must be an integer") from exc


def parse_json_object(raw: bytes) -> JsonObject:
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise BadRequestError("request body must be UTF-8 JSON") from exc
    except json.JSONDecodeError as exc:
        raise BadRequestError("request body must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise BadRequestError("request body must be a JSON object")
    return parsed


def parse_rerank_request(data: JsonObject) -> RerankRequest:
    prompt = data.get("prompt")
    candidate_count = data.get("candidate_count")
    max_tokens = data.get("max_tokens", DEFAULT_RERANK_MAX_TOKENS)
    if not isinstance(prompt, str) or not prompt.strip():
        raise BadRequestError("prompt must be a non-empty string")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise BadRequestError("prompt is too large")
    if not isinstance(candidate_count, int):
        raise BadRequestError("candidate_count must be an integer")
    if candidate_count < 1 or candidate_count > MAX_CANDIDATES:
        raise BadRequestError("candidate_count is out of range")
    if not isinstance(max_tokens, int):
        raise BadRequestError("max_tokens must be an integer")
    if max_tokens < 1 or max_tokens > MAX_COMPLETION_TOKENS:
        raise BadRequestError("max_tokens is out of range")
    return RerankRequest(prompt=prompt, candidate_count=candidate_count, max_tokens=max_tokens)


def post_json(url: str, payload: JsonObject, timeout_seconds: float) -> JsonObject:
    body = json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            return parse_json_object(response.read())
    except HTTPError as exc:
        raise UpstreamError(f"vLLM returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise UpstreamError(f"vLLM is unreachable: {exc.reason}") from exc
    except TimeoutError as exc:
        raise UpstreamError("vLLM request timed out") from exc


def get_json(url: str, timeout_seconds: float) -> JsonObject:
    try:
        with urlopen(url, timeout=timeout_seconds) as response:
            return parse_json_object(response.read())
    except HTTPError as exc:
        raise UpstreamError(f"vLLM returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise UpstreamError(f"vLLM is unreachable: {exc.reason}") from exc
    except TimeoutError as exc:
        raise UpstreamError("vLLM request timed out") from exc


def validate_proxy_path(path: str, allowed_prefixes: tuple[str, ...]) -> str:
    normalized = path.lstrip("/")
    if not normalized or ".." in normalized.split("/"):
        raise BadRequestError("proxy path is invalid")
    if not any(normalized.startswith(prefix) for prefix in allowed_prefixes):
        raise BadRequestError("proxy path is not allowed")
    return normalized


def fetch_upstream(url: str, timeout_seconds: float) -> tuple[int, bytes]:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            return response.status, response.read()
    except HTTPError as exc:
        return exc.code, exc.read()
    except URLError as exc:
        raise UpstreamError(f"upstream is unreachable: {exc.reason}") from exc
    except RemoteDisconnected as exc:
        raise UpstreamError("upstream closed the connection before responding") from exc
    except TimeoutError as exc:
        raise UpstreamError("upstream request timed out") from exc


def parse_arxiv_id(value: str | None) -> str:
    arxiv_id = (value or "").strip()
    if not ARXIV_ID_RE.fullmatch(arxiv_id):
        raise BadRequestError("id must be an arXiv identifier like 2407.21783")
    return re.sub(r"v\d+$", "", arxiv_id)


def fetch_arxiv_bibtex(arxiv_id: str, timeout_seconds: float) -> str:
    cached = ARXIV_BIBTEX_CACHE.get(arxiv_id)
    if cached is not None:
        return cached[1].decode("utf-8")
    request = Request(
        f"https://arxiv.org/bibtex/{arxiv_id}",
        headers={"User-Agent": "local-citation-verifier/1.0"},
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            body = response.read()
            ARXIV_BIBTEX_CACHE.set(arxiv_id, response.status, body)
            return body.decode("utf-8")
    except HTTPError as exc:
        raise UpstreamError(f"arXiv returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise UpstreamError(f"arXiv is unreachable: {exc.reason}") from exc
    except TimeoutError as exc:
        raise UpstreamError("arXiv request timed out") from exc


def first_model_id(models: JsonObject) -> str | None:
    data = models.get("data")
    if not isinstance(data, list) or not data:
        return None
    first = data[0]
    if not isinstance(first, dict):
        return None
    model_id = first.get("id")
    return model_id if isinstance(model_id, str) and model_id else None


def extract_chat_output(response: JsonObject) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise UpstreamError("vLLM response has no choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise UpstreamError("vLLM choice is invalid")
    message = first.get("message")
    if not isinstance(message, dict):
        raise UpstreamError("vLLM message is invalid")
    content = message.get("content")
    if not isinstance(content, str):
        raise UpstreamError("vLLM content is invalid")
    return content


def make_chat_payload(model: str, rerank: RerankRequest) -> JsonObject:
    return {
        "model": model,
        "messages": [{"role": "user", "content": rerank.prompt}],
        "temperature": 0,
        "max_tokens": rerank.max_tokens,
    }


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


def main() -> None:
    CitationRequestHandler.config = build_config()
    host = os.environ.get("HOST", DEFAULT_HOST)
    port = env_int("PORT", DEFAULT_PORT)
    server = ThreadingHTTPServer((host, port), CitationRequestHandler)
    print(f"Serving {CitationRequestHandler.config.docs_dir} on http://{host}:{port}")
    print(f"Proxying vLLM at {CitationRequestHandler.config.vllm_base_url}")
    server.serve_forever()


if __name__ == "__main__":
    main()
