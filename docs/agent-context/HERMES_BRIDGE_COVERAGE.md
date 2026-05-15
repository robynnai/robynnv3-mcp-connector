# Hermes Robynn Bridge Coverage

Last updated: 2026-05-15.

## Phase 1 Covered In This Repo

- `robynn_capabilities` calls robynnv3 `GET /api/cli/mcp/capabilities` and returns the semantic capability manifest.
- `robynn_brand_source_add` calls robynnv3 `POST /api/cli/brand/sources` for website source drafts and text sources.
- `robynn_brand_rebuild` calls robynnv3 `POST /api/cli/brand/rebuild` with explicit write confirmation.
- `robynn_connected_app_action` no longer exposes `provider_access_token`; connector write execution goes through robynnv3 `POST /api/cli/connectors/act`.
- Hosted MCP (`src/index.ts`) and local CLI MCP (`src/cli/index.ts`) register the same Phase 1 bridge tools.

## Explicitly Not Covered In Phase 1

- No direct calls from MCP/Hermes to `robynnv3_agents`.
- No Hostinger provisioning, billing checkout, broad publishing expansion, Design Studio CRUD, Content Studio CRUD, or direct org intelligence tooling.
- Direct org intelligence remains discoverable only as planned/not exposed through the capability manifest.

## Verification

```bash
pnpm test
```
