---
name: deploy
description: Type-check, test, and deploy the MCP server to Cloudflare Workers
disable-model-invocation: true
---

Run these steps in order, stopping on any failure:

1. Type-check: `npx tsc --noEmit`
2. Run tests: `pnpm test -- --run`
3. Deploy: `npx wrangler deploy`

Report the deployment URL on success.
