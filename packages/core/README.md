# @reqmind/core

A request intelligence engine for the fetch era: request deduplication, an offline-first cache with stale-while-revalidate, smart retries, cancellation, timeouts, and mutation-driven cache invalidation — wrapped in a tiny, framework-agnostic client with a lifecycle event system.

- **Zero dependencies** — built on top of the native `fetch`/`Response`
- **Dual build** — ESM + CJS with full TypeScript types
- **Node ≥ 18** (browser-ready; bring your own fetch in older runtimes)

## Version story

| Version | Layer | Highlights |
| --- | --- | --- |
| **v0.1.0** | MVP | Dedup, TTL cache, retry with backoff, cancellation, timeouts, lifecycle events |
| **v0.2.0** | SWR | Stale-while-revalidate + background refresh + cache subscription notifications |
| **v0.3.0** | Invalidation | Mutation-driven cache invalidation (path / tag / predicate) with automatic refetch |
| **v0.4.0** | Docs & hardening | Full documentation suite, JSDoc on the public API, invalidation/refetch fixes |

## Install

```sh
npm install @reqmind/core
```

## Quick start

```ts
import { createClient } from "@reqmind/core";

const api = createClient({
  baseURL: "https://api.example.com",
  headers: { "X-Client": "reqmind" },
  cache: { enabled: true, ttl: 30_000, strategy: "stale-while-revalidate" },
  retry: { attempts: 3, baseDelay: 1000, maxDelay: 30_000 },
  timeout: 10_000,
});

// Reads get cached + deduplicated + retried automatically.
const { data, status, headers } = await api.get<{ id: number; name: string }>("/users/1");

// Mutations invalidate caches and refetch subscribed keys.
api.subscribe((key) => key.includes("/users"), (update) => {
  if (update.type === "revalidate") console.log("fresh users:", update.response?.data);
});
await api.post("/users", { name: "Moaaz" });
```

## Request intelligence

### Deduplication
Concurrent identical reads are coalesced into **one** network call; every caller receives the same response. Only `GET`/`HEAD`/`OPTIONS` participate.

```ts
const [a, b] = await Promise.all([api.get("/users"), api.get("/users")]);
// → exactly one network request
```

### Caching
Successful `GET` responses are stored in an in-memory TTL cache keyed by a stable fingerprint (method + canonical URL + headers + body).

```ts
const api = createClient({ cache: { enabled: true, ttl: 60_000 } });
// fresh → served instantly, no network; stale → treated per strategy below
```

Per-request control:

```ts
await api.get("/report", { cache: { ttl: 1000 }, params: { q: "x" } }); // short-lived override
await api.get("/health", { cache: false });                             // never cache
```

### Stale-while-revalidate
With `strategy: "stale-while-revalidate"`, stale entries are **served instantly with data from cache**, and a background request refreshes the copy. Subscribers are notified with a `revalidate` update when fresh data lands.

```ts
const api = createClient({ cache: { strategy: "stale-while-revalidate" } });

api.subscribe((key) => key.includes("/feed"), ({ type, response }) => {
  if (type === "revalidate") ui.patch(response!.data);
});
const { data } = await api.get("/feed"); // instant, even if stale
```

### Smart retries
Transient failures retry with exponential backoff + jitter (default). Retry-eligible statuses: `408`, `429`, `500`, `502`, `503`, `504`. `429`/`503` respect the `Retry-After` header. Client errors (`400`, `401`, `403`, `404`, `409`, `422`) fail fast.

```ts
const api = createClient({
  retry: { attempts: 5, baseDelay: 200, backoff: "exponential", jitter: true },
});
// or fully custom:
const api = createClient({
  retry: { attempts: 3, retryOn: (status) => status === 503 || status === 429 },
});
```

Each retry fires a `retry` event carrying `{ attempt, delay, error }`.

### Cancellation & timeouts
Every request returns a **cancellable promise**:

```ts
const req = api.get("/big-report");
req.cancel();                       // rejects with CancelledError

const controller = new AbortController();
api.get("/users", { signal: controller.signal });
controller.abort();                 // same cancellation, from outside

const api = createClient({ timeout: 5_000 }); // opts out; rejects with TimeoutError
await api.get("/slow", { timeout: 1_000 });   // per-request override
```

Cancel/timeout aborts the underlying `fetch` signal, so sockets are actually released. Rejected requests emit `error`/`cancel` and reach the `cancelled` tracker state.

### Mutation-driven invalidation
A successful mutation invalidates the **path** of the request plus any **tags** you declare:

```ts
api.subscribe((key) => key.includes("/users"), { /* watch */ });

await api.post("/users", { name: "Moaaz" });            // invalidates "/users" path
await api.put("/users/1", body, { tags: ["users"] });   // invalidates "/users" path + "users" tag
```

Invalidation by path also matches **children and query variants** (`/users`, `/users/10`, `/users?page=1`). Subscribed keys are automatically **refetched** in the background.

Explicit invalidation — by path, tags, or predicate:

```ts
api.invalidate("/users");                              // path + children/query variants
api.invalidate(["users", "teams"]);                    // tags
api.invalidate((meta) => meta.tags.includes("users")); // predicate
api.invalidate("/users", { refetch: false });          // drop cache, skip refetch
```

### Lifecycle events

```ts
api.on("request",    ({ key, method, url }) => {});
api.on("retry",      ({ key, attempt, delay }) => {});
api.on("success",    ({ key, tracker, response }) => {});
api.on("error",      ({ key, tracker, error }) => {});
api.on("cancel",     ({ key, tracker }) => {});
api.on("cache-hit",  ({ key }) => {});
api.on("cache-write",({ key, response }) => {});
api.on("invalidate", ({ keys, target }) => {});
api.on("revalidate", ({ key, response }) => {});
```

## API surface

- `createClient(options)` → `Client`
- `client.request(method, url, options?)`, `get`, `post`, `put`, `patch`, `delete`, `head`, `options`
- `client.on(event, listener)` → unsubscribe
- `client.subscribe(matcher, listener)` → unsubscribe
- `client.invalidate(target, { refetch })` → removed keys
- `client.cancelAll()`, `client.clearCache()`

See [docs/api-reference.md](../docs/api-reference.md) for the full reference, and the [docs](../docs/INDEX.md) folder for deep guides on [caching & SWR](../docs/request-intelligence.md), [retries](../docs/retries-and-backoff.md), [cancellation](../docs/cancellation-and-timeouts.md), and [invalidation](../docs/cache-invalidation.md).

## License

MIT