import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client/client.js";
import type { Client, ClientEvents } from "../src/client/client.js";
import { CancelledError, CircuitOpenError, HttpError } from "../src/errors.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ABS = "https://x.test";

/** Strip the client's base URL so expectations can use logical paths. */
function pathOf(url: string): string {
  const parsed = new URL(url, ABS);
  return parsed.pathname + parsed.search;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Router = (
  url: string,
  method: string,
  callNumber: number,
  init: RequestInit,
) => Response | Promise<Response>;

function fakeFetch(router: Router): { fn: typeof fetch; calls: Array<{ url: string; method: string }> } {
  let n = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init.method ?? "GET");
    calls.push({ url: pathOf(url), method });
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

type SchedulerConfig = Partial<{
  enabled: boolean;
  concurrency: number;
  priority: boolean;
  hosts: Record<string, number>;
  rateLimit: { requests: number; interval: number };
}>;

function schedulerApi(
  router: Router,
  scheduler: SchedulerConfig = {},
  options: Partial<Parameters<typeof createClient>[0]> = {},
): { api: Client; fn: typeof fetch; calls: Array<{ url: string; method: string }> } {
  const { fn, calls } = fakeFetch(router);
  const api = createClient({
    baseURL: ABS,
    fetch: fn,
    cache: { enabled: false },
    retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
    scheduler,
    ...options,
  });
  return { api, fn, calls };
}

/** Build a client whose /hold requests never settle until their signal aborts. */
function scheduleHangApi(
  scheduler: SchedulerConfig,
  options: Partial<Parameters<typeof createClient>[0]> = {},
): { api: Client; fn: typeof fetch; calls: Array<{ url: string; method: string }> } {
  return schedulerApi(
    (url, _method, _n, init) =>
      url.includes("/hold")
        ? hang(url, init)
        : url.includes("?bad")
          ? json(500, {})
          : json(200, { ok: true }),
    scheduler,
    options,
  );
}

function maxInWindow(timestamps: number[], interval: number): number {
  let max = 0;
  for (let i = 0; i < timestamps.length; i += 1) {
    let count = 0;
    for (let j = i; j < timestamps.length; j += 1) {
      if (timestamps[j] - timestamps[i] < interval) count += 1;
    }
    max = Math.max(max, count);
  }
  return max;
}

describe("scheduler: FIFO within a priority", () => {
  it("runs queued requests of the same priority in submission order", async () => {
    const { api, calls } = schedulerApi((url) => json(200, { url: pathOf(url) }), { concurrency: 1 });
    const reqs = [api.get("/a"), api.get("/b"), api.get("/c")];
    await Promise.all(reqs);
    expect(calls.map((call) => call.url)).toEqual(["/a", "/b", "/c"]);
  });
});

describe("scheduler: priority scheduling", () => {
  it("serves high before normal before low (weighted round-robin)", async () => {
    const { api, calls } = schedulerApi((url) => json(200, { url: pathOf(url) }), { concurrency: 1, priority: true });
    const reqs = [
      api.get("/normal"),
      api.get("/low", { priority: "low" }),
      api.get("/high-a", { priority: "high" }),
      api.get("/high-b", { priority: "high" }),
    ];
    await Promise.all(reqs);
    expect(calls.map((call) => call.url)).toEqual(["/normal", "/high-a", "/high-b", "/low"]);
  });
});

describe("scheduler: fairness / no starvation", () => {
  it("a low-priority request always gets served under a high-priority flood", async () => {
    const { api, calls } = schedulerApi((url) => json(200, { url: pathOf(url) }), { concurrency: 1, priority: true });
    const highs = Array.from({ length: 8 }, (_, i) => api.get(`/high-${i}`, { priority: "high" }));
    const low = api.get("/low-000", { priority: "low" });
    await Promise.all([...highs, low]);
    // Pattern is high×4 then low: the low request must be 5th, never starved.
    expect(calls[4].url).toBe("/low-000");
  });
});

describe("scheduler: global concurrency", () => {
  it("never exceeds the concurrency cap while queueing the rest", async () => {
    let outstanding = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const { api, calls } = schedulerApi(() => {
      outstanding += 1;
      peak = Math.max(peak, outstanding);
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          outstanding -= 1;
          resolve(json(200, {}));
        });
      });
    }, { concurrency: 3 });

    const reqs = Array.from({ length: 10 }, (_, i) => api.get(`/r${i}`));
    expect(peak).toBe(3);
    expect(api.scheduler().stats()).toMatchObject({ active: 3, queued: 7 });

    let handled = 0;
    while (handled < 10) {
      releases.shift()?.();
      handled += 1;
      await sleep(0);
    }
    await Promise.all(reqs);
    expect(peak).toBe(3);
    expect(calls).toHaveLength(10);
    expect(api.scheduler().stats()).toMatchObject({ active: 0, queued: 0, completed: 10 });
  });
});

