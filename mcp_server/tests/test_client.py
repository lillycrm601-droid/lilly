import httpx, pytest, respx
from lcrm_mcp.client import CrmClient, CrmError


@pytest.mark.asyncio
async def test_get_sends_bearer_and_returns_json():
    client = CrmClient("https://crm.example.com", "lcrm_pat_abc")
    with respx.mock:
        route = respx.get("https://crm.example.com/api/leads/").mock(
            return_value=httpx.Response(200, json={"results": []})
        )
        data = await client.get("/api/leads/")
    assert data == {"results": []}
    assert route.calls.last.request.headers["Authorization"] == "Bearer lcrm_pat_abc"


@pytest.mark.asyncio
async def test_400_raises_crmerror_with_detail():
    client = CrmClient("https://crm.example.com", "lcrm_pat_abc")
    with respx.mock:
        respx.post("https://crm.example.com/api/leads/").mock(
            return_value=httpx.Response(400, json={"name": ["This field is required."]})
        )
        with pytest.raises(CrmError) as exc:
            await client.post("/api/leads/", {})
    assert "required" in str(exc.value)
