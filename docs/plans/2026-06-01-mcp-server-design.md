# LillyCRM MCP Server — Design

**Date:** 2026-06-01
**Status:** Approved design (pre-implementation)
**Repo:** `Django-CRM` (community edition; enterprise inherits via the `opensource/` symlink)

## Goal

Let users connect LillyCRM to their AI agents / LLMs (Claude Desktop, custom
agents, etc.) through a Model Context Protocol (MCP) server, with full CRUD +
actions across the main CRM entities — without ever weakening the existing
security model.

## Decisions (locked)

| Question | Decision |
| --- | --- |
| Transport | **Both, phased** — stdio first, then remote Streamable HTTP. One tool layer, two entry points. |
| Data access | **Over the REST API** — MCP is a thin DRF client; never touches the DB or ORM directly. |
| Runtime | **Python + FastMCP** (official Python MCP SDK high-level API). |
| Write posture | **Full CRUD + actions**, with destructive ops gated behind explicit confirmation. |
| Auth / identity | **Per-user Personal Access Tokens (PATs)** — agent acts AS the issuing user, inheriting their role + org. OAuth 2.1 deferred to phase 2. |
| Tiering | **Community edition** (Django-CRM). Headline OSS "connect your AI" feature. |
| Tool surface | **Few generic, entity-parameterized tools** (~6) + schema discovery. |

## Architecture

A standalone Python **FastMCP** server that is a *thin REST client* of the
existing DRF API. It holds no database access of its own — every call goes over
HTTP to the CRM, so **RLS, permission classes, serializer validation, and tenant
scoping are enforced by DRF unchanged**. The MCP server physically cannot bypass
them. This keeps the backend as the single trust boundary, per the project's
security rules.

```
Agent / LLM
   │  (MCP tool call)
   ▼
MCP server (FastMCP, thin client)
   │  attaches PAT as Authorization header
   ▼
DRF API  ── RLS + permissions + serializers ──►  Postgres (RLS-scoped)
   │
   ▼  compact JSON
Agent / LLM
```

### Three pieces of work (all in `Django-CRM`)

1. **`backend/` — Personal Access Tokens**
   - `PersonalAccessToken` model (org-scoped, `BaseOrgModel`, added to
     `ORG_SCOPED_TABLES` + a new RLS migration via `get_enable_policy_sql(...)`).
   - `PATAuthentication` DRF auth class (registered ahead of the org-key class).
   - Token CRUD API to mint / list / revoke.

2. **`mcp_server/` — new top-level uv package**
   - The FastMCP app exposing the generic tool set.
   - Depends only on `fastmcp`, `httpx`, `pydantic` — **not** Django. Independently
     publishable, lightweight.
   - Transport-agnostic tool layer; stdio and Streamable HTTP are two entry points.

3. **`frontend/` — token management UI**
   - Settings page ("API Tokens / Connect your AI"): create, copy-once, revoke PATs.
   - Generated connection snippets (Claude Desktop JSON, `claude mcp add`).

## Authentication & token model

### `PersonalAccessToken` (in `common/`, org-scoped)

| Field | Notes |
| --- | --- |
| `id` | uuid |
| `org` | FK, RLS-scoped |
| `user` / `profile` | whose identity the agent assumes |
| `name` | human label, e.g. "Claude Desktop" |
| `token_hash` | SHA-256 of the raw token — raw token never stored |
| `token_prefix` | first ~8 chars, shown in the list for identification |
| `scopes` | optional JSON; default = full inheritance of the profile's role |
| `expires_at` | nullable |
| `last_used_at` | throttled write |
| `created_at`, `revoked_at` | lifecycle |

- Raw token format: `lcrm_pat_<random>`. Shown **once** at creation, never retrievable again.

### PAT resolution: middleware + `PATAuthentication` (DRF)

> **Architecture correction (post-implementation):** org context is set by the
> `GetProfileAndOrg` **middleware**, which runs *before* the `RequireOrgContext`
> middleware and *before* DRF authentication. A DRF auth class sets
> `request.org` too late — `RequireOrgContext` would already have returned 403.
> So PAT resolution lives in **both** layers:
>
> - **`GetProfileAndOrg` middleware** detects a `lcrm_pat_` token (Bearer or
>   `Token:` header), resolves it via the shared `resolve_valid_pat()` helper,
>   and sets `request.profile` / `request.org` / `request.META["org"]` (mirroring
>   the existing org-key path, which is *also* in this middleware — that's why
>   the org-key path works). This is what makes `RequireOrgContext` pass and the
>   RLS session variable get set from the token's org.
> - **`PATAuthentication` (DRF)** reuses the middleware-resolved token
>   (`request._pat`) to set `request.user` for DRF's `IsAuthenticated`, and does
>   the throttled `last_used_at` write (exactly once).

- Reads `Authorization: Bearer lcrm_pat_…` (also accepts the existing `Token:` header style for parity).
- Hashes the presented token; looks up a non-revoked, non-expired row scoped to the **real user's** role instead of always-admin.
- Any failure → denied (403 from `RequireOrgContext`, or 401 from DRF), logged **without** the token value. Never 200, never 500.

**RLS note:** the `personal_access_token` table is intentionally **not**
RLS-protected — it is an auth-bootstrap table looked up by `token_hash` *before*
any tenant context exists (the same reason the `Org`/`api_key` table is not
RLS-protected). Tenant/user isolation for token *management* is enforced by the
explicit `org=… , profile=request.profile` filters in the CRUD views (IDOR-tested).
Business tables (leads, contacts, …) remain RLS-protected unchanged.

**Why per-user matters:** because the agent inherits the owner's role,
authorization comes "for free" from the existing RBAC — a sales rep's agent is
already constrained to what the rep can do. No new authz logic in the MCP layer
to get wrong.

