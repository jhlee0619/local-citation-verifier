#!/usr/bin/env python3

from __future__ import annotations

import sys
import unittest
from http.client import RemoteDisconnected
from pathlib import Path
from typing import NoReturn
from urllib.request import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "server"))

from vllm_proxy_server import (  # noqa: E402
    BadRequestError,
    CSP_POLICY,
    DBLP_ALLOWED_PREFIXES,
    DEFAULT_HOST,
    OPENREVIEW_ALLOWED_PREFIXES,
    X_FRAME_OPTIONS,
    RerankRequest,
    TtlByteCache,
    UpstreamError,
    canonical_cache_key,
    extract_chat_output,
    fetch_upstream,
    first_model_id,
    make_chat_payload,
    parse_arxiv_id,
    parse_rerank_request,
    validate_proxy_path,
)
import vllm_proxy_server  # noqa: E402
from server import proxy_core  # noqa: E402


class VllmProxyServerTests(unittest.TestCase):
    def test_canonical_cache_key_sorts_query_parameters(self) -> None:
        first = canonical_cache_key("https://api.example.test/path?b=2&a=1")
        second = canonical_cache_key("https://api.example.test/path?a=1&b=2")
        self.assertEqual(first, second)

    def test_ttl_byte_cache_reuses_value_until_expiration(self) -> None:
        now = 100.0
        cache = TtlByteCache(ttl_seconds=5.0, now=lambda: now)
        cache.set("key", 200, b"cached")
        self.assertEqual(cache.get("key"), (200, b"cached"))
        now = 106.0
        self.assertIsNone(cache.get("key"))

    def test_default_host_is_loopback_only(self) -> None:
        self.assertEqual(DEFAULT_HOST, "127.0.0.1")

    def test_csp_keeps_metadata_hosts_out_of_script_sources(self) -> None:
        directives = {
            tokens[0]: tokens[1:]
            for part in CSP_POLICY.split(";")
            if (tokens := part.split())
        }
        script_sources = directives["script-src"]
        connect_sources = directives["connect-src"]
        self.assertNotIn("https://dblp.org", script_sources)
        self.assertNotIn("https://openreview.net", script_sources)
        self.assertNotIn("https://dblp.org", connect_sources)
        self.assertNotIn("https://api.openreview.net", connect_sources)
        self.assertNotIn("https://openreview.net", connect_sources)

    def test_csp_allows_huggingface_xet_download_hosts(self) -> None:
        for host in (
            "https://huggingface.co",
            "https://*.huggingface.co",
            "https://*.hf.co",
            "https://cas-bridge.xethub.hf.co",
            "https://cas-server.xethub.hf.co",
            "https://transfer.xethub.hf.co",
        ):
            self.assertIn(host, CSP_POLICY)

    def test_proxy_frame_defense_is_header_only(self) -> None:
        index = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
        meta_csp = index.split('http-equiv="Content-Security-Policy"', 1)[1].split("/>", 1)[0]
        self.assertIn("frame-ancestors", CSP_POLICY)
        self.assertNotIn("frame-ancestors", meta_csp)
        self.assertEqual(X_FRAME_OPTIONS, "DENY")

    def test_parse_rerank_request_accepts_valid_payload(self) -> None:
        rerank = parse_rerank_request({"prompt": 'Return {"best": 1}', "candidate_count": 2})
        expected = RerankRequest(prompt='Return {"best": 1}', candidate_count=2, max_tokens=160)
        self.assertEqual(rerank, expected)

    def test_parse_rerank_request_rejects_missing_prompt(self) -> None:
        with self.assertRaises(BadRequestError) as raised:
            parse_rerank_request({"candidate_count": 2})
        self.assertIn("prompt", raised.exception.message)

    def test_make_chat_payload_uses_openai_chat_shape(self) -> None:
        payload = make_chat_payload(
            "local-model",
            RerankRequest(prompt="Pick one", candidate_count=3, max_tokens=160),
        )
        self.assertEqual(payload["model"], "local-model")
        self.assertEqual(payload["messages"], [{"role": "user", "content": "Pick one"}])
        self.assertEqual(payload["max_tokens"], 160)

    def test_make_chat_payload_uses_requested_token_budget(self) -> None:
        rerank = RerankRequest(prompt="Judge citation", candidate_count=1, max_tokens=220)
        payload = make_chat_payload("local-model", rerank)
        self.assertEqual(payload["max_tokens"], 220)

    def test_parse_rerank_request_accepts_token_budget(self) -> None:
        rerank = parse_rerank_request({"prompt": "Judge", "candidate_count": 1, "max_tokens": 220})
        self.assertEqual(rerank.max_tokens, 220)

    def test_extract_chat_output_reads_first_choice_message(self) -> None:
        output = extract_chat_output({"choices": [{"message": {"content": '{"best": 2}'}}]})
        self.assertEqual(output, '{"best": 2}')

    def test_first_model_id_reads_openai_models_shape(self) -> None:
        self.assertEqual(first_model_id({"data": [{"id": "gemma-local"}]}), "gemma-local")

    def test_parse_arxiv_id_accepts_plain_and_versioned_ids(self) -> None:
        self.assertEqual(parse_arxiv_id("2407.21783"), "2407.21783")
        self.assertEqual(parse_arxiv_id("2407.21783v3"), "2407.21783")

    def test_parse_arxiv_id_rejects_invalid_values(self) -> None:
        with self.assertRaises(BadRequestError) as raised:
            parse_arxiv_id("https://example.com/not-arxiv")
        self.assertIn("arXiv identifier", raised.exception.message)

    def test_fetch_upstream_wraps_closed_connections(self) -> None:
        original_urlopen = proxy_core.urlopen

        def closed_connection(_request: Request, timeout: float) -> NoReturn:
            raise RemoteDisconnected("closed")

        proxy_core.urlopen = closed_connection
        try:
            with self.assertRaises(UpstreamError) as raised:
                fetch_upstream("https://dblp.org/search/publ/api", timeout_seconds=1.0)
            self.assertIn("closed", raised.exception.message)
        finally:
            proxy_core.urlopen = original_urlopen

    def test_validate_proxy_path_accepts_dblp_publication_search(self) -> None:
        path = validate_proxy_path("search/publ/api", DBLP_ALLOWED_PREFIXES)
        self.assertEqual(path, "search/publ/api")

    def test_validate_proxy_path_accepts_openreview_search(self) -> None:
        path = validate_proxy_path("notes/search", OPENREVIEW_ALLOWED_PREFIXES)
        self.assertEqual(path, "notes/search")

    def test_validate_proxy_path_accepts_semanticscholar_routes(self) -> None:
        prefixes = ("graph/v1/paper/search", "graph/v1/paper/search/match", "graph/v1/paper/")
        self.assertEqual(validate_proxy_path("graph/v1/paper/search", prefixes), "graph/v1/paper/search")
        doi_path = "graph/v1/paper/DOI:10.1038/example"
        self.assertEqual(validate_proxy_path(doi_path, prefixes), doi_path)

    def test_validate_proxy_path_rejects_traversal_and_unknown_paths(self) -> None:
        for path in ("../works", "admin/status", ""):
            with self.subTest(path=path):
                with self.assertRaises(BadRequestError):
                    validate_proxy_path(path, ("works",))
