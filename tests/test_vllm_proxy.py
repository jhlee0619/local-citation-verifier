#!/usr/bin/env python3

from __future__ import annotations

import sys
from http.client import RemoteDisconnected
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from vllm_proxy_server import (  # noqa: E402
    BadRequestError,
    DEFAULT_HOST,
    DBLP_ALLOWED_PREFIXES,
    OPENREVIEW_ALLOWED_PREFIXES,
    CSP_POLICY,
    RerankRequest,
    X_FRAME_OPTIONS,
    extract_chat_output,
    first_model_id,
    make_chat_payload,
    parse_arxiv_id,
    parse_rerank_request,
    TtlByteCache,
    canonical_cache_key,
    validate_proxy_path,
    fetch_upstream,
)
import vllm_proxy_server


def test_canonical_cache_key_sorts_query_parameters() -> None:
    first = canonical_cache_key("https://api.example.test/path?b=2&a=1")
    second = canonical_cache_key("https://api.example.test/path?a=1&b=2")

    assert first == second


def test_ttl_byte_cache_reuses_value_until_expiration() -> None:
    now = 100.0
    cache = TtlByteCache(ttl_seconds=5.0, now=lambda: now)

    cache.set("key", 200, b"cached")
    assert cache.get("key") == (200, b"cached")
    now = 106.0
    assert cache.get("key") is None


def test_default_host_is_loopback_only() -> None:
    assert DEFAULT_HOST == "127.0.0.1"


def test_csp_allows_dblp_and_openreview_for_local_metadata() -> None:
    assert "https://dblp.org" in CSP_POLICY
    assert "https://api.openreview.net" in CSP_POLICY
    assert "https://openreview.net" in CSP_POLICY


def test_csp_allows_huggingface_xet_download_hosts() -> None:
    assert "https://huggingface.co" in CSP_POLICY
    assert "https://*.huggingface.co" in CSP_POLICY
    assert "https://*.hf.co" in CSP_POLICY
    assert "https://cas-bridge.xethub.hf.co" in CSP_POLICY
    assert "https://cas-server.xethub.hf.co" in CSP_POLICY
    assert "https://transfer.xethub.hf.co" in CSP_POLICY


def test_proxy_frame_defense_is_header_only() -> None:
    index = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    meta_csp = index.split('http-equiv="Content-Security-Policy"', 1)[1].split("/>", 1)[0]

    assert "frame-ancestors" in CSP_POLICY
    assert "frame-ancestors" not in meta_csp
    assert X_FRAME_OPTIONS == "DENY"


def test_parse_rerank_request_accepts_valid_payload() -> None:
    rerank = parse_rerank_request({"prompt": "Return {\"best\": 1}", "candidate_count": 2})
    assert rerank == RerankRequest(prompt="Return {\"best\": 1}", candidate_count=2, max_tokens=160)


def test_parse_rerank_request_rejects_missing_prompt() -> None:
    try:
        parse_rerank_request({"candidate_count": 2})
    except BadRequestError as exc:
        assert "prompt" in exc.message
    else:
        raise AssertionError("expected BadRequestError")


def test_make_chat_payload_uses_openai_chat_shape() -> None:
    payload = make_chat_payload("local-model", RerankRequest(prompt="Pick one", candidate_count=3, max_tokens=160))
    assert payload["model"] == "local-model"
    assert payload["messages"] == [{"role": "user", "content": "Pick one"}]
    assert payload["max_tokens"] == 160



def test_make_chat_payload_uses_requested_token_budget() -> None:
    rerank = RerankRequest(prompt="Judge citation", candidate_count=1, max_tokens=220)
    payload = make_chat_payload("local-model", rerank)

    assert payload["max_tokens"] == 220


def test_parse_rerank_request_accepts_token_budget() -> None:
    rerank = parse_rerank_request({"prompt": "Judge", "candidate_count": 1, "max_tokens": 220})

    assert rerank.max_tokens == 220

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


def test_fetch_upstream_wraps_closed_connections() -> None:
    original_urlopen = vllm_proxy_server.urlopen

    def closed_connection(_request: object, timeout: float) -> object:
        raise RemoteDisconnected("closed")

    vllm_proxy_server.urlopen = closed_connection
    try:
        try:
            fetch_upstream("https://dblp.org/search/publ/api", timeout_seconds=1.0)
        except Exception as exc:
            assert exc.__class__.__name__ == "UpstreamError"
            assert "closed" in exc.message
        else:
            raise AssertionError("expected UpstreamError")
    finally:
        vllm_proxy_server.urlopen = original_urlopen


def test_validate_proxy_path_accepts_dblp_publication_search() -> None:
    assert validate_proxy_path("search/publ/api", DBLP_ALLOWED_PREFIXES) == "search/publ/api"


def test_validate_proxy_path_accepts_openreview_search() -> None:
    assert validate_proxy_path("notes/search", OPENREVIEW_ALLOWED_PREFIXES) == "notes/search"


def test_validate_proxy_path_accepts_semanticscholar_routes() -> None:
    assert validate_proxy_path(
        "graph/v1/paper/search",
        ("graph/v1/paper/search", "graph/v1/paper/search/match", "graph/v1/paper/"),
    ) == "graph/v1/paper/search"
    assert validate_proxy_path(
        "graph/v1/paper/DOI:10.1038/example",
        ("graph/v1/paper/search", "graph/v1/paper/search/match", "graph/v1/paper/"),
    ) == "graph/v1/paper/DOI:10.1038/example"


def test_validate_proxy_path_rejects_traversal_and_unknown_paths() -> None:
    for path in ("../works", "admin/status", ""):
        try:
            validate_proxy_path(path, ("works",))
        except BadRequestError:
            continue
        raise AssertionError(f"expected BadRequestError for {path!r}")


if __name__ == "__main__":
    test_canonical_cache_key_sorts_query_parameters()
    test_ttl_byte_cache_reuses_value_until_expiration()
    test_default_host_is_loopback_only()
    test_parse_rerank_request_accepts_valid_payload()
    test_parse_rerank_request_rejects_missing_prompt()
    test_make_chat_payload_uses_openai_chat_shape()
    test_make_chat_payload_uses_requested_token_budget()
    test_parse_rerank_request_accepts_token_budget()
    test_extract_chat_output_reads_first_choice_message()
    test_first_model_id_reads_openai_models_shape()
    test_parse_arxiv_id_accepts_plain_and_versioned_ids()
    test_parse_arxiv_id_rejects_invalid_values()
    test_validate_proxy_path_accepts_semanticscholar_routes()
    test_validate_proxy_path_rejects_traversal_and_unknown_paths()
    print("vllm proxy tests passed")
