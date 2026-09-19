# LillyCRM MCP Server — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **⚠️ PROJECT POLICY — NEVER COMMIT.** This repo's `CLAUDE.md` forbids Claude from running `git commit`/`git push`. The **Commit** steps below are written for the human engineer to run. When Claude executes this plan it must STOP at each commit step, summarize what changed, and let the user commit. Do not run any git history-mutating command.

**Goal:** Ship a Personal Access Token (PAT) auth layer in the Django backend and a standalone Python FastMCP server (stdio) that lets a user connect their AI agent to LillyCRM with full CRUD over the existing REST API, acting as the token's owning user.

**Architecture:** The MCP server is a *thin REST client* — it never touches the DB. A new `PersonalAccessToken` model + `PATAuthentication` DRF class let an agent authenticate as a real user (inheriting their role + org + RLS). Six generic, entity-parameterized FastMCP tools (`crm_search/get/create/update/delete/action`) plus `crm_describe` call the DRF API over HTTP. All authorization stays in DRF.

**Tech Stack:** Django + DRF + drf-spectacular (backend, uv), PostgreSQL RLS, FastMCP + httpx + pydantic (MCP server, separate uv package), SvelteKit 5 + Tailwind 4 (frontend token UI).

**Design doc:** `docs/plans/2026-06-01-mcp-server-design.md`

> **Implementation deviations (discovered during the final holistic review):**
> 1. **PAT org context must be set in middleware, not (only) DRF auth.** Setting
>    `request.org` in `PATAuthentication` is too late — `RequireOrgContext`
>    middleware runs first and 403s. Fix: `GetProfileAndOrg` middleware resolves
>    the PAT (shared `resolve_valid_pat()` in `common/pat_auth.py`) and sets org
>    context; `PATAuthentication` reuses `request._pat` for the DRF user +
>    throttled `last_used_at`. Tasks A2/A3 below predate this finding.
> 2. **Task A2 (RLS on `personal_access_token`) was reversed.** The table is an
>    auth-bootstrap table (looked up by `token_hash` before tenant context
>    exists), so RLS makes its own auth lookup return zero rows on non-superuser
>    Postgres. It is now treated like the `Org` table: **not** RLS-protected;
>    isolation enforced by explicit `org+profile` filters in the CRUD views.
>    Migration `0028` was dropped and the table removed from `ORG_SCOPED_TABLES`.

**Conventions discovered (follow these exactly):**
- Org-scoped models inherit `common.base.BaseOrgModel`; register the DB table name in `ORG_SCOPED_TABLES` (`common/rls/__init__.py`) and add an RLS migration using `get_enable_policy_sql(table)` (pattern: `common/migrations/0008_enable_rls_product_invoice_line_item.py`).
- Views are `APIView` subclasses, `permission_classes = (IsAuthenticated, HasOrgContext)`, responses wrapped as `{"error": False, ...}`, decorated with `@extend_schema(tags=[...])`. Permissions live in `common/permissions.py` (`HasOrgContext`).
- Serializers live in `common/serializer.py`. URLs are added in `common/urls.py` (mounted at `/api/`).
- Auth classes follow `common/external_auth.py`; registered in `REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"]` in `crm/settings.py`.
- Tests live in `common/tests/test_*.py`; existing fixtures `org_a`, `admin_user`, `admin_profile` come from `conftest.py`. Run with `uv run pytest --no-cov -x`.
- Frontend settings pages: `src/routes/(app)/settings/<name>/+page.server.js` (loader + form `actions` using `apiRequest` from `$lib/api-helpers.js`) and `+page.svelte`.

---

## Part A — Backend: Personal Access Token model + auth

### Task A1: `PersonalAccessToken` model

**Files:**
- Modify: `backend/common/models.py` (append model + token helpers)
- Modify: `backend/common/rls/__init__.py` (add table to `ORG_SCOPED_TABLES`)

**Step 1: Write the failing test**

Create `backend/common/tests/test_pat_model.py`:

```python
import hashlib

import pytest
from django.utils import timezone
from datetime import timedelta

from common.models import PersonalAccessToken


@pytest.mark.django_db
class TestPersonalAccessToken:
    def test_generate_returns_raw_token_and_persists_hash(self, org_a, admin_profile):
        raw, pat = PersonalAccessToken.generate(
            profile=admin_profile, name="Claude Desktop"
        )
        assert raw.startswith("lcrm_pat_")
        # Raw token is NOT stored; only its sha256 hash
        assert pat.token_hash == hashlib.sha256(raw.encode()).hexdigest()
        assert pat.token_hash != raw
        assert pat.token_prefix and raw.startswith(pat.token_prefix)
        assert pat.org == org_a
        assert pat.profile == admin_profile

    def test_is_valid_true_when_active(self, admin_profile):
        _, pat = PersonalAccessToken.generate(profile=admin_profile, name="x")
        assert pat.is_valid() is True

    def test_is_valid_false_when_revoked(self, admin_profile):
        _, pat = PersonalAccessToken.generate(profile=admin_profile, name="x")
        pat.revoked_at = timezone.now()
        pat.save()
        assert pat.is_valid() is False

    def test_is_valid_false_when_expired(self, admin_profile):
        _, pat = PersonalAccessToken.generate(
            profile=admin_profile, name="x",
            expires_at=timezone.now() - timedelta(days=1),
        )
        assert pat.is_valid() is False
```

