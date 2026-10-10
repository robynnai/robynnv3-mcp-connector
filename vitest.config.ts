import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Transform these Workers-runtime packages through Vite so tests can
    // vi.mock their `cloudflare:*` imports (src/__tests__/provider-contract.test.ts).
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider', 'agents', 'partyserver'] } },
  },
});
