#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# ///
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final, TypeAlias
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

DEFAULT_HOST: Final = "0.0.0.0"
DEFAULT_PORT: Final = 8088
DEFAULT_VLLM_BASE_URL: Final = "http://127.0.0.1:8000"
MAX_BODY_BYTES: Final = 64 * 1024
MAX_PROMPT_CHARS: Final = 24_000
MAX_CANDIDATES: Final = 50


@dataclass(frozen=True, slots=True)
class RerankRequest:
    prompt: str
    candidate_count: int


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
    if not isinstance(prompt, str) or not prompt.strip():
        raise BadRequestError("prompt must be a non-empty string")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise BadRequestError("prompt is too large")
    if not isinstance(candidate_count, int):
        raise BadRequestError("candidate_count must be an integer")
    if candidate_count < 1 or candidate_count > MAX_CANDIDATES:
        raise BadRequestError("candidate_count is out of range")
    return RerankRequest(prompt=prompt, candidate_count=candidate_count)


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
        "max_tokens": 24,
    }


class CitationRequestHandler(SimpleHTTPRequestHandler):
    config: AppConfig

    def __init__(self, *args: object, **kwargs: object) -> None:  # noqa: OBJECT_OK
        super().__init__(*args, directory=str(self.config.docs_dir), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/rerank/vllm/health":
            self.handle_health()
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