**Step 2: Run it, verify it fails**

Run: `cd backend && uv run pytest common/tests/test_pat_model.py --no-cov -x`
Expected: FAIL — `ImportError: cannot import name 'PersonalAccessToken'`.

**Step 3: Implement the model**

Append to `backend/common/models.py` (top-of-file imports already include `uuid`, `secrets` may need adding; use `hashlib` + `secrets`):

```python
import hashlib
import secrets

from common.base import BaseOrgModel


def generate_pat_raw():
    """Return a new raw personal access token string."""
    return f"lcrm_pat_{secrets.token_urlsafe(32)}"


class PersonalAccessToken(BaseOrgModel):
    """
    Per-user token for programmatic/agent (MCP) access.

    The agent authenticates AS `profile` and inherits that user's role,
    org and RLS scope. The raw token is shown ONCE at creation and only
    its SHA-256 hash is stored.
    """

    profile = models.ForeignKey(
        "common.Profile",
        on_delete=models.CASCADE,
        related_name="access_tokens",
    )
    name = models.CharField(max_length=255)
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    token_prefix = models.CharField(max_length=20)
    scopes = models.JSONField(default=list, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "personal_access_token"
        indexes = [models.Index(fields=["org", "-created_at"])]

    @staticmethod
    def hash_token(raw):
        return hashlib.sha256(raw.encode()).hexdigest()

    @classmethod
    def generate(cls, profile, name, scopes=None, expires_at=None):
        raw = generate_pat_raw()
        pat = cls.objects.create(
            org=profile.org,
            profile=profile,
            name=name,
            token_hash=cls.hash_token(raw),
            token_prefix=raw[:13],  # lcrm_pat_ + 4 chars only — avoid persisting secret bytes
            scopes=scopes or [],
            expires_at=expires_at,
        )
        return raw, pat

    def is_valid(self):
        if self.revoked_at is not None:
            return False
        if self.expires_at is not None and self.expires_at <= timezone.now():
            return False
        return True
```

Ensure `from django.utils import timezone` is imported in `models.py` (it usually is — verify, add if missing).

Add `"personal_access_token"` to `ORG_SCOPED_TABLES` in `backend/common/rls/__init__.py` under a new `# MCP / programmatic access` comment.

**Step 4: Make the migration & run tests**

Run:
```
cd backend && uv run python manage.py makemigrations common
uv run pytest common/tests/test_pat_model.py --no-cov -x
```
Expected: migration created; all 4 tests PASS.

**Step 5: Commit** *(USER runs — Claude must not commit)*
```
git add common/models.py common/rls/__init__.py common/migrations/ common/tests/test_pat_model.py
git commit -m "feat(mcp): add PersonalAccessToken model"
```

---

### Task A2: RLS migration for the new table

**Files:**
- Create: `backend/common/migrations/00XX_enable_rls_personal_access_token.py` (number = next after the migration A1 created)

**Step 1: Write the failing test** (postgres-only)

Append to `backend/common/tests/test_pat_model.py`:

```python
@pytest.mark.postgres_only
@pytest.mark.django_db
def test_pat_table_has_rls_policy():
    from django.db import connection
    if connection.vendor != "postgresql":
        pytest.skip("RLS requires PostgreSQL")
    with connection.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM pg_policies WHERE tablename = %s",
            ["personal_access_token"],
        )
        assert cur.fetchone()[0] >= 1
```

**Step 2: Run it, verify it fails**

Run: `cd backend && uv run pytest common/tests/test_pat_model.py -k rls --no-cov -x` (against Postgres).
Expected: FAIL — 0 policies.

**Step 3: Write the migration**

Copy the structure of `common/migrations/0008_enable_rls_product_invoice_line_item.py` exactly, but with `tables = ["personal_access_token"]`. Keep both `enable_rls` and `disable_rls`, the `check_column_exists` guard, and the `migrations.RunPython(enable_rls, disable_rls)` operation. Set `dependencies` to the migration created in Task A1.

**Step 4: Migrate & run test**

Run:
```
cd backend && uv run python manage.py migrate common
uv run pytest common/tests/test_pat_model.py -k rls --no-cov -x
uv run python manage.py manage_rls --status   # personal_access_token should show enabled
```
Expected: policy present; test PASS.

**Step 5: Commit** *(USER runs)*
```
git add common/migrations/ common/tests/test_pat_model.py
git commit -m "feat(mcp): enable RLS on personal_access_token"
```

---

### Task A3: `PATAuthentication` DRF class

**Files:**
- Create: `backend/common/pat_auth.py`
- Modify: `backend/crm/settings.py` (register the class FIRST in `DEFAULT_AUTHENTICATION_CLASSES`)
- Test: `backend/common/tests/test_pat_auth.py`

**Why first in the list:** JWT auth also reads `Authorization: Bearer …` and *raises* on a token it can't decode. `PATAuthentication` must run first and only *claim* tokens starting with `lcrm_pat_`, returning `None` for anything else so JWT/org-key still work.

**Step 1: Write the failing test**

Create `backend/common/tests/test_pat_auth.py`:

