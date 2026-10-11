from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from http.client import RemoteDisconnected
from pathlib import Path
from typing import Final, Protocol, TypeAlias
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, unquote, urlencode, urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

from .ttl_cache import TtlByteCache

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

MAX_PROMPT_CHARS: Final = 24_000
MAX_CANDIDATES: Final = 50
DEFAULT_RERANK_MAX_TOKENS: Final = 160
MAX_COMPLETION_TOKENS: Final = 512
ARXIV_ID_RE: Final = re.compile(r"^\d{4}\.\d{4,5}(?:v\d+)?$")
USER_AGENT: Final = "local-citation-verifier/1.0"
METADATA_CACHE_TTL_SECONDS: Final = 24 * 60 * 60
ARXIV_CACHE_TTL_SECONDS: Final = 7 * 24 * 60 * 60
MAX_JSON_RESPONSE_BYTES: Final = 1024 * 1024
MAX_METADATA_RESPONSE_BYTES: Final = 4 * 1024 * 1024
MAX_ARXIV_BIBTEX_BYTES: Final = 1024 * 1024
METADATA_CACHE_MAX_ENTRIES: Final = 256
METADATA_CACHE_MAX_BYTES: Final = 16 * 1024 * 1024
ARXIV_CACHE_MAX_ENTRIES: Final = 128
ARXIV_CACHE_MAX_BYTES: Final = 8 * 1024 * 1024
MAX_PAGE_BYTES: Final = 2 * 1024 * 1024
# docs/core/pages.js PAGE_HOSTS: the official proceedings sites /api/page
# fetches (the page's own URL is built there).
PAGE_HOSTS: Final = frozenset({
    "proceedings.neurips.cc", "papers.neurips.cc", "papers.nips.cc",
    "proceedings.mlr.press",
    "jmlr.org", "www.jmlr.org",
    "aclanthology.org", "www.aclanthology.org", "www.aclweb.org", "aclweb.org",
    "openaccess.thecvf.com",
    "www.ijcai.org", "ijcai.org",
})
META_TAG_RE: Final = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
FORWARDED_UPSTREAM_HEADERS: Final = (
    "Retry-After",
    "X-Rate-Limit-Limit",
    "X-Rate-Limit-Interval",
    "X-Concurrency-Limit",
)


class ReadableBytes(Protocol):
    def read(self, amount: int = -1, /) -> bytes: ...


def canonical_cache_key(url: str) -> str:
    parsed = urlparse(url)
    query = urlencode(sorted(parse_qsl(parsed.query, keep_blank_values=True)))
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", query, ""))


def is_cacheable_metadata(body: bytes) -> bool:
    """A metadata answer worth caching: a JSON body. A bot check or portal
    page (HTML, such as DBLP's "Making sure you're not a bot!") answers HTTP
    200 too and must never be served again from the cache."""
    return body.lstrip()[:1] in (b"{", b"[")


METADATA_RESPONSE_CACHE = TtlByteCache(
    METADATA_CACHE_TTL_SECONDS,
    max_entries=METADATA_CACHE_MAX_ENTRIES,
    max_bytes=METADATA_CACHE_MAX_BYTES,
)
ARXIV_BIBTEX_CACHE = TtlByteCache(
    ARXIV_CACHE_TTL_SECONDS,
    max_entries=ARXIV_CACHE_MAX_ENTRIES,
    max_bytes=ARXIV_CACHE_MAX_BYTES,
)
PAGE_META_CACHE = TtlByteCache(
    ARXIV_CACHE_TTL_SECONDS,
    max_entries=ARXIV_CACHE_MAX_ENTRIES,
    max_bytes=ARXIV_CACHE_MAX_BYTES,
)


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