describe("scheduler: per-host concurrency", () => {
  it("caps concurrency independently per host", async () => {
    const outstanding: Record<string, number> = {};
    const peaks: Record<string, number> = {};
    const releases: Array<() => void> = [];
    const router: Router = (url) => {
      const host = new URL(url).hostname;
      outstanding[host] = (outstanding[host] ?? 0) + 1;
      peaks[host] = Math.max(peaks[host] ?? 0, outstanding[host]);
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          outstanding[host] -= 1;
          resolve(json(200, {}));
        });
      });
    };
    const { api, calls } = schedulerApi(router, { concurrency: 8, hosts: { "a.test": 1, "b.test": 3 } });

    const reqs = [
      ...Array.from({ length: 6 }, (_, i) => api.get(`https://a.test/aa${i}`)),
      ...Array.from({ length: 6 }, (_, i) => api.get(`https://b.test/bb${i}`)),
    ];
    expect(peaks).toEqual({ "a.test": 1, "b.test": 3 });

    let handled = 0;
    while (handled < 12) {
      releases.shift()?.();
      handled += 1;
      await sleep(0);
    }
    await Promise.all(reqs);
    expect(peaks).toEqual({ "a.test": 1, "b.test": 3 });
    expect(calls).toHaveLength(12);
  });
});