```python
import pytest
from datetime import timedelta
from django.test import RequestFactory
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed

from common.models import PersonalAccessToken
from common.pat_auth import PATAuthentication


@pytest.mark.django_db
class TestPATAuthentication:
    def setup_method(self):
        self.factory = RequestFactory()
        self.auth = PATAuthentication()

    def test_no_header_returns_none(self):
        req = self.factory.get("/api/leads/")
        assert self.auth.authenticate(req) is None

    def test_non_pat_bearer_returns_none(self):
        # A JWT-style bearer must be ignored so JWTAuthentication handles it
        req = self.factory.get("/api/leads/", HTTP_AUTHORIZATION="Bearer ey.some.jwt")
        assert self.auth.authenticate(req) is None

    def test_valid_pat_authenticates_as_owner(self, org_a, admin_user, admin_profile):
        raw, pat = PersonalAccessToken.generate(profile=admin_profile, name="cli")
        req = self.factory.get("/api/leads/", HTTP_AUTHORIZATION=f"Bearer {raw}")
        user, _ = self.auth.authenticate(req)
        assert user == admin_user
        assert req.profile == admin_profile
        assert req.org == org_a
        assert req.META["org"] == str(org_a.id)
        pat.refresh_from_db()
        assert pat.last_used_at is not None

    def test_revoked_pat_raises(self, admin_profile):
        raw, pat = PersonalAccessToken.generate(profile=admin_profile, name="cli")
        pat.revoked_at = timezone.now(); pat.save()
        req = self.factory.get("/api/leads/", HTTP_AUTHORIZATION=f"Bearer {raw}")
        with pytest.raises(AuthenticationFailed):
            self.auth.authenticate(req)

    def test_expired_pat_raises(self, admin_profile):
        raw, _ = PersonalAccessToken.generate(
            profile=admin_profile, name="cli",
            expires_at=timezone.now() - timedelta(days=1),
        )
        req = self.factory.get("/api/leads/", HTTP_AUTHORIZATION=f"Bearer {raw}")
        with pytest.raises(AuthenticationFailed):
            self.auth.authenticate(req)

    def test_unknown_pat_raises(self):
        req = self.factory.get("/api/leads/", HTTP_AUTHORIZATION="Bearer lcrm_pat_nope")
        with pytest.raises(AuthenticationFailed):
            self.auth.authenticate(req)

    def test_inactive_profile_raises(self, admin_profile):
        raw, _ = PersonalAccessToken.generate(profile=admin_profile, name="cli")
        admin_profile.is_active = False; admin_profile.save()
        req = self.factory.get("/api/leads/", HTTP_AUTHORIZATION=f"Bearer {raw}")
        with pytest.raises(AuthenticationFailed):
            self.auth.authenticate(req)
```

**Step 2: Run it, verify it fails**

Run: `cd backend && uv run pytest common/tests/test_pat_auth.py --no-cov -x`
Expected: FAIL — `ModuleNotFoundError: common.pat_auth`.

**Step 3: Implement the auth class**

Create `backend/common/pat_auth.py` (mirror `common/external_auth.py` style, including the `OpenApiAuthenticationExtension`):

```python
import logging

from django.utils import timezone
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from common.models import PersonalAccessToken

logger = logging.getLogger(__name__)

PAT_PREFIX = "lcrm_pat_"


def _extract_raw(request):
    """Pull a lcrm_pat_ token from Authorization: Bearer or Token header."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        candidate = auth[len("Bearer "):].strip()
        if candidate.startswith(PAT_PREFIX):
            return candidate
    token = request.headers.get("Token", "")
    if token.startswith(PAT_PREFIX):
        return token
    return None


class PATAuthentication(BaseAuthentication):
    """Authenticate an agent AS the token's owning Profile (inherits role+org)."""

    def authenticate(self, request):
        raw = _extract_raw(request)
        if not raw:
            return None  # Not a PAT — let JWT / org-key auth handle it.

        try:
            pat = PersonalAccessToken.objects.select_related(
                "profile", "profile__user", "org"
            ).get(token_hash=PersonalAccessToken.hash_token(raw))
        except PersonalAccessToken.DoesNotExist as exc:
            logger.warning("Invalid PAT attempted")
            raise AuthenticationFailed("Invalid token") from exc

        if not pat.is_valid():
            raise AuthenticationFailed("Token revoked or expired")

        profile = pat.profile
        if not profile.is_active or not pat.org.is_active:
            raise AuthenticationFailed("Token owner or org is inactive")

        # Mirror the org-context wiring of APIKeyAuthentication.
        request.profile = profile
        request.org = pat.org
        request.META["org"] = str(pat.org.id)
        request.META["mcp_token_id"] = str(pat.id)  # for audit attribution

        # Throttled last_used_at write (avoid a write on every call).
        now = timezone.now()
        if pat.last_used_at is None or (now - pat.last_used_at).total_seconds() > 60:
            PersonalAccessToken.objects.filter(pk=pat.pk).update(last_used_at=now)

        return (profile.user, pat)


class PATAuthenticationScheme(OpenApiAuthenticationExtension):
    target_class = "common.pat_auth.PATAuthentication"
    name = "PersonalAccessToken"

    def get_security_definition(self, auto_schema):
        return {
            "type": "http",
            "scheme": "bearer",
            "description": "Personal access token (lcrm_pat_…) for agent/MCP access",
        }
```

Register it FIRST in `crm/settings.py`:
```python
"DEFAULT_AUTHENTICATION_CLASSES": (
    "common.pat_auth.PATAuthentication",
    "rest_framework_simplejwt.authentication.JWTAuthentication",
    "common.external_auth.APIKeyAuthentication",
),
```