### Token CRUD API (`/api/profile/tokens/`)

- `POST` create → returns raw token **once**.
- `GET` list → prefixes + metadata only (never the raw token).
- `DELETE` revoke → immediate (next call fails auth).
- A user manages **only their own** tokens. Raw token never logged or re-served.

## Tool surface

Six generic, entity-parameterized tools. `entity` is an enum mapping to a REST
resource (`leads`, `contacts`, `accounts`, `opportunities`, `tasks`, `cases`,
`invoices`, `solutions`, …).

| Tool | Annotation | Purpose |
| --- | --- | --- |
| `crm_search(entity, query?, filters?, limit, offset)` | readOnly | List/filter/search. Returns **compact** rows (id + key fields), not full objects — protects token budget. |
| `crm_get(entity, id)` | readOnly | Full detail for one record (+ nested relations where the API provides them). |
| `crm_create(entity, data)` | — | Create; `data` validated by the DRF serializer. |
| `crm_update(entity, id, data)` | — | Partial update (PATCH semantics). |
| `crm_delete(entity, id, confirm=true)` | **destructive** | Requires explicit `confirm`; refuses without it. Soft-delete where supported. |
| `crm_action(entity, id, action, params?)` | varies | Non-CRUD verbs (convert lead, change_status, assign, add_comment). Discoverable via `list_actions`. |

Plus **`crm_describe(entity)`** — returns writable/readable fields + enums for an
entity, derived at runtime from the **drf-spectacular OpenAPI schema** already
published at `/schema/`. The LLM learns valid fields/values without hardcoding;
new entities/fields surface automatically.

### Guardrails in the tools

- Destructive ops gated behind `confirm`, flagged `destructiveHint`.
- `limit` capped (e.g. ≤50) with pagination cursors — prevents giant dumps and bulk exfil-in-one-call.
- Tool errors are the DRF errors surfaced cleanly (400 validation, 403 role-forbidden, 404) so the agent self-corrects.

## Transports, entity registry & deployment

### Entity registry (the only CRM-specific routing)

```python
ENTITIES = {
  "leads":    {"path": "/api/leads/",    "actions": ["convert", "add_comment"]},
  "contacts": {"path": "/api/contacts/", "actions": ["add_comment"]},
  "accounts": {"path": "/api/accounts/", "actions": [...]},
  # ...
}
```

Adding an entity = one dict entry; the six generic tools + `crm_describe` pick it
up automatically. Tool *code* stays entity-agnostic.

### Two entry points, one tool layer

- **stdio** (`lcrm-mcp` console script via `uvx`/`pipx`): reads `LCRM_BASE_URL` +
  `LCRM_TOKEN` from env. Drops into Claude Desktop's `mcpServers` config. **Ships first.**
- **Streamable HTTP** (`lcrm-mcp --http`, hosted e.g. at `mcp.lillycrm.io`): PAT
  travels in each request's `Authorization` header — server is **stateless and
  multi-tenant**, never stores a token. Phase 2 adds OAuth on top.

### Shared HTTP client

One `httpx` wrapper centralizes base URL, auth header injection, timeouts/retries
(idempotent reads only), and DRF-status → MCP-error translation. Tools never build
URLs or headers themselves.

### Packaging

`Django-CRM/mcp_server/` as its own uv project (deps: `fastmcp`, `httpx`,
`pydantic` — not Django). Connection snippets generated in the frontend token
page and documented in `mcp_server/README.md`.

## Security, abuse controls, observability

### Security
- MCP never bypasses DRF — RLS + permission classes + serializers are the enforcement.
- PATs hashed at rest, shown once, named, revocable, expirable, `last_used_at` tracked. Never logged/echoed. Revocation immediate.
- Agent inherits the owner's role — RBAC-constrained by construction.
- Destructive tools require `confirm`; deletes prefer soft-delete.
- HTTP transport is stateless per-call auth — no token storage, no session fixation surface.

### Abuse controls
- Per-token DRF throttle (separate scope from web traffic), configurable.
- `limit` caps + pagination prevent bulk exfil and runaway token spend.
- Optional per-token entity/action allow-list (`scopes`) for least-privilege agents.

### Observability
- MCP-originated requests tagged (`X-Client: mcp` / token id) — distinguishable in audit log, attributable to a real user.
- Auth failures + destructive actions logged (without secrets).

## Testing (required)

### `backend/`
- PAT model: lifecycle, hashing, expiry, revocation.
- `PATAuthentication`: valid / expired / revoked / wrong-org → 401; inherits correct role.
- Token CRUD endpoints: happy path + "can't manage others' tokens" + raw token returned exactly once.
- `postgres_only` RLS test: a token from org A cannot read org B's data.

### `mcp_server/`
- Unit tests with a mocked httpx client: each tool's request shaping, the `confirm`
  gate on delete, error translation, `limit` capping, and `crm_describe` parsing
  the OpenAPI schema.

## Phasing

1. **Phase 1 (MVP):** PAT model + auth + CRUD API; FastMCP server with the 6 generic
   tools + `crm_describe`; **stdio** transport; frontend token page; tests.
2. **Phase 2:** Streamable HTTP transport hosted at `mcp.lillycrm.io`; per-token
   throttling + scopes; richer named actions via `crm_action`.
3. **Phase 3:** OAuth 2.1 authorization-code flow for one-click "Connect" UX on the
   hosted endpoint; MCP resources/prompts for common workflows.

## Out of scope (YAGNI for now)

- OAuth (phase 3), MCP resources/prompts (phase 3), direct ORM access, admin/user/org
  management tools, enterprise-only gating.
