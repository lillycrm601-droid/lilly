import pytest

from lcrm_mcp.auth import AuthError
from lcrm_mcp.config import Settings
from lcrm_mcp.server import ClientResolver


def _http_settings():
    return Settings(base_url="https://crm.example.com", token=None, transport="http")


def _stdio_settings():
    return Settings(
        base_url="https://crm.example.com", token="lcrm_pat_srv", transport="stdio"
    )


def _boom():
    raise AssertionError("settings_loader should not be called")


def test_injected_client_wins_without_loading_settings():
    sentinel = object()
    r = ClientResolver(injected=sentinel, settings_loader=_boom)
    assert r.get() is sentinel


def test_http_builds_client_from_request_token():
    r = ClientResolver(
        settings_loader=_http_settings,
        headers_getter=lambda: {"authorization": "Bearer tok_a"},
    )
    c = r.get()
    assert c._base == "https://crm.example.com"
    assert c._headers["Authorization"] == "Bearer tok_a"


def test_http_is_per_request_and_never_cached():
    # The caller's token changes between requests; each resolved client must
    # carry the CURRENT caller's token. Equal-or-cached would be a tenant leak.
    box = {"tok": "tok_a"}
    r = ClientResolver(
        settings_loader=_http_settings,
        headers_getter=lambda: {"authorization": f"Bearer {box['tok']}"},
    )
    first = r.get()
    box["tok"] = "tok_b"
    second = r.get()
    assert first is not second
    assert first._headers["Authorization"] == "Bearer tok_a"
    assert second._headers["Authorization"] == "Bearer tok_b"


def test_http_missing_token_raises_autherror():
    r = ClientResolver(settings_loader=_http_settings, headers_getter=lambda: {})
    with pytest.raises(AuthError):
        r.get()


def test_http_wrong_scheme_raises_autherror():
    r = ClientResolver(
        settings_loader=_http_settings,
        headers_getter=lambda: {"authorization": "Basic abc"},
    )
    with pytest.raises(AuthError):
        r.get()


def test_stdio_builds_once_and_reuses():
    calls = {"n": 0}

    def loader():
        calls["n"] += 1
        return _stdio_settings()

    r = ClientResolver(settings_loader=loader)
    a = r.get()
    b = r.get()
    assert a is b  # shared client, cached
    assert a._headers["Authorization"] == "Bearer lcrm_pat_srv"
    assert calls["n"] == 1  # settings loaded exactly once


def test_build_http_app_returns_mountable_asgi_app_with_lifespan():
    # The object the Django mount uses. Must not require env vars, and must
    # expose a lifespan (propagating it is the documented mount requirement).
    from lcrm_mcp.server import build_http_app

    app = build_http_app("https://crm.example.com", path="/")
    assert app.lifespan is not None