def read_limited_bytes(source: ReadableBytes, limit: int, label: str) -> bytes:
    body = source.read(limit + 1)
    if len(body) > limit:
        raise UpstreamError(f"{label} response is too large")
    return body


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
            return parse_json_object(read_limited_bytes(response, MAX_JSON_RESPONSE_BYTES, "vLLM"))
    except HTTPError as exc:
        raise UpstreamError(f"vLLM returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise UpstreamError(f"vLLM is unreachable: {exc.reason}") from exc
    except TimeoutError as exc:
        raise UpstreamError("vLLM request timed out") from exc


def get_json(url: str, timeout_seconds: float) -> JsonObject:
    try:
        with urlopen(url, timeout=timeout_seconds) as response:
            return parse_json_object(read_limited_bytes(response, MAX_JSON_RESPONSE_BYTES, "vLLM"))
    except HTTPError as exc:
        raise UpstreamError(f"vLLM returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise UpstreamError(f"vLLM is unreachable: {exc.reason}") from exc
    except TimeoutError as exc:
        raise UpstreamError("vLLM request timed out") from exc


def validate_proxy_path(path: str, allowed_prefixes: tuple[str, ...]) -> str:
    normalized = path.lstrip("/")
    decoded = unquote(normalized)
    if not normalized or ".." in decoded.split("/"):
        raise BadRequestError("proxy path is invalid")
    if not any(
        normalized == prefix.rstrip("/") or normalized.startswith(f"{prefix.rstrip('/')}/")
        for prefix in allowed_prefixes
    ):
        raise BadRequestError("proxy path is not allowed")
    return normalized


def upstream_headers(url: str) -> dict[str, str]:
    """Headers for a metadata upstream request.

    Semantic Scholar enforces tight anonymous rate limits; when the operator
    provides SEMANTIC_SCHOLAR_API_KEY the proxy attaches it, and only for
    api.semanticscholar.org so the key never leaks to other upstreams.
    """
    headers = {"User-Agent": USER_AGENT}
    if urlparse(url).netloc.lower() == "api.semanticscholar.org":
        api_key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "").strip()
        if api_key:
            headers["x-api-key"] = api_key
    return headers


def forwarded_headers(headers: object) -> dict[str, str]:
    """The upstream rate-limit headers the app paces itself by.

    Crossref announces its limits in X-Rate-Limit-Limit / X-Rate-Limit-Interval
    / X-Concurrency-Limit and asks clients to wait with Retry-After. A page on
    another origin cannot read them (Crossref's CORS exposes only Link), so the
    proxy passes them through to the same-origin app.
    """
    get = getattr(headers, "get", None)
    if get is None:
        return {}
    out: dict[str, str] = {}
    for name in FORWARDED_UPSTREAM_HEADERS:
        value = get(name)
        if isinstance(value, str) and value.strip():
            out[name] = value.strip()
    return out


def fetch_upstream(url: str, timeout_seconds: float) -> tuple[int, bytes, dict[str, str]]:
    request = Request(url, headers=upstream_headers(url))
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            body = read_limited_bytes(response, MAX_METADATA_RESPONSE_BYTES, "metadata upstream")
            return response.status, body, forwarded_headers(response.headers)
    except HTTPError as exc:
        body = read_limited_bytes(exc, MAX_METADATA_RESPONSE_BYTES, "metadata upstream")
        return exc.code, body, forwarded_headers(exc.headers)
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
            body = read_limited_bytes(response, MAX_ARXIV_BIBTEX_BYTES, "arXiv")
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


def is_page_url(value: str) -> bool:
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and (parsed.hostname or "").lower() in PAGE_HOSTS
        and parsed.port is None
        and not parsed.username
        and not parsed.password
    )


def parse_page_url(value: str | None) -> str:
    url = (value or "").strip()
    if len(url) > 512 or not is_page_url(url):
        raise BadRequestError("url must be an official proceedings page")
    return url


class _PageRedirects(HTTPRedirectHandler):
    """Follows a redirect only to another allowlisted proceedings page."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if not is_page_url(newurl):
            raise UpstreamError("the proceedings page redirected off its site")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_page_meta(url: str, timeout_seconds: float) -> JsonObject:
    """The page's <meta> tags: {"url": final URL, "meta": tags joined by newlines}."""
    cached = PAGE_META_CACHE.get(url)
    if cached is not None:
        return json.loads(cached[1].decode("utf-8"))
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with build_opener(_PageRedirects).open(request, timeout=timeout_seconds) as response:
            body = read_limited_bytes(response, MAX_PAGE_BYTES, "proceedings page")
            answer: JsonObject = {
                "url": response.geturl(),
                "meta": "\n".join(META_TAG_RE.findall(body.decode("utf-8", "replace"))),
            }
    except HTTPError as exc:
        raise UpstreamError(f"the proceedings page returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise UpstreamError(f"the proceedings page is unreachable: {exc.reason}") from exc
    except TimeoutError as exc:
        raise UpstreamError("the proceedings page timed out") from exc
    PAGE_META_CACHE.set(url, 200, json.dumps(answer).encode("utf-8"))
    return answer
