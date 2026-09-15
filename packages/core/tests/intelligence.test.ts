import { describe, expect, it } from "vitest";
import { createClient } from "../src/client/client.js";
import { CancelledError, TimeoutError } from "../src/errors.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface FakeFetch {
  fn: typeof fetch;
  calls: Array<{ url: string; method: string }>;
}

function fakeFetch(
  router: (url: string, method: string, callNumber: number) => Response | Promise<Response>,
): FakeFetch {
  let n = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init.method ?? "GET");
    calls.push({ url, method });
    return router(url, method, n++);
  };
  return { fn, calls };
}

/** A fetch that never settles until its signal aborts. */
function hang(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    init.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

describe("intelligence", () => {
  it("tracks requests, successes, cache hits and cache misses per endpoint", async () => {
    const { fn } = fakeFetch(() => json(200, { ok: true }));
    const api = createClient({ baseURL: "https://x.test", fetch: fn, cache: { ttl: 60_000 } });

    await api.get("/users");
    await api.get("/users"); // cache hit

    const ep = api.intelligence().endpoint("GET", "/users")!;
    expect(ep.requests).toBe(2);
    expect(ep.successes).toBe(1);
    expect(ep.cacheHits).toBe(1);
    expect(ep.cacheMisses).toBe(1);

    const snap = api.intelligence().snapshot();
    expect(snap.summary.totalRequests).toBe(2);
    expect(snap.summary.cacheHitRate).toBe(0.5);
    expect(snap.endpoints).toHaveLength(1);
  });

  it("counts deduplicated requests joining an in-flight flight", async () => {
    const { fn } = fakeFetch(async () => {
      await sleep(20);
      return json(200, { v: 1 });
    });
    const api = createClient({ baseURL: "https://x.test", fetch: fn, cache: { enabled: false } });

    const all = await Promise.all([api.get("/x"), api.get("/x"), api.get("/x")]);
    expect(all).toHaveLength(3);
    const ep = api.intelligence().endpoint("GET", "/x")!;
    expect(ep.requests).toBe(3);
    expect(ep.dedupPrevented).toBe(2);
    expect(ep.successes).toBe(1);
  });

  it("counts retries performed and recovered (success after attempts > 1)", async () => {
    let failures = 2;
    const { fn } = fakeFetch((url, method) => {
      if (failures > 0) {
        failures -= 1;
        return json(500, {});
      }
      return json(200, { ok: true });
    });
    const api = createClient({
      baseURL: "https://x.test",
      fetch: fn,
      cache: { enabled: false },
      retry: { attempts: 3, baseDelay: 0, maxDelay: 0 },
    });

    await api.get("/x");
    const ep = api.intelligence().endpoint("GET", "/x")!;
    expect(ep.retriesPerformed).toBe(2);
    expect(ep.retriesRecovered).toBe(1);
    expect(ep.successes).toBe(1);
    expect(ep.failures).toBe(0);
  });

  it("counts failures, rate limits (429) and timeouts", async () => {
    const { fn: fn429 } = fakeFetch((url, method) => json(429, {}));
    const api429 = createClient({
      baseURL: "https://x.test",
      fetch: fn429,
      cache: { enabled: false },
      retry: { attempts: 3, baseDelay: 0, maxDelay: 0 },
    });
    await expect(api429.get("/limited")).rejects.toThrow(/429/);
    const limited = api429.intelligence().endpoint("GET", "/limited")!;
    expect(limited.rateLimited).toBe(3);
    expect(limited.failures).toBe(1);

    const api = createClient({
      baseURL: "https://x.test",
      fetch: hang,
      cache: { enabled: false },
    });
    await expect(api.get("/slow", { timeout: 20 })).rejects.toBeInstanceOf(TimeoutError);
    const slow = api.intelligence().endpoint("GET", "/slow")!;
    expect(slow.timeouts).toBe(1);
    expect(slow.failures).toBe(1);
  });

  it("records terminal cancellations", async () => {
    const api = createClient({
      baseURL: "https://x.test",
      fetch: hang,
      cache: { enabled: false },
    });
    const request = api.get("/big") as Promise<unknown> & { cancel: () => void };
    await sleep(0);
    request.cancel();
    await expect(request).rejects.toBeInstanceOf(CancelledError);
    const ep = api.intelligence().endpoint("GET", "/big")!;
    expect(ep.cancels).toBe(1);
  });

  it("reports rolling latency percentiles and avg", async () => {
    const { fn } = fakeFetch(() => json(200, {}));
    const api = createClient({ baseURL: "https://x.test", fetch: fn, cache: { enabled: false } });
    for (let i = 0; i < 10; i++) await api.get("/lat");
    const ep = api.intelligence().endpoint("GET", "/lat")!;
    expect(ep.latency.samples).toBe(10);
    expect(ep.latency.avg).toBeGreaterThanOrEqual(0);
    expect(ep.latency.p50).toBeGreaterThanOrEqual(0);
    expect(ep.latency.p95).toBeGreaterThanOrEqual(ep.latency.p50);
  });

  it("adaptiveTimeout tightens the timeout from observed latency", async () => {
    let n = 0;
    const slowFetch: typeof fetch = (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const wait = n++ < 5 ? 200 : 3000; // establish p95 ≈ 200ms → ~600ms timeout
        const timer = setTimeout(() => resolve(json(200, { ok: true })), wait);
        init.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    const api = createClient({
      baseURL: "https://x.test",
      fetch: slowFetch,
      cache: { enabled: false },
      intelligence: { adaptiveTimeout: true },
    });

    for (let i = 0; i < 5; i++) await api.get("/search");
    await expect(api.get("/search")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("adaptiveStaleWhileRevalidate serves stale data for slow endpoints", async () => {
    let value = 0;
    const { fn } = fakeFetch(async () => {
      value += 1;
      await sleep(600);
      return json(200, { v: value });
    });
    const api = createClient({
      baseURL: "https://x.test",
      fetch: fn,
      cache: { strategy: "cache-first", ttl: 40 },
      intelligence: { adaptiveStaleWhileRevalidate: true },
    });

    const updates: Array<{ v: number }> = [];
    api.subscribe((key) => key.includes("/search"), (u) => {
      if (u.type === "revalidate" && u.response) updates.push(u.response.data as never);
    });

    for (let i = 0; i < 5; i++) {
      await api.get("/search", { cache: { ttl: 1 } }); // force network each time
      await sleep(5);
    }
    await sleep(60); // let the entry go stale

    const res = await api.get("/search");
    expect(res.data).toEqual({ v: 5 }); // stale copy served instantly, not a fresh network run
    await waitFor(() => updates.length >= 1);
    expect(updates[0]).toEqual({ v: 6 }); // background revalidate landed fresh data
  }, 15_000);

  it("observes nothing when intelligence is disabled", async () => {
    const { fn } = fakeFetch(() => json(200, { ok: true }));
    const api = createClient({
      baseURL: "https://x.test",
      fetch: fn,
      intelligence: { enabled: false },
    });
    await api.get("/x");
    expect(api.intelligence().endpoint("GET", "/x")).toBeUndefined();
    const snap = api.intelligence().snapshot();
    expect(snap.summary.totalRequests).toBe(0);
  });

  it("reset() clears endpoint history", async () => {
    const { fn } = fakeFetch(() => json(200, { ok: true }));
    const api = createClient({ baseURL: "https://x.test", fetch: fn });
    await api.get("/x");
    api.intelligence().reset();
    expect(api.intelligence().endpoint("GET", "/x")).toBeUndefined();
  });
});