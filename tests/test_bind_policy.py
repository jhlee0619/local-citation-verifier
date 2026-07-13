#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import io
import os
import socket
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

import vllm_proxy_server  # noqa: E402


class BindPolicyTests(unittest.TestCase):
    def test_loopback_hosts_are_allowed_without_remote_opt_in(self) -> None:
        for host in ("127.0.0.1", "::1", "localhost"):
            with self.subTest(host=host):
                decision = vllm_proxy_server.enforce_bind_policy(host, None)
                self.assertFalse(decision.remote)
                self.assertIsNone(decision.warning)

    def test_remote_hosts_require_exact_opt_in(self) -> None:
        for host in ("0.0.0.0", "::", "192.168.1.20", "proxy.example.test"):
            for allow_remote in (None, "", "true", "TRUE", "yes", "01", "1 "):
                with self.subTest(host=host, allow_remote=allow_remote):
                    with self.assertRaises(vllm_proxy_server.RemoteBindDeniedError):
                        vllm_proxy_server.enforce_bind_policy(host, allow_remote)

    def test_exact_remote_opt_in_returns_exposure_warning(self) -> None:
        decision = vllm_proxy_server.enforce_bind_policy("192.168.1.20", "1")
        self.assertTrue(decision.remote)
        self.assertIn("static app", decision.warning or "")
        self.assertIn("metadata proxy", decision.warning or "")
        self.assertIn("rerank API", decision.warning or "")
        self.assertIn("authentication", decision.warning or "")
        self.assertIn("TLS", decision.warning or "")

    def test_main_rejects_remote_host_before_server_construction(self) -> None:
        stderr = io.StringIO()
        environment = {"HOST": "192.168.1.20"}
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(vllm_proxy_server, "ThreadingHTTPServer") as server_class,
            contextlib.redirect_stderr(stderr),
        ):
            exit_code = vllm_proxy_server.main()
        self.assertEqual(exit_code, 2)
        server_class.assert_not_called()
        self.assertIn("ALLOW_REMOTE=1", stderr.getvalue())

    def test_main_constructs_server_for_each_loopback_spelling(self) -> None:
        for host in ("127.0.0.1", "::1", "localhost"):
            with self.subTest(host=host):
                with (
                    patch.dict(os.environ, {"HOST": host, "PORT": "0"}, clear=True),
                    patch.object(vllm_proxy_server, "ThreadingHTTPServer") as ipv4_server,
                    patch.object(vllm_proxy_server, "ThreadingHTTPServerV6") as ipv6_server,
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    exit_code = vllm_proxy_server.main()
                self.assertEqual(exit_code, 0)
                expected_server = ipv6_server if ":" in host else ipv4_server
                expected_server.assert_called_once()

    def test_ipv6_server_class_binds_ipv6_loopback(self) -> None:
        self.assertTrue(socket.has_ipv6)
        vllm_proxy_server.CitationRequestHandler.config = vllm_proxy_server.build_config()
        with vllm_proxy_server.ThreadingHTTPServerV6(
            ("::1", 0),
            vllm_proxy_server.CitationRequestHandler,
        ) as server:
            self.assertEqual(server.server_address[0], "::1")

    def test_main_warns_when_remote_bind_is_explicitly_allowed(self) -> None:
        stderr = io.StringIO()
        stdout = io.StringIO()
        environment = {"HOST": "192.168.1.20", "PORT": "0", "ALLOW_REMOTE": "1"}
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(vllm_proxy_server, "ThreadingHTTPServer") as server_class,
            contextlib.redirect_stderr(stderr),
            contextlib.redirect_stdout(stdout),
        ):
            exit_code = vllm_proxy_server.main()
        self.assertEqual(exit_code, 0)
        server_class.assert_called_once()
        self.assertIn("authentication", stderr.getvalue())
        self.assertIn("TLS", stderr.getvalue())

    def test_entrypoint_rejects_remote_host_with_actionable_stderr(self) -> None:
        environment = os.environ.copy()
        environment.pop("ALLOW_REMOTE", None)
        environment.update({"HOST": "192.168.1.20", "PORT": "0"})
        completed = subprocess.run(
            [sys.executable, str(ROOT / "server" / "vllm_proxy_server.py")],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
            env=environment,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("ALLOW_REMOTE=1", completed.stderr)
        self.assertNotIn("Serving ", completed.stdout)

    def test_package_entrypoint_imports_before_remote_policy_rejection(self) -> None:
        environment = os.environ.copy()
        environment.pop("ALLOW_REMOTE", None)
        environment.update({"HOST": "192.168.1.20", "PORT": "0"})
        completed = subprocess.run(
            [sys.executable, "-m", "server.vllm_proxy_server"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
            env=environment,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("ALLOW_REMOTE=1", completed.stderr)
        self.assertNotIn("ModuleNotFoundError", completed.stderr)

    def test_readme_matches_loopback_and_remote_exposure_policy(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("defaults to `127.0.0.1`", readme)
        self.assertNotIn("defaults to `0.0.0.0`", readme)
        self.assertIn("ALLOW_REMOTE=1", readme)
        self.assertIn("SSH tunnel", readme)
        self.assertIn("authentication nor TLS", readme)


if __name__ == "__main__":
    unittest.main()
