import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheStore } from "../src/cache/cache-store.js";
import { createFingerprint } from "../src/utils/fingerprint.js";

const SPEC = {
  method: "GET",
  url: "/users",
  headers: {},
  retry: { attempts: 1 },
} as const;

const RESPONSE = { data: 1, status: 200, statusText: "OK", headers: new Headers() };

function key(url: string): string {
  return createFingerprint({ method: "GET", url });
}

let store: CacheStore;

beforeEach(() => {
  store = new CacheStore();
});

describe("CacheStore", () => {
  it("stores and returns fresh entries", () => {
    store.set({ key: "k", response: RESPONSE, spec: SPEC as never, ttl: 10_000 });
    expect(store.get("k")).toBeDefined();
  });

  it("expires an entry after its TTL", () => {
    vi.useFakeTimers();
    try {
      store.set({ key: "k", response: RESPONSE, spec: SPEC as never, ttl: 100 });
      expect(store.get("k")).toBeDefined();
      vi.advanceTimersByTime(101);
      expect(store.get("k")).toBeUndefined();
      expect(store.peek("k")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates by path including children and query variants", () => {
    ["/users", "/users/10", "/users?page=1", "/users-evil"].forEach((url) => {
      store.set({ key: key(url), path: (url.split("?")[0] ?? "") || "/", response: RESPONSE, spec: SPEC as never, ttl: 10_000 });
    });

    const result = store.invalidate("/users");
    expect(result.removedKeys.sort()).toEqual([key("/users"), key("/users/10"), key("/users?page=1")].sort());
    expect(store.has(key("/users-evil"))).toBe(true);
  });

  it("invalidates by tag", () => {
    store.set({ key: key("/users"), response: RESPONSE, spec: SPEC as never, tags: ["users"], ttl: 10_000 });
    store.set({ key: key("/teams"), response: RESPONSE, spec: SPEC as never, tags: ["teams"], ttl: 10_000 });

    expect(store.invalidate("users").removedKeys).toEqual([key("/users")]);
    expect(store.has(key("/teams"))).toBe(true);
  });

  it("notifies subscribers on revalidate", () => {
    const entry = store.set({ key: key("/users"), response: RESPONSE, spec: SPEC as never, ttl: 10_000 });
    const types: string[] = [];
    entry.subscribers.add((update) => types.push(update.type));
    store.notifySubscribers(entry, { key: entry.key, response: RESPONSE });
    expect(types).toEqual(["revalidate"]);
  });

  it("collects removed subscribers so callers can refetch", () => {
    const entry = store.set({ key: key("/users"), response: RESPONSE, spec: SPEC as never, tags: ["users"], ttl: 10_000 });
    let fired = false;
    entry.subscribers.add(() => {
      fired = true;
    });

    const result = store.invalidate("users");
    expect(result.removed).toHaveLength(1);
    for (const sub of result.removed[0]?.subscribers ?? []) {
      sub({ type: "revalidate", key: key("/users"), response: RESPONSE });
    }
    expect(fired).toBe(true);
  });
});