**Step 4: Run tests**

Run: `cd backend && uv run pytest common/tests/test_pat_auth.py --no-cov -x`
Expected: all PASS.

**Step 5: Commit** *(USER runs)*
```
git add common/pat_auth.py crm/settings.py common/tests/test_pat_auth.py
git commit -m "feat(mcp): add PATAuthentication (agent acts as token owner)"
```

---

### Task A4: Cross-org RLS isolation test (postgres-only)

**Files:**
- Test: `backend/common/tests/test_pat_auth.py` (append)

**Step 1: Write the test** — prove a PAT from org A cannot read org B's leads through a real endpoint.

```python
@pytest.mark.postgres_only
@pytest.mark.django_db
def test_pat_cannot_cross_org(client, org_a, org_b, admin_profile):
    """A PAT scoped to org_a must not see org_b data (RLS + org filter)."""
    raw, _ = PersonalAccessToken.generate(profile=admin_profile, name="cli")
    # Hit a known list endpoint; response must be 200 and contain only org_a rows.
    resp = client.get("/api/leads/", HTTP_AUTHORIZATION=f"Bearer {raw}")
    assert resp.status_code == 200
    # No lead in the payload may belong to org_b (assert via ids if fixtures seed them)
```

> Adapt the assertion to the available fixtures (`org_b`, any seeded leads). If `org_b` fixture doesn't exist, create minimal data inline. Keep it `postgres_only`.

**Step 2–4:** Run `uv run pytest common/tests/test_pat_auth.py -k cross_org --no-cov -x` against Postgres; expected PASS (existing org filters + RLS already enforce this — this test guards against regressions).

**Step 5: Commit** *(USER runs)* — `git commit -m "test(mcp): PAT cross-org isolation"`.

---

## Part B — Backend: Token CRUD API

### Task B1: PAT serializers

**Files:**
- Modify: `backend/common/serializer.py` (append)

**Step 1: Write the failing test**

Create `backend/common/tests/test_pat_api.py` (first test only here; more in B2):

```python
import pytest
from common.serializer import PersonalAccessTokenListSerializer
from common.models import PersonalAccessToken


@pytest.mark.django_db
def test_list_serializer_hides_secret(admin_profile):
    raw, pat = PersonalAccessToken.generate(profile=admin_profile, name="cli")
    data = PersonalAccessTokenListSerializer(pat).data
    assert "token_hash" not in data
    assert data["token_prefix"] == pat.token_prefix
    assert data["name"] == "cli"
    # Raw token must never appear in any list representation
    assert raw not in str(data)
```

**Step 2: Run, verify fail** — `uv run pytest common/tests/test_pat_api.py --no-cov -x` → ImportError.

**Step 3: Implement serializers** in `common/serializer.py`:

```python
from common.models import PersonalAccessToken


class PersonalAccessTokenListSerializer(serializers.ModelSerializer):
    class Meta:
        model = PersonalAccessToken
        fields = (
            "id", "name", "token_prefix", "scopes",
            "expires_at", "last_used_at", "created_at", "revoked_at",
        )
        read_only_fields = fields


class PersonalAccessTokenCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = PersonalAccessToken
        fields = ("name", "scopes", "expires_at")

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Name is required.")
        if len(value) > 255:
            raise serializers.ValidationError("Name too long (max 255).")
        return value

    def validate_scopes(self, value):
        if value in (None, ""):
            return []
        if not isinstance(value, list) or not all(isinstance(s, str) for s in value):
            raise serializers.ValidationError("scopes must be a list of strings.")
        return value
```

(`serializers` is already imported at the top of `common/serializer.py` — verify.)

**Step 4: Run** → PASS. **Step 5: Commit** *(USER)* `feat(mcp): PAT serializers`.

---

### Task B2: Token CRUD views + URLs

**Files:**
- Create: `backend/common/views/pat_views.py`
- Modify: `backend/common/urls.py` (add 2 routes)
- Test: `backend/common/tests/test_pat_api.py` (append)

**Endpoints (user manages ONLY their own tokens):**
- `GET  /api/profile/tokens/` → list current user's tokens (metadata only)
- `POST /api/profile/tokens/` → create, returns raw token ONCE
- `DELETE /api/profile/tokens/<uuid:pk>/` → revoke (sets `revoked_at`)

**Step 1: Write the failing tests** (append to `test_pat_api.py`):

