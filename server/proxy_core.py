from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from http.client import RemoteDisconnected
from pathlib import Path
from threading import RLock
from typing import Callable, Final, TypeAlias
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

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
