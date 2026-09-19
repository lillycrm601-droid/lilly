from lcrm_mcp.server import build_server

EXPECTED = {
    "crm_search",
    "crm_get",
    "crm_create",
    "crm_update",
    "crm_delete",
    "crm_action",
    "crm_describe",
    "list_actions",
}


async def _registered_tool_names(mcp):
    tools = await mcp.list_tools()
    return {t.name for t in tools}


async def test_all_tools_registered():
    # client injected so registration needs no env vars
    mcp = build_server(client=object())
    names = await _registered_tool_names(mcp)
    assert EXPECTED <= names


async def test_build_server_without_env_or_client_does_not_raise():
    # get_client() is lazy; building must not require env vars
    build_server()


async def test_crm_delete_is_marked_destructive():
    mcp = build_server(client=object())
    tools = {t.name: t for t in await mcp.list_tools()}
    delete = tools["crm_delete"]
    ann = delete.annotations
    assert ann is not None and ann.destructiveHint is True
    assert "DESTRUCTIVE" in (delete.description or "")


async def test_read_only_tools_have_hint():
    mcp = build_server(client=object())
    tools = {t.name: t for t in await mcp.list_tools()}
    for name in ("crm_search", "crm_get", "crm_describe", "list_actions"):
        ann = tools[name].annotations
        assert ann is not None and ann.readOnlyHint is True, name
