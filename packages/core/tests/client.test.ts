import { describe, expect, it } from "vitest";
import { createClient } from "../src/client/client.js";
import type { Client } from "../src/client/client.js";
import { CancelledError, HttpError, TimeoutError } from "../src/errors.js";
import { Tracker } from "../src/request/tracker.js";
import type { RequestState } from "../src/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tick = (): Promise<void> => sleep(0);

async function waitFor(check: () => boolean, timeout = 2000): Promise<void> {
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
  count: () => number;
}

function fakeFetch(
  router: (url: string, method: string, callNumber: number, init: RequestInit) => Response | Promise<Response>,
): FakeFetch {
  let n = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init.method ?? "GET");
    calls.push({ url, method });
    return router(url, method, n++, init);
  };
  return { fn, calls, count: () => n };
}

/** A fetch that hangs until its signal aborts. */
function hang(
  input: RequestInfo | URL,
  initOrMethod: RequestInit | string,
  _callNumber?: number,
  init?: RequestInit,
): Promise<Response> {
  const options = init ?? (typeof initOrMethod === "object" ? initOrMethod : undefined);
  return new Promise<Response>((_resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    options?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

function client(overrides?: ConstructorParameters<typeof createClient>[0]): Client {
  const { fn, calls } = fakeFetch(() => json(200, { ok: true }));
  return createClient({ baseURL: "https://x.test", fetch: fn, cache: { enabled: false }, ...overrides });
}

describe("request deduplication", () => {
  it("coalesces identical in-flight reads into a single network call", async () => {
    let resolveFlight!: (r: Response) => void;
    const { fn, calls } = fakeFetch(() => new Promise<Response>((resolve) => (resolveFlight = resolve)));
    const api = createClient({ baseURL: "https://x.test", cache: { enabled: false }, fetch: fn });

    const a = api.get("/users");
    const b = api.get("/users");
    const c = api.get("/users");
    expect(calls.length).toBe(1);

    resolveFlight(json(200, [{ id: 1 }]));
    const results = await Promise.all([a, b, c]);
    expect(calls.length).toBe(1);
    expect(results).toHaveLength(3);
    expect((results[0].data as Array<object>).length).toBe(1);
  });

  it("treats reordered query params as a single request", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => json(200, { n: ++n }));
    const api = createClient({ baseURL: "https://x.test", cache: { enabled: false }, fetch: fn });

    const [a, b] = await Promise.all([api.get("/users?b=1&a=2"), api.get("/users?a=2&b=1")]);
    expect(calls.length).toBe(1);
    expect(a.data).toEqual({ n: 1 });
    expect(b.data).toEqual({ n: 1 });
  });

  it("does not deduplicate different requests", async () => {
    const { fn, calls } = fakeFetch((url) => json(200, { url }));
    const api = createClient({ baseURL: "https://x.test", cache: { enabled: false }, fetch: fn });
    await Promise.all([api.get("/users?page=1"), api.get("/users?page=2")]);
    expect(calls.length).toBe(2);
  });
});

describe("cache", () => {
  it("serves repeat reads from cache within the TTL", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => json(200, { n: ++n }));
    const api = createClient({ baseURL: "https://x.test", fetch: fn });

    const first = await api.get("/users");
    const second = await api.get("/users");
    expect(first.data).toEqual({ n: 1 });
    expect(second.data).toEqual({ n: 1 });
    expect(calls.length).toBe(1);
  });

  it("emits cache-hit for cached reads", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { ok: true }));
    const api = createClient({ baseURL: "https://x.test", fetch: fn });
    const hits: string[] = [];
    api.on("cache-hit", ({ key }) => hits.push(key));

    await api.get("/users");
    await api.get("/users");
    expect(calls.length).toBe(1);
    expect(hits).toHaveLength(1);
  });

  it("refetches after the cache expires", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => json(200, { n: ++n }));
    const api = createClient({ baseURL: "https://x.test", fetch: fn, cache: { enabled: true, ttl: 20 } });

    expect((await api.get("/users")).data).toEqual({ n: 1 });
    await sleep(25);
    expect((await api.get("/users")).data).toEqual({ n: 2 });
    expect(calls.length).toBe(2);
  });
});

