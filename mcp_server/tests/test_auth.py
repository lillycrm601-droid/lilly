from lcrm_mcp.auth import extract_bearer_token


def test_extracts_token():
    assert extract_bearer_token({"authorization": "Bearer lcrm_pat_abc"}) == "lcrm_pat_abc"


def test_scheme_is_case_insensitive():
    assert extract_bearer_token({"authorization": "bearer tok"}) == "tok"
    assert extract_bearer_token({"authorization": "BEARER tok"}) == "tok"


def test_strips_surrounding_and_inner_whitespace():
    assert extract_bearer_token({"authorization": "  Bearer   tok  "}) == "tok"


def test_accepts_capitalized_header_key():
    assert extract_bearer_token({"Authorization": "Bearer tok"}) == "tok"


def test_missing_header_returns_none():
    assert extract_bearer_token({}) is None
    assert extract_bearer_token(None) is None


def test_wrong_scheme_returns_none():
    assert extract_bearer_token({"authorization": "Basic abc"}) is None
    assert extract_bearer_token({"authorization": "Token abc"}) is None


def test_empty_token_returns_none():
    assert extract_bearer_token({"authorization": "Bearer "}) is None
    assert extract_bearer_token({"authorization": "Bearer"}) is None
