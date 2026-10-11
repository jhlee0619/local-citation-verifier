from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

LOOPBACK_HOSTS: Final = frozenset({"127.0.0.1", "::1", "localhost"})
REMOTE_WARNING: Final = (
    "WARNING: remote bind exposes the static app, metadata proxy, and rerank API. "
    "ALLOW_REMOTE=1 supplies neither authentication nor TLS; use an authenticated "
    "HTTPS reverse proxy and firewall allowlist."
)
# The Host header values every server accepts, with its port (DNS-rebinding
# defence: a page on an attacker's domain that resolves to this machine still
# sends its own domain as Host and is refused).
LOOPBACK_HOST_NAMES: Final = ("127.0.0.1", "localhost", "[::1]")
ALLOWED_HOSTS_WARNING: Final = (
    "WARNING: ALLOW_REMOTE=1 without ALLOWED_HOSTS accepts only the Host {bind} and the "
    "loopback names. List every LAN name or address clients use in ALLOWED_HOSTS "
    "(comma-separated host or host:port); other Host values get 403."
)
ALLOWED_HOSTS_IGNORED_WARNING: Final = (
    "WARNING: ALLOWED_HOSTS is ignored without ALLOW_REMOTE=1; only loopback Host names are accepted."
)
HOST_ENTRY_PATTERN: Final = re.compile(r"(?P<host>\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(?P<port>\d{1,5}))?")


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


@dataclass(frozen=True, slots=True)
class InvalidAllowedHostsError(ValueError):
    entry: str

    def __str__(self) -> str:
        return (
            f"Invalid ALLOWED_HOSTS entry {self.entry!r}: "
            "use host or host:port, comma-separated, without a scheme or path."
        )


def enforce_bind_policy(host: str, allow_remote: str | None) -> BindDecision:
    """Parse bind configuration into an allowed local or explicit remote decision."""
    if host.casefold() in LOOPBACK_HOSTS:
        return BindDecision(host=host, remote=False, warning=None)
    if allow_remote != "1":
        raise RemoteBindDeniedError(host=host)
    return BindDecision(host=host, remote=True, warning=REMOTE_WARNING)


def host_literal(host: str) -> str:
    """A host as a Host header writes it: lower-case, IPv6 addresses in brackets."""
    value = host.strip().lower()
    return f"[{value}]" if ":" in value and not value.startswith("[") else value


def parse_allowed_hosts(value: str | None) -> tuple[str, ...]:
    """ALLOWED_HOSTS ("host" or "host:port", comma-separated) as normalised entries."""
    entries: list[str] = []
    for raw in (value or "").split(","):
        entry = raw.strip().lower()
        if not entry:
            continue
        if entry.count(":") > 1 and not entry.startswith("["):
            entry = f"[{entry}]"
        if not HOST_ENTRY_PATTERN.fullmatch(entry):
            raise InvalidAllowedHostsError(entry=raw.strip())
        entries.append(entry)
    return tuple(entries)


@dataclass(frozen=True, slots=True)
class HostPolicy:
    """The Host header values the server answers; every other request gets 403.

    The loopback names are allowed with the bound port, and without a port only
    on port 80. An `extra` entry (ALLOWED_HOSTS) with a port matches exactly; a
    bare name matches with the bound port and without a port, as a reverse
    proxy forwards it. `bind` is the remote bind HOST, allowed with the bound
    port when ALLOW_REMOTE=1 lists no ALLOWED_HOSTS.
    """

    extra: tuple[str, ...] = ()
    bind: str | None = None

    def allowed(self, port: int) -> frozenset[str]:
        names = LOOPBACK_HOST_NAMES + ((host_literal(self.bind),) if self.bind else ())
        values = {f"{name}:{port}" for name in names}
        if port == 80:
            values.update(names)
        for entry in self.extra:
            values.add(entry)
            match = HOST_ENTRY_PATTERN.fullmatch(entry)
            if match is not None and match.group("port") is None:
                values.add(f"{entry}:{port}")
        return frozenset(values)

    def allows(self, host_header: str | None, port: int) -> bool:
        return (host_header or "").strip().lower() in self.allowed(port)


def build_host_policy(bind: BindDecision, allowed_hosts: str | None, port: int) -> tuple[HostPolicy, str | None]:
    """The Host allowlist for a bind decision and ALLOWED_HOSTS, plus a startup warning (or None)."""
    entries = parse_allowed_hosts(allowed_hosts)
    if not bind.remote:
        return HostPolicy(), ALLOWED_HOSTS_IGNORED_WARNING if entries else None
    if entries:
        return HostPolicy(extra=entries), None
    return HostPolicy(bind=bind.host), ALLOWED_HOSTS_WARNING.format(bind=f"{host_literal(bind.host)}:{port}")


def same_origin(origin: str | None, host_header: str | None) -> bool:
    """Whether a request's Origin is this server as the browser addressed it.

    The Origin must be http:// or https:// plus the request's own Host: the
    server speaks plain HTTP, and https:// is a TLS reverse proxy in front of
    it. A missing Origin, "null" or any other origin fails.
    """
    host = (host_header or "").strip().lower()
    value = (origin or "").strip().lower()
    return bool(host) and value in (f"http://{host}", f"https://{host}")