describe("retry", () => {
  it("retries transient server errors with backoff, then succeeds", async () => {
    const statuses = [500, 502, 200];
    let i = 0;
    const { fn, calls } = fakeFetch(() => json(statuses[i++]!, { ok: i === 3 }));
    const api = createClient({
      baseURL: "https://x.test",
      cache: { enabled: false },
      retry: { attempts: 3, baseDelay: 10, jitter: false },
      fetch: fn,
    });
    const retryEvents: Array<{ attempts: number; delay: number }> = [];
    const states: RequestState[] = [];
    let tracker!: Tracker;
    api.on("retry", (e) => retryEvents.push({ attempts: e.attempts, delay: e.delay }));
    api.on("request", ({ tracker: t }) => {
      tracker = t;
      t.onChange((s) => states.push(s));
    });

    const res = await api.get("/x");
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
    expect(retryEvents).toEqual([
      { attempts: 1, delay: 10 },
      { attempts: 2, delay: 20 },
    ]);
    expect(states).toContain("retrying");
    expect(states[states.length - 1]).toBe("success");
    expect(tracker.attempts).toBe(3);
  });

  it("does not retry client errors", async () => {
    const { fn, calls } = fakeFetch(() => json(400, { msg: "bad request" }));
    const api = createClient({
      baseURL: "https://x.test",
      cache: { enabled: false },
      retry: { attempts: 5, baseDelay: 5, jitter: false },
      fetch: fn,
    });
    const errors: unknown[] = [];
    api.on("error", ({ error }) => errors.push(error));

    await expect(api.get("/x")).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(HttpError);
    expect((errors[0] as HttpError).status).toBe(400);
  });

  it("respects the Retry-After header", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() =>
      n++ === 0 ? json(429, {}, { "retry-after": "0" }) : json(200, { ok: true }),
    );
    const api = createClient({
      baseURL: "https://x.test",
      cache: { enabled: false },
      retry: { attempts: 2, baseDelay: 60_000, jitter: false },
      fetch: fn,
    });
    const retries: Array<number> = [];
    api.on("retry", ({ delay }) => retries.push(delay));

    await api.get("/x");
    expect(calls.length).toBe(2);
    expect(retries).toEqual([0]);
  });
});

