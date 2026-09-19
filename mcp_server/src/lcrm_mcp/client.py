import httpx


class CrmError(Exception):
    """Raised on a non-2xx CRM response; message carries the DRF error."""


class CrmClient:
    def __init__(self, base_url: str, token: str, timeout: float = 30.0):
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}",
                         "X-Client": "mcp", "Accept": "application/json"}
        self._timeout = timeout

    async def _request(self, method, path, *, params=None, json=None):
        url = f"{self._base}{path}"
        async with httpx.AsyncClient(timeout=self._timeout) as c:
            resp = await c.request(method, url, headers=self._headers,
                                   params=params, json=json)
        if resp.status_code >= 400:
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            raise CrmError(f"{resp.status_code}: {detail}")
        if resp.status_code == 204 or not resp.content:
            return {}
        return resp.json()

    async def get(self, path, params=None):
        return await self._request("GET", path, params=params)

    async def post(self, path, json):
        return await self._request("POST", path, json=json)

    async def patch(self, path, json):
        return await self._request("PATCH", path, json=json)

    async def delete(self, path):
        return await self._request("DELETE", path)
