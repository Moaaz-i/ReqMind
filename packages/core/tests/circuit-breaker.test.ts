import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client/client.js";
import type { Client, ClientEvents } from "../src/client/client.js";
import { CancelledError, CircuitOpenError, HttpError, TimeoutError } from "../src/errors.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  router: (
    url: string,
    method: string,
    callNumber: number,
    init: RequestInit,
  ) => Response | Promise<Response>,
): FakeFetch {
  let n = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init.method ?? "GET");
    calls.push({ url, method });
    return router(url, method, n++, init);
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

function collect<K extends keyof ClientEvents>(api: Client, event: K): Array<ClientEvents[K]> {
  const seen: Array<ClientEvents[K]> = [];
  api.on(event, (payload) => {
    seen.push(payload);
  });
  return seen;
}

type BreakerConfig = Partial<{
  enabled: boolean;
  failureThreshold: number;
  resetTimeout: number;
}>;

function breakerApi(
  router: (
    url: string,
    method: string,
    callNumber: number,
    init: RequestInit,
  ) => Response | Promise<Response>,
  breaker: BreakerConfig = {},
): FakeFetch & { api: Client } {
  const { fn, calls } = fakeFetch(router);
  const api = createClient({
    baseURL: "https://x.test",
    fetch: fn,
    cache: { enabled: false },
    retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
    circuitBreaker: { failureThreshold: 2, resetTimeout: 10_000, ...breaker },
  });
  return { api, fn, calls };
}

