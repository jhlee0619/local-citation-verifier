"""Run the app from this checkout, optionally with an operator's vLLM server.

The static app and the metadata/rerank proxy run locally from this folder.
When an SSH host alias is configured, vLLM inference is reached through an
SSH tunnel:

    browser -> 127.0.0.1:18088 (server/vllm_proxy_server.py, this folder)
            -> 127.0.0.1:18000 (ssh -N <alias>, LocalForward)
            -> server 127.0.0.1:8000 (vllm serve <model>)

The alias comes from LCV_SSH_HOST, else from the first line of the ignored
file local/ssh-host.txt; without one, no tunnel is opened and the AI judge is
simply unavailable. The alias must forward the tunnel port, e.g. in
~/.ssh/config:

    Host <alias>
        HostName <server>
        User <user>
        ExitOnForwardFailure yes
        LocalForward 18000 127.0.0.1:8000

Usage: python scripts/run_local.py [--no-browser]
Env overrides: LCV_SSH_HOST, LCV_TUNNEL_PORT, PORT, SEMANTIC_SCHOLAR_API_KEY.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener, urlopen

REPO = Path(__file__).resolve().parents[1]
def configured_ssh_host() -> str:
    """LCV_SSH_HOST, else the first line of local/ssh-host.txt, else ""."""
    host = os.environ.get("LCV_SSH_HOST", "").strip()
    if host:
        return host
    try:
        lines = (REPO / "local" / "ssh-host.txt").read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    return lines[0].strip() if lines else ""


SSH_HOST = configured_ssh_host()
TUNNEL_PORT = int(os.environ.get("LCV_TUNNEL_PORT", "18000"))
APP_PORT = int(os.environ.get("PORT", "18088"))
# What server/vllm_proxy_server.py answers at GET /api/health.
APP_SIGNATURE = {"app": "local-citation-verifier", "ok": True}


def port_open(port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def is_this_app(port: int, timeout: float = 2.0) -> bool:
    """Whether 127.0.0.1:<port> is this app: GET /api/health answers APP_SIGNATURE."""
    try:
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as resp:
            body = json.load(resp)
    except (URLError, OSError, ValueError):
        return False
    return isinstance(body, dict) and all(body.get(key) == value for key, value in APP_SIGNATURE.items())


def wait_for_port(port: int, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if port_open(port):
            return True
        time.sleep(0.3)
    return False


def ensure_tunnel() -> subprocess.Popen | None:
    """Reuse an existing tunnel, or open one and return its process."""
    if not SSH_HOST:
        print("[tunnel] no SSH host configured (LCV_SSH_HOST or local/ssh-host.txt); AI judge unavailable")
        return None
    if port_open(TUNNEL_PORT):
        print(f"[tunnel] 127.0.0.1:{TUNNEL_PORT} already open, reusing it")
        return None
    print(f"[tunnel] opening ssh -N {SSH_HOST} ...")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    proc = subprocess.Popen(["ssh", "-N", "-o", "BatchMode=yes", SSH_HOST], creationflags=flags)
    if not wait_for_port(TUNNEL_PORT, 15):
        proc.terminate()
        print(f"[tunnel] could not open 127.0.0.1:{TUNNEL_PORT}; reranking falls back to heuristics")
        return None
    print(f"[tunnel] 127.0.0.1:{TUNNEL_PORT} -> {SSH_HOST}:8000")
    return proc


def vllm_models() -> list[str]:
    try:
        with urlopen(f"http://127.0.0.1:{TUNNEL_PORT}/v1/models", timeout=5) as resp:
            return [m["id"] for m in json.load(resp).get("data", [])]
    except (URLError, OSError, ValueError, KeyError):
        return []


def main() -> int:
    url = f"http://127.0.0.1:{APP_PORT}/"
    if port_open(APP_PORT):
        if not is_this_app(APP_PORT):
            print(
                f"[app] port {APP_PORT} is already in use by another program: {url}api/health did not answer "
                "as local-citation-verifier. Stop that program or set PORT to a free port, then run again.",
                file=sys.stderr,
            )
            return 1
        print(f"[app] local-citation-verifier is already serving {url}; opening it")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return 0

    tunnel = ensure_tunnel()
    models = vllm_models()
    print(f"[vllm] models: {', '.join(models) if models else 'unavailable'}")

    env = dict(os.environ, HOST="127.0.0.1", PORT=str(APP_PORT), VLLM_BASE_URL=f"http://127.0.0.1:{TUNNEL_PORT}")
    app = subprocess.Popen([sys.executable, str(REPO / "server" / "vllm_proxy_server.py")], cwd=REPO, env=env)
    try:
        if wait_for_port(APP_PORT, 15):
            print(f"[app] serving {REPO / 'docs'} at {url}  (Ctrl+C to stop)")
            if "--no-browser" not in sys.argv:
                webbrowser.open(url)
        return app.wait()
    except KeyboardInterrupt:
        return 0
    finally:
        if app.poll() is None:
            app.terminate()
        if tunnel is not None and tunnel.poll() is None:
            tunnel.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