```python
@pytest.mark.django_db
class TestPATApi:
    def _auth(self, client, profile):
        # Use the JWT/login fixture pattern already used elsewhere in the suite.
        # (Reuse whatever helper the repo uses to authenticate a Profile for APIClient.)
        ...

    def test_create_returns_raw_token_once(self, client, admin_profile, auth_headers):
        resp = client.post("/api/profile/tokens/", {"name": "Claude"},
                           content_type="application/json", **auth_headers)
        assert resp.status_code == 201
        body = resp.json()
        assert body["token"].startswith("lcrm_pat_")  # raw token present ONCE
        # Subsequent list must NOT contain the raw token
        lst = client.get("/api/profile/tokens/", **auth_headers).json()
        assert all("token" not in t for t in lst["tokens"])

    def test_create_rejects_blank_name(self, client, admin_profile, auth_headers):
        resp = client.post("/api/profile/tokens/", {"name": "  "},
                           content_type="application/json", **auth_headers)
        assert resp.status_code == 400

    def test_list_only_own_tokens(self, client, admin_profile, other_profile,
                                  auth_headers):
        from common.models import PersonalAccessToken
        PersonalAccessToken.generate(profile=other_profile, name="theirs")
        PersonalAccessToken.generate(profile=admin_profile, name="mine")
        lst = client.get("/api/profile/tokens/", **auth_headers).json()
        names = [t["name"] for t in lst["tokens"]]
        assert "mine" in names and "theirs" not in names

    def test_cannot_revoke_others_token(self, client, other_profile, auth_headers):
        from common.models import PersonalAccessToken
        _, pat = PersonalAccessToken.generate(profile=other_profile, name="theirs")
        resp = client.delete(f"/api/profile/tokens/{pat.id}/", **auth_headers)
        assert resp.status_code in (403, 404)
        pat.refresh_from_db()
        assert pat.revoked_at is None  # untouched

    def test_revoke_own_token(self, client, admin_profile, auth_headers):
        from common.models import PersonalAccessToken
        _, pat = PersonalAccessToken.generate(profile=admin_profile, name="mine")
        resp = client.delete(f"/api/profile/tokens/{pat.id}/", **auth_headers)
        assert resp.status_code in (200, 204)
        pat.refresh_from_db()
        assert pat.revoked_at is not None
```

> **Note on `auth_headers`/`client` fixtures:** match the existing suite. Look at `common/tests/test_custom_fields.py` or `test_auth.py` for how they authenticate an `APIClient` as a profile (JWT bearer or force_authenticate) and reuse that exact helper instead of inventing one.

**Step 2: Run, verify fail.**

**Step 3: Implement the views** in `common/views/pat_views.py`:

```python
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from common.models import PersonalAccessToken
from common.permissions import HasOrgContext
from common.serializer import (
    PersonalAccessTokenCreateSerializer,
    PersonalAccessTokenListSerializer,
)


class PersonalAccessTokenListCreateView(APIView):
    permission_classes = (IsAuthenticated, HasOrgContext)

    @extend_schema(tags=["MCP / Tokens"], operation_id="pat_list")
    def get(self, request):
        qs = PersonalAccessToken.objects.filter(
            org=request.profile.org, profile=request.profile
        ).order_by("-created_at")
        return Response(
            {"error": False,
             "tokens": PersonalAccessTokenListSerializer(qs, many=True).data},
            status=status.HTTP_200_OK,
        )

    @extend_schema(tags=["MCP / Tokens"], operation_id="pat_create",
                   request=PersonalAccessTokenCreateSerializer)
    def post(self, request):
        ser = PersonalAccessTokenCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        raw, pat = PersonalAccessToken.generate(
            profile=request.profile,
            name=ser.validated_data["name"],
            scopes=ser.validated_data.get("scopes", []),
            expires_at=ser.validated_data.get("expires_at"),
        )
        data = PersonalAccessTokenListSerializer(pat).data
        data["token"] = raw  # shown ONCE
        return Response({"error": False, **data}, status=status.HTTP_201_CREATED)


class PersonalAccessTokenDetailView(APIView):
    permission_classes = (IsAuthenticated, HasOrgContext)

    @extend_schema(tags=["MCP / Tokens"], operation_id="pat_revoke")
    def delete(self, request, pk):
        # Scoped to the requesting user's own tokens → 404 for anyone else's.
        pat = get_object_or_404(
            PersonalAccessToken, pk=pk,
            org=request.profile.org, profile=request.profile,
        )
        if pat.revoked_at is None:
            pat.revoked_at = timezone.now()
            pat.save(update_fields=["revoked_at"])
        return Response({"error": False}, status=status.HTTP_200_OK)
```

Add to `common/urls.py`:
```python
from common.views.pat_views import (
    PersonalAccessTokenDetailView,
    PersonalAccessTokenListCreateView,
)
# ...
path("profile/tokens/", PersonalAccessTokenListCreateView.as_view(), name="pat_list_create"),
path("profile/tokens/<uuid:pk>/", PersonalAccessTokenDetailView.as_view(), name="pat_detail"),
```

> **Security checks baked in:** queries are filtered by both `org` AND `profile=request.profile`, so IDOR on another user's token returns 404. `token_hash` is never serialized. Raw token returned only from `POST`. Create input validated by the serializer (400 on blank/oversized name, bad scopes).

**Step 4: Run** `uv run pytest common/tests/test_pat_api.py --no-cov -x` → PASS.

**Step 5: Commit** *(USER)* `feat(mcp): personal access token CRUD API`.

---

## Part C — MCP server package (FastMCP, stdio)

### Task C1: Scaffold the `mcp_server` uv package

**Files:**
- Create: `mcp_server/pyproject.toml`
- Create: `mcp_server/src/lcrm_mcp/__init__.py`
- Create: `mcp_server/src/lcrm_mcp/config.py`
- Create: `mcp_server/README.md`
- Create: `mcp_server/tests/__init__.py`

**Step 1:** `mcp_server/pyproject.toml`:
```toml
[project]
name = "lcrm-mcp"
version = "0.1.0"
description = "LillyCRM MCP server — connect your AI agent to LillyCRM"
requires-python = ">=3.11"
dependencies = ["fastmcp>=2.0", "httpx>=0.27", "pydantic>=2.7"]

[project.scripts]
lcrm-mcp = "lcrm_mcp.server:main"

[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.23", "respx>=0.21"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

`config.py`:
```python
import os
from dataclasses import dataclass


