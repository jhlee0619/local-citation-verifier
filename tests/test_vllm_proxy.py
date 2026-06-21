#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from vllm_proxy_server import (  # noqa: E402
    BadRequestError,
    RerankRequest,
    extract_chat_output,
    first_model_id,
    make_chat_payload,
    parse_arxiv_id,
    parse_rerank_request,
)


def test_parse_rerank_request_accepts_valid_payload() -> None:
    rerank = parse_rerank_request({"prompt": "Return {\"best\": 1}", "candidate_count": 2})
    assert rerank == RerankRequest(prompt="Return {\"best\": 1}", candidate_count=2)


def test_parse_rerank_request_rejects_missing_prompt() -> None:
    try:
        parse_rerank_request({"candidate_count": 2})
    except BadRequestError as exc:
        assert "prompt" in exc.message
    else:
        raise AssertionError("expected BadRequestError")


def test_make_chat_payload_uses_openai_chat_shape() -> None:
    payload = make_chat_payload("local-model", RerankRequest(prompt="Pick one", candidate_count=3))
    assert payload["model"] == "local-model"
    assert payload["messages"] == [{"role": "user", "content": "Pick one"}]
    assert payload["max_tokens"] == 160


def test_extract_chat_output_reads_first_choice_message() -> None:
    output = extract_chat_output({"choices": [{"message": {"content": "{\"best\": 2}"}}]})
    assert output == "{\"best\": 2}"


def test_first_model_id_reads_openai_models_shape() -> None:
    assert first_model_id({"data": [{"id": "gemma-local"}]}) == "gemma-local"


def test_parse_arxiv_id_accepts_plain_and_versioned_ids() -> None:
    assert parse_arxiv_id("2407.21783") == "2407.21783"
    assert parse_arxiv_id("2407.21783v3") == "2407.21783"


def test_parse_arxiv_id_rejects_invalid_values() -> None:
    try:
        parse_arxiv_id("https://example.com/not-arxiv")
    except BadRequestError as exc:
        assert "arXiv identifier" in exc.message
    else:
        raise AssertionError("expected BadRequestError")


if __name__ == "__main__":
    test_parse_rerank_request_accepts_valid_payload()
    test_parse_rerank_request_rejects_missing_prompt()
    test_make_chat_payload_uses_openai_chat_shape()
    test_extract_chat_output_reads_first_choice_message()
    test_first_model_id_reads_openai_models_shape()
    test_parse_arxiv_id_accepts_plain_and_versioned_ids()
    test_parse_arxiv_id_rejects_invalid_values()
    print("vllm proxy tests passed")
