import { describe, expect, it } from "vitest";

import { refreshRequestKey, SerializedRunner } from "./refresh-coordinator";

// COS-PLUGIN-001 P10: one refresh at a time per grant; identical in-flight
// requests share one result (contract §6.3 step 2).

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("SerializedRunner", () => {
  it("runs an identical in-flight request once and gives every caller its own copy of the result", async () => {
    const runner = new SerializedRunner();
    const gate = deferred();
    let runs = 0;
    const task = async () => {
      runs++;
      await gate.promise;
      return Response.json({ token: "t1" }, { headers: { "cache-control": "no-store" } });
    };
    const calls = [runner.run("k", task), runner.run("k", task), runner.run("k", task)];
    gate.resolve();
    const responses = await Promise.all(calls);
    expect(runs).toBe(1);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ token: "t1" });
    }
    expect(runner.pending).toBe(0);
  });

  it("never overlaps different requests for the same grant", async () => {
    const runner = new SerializedRunner();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const task = (name: string) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${name}`);
      active--;
      return new Response(name);
    };
    const results = await Promise.all([runner.run("a", task("a")), runner.run("b", task("b")), runner.run("c", task("c"))]);
    expect(await Promise.all(results.map((r) => r.text()))).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("a failed run rejects its callers but does not wedge the queue; a later identical request runs again", async () => {
    const runner = new SerializedRunner();
    await expect(runner.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const res = await runner.run("k", async () => new Response("ok"));
    expect(await res.text()).toBe("ok");
  });
});

describe("refreshRequestKey", () => {
  const req = (body: string, auth?: string) =>
    new Request("https://mcp.test/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(auth ? { authorization: auth } : {}) },
      body,
    });

  it("is equal only for identical credentials and body, and leaves the body readable", async () => {
    const a = req("grant_type=refresh_token&refresh_token=u:g:s1");
    expect(await refreshRequestKey(a)).toBe(await refreshRequestKey(req("grant_type=refresh_token&refresh_token=u:g:s1")));
    expect(await refreshRequestKey(a)).not.toBe(await refreshRequestKey(req("grant_type=refresh_token&refresh_token=u:g:s2")));
    expect(await refreshRequestKey(a)).not.toBe(await refreshRequestKey(req("grant_type=refresh_token&refresh_token=u:g:s1", "Basic x")));
    expect(await a.text()).toContain("refresh_token");
  });
});
