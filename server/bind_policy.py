from __future__ import annotations

from dataclasses import dataclass
from typing import Final

LOOPBACK_HOSTS: Final = frozenset({"127.0.0.1", "::1", "localhost"})
REMOTE_WARNING: Final = (
    "WARNING: remote bind exposes the static app, metadata proxy, and rerank API. "
    "ALLOW_REMOTE=1 supplies neither authentication nor TLS; use an authenticated "
    "HTTPS reverse proxy and firewall allowlist."
)


@dataclass(frozen=True, slots=True)
class BindDecision:
    host: str
    remote: bool
    warning: str | None


@dataclass(frozen=True, slots=True)
class RemoteBindDeniedError(RuntimeError):
    host: str

    def __str__(self) -> str:
        return (
            f"Refusing non-loopback HOST={self.host!r}. "
            "Set ALLOW_REMOTE=1 exactly to acknowledge unauthenticated, non-TLS exposure."
        )


def enforce_bind_policy(host: str, allow_remote: str | None) -> BindDecision:
    """Parse bind configuration into an allowed local or explicit remote decision."""
    if host.casefold() in LOOPBACK_HOSTS:
        return BindDecision(host=host, remote=False, warning=None)
    if allow_remote != "1":
        raise RemoteBindDeniedError(host=host)
    return BindDecision(host=host, remote=True, warning=REMOTE_WARNING)
