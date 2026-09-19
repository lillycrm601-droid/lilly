import pytest
from lcrm_mcp.entities import ENTITIES, resolve_path, EntityError


def test_known_entity_resolves_list_path():
    assert resolve_path("leads") == "/api/leads/"

def test_known_entity_resolves_detail_path():
    assert resolve_path("leads", "123") == "/api/leads/123/"

def test_unknown_entity_raises():
    with pytest.raises(EntityError):
        resolve_path("dragons")
