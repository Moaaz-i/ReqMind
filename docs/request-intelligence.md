# Request intelligence: dedup, cache & SWR

Three layers run before the network is ever touched. They only apply to **reads** — `GET`, `HEAD`, `OPTIONS` — never to mutations.

## 1. Deduplication

Identical concurrent reads are coalesced into a single network call. Each caller receives the shared response; the call is torn down when the last consumer finishes.

```ts
const [a, b, c] = await Promise.all([
  api.get("/analytics?day=today"),
  api.get("/analytics?day=today"),
  api.get("/analytics?day=today"),
]);
// one network request; a.data === b.data === c.data
```

Two requests are "identical" when their **fingerprints** match.

## 2. Caching

Successful `GET` responses are stored in an in-memory TTL cache. A request is served from cache when its entry is **fresh** and the strategy is `cache-first`.

```ts
const api = createClient({ cache: { enabled: true, ttl: 60_000 } });

await api.get("/users");            // miss  → network
await api.get("/users");            // hit   → same object, no network
```

Per-request overrides:

```ts
await api.get("/users", { cache: false });              // bypass the cache for this call
await api.get("/users", { cache: { ttl: 5_000 } });     // short-lived entry
await api.get("/users", { cache: { strategy: "stale-while-revalidate" } });
```

### Cache keys (fingerprints)

Keys are produced by `createFingerprint({ method, url, headers, body })`:

- method + canonicalized URL (sorted query keys, case/whitespace normalization)
- stable header set: `accept` and `content-type` are included; other headers are dropped so cache hits don't depend on request-specific headers
- serialized body

Reads whose fingerprint differs (different query, different `content-type`) get separate cache entries.

### Cache metadata

Every stored entry keeps the request spec and metadata so it can be refetched or invalidated later:

```ts
interface CacheMeta {
  key: string;
  tags: string[];
  storedAt: number;
  expiresAt: number;
}
```

## 3. Stale-while-revalidate (SWR)

When an entry exists but is **stale**, `cache-first` goes to the network — but SWR serves the stale copy instantly and refreshes in the background:

```ts
const api = createClient({ cache: { strategy: "stale-while-revalidate", ttl: 30_000 } });

const { data } = await api.get("/feed");
// 1st call:  miss → network, cached
// 2nd call (after TTL): stale copy returned instantly + background refresh kicked off
```

Observers are notified when the fresh copy lands:

```ts
api.subscribe(
  (key) => key.includes("/feed"),
  (update) => {
    if (update.type === "revalidate") render(update.response.data);
    if (update.type === "write")      /* first fill */;
  },
);
```

### Cache stores that ship

| Export | Purpose |
| --- | --- |
| `CacheStore` | In-memory TTL cache with path/tag/predicate invalidation and subscriber bookkeeping |
| `Deduper` | In-flight request coalescing |
| `createFingerprint`, `resolveURL`, `buildQuery`, `canonicalizeURL` | Key + URL utilities that back the client |

These are exported so advanced integrations can build custom cache/dedup layers with the same contracts.

Next: [retries & backoff](retries-and-backoff.md).