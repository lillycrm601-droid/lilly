import pytest
from lcrm_mcp import tools


class FakeClient:
    def __init__(self): self.calls = []
    async def get(self, path, params=None): self.calls.append(("GET", path, params)); return {"results":[{"id":"1"}]}
    async def post(self, path, json): self.calls.append(("POST", path, json)); return {"id":"1"}
    async def patch(self, path, json): self.calls.append(("PATCH", path, json)); return {"id":"1"}
    async def delete(self, path): self.calls.append(("DELETE", path)); return {}


@pytest.mark.asyncio
async def test_search_caps_limit():
    c = FakeClient()
    await tools.crm_search(c, "leads", limit=999)
    _, _, params = c.calls[0]
    assert params["limit"] <= 50

@pytest.mark.asyncio
async def test_search_passes_query_as_search_param():
    c = FakeClient()
    await tools.crm_search(c, "leads", query="acme")
    assert c.calls[0][2]["search"] == "acme"

@pytest.mark.asyncio
async def test_get_builds_detail_path():
    c = FakeClient()
    await tools.crm_get(c, "leads", "1")
    assert c.calls[0] == ("GET", "/api/leads/1/", None)

@pytest.mark.asyncio
async def test_delete_requires_confirm():
    c = FakeClient()
    with pytest.raises(ValueError, match="confirm"):
        await tools.crm_delete(c, "leads", "1", confirm=False)
    assert c.calls == []  # nothing sent

@pytest.mark.asyncio
async def test_delete_with_confirm_sends_delete():
    c = FakeClient()
    await tools.crm_delete(c, "leads", "1", confirm=True)
    assert c.calls[0] == ("DELETE", "/api/leads/1/")

@pytest.mark.asyncio
async def test_unknown_entity_rejected():
    c = FakeClient()
    with pytest.raises(Exception):
        await tools.crm_get(c, "dragons", "1")

@pytest.mark.asyncio
async def test_action_rejects_disallowed_action():
    c = FakeClient()
    with pytest.raises(ValueError):
        await tools.crm_action(c, "tasks", "1", "convert")  # tasks has no actions

@pytest.mark.asyncio
async def test_action_allowed_posts_to_action_path():
    c = FakeClient()
    await tools.crm_action(c, "leads", "1", "convert", {"x": 1})
    assert c.calls[0] == ("POST", "/api/leads/1/convert/", {"x": 1})

@pytest.mark.asyncio
async def test_outward_facing_action_requires_confirm():
    c = FakeClient()
    with pytest.raises(ValueError, match="confirm"):
        await tools.crm_action(c, "invoices", "1", "send")
    assert c.calls == []  # nothing sent without confirm

@pytest.mark.asyncio
async def test_outward_facing_action_with_confirm_posts():
    c = FakeClient()
    await tools.crm_action(c, "invoices", "1", "send", confirm=True)
    assert c.calls[0] == ("POST", "/api/invoices/1/send/", {})

@pytest.mark.asyncio
async def test_non_outward_action_does_not_require_confirm():
    c = FakeClient()
    await tools.crm_action(c, "leads", "1", "add_comment", {"comment": "hi"})
    assert c.calls[0] == ("POST", "/api/leads/1/add_comment/", {"comment": "hi"})

@pytest.mark.asyncio
async def test_list_actions_returns_map():
    m = tools.list_actions()
    assert m["leads"] == ["convert", "add_comment"]


def test_describe_extracts_fields():
    schema = {
        "components": {"schemas": {
            "Lead": {
                "type": "object",
                "required": ["title"],
                "properties": {
                    "title": {"type": "string"},
                    "status": {"type": "string", "enum": ["new", "won", "lost"]},
                },
            }
        }}
    }
    out = tools._extract_entity_fields(schema, "leads")
    assert out["title"]["required"] is True
    assert out["status"]["enum"] == ["new", "won", "lost"]

def test_describe_unknown_component_returns_empty():
    assert tools._extract_entity_fields({"components": {"schemas": {}}}, "leads") == {}