@dataclass
class Settings:
    base_url: str
    token: str

    @classmethod
    def from_env(cls):
        base = os.environ.get("LCRM_BASE_URL", "").rstrip("/")
        token = os.environ.get("LCRM_TOKEN", "")
        if not base or not token:
            raise SystemExit("LCRM_BASE_URL and LCRM_TOKEN env vars are required")
        return cls(base_url=base, token=token)
```

**Step 2:** `cd mcp_server && uv sync` → resolves deps, creates `.venv`.

**Step 3: Commit** *(USER)* `chore(mcp): scaffold lcrm-mcp package`.

---

### Task C2: HTTP client wrapper

**Files:**
- Create: `mcp_server/src/lcrm_mcp/client.py`
- Test: `mcp_server/tests/test_client.py`

**Step 1: Write failing test** (uses `respx` to mock httpx):
```python
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
```

**Step 2: Run → fail.**

**Step 3: Implement** `client.py`:
```python
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

    async def get(self, path, params=None):    return await self._request("GET", path, params=params)
    async def post(self, path, json):          return await self._request("POST", path, json=json)
    async def patch(self, path, json):         return await self._request("PATCH", path, json=json)
    async def delete(self, path):              return await self._request("DELETE", path)
```

**Step 4: Run → PASS. Step 5: Commit** *(USER)* `feat(mcp): http client wrapper`.

---

### Task C3: Entity registry

**Files:**
- Create: `mcp_server/src/lcrm_mcp/entities.py`
- Test: `mcp_server/tests/test_entities.py`

**Step 1: Test:**
```python
from lcrm_mcp.entities import ENTITIES, resolve_path, EntityError
import pytest


def test_known_entity_resolves_list_path():
    assert resolve_path("leads") == "/api/leads/"

def test_known_entity_resolves_detail_path():
    assert resolve_path("leads", "123") == "/api/leads/123/"

def test_unknown_entity_raises():
    with pytest.raises(EntityError):
        resolve_path("dragons")
```

**Step 2: fail. Step 3: Implement** — declarative map (only CRM-specific knowledge in the whole server):
```python
class EntityError(ValueError):
    pass

ENTITIES = {
    "leads":         {"path": "/api/leads/",         "actions": ["convert", "add_comment"]},
    "contacts":      {"path": "/api/contacts/",      "actions": ["add_comment"]},
    "accounts":      {"path": "/api/accounts/",      "actions": ["add_comment"]},
    "opportunities": {"path": "/api/opportunities/", "actions": ["add_comment"]},
    "tasks":         {"path": "/api/tasks/",         "actions": []},
    "cases":         {"path": "/api/cases/",         "actions": ["add_comment"]},
    "invoices":      {"path": "/api/invoices/",      "actions": ["send"]},
    "solutions":     {"path": "/api/solutions/",     "actions": []},
}

def resolve_path(entity, pk=None):
    if entity not in ENTITIES:
        raise EntityError(f"Unknown entity '{entity}'. Known: {', '.join(ENTITIES)}")
    base = ENTITIES[entity]["path"]
    return f"{base}{pk}/" if pk else base
```

> **Verify each path** against `common/app_urls/__init__.py` before finalizing (e.g. `/api/leads/`, `/api/contacts/`, `/api/opportunities/`, `/api/tasks/`, `/api/cases/`, `/api/invoices/`). Drop any entity whose list endpoint differs or doesn't support CRUD; better to ship fewer correct entities.

**Step 4: PASS. Step 5: Commit** *(USER)* `feat(mcp): entity registry`.

---

### Task C4: The 6 generic tools + `crm_describe`

**Files:**
- Create: `mcp_server/src/lcrm_mcp/tools.py`
- Test: `mcp_server/tests/test_tools.py`

**Step 1: Write failing tests** (call the underlying functions directly with a fake client; the FastMCP wrapper is thin):
```python
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
```

**Step 2: fail. Step 3: Implement** `tools.py` (pure functions taking `client` first — registered onto FastMCP in C5):
```python
from lcrm_mcp.entities import ENTITIES, resolve_path, EntityError

MAX_LIMIT = 50


async def crm_search(client, entity, query=None, filters=None, limit=20, offset=0):
    """Search/list records of an entity. Returns compact rows."""
    params = dict(filters or {})
    if query:
        params["search"] = query
    params["limit"] = min(int(limit or 20), MAX_LIMIT)
    params["offset"] = max(int(offset or 0), 0)
    return await client.get(resolve_path(entity), params=params)


async def crm_get(client, entity, id):
    """Fetch a single record's full detail."""
    return await client.get(resolve_path(entity, id))


async def crm_create(client, entity, data):
    """Create a record. `data` is validated server-side by DRF."""
    return await client.post(resolve_path(entity), json=data)


async def crm_update(client, entity, id, data):
    """Partially update a record (PATCH)."""
    return await client.patch(resolve_path(entity, id), json=data)


async def crm_delete(client, entity, id, confirm=False):
    """Delete a record. Requires confirm=True (destructive)."""
    if not confirm:
        raise ValueError("Destructive op: pass confirm=true to delete.")
    return await client.delete(resolve_path(entity, id))