describe("cancellation & timeouts", () => {
  function hangingClient(): { api: Client; fn: typeof fetch } {
    const { fn } = fakeFetch(hang);
    const api = createClient({ baseURL: "https://x.test", cache: { enabled: false }, fetch: fn });
    return { api, fn };
  }

  it("cancels an in-flight request via cancel()", async () => {
    const { api } = hangingClient();
    const cancels: string[] = [];
    api.on("cancel", ({ tracker }) => {
      cancels.push(tracker.key);
      expect(tracker.state).toBe("cancelled");
    });

    const request = api.get("/slow") as Promise<unknown> & { cancel: () => void };
    await tick();
    request.cancel();
    await expect(request).rejects.toBeInstanceOf(CancelledError);
    await tick();
    expect(cancels).toHaveLength(1);
  });

  it("cancels with an external AbortController", async () => {
    const { api } = hangingClient();
    const controller = new AbortController();
    const request = api.get("/slow", { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(request).rejects.toBeInstanceOf(CancelledError);
  });

  it("rejects already-aborted signals immediately", async () => {
    const { api } = hangingClient();
    const controller = new AbortController();
    controller.abort();
    await expect(api.get("/slow", { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it("throws a TimeoutError when the request exceeds the timeout", async () => {
    const { api } = hangingClient();
    const api2 = createClient({
      baseURL: "https://x.test",
      cache: { enabled: false },
      timeout: 20,
      fetch: hang as typeof fetch,
    });
    await expect(api2.get("/x")).rejects.toBeInstanceOf(TimeoutError);
    expect(api).toBeDefined();
  });
});

describe("stale-while-revalidate", () => {
  it("serves stale data immediately, then refreshes in the background", async () => {
    let value = 1;
    const { fn, calls } = fakeFetch(() => json(200, { value }));
    const api = createClient({ baseURL: "https://x.test", cache: { enabled: true, ttl: 30 }, fetch: fn });
    const swr = { cache: { strategy: "stale-while-revalidate" as const } };

    expect((await api.get("/products", swr)).data).toEqual({ value: 1 });
    value = 2;
    await sleep(40);

    const updates: Array<{ type: string; response?: { data: { value: number } } }> = [];
    api.subscribe((key) => key.includes("/products"), (update) => updates.push(update as never));

    const stale = await api.get("/products", swr);
    expect(stale.data).toEqual({ value: 1 });

    await waitFor(() => updates.some((u) => u.type === "revalidate"));
    expect(calls.length).toBe(2);

    const third = await api.get("/products", swr);
    expect(third.data).toEqual({ value: 2 });
    expect(calls.length).toBe(2);
  });
});

describe("mutation & cache invalidation", () => {
  it("invalidates related caches after a mutation and refetches subscribed keys", async () => {
    let users = [{ id: 1 }];
    let creates = 0;
    const { fn, calls } = fakeFetch((url, method) => {
      if (method === "POST") {
        creates += 1;
        users = [{ id: 2 }];
        return json(201, { id: 2 });
      }
      return json(200, users);
    });
    const api = createClient({ baseURL: "https://x.test", fetch: fn });
    const updates: Array<{ type: string; key: string }> = [];
    api.subscribe((key) => key.includes("/users"), (u) => updates.push(u as never));

    expect((await api.get("/users", { tags: ["users"] })).data).toEqual([{ id: 1 }]);
    expect(calls.length).toBe(1);

    await api.post("/users", { name: "Moaaz" });
    expect(creates).toBe(1);

    await waitFor(() => updates.some((u) => u.type === "revalidate"));
    expect((await api.get("/users")).data).toEqual([{ id: 2 }]);
  });

  it("refetches a subscribed key after an explicit invalidate", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => json(200, { n: ++n }));
    const api = createClient({ baseURL: "https://x.test", fetch: fn });
    const updates: Array<{ type: string }> = [];
    api.subscribe((key) => key.includes("/users"), (u) => updates.push(u as never));

    await api.get("/users", { tags: ["users"] });
    expect(calls.length).toBe(1);

    api.invalidate("users");
    await waitFor(() => updates.some((u) => u.type === "revalidate"));
    expect(calls.length).toBe(2);

    const fresh = await api.get("/users");
    expect(fresh.data).toEqual({ n: 2 });
  });
});

describe("request lifecycle", () => {
  it("walks through pending → success for a healthy read", async () => {
    const { fn } = fakeFetch(() => json(200, { ok: true }));
    const api = createClient({ baseURL: "https://x.test", cache: { enabled: false }, fetch: fn });
    const states: RequestState[] = [];
    api.on("request", ({ tracker }) => tracker.onChange((s) => states.push(s)));

    await api.get("/ok");
    expect(states).toEqual(["pending", "success"]);
  });

  it("reaches the error state and emits error", async () => {
    const { fn } = fakeFetch(() => json(404, { nope: true }));
    const api = createClient({ baseURL: "https://x.test", cache: { enabled: false }, fetch: fn });
    const states: RequestState[] = [];
    const errors: unknown[] = [];
    api.on("request", ({ tracker }) => tracker.onChange((s) => states.push(s)));
    api.on("error", ({ error }) => errors.push(error));

    await expect(api.get("/missing")).rejects.toBeInstanceOf(HttpError);
    expect(states).toEqual(["pending", "error"]);
    expect(errors).toHaveLength(1);
  });
});