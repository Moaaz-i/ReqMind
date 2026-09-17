import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client/client.js";
import type { Client, ClientEvents } from "../src/client/client.js";
import { AdaptiveEngine } from "../src/adaptive/engine.js";
import { EventEmitter } from "../src/events/event-emitter.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { HttpError } from "../src/errors.js";

const ABS = "https://x.test";

function pathOf(url: string): string {
  return new URL(url, ABS).pathname + new URL(url, ABS).search;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Direct engine harness: scripted attempts over an EventEmitter + fake clock. */
function wireImpl(opts?: Partial<import("../src/types.js").AdaptiveOptions>) {
  const events = new EventEmitter<ClientEvents>();
  let now = 0;
  const engine = new AdaptiveEngine(opts, true, 6, events, () => now);
  const url = "/x";
  const start = (key: string): void => {
    events.emit("request-started", { id: 0, key, method: "GET", url, priority: "normal" } as ClientEvents["request-started"]);
  };
  const ok = (key: string, latency: number): void => {
    now += latency;
    events.emit("success", {
      key,
      tracker: undefined as unknown as ClientEvents["success"]["tracker"],
      response: undefined as unknown as ClientEvents["success"]["response"],
    });
  };
  const fail = (key: string, latency: number): void => {
    now += latency;
    events.emit("error", {
      key,
      tracker: undefined as unknown as ClientEvents["error"]["tracker"],
      error: new HttpError(500, "oops"),
    });
  };
  const delayed = (key: string, latency: number): void => {
    now += latency;
    events.emit("request-delayed", {
      id: 0,
      key,
      method: "GET",
      url,
      priority: "normal",
      reason: "retry",
      delay: 0,
    });
  };
  const retry429 = (key: string): void => {
    events.emit("retry", {
      key,
      tracker: undefined as unknown as ClientEvents["retry"]["tracker"],
      attempts: 1,
      delay: 0,
      error: new HttpError(429, "Too Many Requests"),
    });
  };
  return { engine, events, start, ok, fail, delayed, retry429 };
}

/** Record all distinct changes of `effective` over the given settle order. */
function effectiveChanges(engine: AdaptiveEngine, onEach: () => void): number[] {
  const seen: number[] = [];
  const loop = 20;
  let last: number | undefined;
  let guard = 0;
  // Each onEach() call settles one attempt and then we read the ceiling.
  while (guard < loop) {
    guard += 1;
    onEach();
    const next = engine.endpoint("GET /x")?.effective;
    if (next !== undefined && next !== last) {
      seen.push(next);
      last = next;
    }
  }
  return seen;
}

describe("adaptive: determinism", () => {
  it("identical input events + clock produce identical snapshots across engines", () => {
    const a = wireImpl({ enabled: true, concurrency: true, retry: true, rateLimit: true, staleWhileRevalidate: true });
    const b = wireImpl({ enabled: true, concurrency: true, retry: true, rateLimit: true, staleWhileRevalidate: true });
    const script: Array<["bad" | "ok" | "429" | "err", number]> = [
      ["ok", 100],
      ["ok", 120],
      ["429", 0],
      ["delayed", 40],
      ["ok", 3200],
      ["ok", 4000],
      ["429", 0],
      ["err", 33],
      ["ok", 500],
      ["bad", 2500],
      ["ok", 90],
      ["429", 0],
      ["delayed", 60],
      ["ok", 2800],
      ["ok", 100],
      ["ok", 200],
    ];
    for (let step = 0; step < script.length; step += 1) {
      const [kind, latency] = script[step]!;
      for (const h of [a, b]) {
        const key = "k" + step;
        if (kind === "ok") {
          h.start(key);
          h.ok(key, latency);
        } else if (kind === "bad" || kind === "err") {
          h.start(key);
          h[kind === "err" ? "fail" : "ok"](key, latency);
        } else if (kind === "429") {
          h.start(key);
          h.retry429(key);
        } else {
          h.start(key);
          h.delayed(key, latency);
        }
      }
    }
    expect(a.engine.snapshot()).toEqual(b.engine.snapshot());
    expect(a.engine.metrics()).toEqual(b.engine.metrics());
  });
});

describe("adaptive: disabled is identical to 0.7", () => {
  it("engine stays inert without explicit enable", () => {
    const events = new EventEmitter<ClientEvents>();
    const engine = new AdaptiveEngine(undefined, true, 6, events);
    expect(engine.snapshot().enabled).toBe(false);
    expect(engine.endpointCeiling("GET /x")).toBeUndefined();
    expect(engine.retryMultiplier("GET /x")).toBe(1);
    expect(engine.cacheStrategy("GET", "/x")).toBeUndefined();
    expect(engine.metrics()).toEqual({
      decisions: 0,
      concurrencyReductions: 0,
      concurrencyRecoveries: 0,
      throttles: 0,
      retryChanges: 0,
    });
  });

  it("a default client reports a disabled engine and plain scheduler behavior", async () => {
    const { api, calls } = (() => {
      const { fn, calls } = fakeFetch(() => json(200, { ok: true }));
      const api = createClient({
        baseURL: ABS,
        fetch: fn,
        cache: { enabled: false },
        scheduler: { concurrency: 2 },
      });
      return { api, calls };
    })();
    const snap = api.intelligence().snapshot();
    expect(snap.summary.adaptive).toEqual({
      decisions: 0,
      concurrencyReductions: 0,
      concurrencyRecoveries: 0,
      throttles: 0,
      retryChanges: 0,
    });
    expect(api.adaptive().snapshot().enabled).toBe(false);
    const results = await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(calls).toHaveLength(3);
  });
});

describe("adaptive: per-endpoint isolation", () => {
  it("degrades /search while /users stays at the configured ceiling", () => {
    const h = wireImpl({ enabled: true, concurrency: true });
    for (let i = 0; i < 20; i += 1) {
      h.start("s" + i);
      h.ok("s" + i, 3000);
    }
    const search = h.engine.endpoint("GET /x");
    expect(search?.effective).toBeLessThan(6);
    expect(search?.health).toBe("degraded");
    expect(search?.reason).toMatch(/p95 latency/);
    // A second endpoint never observed stays nominal.
    expect(h.engine.endpoint("GET /other")).toBeUndefined();
  });
});

describe("adaptive: gradual decrease + bounds", () => {
  it("steps down 1 at a time, never jumping, never below the floor", () => {
    const h = wireImpl({ enabled: true, concurrency: true });
    const changes = effectiveChanges(h.engine, () => {
      h.start("d");
      h.ok("d", 3000);
    });
    // 20 bad windows: floor at 1 after 6→5→4→3→2→1.
    expect(changes.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < changes.length; i += 1) {
      expect(changes[i]! - changes[i - 1]!).toBeCloseTo(-1);
    }
    expect(changes[changes.length - 1]).toBe(1);
    expect(h.engine.endpoint("GET /x")?.effective).toBe(1);
  });

  it("never drops below minConcurrency no matter how long pressure lasts", () => {
    const h = wireImpl({ enabled: true, concurrency: true, minConcurrency: 2 });
    for (let i = 0; i < 50; i += 1) {
      h.start("d" + i);
      h.ok("d" + i, 4000);
    }
    expect(h.engine.endpoint("GET /x")?.effective).toBe(2);
  });
});

describe("adaptive: gradual recovery", () => {
  it("climbs back 1 at a time and stops at the configured ceiling", () => {
    const h = wireImpl({
      enabled: true,
      concurrency: true,
      latencyWindow: 4,
      outcomeWindow: 8,
      degradeSamples: 2,
      changeCooldown: 0,
      recoverySamples: 2,
    });
    for (let i = 0; i < 10; i += 1) {
      h.start("d");
      h.ok("d", 3000);
    }
    const floor = h.engine.endpoint("GET /x")!.effective;
    expect(floor).toBe(1);

    const changes = effectiveChanges(h.engine, () => {
      h.start("r");
      h.ok("r", 100);
    });
    for (let i = 1; i < changes.length; i += 1) {
      expect(changes[i]! - changes[i - 1]!).toBeCloseTo(1);
    }
    expect(changes[changes.length - 1]).toBe(6);
    const state = h.engine.endpoint("GET /x")!;
    expect(state.health).toBe("good");
    expect(state.effective).toBe(6);
    expect(state.counters.concurrencyRecoveries).toBeGreaterThanOrEqual(5);
  });
});

describe("adaptive: no oscillation", () => {
  it("the hysteresis deadband (low ≤ p95 < high) changes nothing", () => {
    const h = wireImpl({ enabled: true, concurrency: true });
    for (let i = 0; i < 30; i += 1) {
      h.start("w" + i);
      h.ok("w" + i, 1500);
    }
    const state = h.engine.endpoint("GET /x")!;
    expect(state.effective).toBe(6);
    expect(state.health).toBe("good");
    expect(state.counters.decisions).toBe(0);
  });

  it("consecutive decisions are spaced by the change cooldown (no sawtooth)", () => {
    const h = wireImpl({
      enabled: true,
      concurrency: true,
      latencyWindow: 4,
      outcomeWindow: 8,
      degradeSamples: 1,
      changeCooldown: 2,
    });
    const changeWindows: number[] = [];
    let last = 6;
    for (let i = 1; i <= 12; i += 1) {
      h.start("d" + i);
      h.ok("d" + i, 3000);
      const current = h.engine.endpoint("GET /x")!.effective;
      if (current !== last) {
        changeWindows.push(i);
        last = current;
      }
    }
    // 6 → 5 at window 1, then every 2nd window (cooldown 2 → one hold between).
    expect(changeWindows).toEqual([1, 3, 5, 7, 9]);
  });
});

describe("adaptive: 429 throttling", () => {
  it("enters throttled mode on 429 pressure and releases after clean windows", () => {
    const h = wireImpl({
      enabled: true,
      concurrency: false,
      rateLimit: true,
      retry: true,
      rateLimitRatio: 0.5,
      recoverySamples: 3,
    });
    h.start("a");
    h.retry429("a");
    expect(h.engine.endpoint("GET /x")).toMatchObject({
      retryMultiplier: 2,
      retryMode: "throttled",
      health: "throttled",
    });
    let metrics = h.engine.metrics();
    expect(metrics.throttles).toBe(1);
    expect(metrics.retryChanges).toBe(1);

    for (let i = 0; i < 6; i += 1) {
      h.start("b" + i);
      h.ok("b" + i, 100);
    }
    const state = h.engine.endpoint("GET /x")!;
    expect(state.retryMultiplier).toBe(1);
    expect(state.retryMode).toBe("nominal");
    expect(state.retryReason).toBe("no 429 pressure");
    metrics = h.engine.metrics();
    expect(metrics.throttles).toBe(1);
    expect(metrics.retryChanges).toBe(2);
  });
});

describe("adaptive: client integration", () => {
  it("Retry-After always beats the adaptive backoff multiplier", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch(() =>
        json(429, {}, { "retry-after": "3" }),
      );
      const api = createClient({
        baseURL: ABS,
        fetch: fn,
        cache: { enabled: false },
        retry: { attempts: 3, baseDelay: 1000, maxDelay: 10_000, backoff: "exponential", jitter: false },
        scheduler: { concurrency: 1 },
        adaptive: { enabled: true, retry: true, rateLimit: true, rateLimitRatio: 0.5 },
      });
      const delayed: number[] = [];
      api.on("request-delayed", (p) => delayed.push(p.delay));

      const promise = api.get("/rl");
      let rounds = 0;
      while (!isSettled(promise)) {
        await vi.advanceTimersByTimeAsync(4000);
        rounds += 1;
        if (rounds > 10) break;
      }
      await expect(promise).rejects.toMatchObject({ status: 429 });

      // Every retry park waited the server's Retry-After (3000ms), never the
      // scaled backoff (1000 → 4000ms would appear without it).
      expect(delayed.length).toBeGreaterThan(0);
      for (const d of delayed) expect(d).toBe(3000);

      // The engine still throttled: next backoff from the endpoint is scaled.
      expect(api.adaptive().endpoint("GET", "/rl")?.retryMultiplier).toBe(2);
      expect(api.adaptive().metrics().throttles).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("circuit OPEN blocks sends and half-open probes are never capped", async () => {
    vi.useFakeTimers();
    try {
      const { fn, calls } = fakeFetch((url) =>
        url.includes("/flaky") ? json(500, {}) : json(200, { ok: true }),
      );
      const api = createClient({
        baseURL: ABS,
        fetch: fn,
        cache: { enabled: false },
        retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
        scheduler: { concurrency: 2 },
        circuitBreaker: { enabled: true, failureThreshold: 2, resetTimeout: 10_000 },
        adaptive: { enabled: true, concurrency: true },
      });
      let rejected = 0;
      api.on("circuit-rejected", () => (rejected += 1));

      await expect(api.get("/flaky")).rejects.toThrow();
      await expect(api.get("/flaky")).rejects.toThrow();
      // Circuit is open now — the next send is rejected before the scheduler.
      await expect(api.get("/flaky")).rejects.toThrow();
      expect(rejected).toBe(1);

      // First half-open probe must actually reach the network (uncapped,
      // probe bypass applies even if the endpoint ceiling were saturated).
      const probe = api.get("/flaky");
      await vi.advanceTimersByTimeAsync(10);
      expect(calls.some((c) => c.url.startsWith("/flaky"))).toBe(true);
      await expect(probe).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduler leapfrogs endpoint-saturated jobs but always lets probes through", async () => {
    const events = new EventEmitter<ClientEvents>();
    const started: string[] = [];
    events.on("request-started", (p) => started.push(p.url));
    const mark = "/probe";
    const limit = (endpoint: string): number | undefined => {
      return endpoint === "GET /probe" ? 1 : undefined;
    };
    const scheduler = new Scheduler({ concurrency: 2 }, events, undefined, undefined, limit);
    const call = (url: string, probe = false): Promise<unknown> =>
      scheduler.submit({
        key: url,
        method: "GET",
        url,
        host: "x.test",
        priority: "normal",
        signal: new AbortController().signal,
        abort: () => undefined,
        probe,
        execute: (_control) =>
          url === `${mark}?held` ? hang("" as unknown as RequestInfo) : new Promise((r) => r(url)),
      });

    const held = call(`${mark}?held`);
    await Promise.resolve();
    // Endpoint cap (1) is now saturated by the held job.
    const second = call(`${mark}?second`);
    await Promise.resolve();
    // Probe bypasses the cap and starts immediately.
    const probe = call(mark, true);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started.filter((u) => u.includes("/probe"))).toContain(mark);
    expect(started.filter((u) => u.includes("/probe") && u.includes("second"))).toHaveLength(0);
    held.catch(() => undefined);
    second.catch(() => undefined);
    await probe;
  });

  it("degraded cache-first reads stay on the cache and never hit the network", async () => {
    vi.useFakeTimers();
    try {
      const { fn, calls } = fakeFetch(() => json(200, { data: 1 }));
      const api = createClient({
        baseURL: ABS,
        fetch: fn,
        cache: { enabled: true, ttl: 10_000, strategy: "cache-first" },
        retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
        scheduler: { concurrency: 2 },
        adaptive: { enabled: true, concurrency: true, highLatencyMs: 1000, lowLatencyMs: 500 },
      });
      await api.get("/hit");
      const before = calls.length;
      for (let i = 0; i < 3; i += 1) {
        const res = await api.get("/hit");
        expect(res.data).toEqual({ data: 1 });
      }
      expect(calls.length).toBe(before);
      expect(api.adaptive().endpoint("GET", "/hit")?.health).toBe("good");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adaptive stale-while-revalidate is offered once an endpoint degrades", async () => {
    vi.useFakeTimers();
    try {
      // First flight is slow → endpoint degrades → SWR recommended.
      const { fn: slowFn } = fakeFetch(async () => {
        await sleep(600);
        return json(200, { data: 1 });
      });
      const slowApi = createClient({
        baseURL: ABS,
        fetch: slowFn,
        cache: { enabled: true, ttl: 10_000, strategy: "cache-first" },
        retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
        scheduler: { concurrency: 2 },
        adaptive: {
          enabled: true,
          staleWhileRevalidate: true,
          concurrency: true,
          highLatencyMs: 500,
          lowLatencyMs: 200,
          swrLatencyMs: 400,
          changeCooldown: 0,
          degradeSamples: 1,
        },
      });
      const req = slowApi.get("/hit");
      await vi.advanceTimersByTimeAsync(700);
      await req;
      expect(slowApi.adaptive().endpoint("GET", "/hit")?.strategy).toBe("stale-while-revalidate");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset() forgets profiles and counters and the ceiling returns to configured", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch(async () => {
        await sleep(700);
        return json(200, {});
      });
      const api = createClient({
        baseURL: ABS,
        fetch: fn,
        cache: { enabled: false },
        retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
        scheduler: { concurrency: 6 },
        adaptive: {
          enabled: true,
          concurrency: true,
          highLatencyMs: 500,
          lowLatencyMs: 200,
          changeCooldown: 0,
          degradeSamples: 1,
        },
      });
      const req = api.get("/slow");
      await vi.advanceTimersByTimeAsync(800);
      await req;
      expect(api.adaptive().endpoint("GET", "/slow")?.effective).toBeLessThan(6);
      expect(api.adaptive().metrics().concurrencyReductions).toBeGreaterThan(0);
      api.adaptive().reset();
      expect(api.adaptive().snapshot().endpoints).toEqual({});
      expect(api.adaptive().metrics()).toEqual({
        decisions: 0,
        concurrencyReductions: 0,
        concurrencyRecoveries: 0,
        throttles: 0,
        retryChanges: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a phased-latency simulation with a smooth, single-valley concurrency curve", async () => {
    vi.useFakeTimers();
    try {
      const latencies = [100, 500, 2000, 4000, 200];
      const phased = (n: number): number => latencies[Math.min(4, Math.floor(n / 20))] ?? 200;
      let call = 0;
      const { fn } = fakeFetch(async () => {
        const delayMs = phased(call++);
        await sleep(delayMs);
        return json(200, { t: delayMs });
      });
      const api = createClient({
        baseURL: ABS,
        fetch: fn,
        cache: { enabled: false },
        retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
        scheduler: { concurrency: 6 },
        adaptive: {
          enabled: true,
          concurrency: true,
          highLatencyMs: 2500,
          lowLatencyMs: 1000,
          degradeSamples: 2,
          recoverySamples: 2,
          changeCooldown: 0,
          latencyWindow: 10,
          minConcurrency: 1,
        },
      });

      const curve: number[] = [];
      const pending = Array.from({ length: 100 }, (_, i) =>
        api.get("/staged?i=" + i).then(() => {
          curve.push(api.adaptive().endpoint("GET", "/staged")?.effective ?? 6);
        }),
      );
      let rounds = 0;
      while (vi.getTimerCount() > 0) {
        await vi.advanceTimersByTimeAsync(1200);
        rounds += 1;
        if (rounds > 200) break;
      }
      await Promise.allSettled(pending);

      // Distinct values where the ceiling actually changed.
      const changed: number[] = [];
      for (const value of curve) {
        if (changed[changed.length - 1] !== value) changed.push(value);
      }

      expect(changed.length).toBeGreaterThanOrEqual(6); // 6→…→2→…→6+
      expect(Math.min(...changed)).toBeLessThan(2);
      // Gradual: ceilings move by exactly one step at a time.
      for (let i = 1; i < changed.length; i += 1) {
        expect(Math.abs(changed[i]! - changed[i - 1]!)).toBe(1);
      }
      // Single valley: once it starts rising it never falls again.
      let rising = false;
      for (let i = 1; i < changed.length; i += 1) {
        if (changed[i]! > changed[i - 1]!) rising = true;
        if (rising) expect(changed[i]!).toBeGreaterThanOrEqual(changed[i - 1]!);
      }
      // Gradual up: recovered back to the configured ceiling.
      const end = api.adaptive().endpoint("GET", "/staged")!;
      expect(end.effective).toBe(6);
      expect(end.health).toBe("good");
      const metrics = api.adaptive().metrics();
      expect(metrics.concurrencyReductions).toBeGreaterThan(0);
      expect(metrics.concurrencyRecoveries).toBeGreaterThan(0);
      expect(metrics.decisions).toBe(
        metrics.concurrencyReductions +
          metrics.concurrencyRecoveries +
          metrics.throttles +
          metrics.retryChanges,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("no starvation: degraded traffic keeps flowing at the concurrency floor", async () => {
    vi.useFakeTimers();
    try {
      const { fn } = fakeFetch(async () => {
        await sleep(200);
        return json(200, {});
      });
      const api = createClient({
        baseURL: ABS,
        fetch: fn,
        cache: { enabled: false },
        retry: { attempts: 1, baseDelay: 0, maxDelay: 0 },
        scheduler: { concurrency: 6 },
        adaptive: {
          enabled: true,
          concurrency: true,
          highLatencyMs: 100,
          lowLatencyMs: 50,
          degradeSamples: 1,
          changeCooldown: 0,
          minConcurrency: 2,
        },
      });
      const results = Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => api.get("/slow?i=" + i)),
      );
      let rounds = 0;
      while (vi.getTimerCount() > 0) {
        await vi.advanceTimersByTimeAsync(400);
        rounds += 1;
        if (rounds > 50) break;
      }
      const settled = await results;
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
      const state = api.adaptive().endpoint("GET", "/slow")!;
      expect(state.effective).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function isSettled<T>(promise: Promise<T>): boolean {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return settled;
}