async def crm_action(client, entity, id, action, params=None):
    """Run a non-CRUD action (e.g. convert, add_comment). See list_actions."""
    if entity not in ENTITIES:
        raise EntityError(f"Unknown entity '{entity}'.")
    allowed = ENTITIES[entity]["actions"]
    if action not in allowed:
        raise ValueError(f"Action '{action}' not allowed for {entity}. Allowed: {allowed}")
    return await client.post(f"{resolve_path(entity, id)}{action}/", json=params or {})


def list_actions():
    """Return the allowed actions per entity."""
    return {e: cfg["actions"] for e, cfg in ENTITIES.items()}
```

For `crm_describe`, derive fields from the published OpenAPI schema:
```python
async def crm_describe(client, entity):
    """Return writable/readable fields + enums for an entity (from OpenAPI schema)."""
    if entity not in ENTITIES:
        raise EntityError(f"Unknown entity '{entity}'.")
    schema = await client.get("/schema/", params={"format": "json"})
    # Walk components.schemas to surface the create/request serializer fields.
    # Implement a small extractor that returns {field: {type, required, enum?}}.
    return _extract_entity_fields(schema, entity)
```
Add a focused unit test for `_extract_entity_fields` with a tiny inline OpenAPI dict (don't hit the network). Keep the extractor defensive (schema shape varies); on miss, return an empty dict with a note rather than raising.

**Step 4: Run `cd mcp_server && uv run pytest -q` → PASS. Step 5: Commit** *(USER)* `feat(mcp): generic CRUD tools + describe`.

---

### Task C5: FastMCP server entry point (stdio)

**Files:**
- Create: `mcp_server/src/lcrm_mcp/server.py`
- Test: `mcp_server/tests/test_server_registration.py`

**Step 1: Test** — assert all expected tools are registered:
```python
from lcrm_mcp.server import build_server

def test_all_tools_registered():
    mcp = build_server()
    names = set(mcp._tool_manager._tools.keys())  # adapt to FastMCP's introspection API
    assert {"crm_search","crm_get","crm_create","crm_update",
            "crm_delete","crm_action","crm_describe","list_actions"} <= names
```
> If FastMCP's internal attribute name differs, use its public listing API (e.g. `await mcp.list_tools()`); check the installed FastMCP version with context7 docs.

**Step 2: fail. Step 3: Implement** `server.py`:
```python
from fastmcp import FastMCP

from lcrm_mcp import tools
from lcrm_mcp.client import CrmClient
from lcrm_mcp.config import Settings


def build_server(client=None):
    mcp = FastMCP("LillyCRM")
    _client = client  # injected in tests; lazily built at runtime otherwise

    def get_client():
        nonlocal _client
        if _client is None:
            s = Settings.from_env()
            _client = CrmClient(s.base_url, s.token)
        return _client

    @mcp.tool(annotations={"readOnlyHint": True})
    async def crm_search(entity: str, query: str = "", filters: dict | None = None,
                         limit: int = 20, offset: int = 0):
        return await tools.crm_search(get_client(), entity, query or None, filters, limit, offset)

    @mcp.tool(annotations={"readOnlyHint": True})
    async def crm_get(entity: str, id: str):
        return await tools.crm_get(get_client(), entity, id)

    @mcp.tool()
    async def crm_create(entity: str, data: dict):
        return await tools.crm_create(get_client(), entity, data)

    @mcp.tool()
    async def crm_update(entity: str, id: str, data: dict):
        return await tools.crm_update(get_client(), entity, id, data)

    @mcp.tool(annotations={"destructiveHint": True})
    async def crm_delete(entity: str, id: str, confirm: bool = False):
        return await tools.crm_delete(get_client(), entity, id, confirm)

    @mcp.tool()
    async def crm_action(entity: str, id: str, action: str, params: dict | None = None):
        return await tools.crm_action(get_client(), entity, id, action, params)

    @mcp.tool(annotations={"readOnlyHint": True})
    async def crm_describe(entity: str):
        return await tools.crm_describe(get_client(), entity)

    @mcp.tool(annotations={"readOnlyHint": True})
    def list_actions():
        return tools.list_actions()

    return mcp


def main():
    build_server().run()  # stdio transport by default


if __name__ == "__main__":
    main()
```

> Confirm the FastMCP decorator/annotation API against the installed version via context7 (`/jlowin/fastmcp` or the official `modelcontextprotocol/python-sdk`). Adjust `annotations=` syntax if the version differs.

**Step 4: Run `uv run pytest -q` → PASS. Step 5: Commit** *(USER)* `feat(mcp): FastMCP stdio server entry point`.

---

### Task C6: Manual smoke test + README

**Files:**
- Modify: `mcp_server/README.md`

**Step 1:** Document setup and run a real smoke test against a local backend:
```
# Terminal 1 — backend
cd backend && uv run python manage.py runserver

# Mint a PAT (via the UI from Part D, or shell):
cd backend && uv run python manage.py shell -c "
from common.models import Profile, PersonalAccessToken
p = Profile.objects.filter(role='ADMIN', is_active=True).first()
print(PersonalAccessToken.generate(p, 'smoke')[0])"

