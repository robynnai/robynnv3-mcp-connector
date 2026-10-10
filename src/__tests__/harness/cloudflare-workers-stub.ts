/**
 * Stand-in for the `cloudflare:workers` runtime module in Node tests:
 *
 *   vi.mock("cloudflare:workers", () => import("./harness/cloudflare-workers-stub"));
 */
export class WorkerEntrypoint {}

export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env = {};
