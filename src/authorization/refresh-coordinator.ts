/**
 * Per-grant refresh serialization (COS-PLUGIN-001 P10; authorization
 * contract §6.3 step 2).
 *
 * The Worker routes every `grant_type=refresh_token` request for one
 * provider grant to the Durable Object `refresh:{grantId}` (class
 * `RefreshCoordinator` in src/index.ts). Inside it, this runner executes one
 * refresh at a time, and a request identical to the one in flight (same
 * credentials and body) receives that in-flight result instead of starting
 * a second upstream refresh. A DO is used because it is single-threaded per
 * id; Workers KV is eventually consistent and cannot provide mutual
 * exclusion. The app's refresh-reuse grace window (P05) is the backstop.
 */

interface ResponseSnapshot {
  status: number;
  headers: [string, string][];
  body: string;
}

async function snapshot(response: Response): Promise<ResponseSnapshot> {
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.text(),
  };
}

function restore(snap: ResponseSnapshot): Response {
  return new Response(snap.status === 204 ? null : snap.body, {
    status: snap.status,
    headers: snap.headers,
  });
}

/** Name of the coordinator DO for a provider grant. */
export function refreshCoordinatorName(grantId: string): string {
  return `refresh:${grantId}`;
}

/** sha256 over the parts that make two token requests identical. */
export async function refreshRequestKey(request: Request): Promise<string> {
  const material = [
    request.headers.get("authorization") ?? "",
    request.headers.get("content-type") ?? "",
    await request.clone().text(),
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SerializedRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<ResponseSnapshot>>();

  /** Number of distinct runs currently queued or executing (tests). */
  get pending(): number {
    return this.inFlight.size;
  }

  async run(key: string, task: () => Promise<Response>): Promise<Response> {
    const shared = this.inFlight.get(key);
    if (shared) return restore(await shared);

    // `tail` never rejects, so each run starts after the previous one settles.
    const result = this.tail.then(async () => snapshot(await task()));
    this.inFlight.set(key, result);
    this.tail = result.catch(() => undefined);
    try {
      return restore(await result);
    } finally {
      if (this.inFlight.get(key) === result) this.inFlight.delete(key);
    }
  }
}