# Terminal 2 — MCP server
cd mcp_server
LCRM_BASE_URL=http://localhost:8000 LCRM_TOKEN=lcrm_pat_… uv run lcrm-mcp
```
Then connect from Claude Desktop using the config snippet in the README:
```json
{
  "mcpServers": {
    "lillycrm": {
      "command": "uvx",
      "args": ["lcrm-mcp"],
      "env": { "LCRM_BASE_URL": "http://localhost:8000", "LCRM_TOKEN": "lcrm_pat_…" }
    }
  }
}
```
Verify `crm_search entity=leads` returns the org's leads and that a token from a non-admin user cannot see what that user can't.

**Step 2: Commit** *(USER)* `docs(mcp): README + connection snippet`.

---

## Part D — Frontend: token management page

### Task D1: Settings page (`/settings/api-tokens`)

**Files:**
- Create: `frontend/src/routes/(app)/settings/api-tokens/+page.server.js`
- Create: `frontend/src/routes/(app)/settings/api-tokens/+page.svelte`

**Step 1:** `+page.server.js` — mirror `settings/custom-fields/+page.server.js` (uses `apiRequest` from `$lib/api-helpers.js`, `load` + form `actions`). Tokens are per-user so **no admin gate** (any active member can manage their own):
```js
import { fail } from '@sveltejs/kit';
import { apiRequest } from '$lib/api-helpers.js';

export async function load({ cookies, locals }) {
  const data = await apiRequest('/profile/tokens/', {}, { cookies, org: locals?.org });
  return { tokens: data.tokens || [] };
}

export const actions = {
  create: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const name = String(form.get('name') || '').trim();
    if (!name) return fail(400, { error: 'Name is required' });
    const expires_at = form.get('expires_at') || null;
    try {
      const created = await apiRequest('/profile/tokens/',
        { method: 'POST', body: { name, expires_at } },
        { cookies, org: locals?.org });
      // Return the raw token ONCE so the page can show a copy-once panel.
      return { created: { token: created.token, name: created.name } };
    } catch (e) {
      return fail(400, { error: e?.message || 'Failed to create token' });
    }
  },
  revoke: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const id = String(form.get('id') || '');
    try {
      await apiRequest(`/profile/tokens/${id}/`, { method: 'DELETE' },
        { cookies, org: locals?.org });
      return { revoked: id };
    } catch (e) {
      return fail(400, { error: e?.message || 'Failed to revoke token' });
    }
  }
};
```
> Verify `apiRequest`'s exact option signature (`method`, `body`) against `$lib/api-helpers.js` and an existing action (custom-fields) — adapt the call shape to match.

**Step 2:** `+page.svelte` (Svelte 5 runes, Tailwind 4, shadcn-svelte to match the app):
- A "Create token" form (name + optional expiry).
- On success, a **copy-once** panel showing the raw token with a warning "You won't see this again."
- A table of existing tokens: name, `token_prefix`, `last_used_at`, `expires_at`, created, and a **Revoke** button (use a `use:enhance` form; avoid native `confirm()` dialogs per browser-automation guidance — use an inline confirm state).
- A collapsible "Connect your AI" section rendering the Claude Desktop JSON snippet pre-filled with the user's CRM base URL (token left as a placeholder since it's only shown once).

**Step 3: Type-check & lint**
Run: `cd frontend && pnpm run check && pnpm run lint`
Expected: no errors.

**Step 4: Commit** *(USER)* `feat(mcp): API tokens settings page`.

---

### Task D2: Navigation link

**Files:**
- Modify: the settings nav/menu component (find it: `grep -rl "settings/custom-fields\|settings/organization" frontend/src`)

**Step 1:** Add an "API Tokens" / "Connect your AI" link pointing to `/settings/api-tokens`, mirroring how `custom-fields` is linked.
**Step 2:** `pnpm run check`. **Step 3: Commit** *(USER)* `feat(mcp): link API tokens in settings nav`.

---

## Part E — Wrap-up

### Task E1: Full test pass

Run:
```
cd backend && uv run pytest common/tests/test_pat_model.py common/tests/test_pat_auth.py common/tests/test_pat_api.py --no-cov -x
cd ../mcp_server && uv run pytest -q
cd ../frontend && pnpm run check
```
Expected: all green. Run the postgres-only RLS tests against a real Postgres (`-m postgres_only`).

### Task E2: Security self-review

Before declaring done, confirm:
- [ ] PAT raw value never logged (grep for `logger`/`print` near token handling) and only returned from `POST /profile/tokens/`.
- [ ] `token_hash` never serialized (only `PersonalAccessTokenListSerializer` is used for reads).
- [ ] Token queries filtered by BOTH `org` and `profile=request.profile` → no IDOR.
- [ ] `PATAuthentication` returns `None` (not raise) for non-PAT bearers so JWT still works.
- [ ] `crm_delete` refuses without `confirm`; `crm_search` caps `limit`.
- [ ] MCP server has zero DB/Django imports — purely an HTTP client.
- [ ] New table in `ORG_SCOPED_TABLES` + RLS migration applied (`manage_rls --status`).
- [ ] Consider running `/security-review` on the diff.

### Task E3: Update docs

- Add a short "Connect your AI (MCP)" section to `backend/README.md` and `mcp_server/README.md`.
- Leave the design doc and this plan in `docs/plans/`.

---

## Out of scope (Phase 2+, do NOT build now)
- Streamable HTTP transport / hosted `mcp.lillycrm.io`
- OAuth 2.1 flow
- Per-token throttling + scope enforcement (model field exists; enforcement deferred)
- Named semantic action tools beyond the generic `crm_action`
- MCP resources/prompts
