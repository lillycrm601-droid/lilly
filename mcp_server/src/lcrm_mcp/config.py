import os
from dataclasses import dataclass

STDIO = "stdio"
HTTP = "http"
_VALID_TRANSPORTS = (STDIO, HTTP)


@dataclass
class Settings:
    base_url: str
    token: str | None = None
    transport: str = STDIO
    host: str = "127.0.0.1"
    port: int = 8900
    path: str = "/mcp"

    @classmethod
    def from_env(cls):
        base = os.environ.get("LCRM_BASE_URL", "").rstrip("/")
        if not base:
            raise SystemExit("LCRM_BASE_URL env var is required")

        transport = os.environ.get("LCRM_TRANSPORT", STDIO).strip().lower()
        if transport not in _VALID_TRANSPORTS:
            raise SystemExit(
                f"LCRM_TRANSPORT must be one of {_VALID_TRANSPORTS}, got '{transport}'"
            )

        token = os.environ.get("LCRM_TOKEN") or None
        # stdio: the whole process acts as ONE user, so a server-side token is
        # required. http: the token arrives per-request in each caller's
        # Authorization header, so a server-side LCRM_TOKEN is not only
        # unnecessary but a footgun (it would make every caller share one
        # identity and bypass tenant isolation) — reject it outright.
        if transport == STDIO and not token:
            raise SystemExit("LCRM_TOKEN env var is required for stdio transport")
        if transport == HTTP and token:
            raise SystemExit(
                "LCRM_TOKEN must NOT be set with http transport: each request "
                "authenticates with its own Authorization header. Unset LCRM_TOKEN."
            )

        host = os.environ.get("LCRM_HOST", "127.0.0.1")
        raw_port = os.environ.get("LCRM_PORT", "8900")
        try:
            port = int(raw_port)
        except ValueError:
            raise SystemExit(f"LCRM_PORT must be an integer, got '{raw_port}'")
        path = os.environ.get("LCRM_PATH", "/mcp")

        return cls(
            base_url=base,
            token=token,
            transport=transport,
            host=host,
            port=port,
            path=path,
        )