describe("scheduler: rate limiting", () => {
  it("never starts more than `requests` flights inside any `interval` window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const starts: number[] = [];
      const { api } = schedulerApi((url) => json(200, { url: pathOf(url) }), {
        concurrency: 8,
        rateLimit: { requests: 2, interval: 1000 },
      });
      api.on("request-started", () => starts.push(Date.now()));

      const reqs = Array.from({ length: 5 }, (_, i) => api.get(`/rl${i}`));
      expect(api.scheduler().stats()).toMatchObject({ active: 2, delayed: 3 });

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all(reqs);

      expect(starts).toHaveLength(5);
      expect(maxInWindow(starts, 1000)).toBeLessThanOrEqual(2);
      expect(api.scheduler().stats()).toMatchObject({ active: 0, queued: 0, delayed: 0, completed: 5 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler: server-aware Retry-After", () => {
  it("parks on Retry-After, frees the slot, then resumes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const { api, calls } = schedulerApi(
        (url) =>
          url.includes("/limited")
            ? json(429, { error: "nope" }, { "retry-after": "4" })
            : json(200, { ok: true }),
        { concurrency: 1 },
        { retry: { attempts: 2, baseDelay: 0, maxDelay: 0 } },
      );
      const delayed = collect(api, "request-delayed");

      const limited = api.get("/limited").catch((error) => error);
      const other = api.get("/other");

      await vi.advanceTimersByTimeAsync(0);
      expect(calls[0].url).toBe("/limited");
      expect(calls[1].url).toBe("/other");
      expect(api.scheduler().stats().active).toBe(0);
      expect(delayed[0]).toMatchObject({ reason: "retry-after", delay: 4000 });
      expect(pathOf(delayed[0].url)).toBe("/limited");

      await vi.advanceTimersByTimeAsync(4_000);
      const result = await limited;
      await other;
      expect(result).toBeInstanceOf(HttpError);
      expect(calls.filter((call) => call.url === "/limited")).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler: retry backoff parks the job", () => {
  it("releases its slot during backoff so other traffic proceeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const { api, calls } = schedulerApi(
        (url, _method, n) => (url.includes("/flaky") && n === 0 ? json(500, {}) : json(200, { ok: true })),
        { concurrency: 1 },
        { retry: { attempts: 2, baseDelay: 300, maxDelay: 300 } },
      );
      const delayed = collect(api, "request-delayed");
      const scheduled = collect(api, "request-scheduled");

      const flaky = api.get("/flaky");
      const other = api.get("/other");

      await vi.advanceTimersByTimeAsync(0);
      expect(calls[0].url).toBe("/flaky");
      expect(calls[1].url).toBe("/other");
      expect(delayed[0]).toMatchObject({ reason: "retry" });
      expect(delayed[0].delay).toBeGreaterThanOrEqual(150);
      expect(delayed[0].delay).toBeLessThanOrEqual(600);

      await vi.advanceTimersByTimeAsync(300);
      await Promise.all([flaky, other]);
      expect(calls.filter((call) => call.url === "/flaky")).toHaveLength(2);
      expect(scheduled).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler: queue groups", () => {
  it("cancels requests in a group, running or queued, without touching others", async () => {
    const { api, calls } = scheduleHangApi({ concurrency: 1 });
    const rejected = collect(api, "request-rejected");

    const hold = api.get("/hold", { scheduler: { group: "g1" } }).catch((error) => error);
    const next = api.get("/next", { scheduler: { group: "g1" } }).catch((error) => error);
    const survivor = api.get("/survivor", { scheduler: { group: "g2" } });

    api.scheduler().cancelGroup("g1");

    expect(await hold).toBeInstanceOf(CancelledError);
    expect(await next).toBeInstanceOf(CancelledError);
    expect((await survivor).status).toBe(200);
    expect(calls.some((call) => call.url === "/survivor")).toBe(true);
    expect(rejected.map((event) => pathOf(event.url)).sort()).toEqual(["/hold", "/next"]);
    expect(api.scheduler().stats().rejected).toBe(2);
  });

  it("pauses and resumes a group: paused jobs stay queued, resume lets them run", async () => {
    const { api, calls } = scheduleHangApi({ concurrency: 1 });
    const paused = collect(api, "queue-paused");
    const resumed = collect(api, "queue-resumed");

    const hold = api.get("/hold?1", { scheduler: { group: "a" } });
    const holdSettled = hold.catch((error) => error);
    const blocked = api.get("/blocked", { scheduler: { group: "a" } });
    const survivor = api.get("/survivor", { scheduler: { group: "b" } });

    api.scheduler().pauseGroup("a");
    expect(paused[0]).toEqual({ group: "a" });

    hold.cancel();
    await holdSettled;
    expect(calls.map((call) => call.url)).toEqual(["/hold?1=", "/survivor"]);

    api.scheduler().resumeGroup("a");
    expect(resumed[0]).toEqual({ group: "a" });

    await Promise.all([blocked, survivor]);
    expect(calls.map((call) => call.url).sort()).toEqual(["/blocked", "/hold?1=", "/survivor"]);
  });
});

describe("scheduler: events", () => {
  it("emits the full scheduler lifecycle", async () => {
    const { api } = scheduleHangApi({ concurrency: 1, priority: true });

    const queued = collect(api, "request-queued");
    const dequeued = collect(api, "request-dequeued");
    const started = collect(api, "request-started");
    const prioritized = collect(api, "request-prioritized");
    const rejected = collect(api, "request-rejected");

    const hold = api.get("/hold?1");
    const holdSettled = hold.catch((error) => error);
    const promoted = api.get("/promoted", { scheduler: { group: "users" } });

    expect(queued.some((event) => pathOf(event.url) === "/promoted")).toBe(true);
    expect(api.scheduler().prioritize("users", "high")).toBe(1);
    expect(pathOf(prioritized[0].url)).toBe("/promoted");
    expect(prioritized[0]).toMatchObject({ priority: "high", to: "high", from: "normal" });

    const doomed = api.get("/doomed", { scheduler: { group: "temp" } }).catch((error) => error);
    api.scheduler().cancelGroup("temp");
    await doomed;
    expect(pathOf(rejected[0].url)).toBe("/doomed");
    expect(rejected[0]).toMatchObject({ reason: "cancelled" });

    hold.cancel();
    await holdSettled;
    await promoted;
    expect(dequeued.map((event) => pathOf(event.url))).toContain("/promoted");
    expect(started.map((event) => pathOf(event.url))).toContain("/promoted");
  });
});

describe("scheduler: delay/pause/resume events", () => {
  it("emits delayed + scheduled around a park, and queue-paused/resumed for groups", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const { api } = schedulerApi(
        (url) => (url.includes("/flaky") ? json(429, { error: "nope" }, { "retry-after": "1" }) : json(200, { ok: true })),
        { concurrency: 1 },
        { retry: { attempts: 2, baseDelay: 0, maxDelay: 0 } },
      );
      const delayed = collect(api, "request-delayed");
      const rejected = collect(api, "request-rejected");
      const paused = collect(api, "queue-paused");
      const resumed = collect(api, "queue-resumed");

      const flaky = api.get("/flaky", { scheduler: { group: "g" } }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(delayed[0]).toMatchObject({ reason: "retry-after", delay: 1000 });

      const doomed = api.get("/doomed", { scheduler: { group: "g" } });
      api.scheduler().pauseGroup("g");
      api.scheduler().cancelGroup("g");
      await doomed.catch((error) => error);
      // cancelGroup also cancels the parked /flaky job in the same group.
      expect(rejected.map((event) => pathOf(event.url)).sort()).toEqual(["/doomed", "/flaky"]);
      expect(paused[0]).toEqual({ group: "g" });

      api.scheduler().resumeGroup("g");
      expect(resumed[0]).toEqual({ group: "g" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler: circuit breaker interaction", () => {
  it("rejects at submit time when the circuit is open without queueing", async () => {
    const { api, calls } = schedulerApi(
      (url) => (url.includes("/x") ? json(500, {}) : json(200, { ok: true })),
      { concurrency: 1 },
      { circuitBreaker: { failureThreshold: 2, resetTimeout: 60_000 } },
    );
    await api.get("/x?a").catch((error) => error);
    await api.get("/x?b").catch((error) => error);
    expect(api.circuitBreaker().status("GET", "/x").state).toBe("open");

    const attempt = api.get("/x?c").catch((error) => error);
    expect(api.scheduler().stats().queued).toBe(0);
    expect(await attempt).toBeInstanceOf(CircuitOpenError);
    expect(calls).toHaveLength(2);
  });

  it("rejects a queued request whose circuit opens while it waits", async () => {
    const { api, calls } = scheduleHangApi(
      { concurrency: 2 },
      { circuitBreaker: { failureThreshold: 1, resetTimeout: 60_000 } },
    );
    const rejectedEvents = collect(api, "circuit-rejected");

    const hold = api.get("/hold?1");
    const holdSettled = hold.catch((error) => error);
    // A failing request on the SAME pathname (GET /fail) opens its circuit
    // while the /fail?ok job sits queued behind the hanging slot.
    const bad = api.get("/fail?bad").catch((error) => error);
    const queued = api.get("/fail?ok").catch((error) => error);

    await bad;
    await sleep(0);
    const error = await queued;
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(rejectedEvents[0]).toMatchObject({ endpoint: "GET /fail" });
    expect(calls.filter((call) => call.url.startsWith("/fail?ok"))).toHaveLength(0);
    expect(api.scheduler().stats().rejected).toBe(1);

    hold.cancel();
    await holdSettled;
  });

  it("lets a half-open probe run despite the pre-start gate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const { api, calls } = schedulerApi(
        (url) => (url.includes("/fail?a") ? json(500, {}) : json(200, { ok: true })),
        { concurrency: 1 },
        { circuitBreaker: { failureThreshold: 1, resetTimeout: 1000 } },
      );
      await api.get("/fail?a").catch((error) => error);
      await api.get("/fail?b").catch((error) => error);
      expect(calls).toHaveLength(1);
      expect(api.circuitBreaker().status("GET", "/fail").state).toBe("open");

      await vi.advanceTimersByTimeAsync(1_000);
      const response = await api.get("/fail?c").catch((error) => error);
      expect(response.status).toBe(200);
      expect(api.circuitBreaker().status("GET", "/fail").state).toBe("closed");
      expect(calls.map((call) => call.url)).toEqual(["/fail?a=", "/fail?c="]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler: deduplication interaction", () => {
  it("coalesces an identical queued request instead of starting a second job", async () => {
    const releases: Array<() => void> = [];
    const { api, calls } = schedulerApi(
      (url) =>
        new Promise<Response>((resolve) => {
          if (url.includes("/users")) releases.push(() => resolve(json(200, { users: ["a"] })));
          else resolve(json(200, { ok: true }));
        }),
      { concurrency: 1 },
    );
    const dedupEvents = collect(api, "dedup");
    const first = api.get("/users?x=1");
    // B reaches the client while A occupies the only slot and is still in flight.
    const second = api.get("/users?x=1");
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(calls.filter((call) => call.url === "/users?x=1")).toHaveLength(1);
    expect(dedupEvents).toHaveLength(1);
    expect(dedupEvents[0]).toMatchObject({ consumers: 2 });
    expect((await second).data).toEqual({ users: ["a"] });
    expect(api.scheduler().stats().completed).toBe(1);
  });
});

describe("scheduler: cache hits do not occupy slots", () => {
  it("serves a cache-first hit without scheduling a network job", async () => {
    const { api, calls } = schedulerApi(
      (url) => json(200, { value: pathOf(url) }),
      { concurrency: 2 },
      { cache: { enabled: true, ttl: 60_000 } },
    );
    const first = await api.get("/cached");
    expect(first.data).toEqual({ value: "/cached" });
    expect(calls).toHaveLength(1);

    const started = collect(api, "request-started");
    const queued = collect(api, "request-queued");
    const hit = await api.get("/cached");
    expect(hit.data).toEqual({ value: "/cached" });
    expect(calls).toHaveLength(1);
    expect(started).toHaveLength(0);
    expect(queued).toHaveLength(0);
    expect(api.scheduler().stats()).toMatchObject({ active: 0, queued: 0, completed: 1 });
  });
});

describe("scheduler: cancelAll", () => {
  it("cancels running and queued work and settles every promise", async () => {
    const { api, calls } = scheduleHangApi({ concurrency: 1 });

    const hold = api.get("/hold?1").catch((error) => error);
    const queued = api.get("/queued").catch((error) => error);

    api.cancelAll();

    expect(await hold).toBeInstanceOf(CancelledError);
    expect(await queued).toBeInstanceOf(CancelledError);
    expect(api.scheduler().stats()).toMatchObject({ rejected: 2, active: 0, queued: 0 });
    expect(calls.filter((call) => call.url === "/queued")).toHaveLength(0);
  });
});

describe("scheduler: cancellation of a parked job does not leak", () => {
  it("parking then cancelling releases the slot and the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const { api } = schedulerApi(
        (url) => (url.includes("/flaky") ? json(429, { error: "nope" }, { "retry-after": "5" }) : json(200, { ok: true })),
        { concurrency: 1 },
        { retry: { attempts: 3, baseDelay: 0, maxDelay: 0 } },
      );
      const flaky = api.get("/flaky", { scheduler: { group: "g" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(api.scheduler().stats().delayed).toBe(1);

      api.scheduler().cancelGroup("g");
      await flaky.catch((error) => error);

      expect(api.scheduler().stats()).toMatchObject({ active: 0, delayed: 0, rejected: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler: transparent mode", () => {
  it("runs immediately with no scheduler events and no queue accounting", async () => {
    const { api, calls } = schedulerApi((url) => json(200, { ok: true }), {}, { scheduler: undefined });
    const queued = collect(api, "request-queued");
    const started = collect(api, "request-started");

    await api.get("/plain");
    expect(calls).toHaveLength(1);
    expect(queued).toHaveLength(0);
    expect(started).toHaveLength(0);
    expect(api.scheduler().stats()).toEqual({
      active: 0,
      queued: 0,
      delayed: 0,
      // Transparent mode still counts a finished request as completed.
      completed: 1,
      rejected: 0,
      lanes: { high: 0, normal: 0, low: 0 },
    });
  });
});

describe("scheduler: stress / leak check", () => {
  it("settles thousands of requests with no leaked timers or stuck state", async () => {
    const { api, calls } = schedulerApi((url) => json(200, { url: pathOf(url) }), { concurrency: 8 });

    const reqs = Array.from({ length: 2_000 }, (_, i) => api.get(`/r${i}`).then((res) => res.data as { url: string }));
    const results = await Promise.all(reqs);

    expect(calls).toHaveLength(2_000);
    expect(results[0].url).toBe("/r0");
    expect(results[1_999].url).toBe("/r1999");
    expect(api.scheduler().stats()).toEqual({
      active: 0,
      queued: 0,
      delayed: 0,
      completed: 2_000,
      rejected: 0,
      lanes: { high: 0, normal: 0, low: 0 },
    });
  });
});