describe("circuit breaker", () => {
  it("isolates endpoints: /a failing never affects /b", async () => {
    const { api, calls } = breakerApi((url) => (url.includes("/a") ? json(500, {}) : json(200, { ok: true })));
    const rejected = collect(api, "circuit-rejected");

    await expect(api.get("/a")).rejects.toBeInstanceOf(HttpError);
    await expect(api.get("/a")).rejects.toBeInstanceOf(HttpError);
    expect(api.circuitBreaker().status("GET", "/a").state).toBe("open");

    expect((await api.get("/b")).status).toBe(200);
    expect(api.circuitBreaker().status("GET", "/b")).toMatchObject({ state: "closed", consecutiveFailures: 0 });

    const callsBefore = calls.length;
    await expect(api.get("/a")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls.length).toBe(callsBefore); // rejected before touching the network
    expect(rejected.map((r) => (r as { path: string }).path)).toEqual(["/a"]);
    expect((await api.get("/b")).status).toBe(200);
  });

  it("opens after consecutive failures and emits circuit-open once", async () => {
    const { api } = breakerApi(() => json(500, {}));
    const opens = collect(api, "circuit-open");

    await expect(api.get("/x")).rejects.toBeTruthy();
    await expect(api.get("/x")).rejects.toBeTruthy();

    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ endpoint: "GET /x", path: "/x" });
    expect(api.circuitBreaker().status("GET", "/x")).toMatchObject({ state: "open", consecutiveFailures: 2 });
  });

  it("does not treat 4xx as a circuit failure", async () => {
    const { api } = breakerApi(() => json(404, { not: "here" }), { failureThreshold: 2 });
    for (let i = 0; i < 5; i++) {
      await expect(api.get(`/missing?i=${i}`)).rejects.toMatchObject({ status: 404 });
    }
    expect(collect(api, "circuit-open")).toHaveLength(0);
    expect(api.circuitBreaker().status("GET", "/missing")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    await expect(api.get("/missing?i=6")).rejects.toMatchObject({ status: 404 }); // still allowed
  });

  it("does not treat cancellation as a circuit failure", async () => {
    const { api } = breakerApi(
      (url, _m, _n, init) => (url.includes("/hang") ? hang(url, init) : json(500, {})),
      { failureThreshold: 2 },
    );
    const opens = collect(api, "circuit-open");

    const p1 = api.get("/hang") as Promise<unknown> & { cancel: () => void };
    await sleep(0);
    p1.cancel();
    await expect(p1).rejects.toBeInstanceOf(CancelledError);

    const p2 = api.get("/hang") as Promise<unknown> & { cancel: () => void };
    await sleep(0);
    p2.cancel();
    await expect(p2).rejects.toBeInstanceOf(CancelledError);

    expect(api.circuitBreaker().status("GET", "/fail").consecutiveFailures).toBe(0);

    await expect(api.get("/fail")).rejects.toBeTruthy(); // real failure #1
    expect(api.circuitBreaker().status("GET", "/fail").consecutiveFailures).toBe(1);
    await expect(api.get("/fail")).rejects.toBeTruthy(); // real failure #2 → open
    expect(api.circuitBreaker().status("GET", "/fail").state).toBe("open");
    expect(opens).toHaveLength(1);
  });

  it("success resets the consecutive-failure counter while closed", async () => {
    let failing = true;
    const { api } = breakerApi(() => (failing ? json(500, {}) : json(200, { ok: true })), {
      failureThreshold: 3,
    });
    const opens = collect(api, "circuit-open");

    await expect(api.get("/svc")).rejects.toBeTruthy();
    await expect(api.get("/svc")).rejects.toBeTruthy();
    expect(api.circuitBreaker().status("GET", "/svc").consecutiveFailures).toBe(2);

    failing = false;
    await api.get("/svc"); // reset to zero
    expect(api.circuitBreaker().status("GET", "/svc").consecutiveFailures).toBe(0);

    failing = true;
    await expect(api.get("/svc")).rejects.toBeTruthy();
    await expect(api.get("/svc")).rejects.toBeTruthy();
    expect(opens).toHaveLength(0); // not at threshold yet
    await expect(api.get("/svc")).rejects.toBeTruthy(); // 3rd after reset → open
    expect(opens).toHaveLength(1);
    expect(api.circuitBreaker().status("GET", "/svc").state).toBe("open");
  });

  it("counts one terminal failure per request even with retries (5xx + timeout)", async () => {
    const { api } = breakerApi(
      (url, _m, _n, init) => (url.includes("/slow") ? hang(url, init) : json(500, {})),
      { failureThreshold: 2 },
    );

    const flaky = api.get("/flaky", { retry: { attempts: 3, baseDelay: 0, maxDelay: 0 } });
    await expect(flaky).rejects.toBeInstanceOf(HttpError);
    expect(api.circuitBreaker().status("GET", "/flaky").consecutiveFailures).toBe(1); // not 3

    const slow = api.get("/slow", { retry: { attempts: 3, baseDelay: 0 }, timeout: 20 });
    await expect(slow).rejects.toBeInstanceOf(TimeoutError);
    expect(api.circuitBreaker().status("GET", "/slow").consecutiveFailures).toBe(1);
    expect(api.circuitBreaker().status("GET", "/flaky").state).toBe("closed");
  });

  it("counts 429 + Retry-After as a single failure and respects the delay", async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = breakerApi((url) => json(429, {}, { "retry-after": "1" }));

      const p1 = api.get("/limited", { retry: { attempts: 3, baseDelay: 0, maxDelay: 0 } });
      const p1Settled = p1.then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(2100);
      const err1 = await p1Settled;
      expect(err1).toMatchObject({ status: 429 });
      expect(calls.length).toBe(3); // retried once per Retry-After second, not in a burst
      expect(api.circuitBreaker().status("GET", "/limited").consecutiveFailures).toBe(1);

      const p2 = api.get("/limited", { retry: { attempts: 3, baseDelay: 0, maxDelay: 0 } });
      const p2Settled = p2.then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(2100);
      await p2Settled;
      expect(api.circuitBreaker().status("GET", "/limited").state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits circuit-rejected for all concurrent requests while open and never hits the network", async () => {
    const { api, calls } = breakerApi(() => json(500, {}));
    const rejected = collect(api, "circuit-rejected");

    await expect(api.get("/x")).rejects.toBeTruthy();
    await expect(api.get("/x")).rejects.toBeTruthy(); // open now
    const callsOnOpen = calls.length;

    const results = await Promise.allSettled([0, 1, 2].map((i) => api.get("/x")));
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(CircuitOpenError);
    }
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(calls.length).toBe(callsOnOpen); // zero network attempts
    expect(rejected).toHaveLength(3);
  });

  it("serves a fresh cache hit while the circuit is open (uncached key is rejected)", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url === "https://x.test/users" ? json(200, { u: 1 }) : json(500, {}),
    );
    const api = createClient({
      baseURL: "https://x.test",
      fetch: fn,
      cache: { enabled: true, ttl: 60_000 },
      retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
      circuitBreaker: { failureThreshold: 1, resetTimeout: 60_000 },
    });

    await api.get("/users"); // cached (fresh)
    await expect(api.get("/users?bad=1")).rejects.toBeInstanceOf(HttpError); // 500 → opens
    expect(api.circuitBreaker().status("GET", "/users").state).toBe("open");

    const fromCache = await api.get("/users"); // fresh hit, circuit ignored
    expect(fromCache.data).toEqual({ u: 1 });
    expect(api.circuitBreaker().status("GET", "/users").state).toBe("open"); // still open
    expect(calls.filter((c) => c.url.includes("users"))).toHaveLength(2);

    await expect(api.get("/users?other=1")).rejects.toBeInstanceOf(CircuitOpenError); // uncached key
  });

  it("skips the background refetch when invalidation happens while the circuit is open", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url === "https://x.test/teams" ? json(200, {}) : json(500, {}),
    );
    const api = createClient({
      baseURL: "https://x.test",
      fetch: fn,
      cache: { enabled: true, ttl: 60_000 },
      retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
      circuitBreaker: { failureThreshold: 1, resetTimeout: 60_000 },
    });
    const revalidates = collect(api, "revalidate");
    api.subscribe((key) => key.includes("/teams"), () => undefined); // create interest

    await api.get("/teams"); // cached + watched
    await expect(api.get("/teams?bad=1")).rejects.toBeInstanceOf(HttpError); // opens
    expect(api.circuitBreaker().status("GET", "/teams").state).toBe("open");

    const beforeInvalidate = calls.filter((c) => c.url.includes("teams")).length;
    const removed = api.invalidate("/teams"); // refetch would run → blocked by the circuit
    expect(removed).toHaveLength(1);
    await sleep(10);
    expect(calls.filter((c) => c.url.includes("teams"))).toHaveLength(beforeInvalidate); // no refetch
    expect(revalidates).toHaveLength(0);
  });

  it("lets the first request past the reset act as the single half-open probe", async () => {
    let n = 0;
    const { api } = breakerApi((url) => {
      n += 1;
      return n === 1 ? json(500, {}) : json(200, { ok: true });
    }, { failureThreshold: 1, resetTimeout: 30 });
    const halves = collect(api, "circuit-half-open");
    const closes = collect(api, "circuit-closed");

    await expect(api.get("/h")).rejects.toBeTruthy(); // open
    expect(api.circuitBreaker().status("GET", "/h").state).toBe("open");

    await sleep(40); // past resetTimeout
    expect((await api.get("/h")).data).toEqual({ ok: true }); // probe allowed
    expect(api.circuitBreaker().status("GET", "/h")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect(halves).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect((await api.get("/h")).data).toEqual({ ok: true }); // normal again
  });

  it("allows exactly one probe when several requests race the OPEN→HALF_OPEN transition", async () => {
    let n = 0;
    const { api, calls } = breakerApi((url) => {
      n += 1;
      return n === 1 ? json(500, {}) : json(200, { ok: true });
    }, { failureThreshold: 1, resetTimeout: 30 });
    const rejected = collect(api, "circuit-rejected");
    const closes = collect(api, "circuit-closed");

    await expect(api.get("/pay")).rejects.toBeTruthy(); // open (threshold 1)
    await sleep(40); // past reset

    const results = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => api.get(`/pay?a=${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); // the probe
    expect(
      results.filter((r) => r.status === "rejected" && r.reason instanceof CircuitOpenError),
    ).toHaveLength(4);
    expect(calls.length).toBe(2); // the open-fail + exactly one probe
    expect(rejected).toHaveLength(4);
    await sleep(10);
    expect(api.circuitBreaker().status("GET", "/pay").state).toBe("closed");
    expect(closes).toHaveLength(1);
    expect((await api.get("/pay?a=9")).data).toEqual({ ok: true }); // fully recovered
  });

  it("reopens the circuit when the half-open probe fails", async () => {
    const { api, calls } = breakerApi(() => json(500, {}), { failureThreshold: 1, resetTimeout: 30 });
    const opens = collect(api, "circuit-open");

    await expect(api.get("/f")).rejects.toBeTruthy(); // open
    expect(opens).toHaveLength(1);
    await sleep(40);

    await expect(api.get("/f")).rejects.toBeTruthy(); // probe fails → reopen
    expect(opens).toHaveLength(2);
    expect(api.circuitBreaker().status("GET", "/f").state).toBe("open");

    const callsBefore = calls.length;
    await expect(api.get("/f")).rejects.toBeInstanceOf(CircuitOpenError); // freshly blocked again
    expect(calls.length).toBe(callsBefore);
  });

  it("cancelling the probe keeps the circuit half-open so the next request probes again", async () => {
    let n = 0;
    const { api } = breakerApi((url, _m, _n, init) => {
      n += 1;
      if (n === 1) return json(500, {});
      return hang(url, init); // probe(s) hang until cancelled
    }, { failureThreshold: 1, resetTimeout: 30 });
    const opens = collect(api, "circuit-open");

    await expect(api.get("/probe")).rejects.toBeTruthy(); // open
    expect(api.circuitBreaker().status("GET", "/probe").state).toBe("open");
    await sleep(40); // past reset

    const p1 = api.get("/probe") as Promise<unknown> & { cancel: () => void };
    await sleep(0);
    p1.cancel();
    await expect(p1).rejects.toBeInstanceOf(CancelledError);
    expect(api.circuitBreaker().status("GET", "/probe")).toMatchObject({ state: "halfOpen", probing: false });

    const p2 = api.get("/probe") as Promise<unknown> & { cancel: () => void };
    await sleep(0);
    expect(api.circuitBreaker().status("GET", "/probe").probing).toBe(true); // new probe in flight
    p2.cancel();
    await expect(p2).rejects.toBeInstanceOf(CancelledError);
    expect(opens).toHaveLength(1); // never re-opened
  });

  it("deduplicates a join onto the half-open probe instead of rejecting it", async () => {
    const calls: string[] = [];
    let n = 0;
    const { api } = breakerApi((url) => {
      calls.push(url);
      n += 1;
      return n === 1
        ? json(500, {})
        : new Promise<Response>((resolve) => {
            setTimeout(() => resolve(json(200, { ok: true })), 60);
          });
    }, { failureThreshold: 1, resetTimeout: 30 });
    const dedups = collect(api, "dedup");
    const closes = collect(api, "circuit-closed");

    await expect(api.get("/dup")).rejects.toBeTruthy(); // open
    await sleep(40); // past reset

    const [a, b] = await Promise.all([api.get("/dup"), api.get("/dup")]); // same key
    expect(a.data).toEqual({ ok: true });
    expect(b.data).toEqual({ ok: true });
    expect(calls.length).toBe(2); // probe only — b joined
    expect(dedups).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });

  it("respects enabled: false (no counting, no rejection)", async () => {
    const { api } = breakerApi(() => json(500, {}), { enabled: false, failureThreshold: 1 });
    const rejected = collect(api, "circuit-rejected");
    for (let i = 0; i < 5; i++) {
      await expect(api.get("/x")).rejects.toBeInstanceOf(HttpError); // plain HTTP failures
    }
    expect(rejected).toHaveLength(0);
    expect(api.circuitBreaker().status("GET", "/x")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("circuitBreaker().reset() restores a circuit to closed immediately", async () => {
    let n = 0;
    const { api } = breakerApi(() => {
      n += 1;
      return n <= 2 ? json(500, {}) : json(200, { ok: true });
    });
    await expect(api.get("/pay")).rejects.toBeTruthy();
    await expect(api.get("/pay")).rejects.toBeTruthy();
    expect(api.circuitBreaker().status("GET", "/pay").state).toBe("open");

    api.circuitBreaker().reset("GET", "/pay");
    expect(api.circuitBreaker().status("GET", "/pay")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect((await api.get("/pay")).data).toEqual({ ok: true }); // allowed again
  });

  it("exposes circuit state through the intelligence snapshot", async () => {
    const { api } = breakerApi(
      (url) => (url.includes("/users") ? json(200, {}) : json(500, {})),
      { failureThreshold: 3 },
    );
    await api.get("/users");
    await api.get("/users");
    for (let i = 0; i < 3; i++) await expect(api.get("/payments")).rejects.toBeTruthy(); // open
    await expect(api.get("/payments")).rejects.toBeInstanceOf(CircuitOpenError); // rejected

    const snap = api.intelligence().snapshot();
    expect(snap.summary.circuits).toEqual({ open: 1, halfOpen: 0, closed: 1 });

    const payments = snap.endpoints.find((e) => e.path === "/payments");
    expect(payments).toMatchObject({ circuit: "open", circuitFailures: 3, circuitRejected: 1 });
    const users = snap.endpoints.find((e) => e.path === "/users");
    expect(users).toMatchObject({ circuit: "closed", circuitFailures: 0 });
  });
});