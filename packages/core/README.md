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
| **v0.5.0** | Intelligence | `client.intelligence()` board, per-endpoint latency, adaptive timeout & stale-while-revalidate |
| **v0.6.0** | Resilience | Per-endpoint circuit breaker (closed/open/half-open), `circuit-*` events, `client.circuitBreaker()` |
| **v0.7.0** | Scheduler | Opt-in priority lanes, concurrency caps, rate limiting, queue groups — transparent by default |

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

The engine observes every request and can adapt — `client.intelligence()` gives you the live board:

```ts
const { summary, endpoints } = api.intelligence().snapshot();
summary.cacheHitRate; summary.deduplicated; summary.retriesRecovered;
summary.failures; summary.rateLimited; summary.timeouts; summary.activeRequests;

api.intelligence().endpoint("GET", "/users")!.latency; // { avg, p50, p95, samples }
```

Adaptive behavior (opt-in), decided per endpoint from observed latency:

```ts
const api = createClient({
  intelligence: {
    adaptiveTimeout: true,              // timeout ≈ 3×p95 per endpoint
    adaptiveStaleWhileRevalidate: true, // slow endpoints serve stale instantly
  },
});
```

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

### Per-endpoint circuit breaker
When an endpoint starts failing in bulk, its circuit trips and subsequent requests are rejected **before touching the network** — while other endpoints keep working normally. Three states per endpoint (`METHOD pathname`): `closed`, `open`, `halfOpen`.

```ts
const api = createClient({
  circuitBreaker: { failureThreshold: 5, resetTimeout: 10_000 }, // default thresholds
});

api.circuitBreaker().status("GET", "/payments"); // { endpoint, state, consecutiveFailures, probing }
api.circuitBreaker().statuses();
api.circuitBreaker().reset("GET", "/payments");

// 5xx, 429, timeouts and network errors count as failures; 4xx and cancellations do not.
// Open circuits reject with CircuitOpenError and emit "circuit-rejected".
api.on("circuit-open", ({ endpoint }) => slackAlert(endpoint));
```

A fresh cache hit is still served while a circuit is open; only requests that would hit the network are blocked. Circuit state is mirrored on the intelligence board (`summary.circuits`, `endpoint.circuit`).

### Request scheduler
Opt-in traffic shaping: the client decides **when** a request touches the network. Priority lanes, global and per-host concurrency caps, client-side rate limiting, and queue groups.

```ts
const api = createClient({
  scheduler: {
    concurrency: 4,                    // at most 4 simultaneous network attempts
    hosts: { "api.example.com": 2 },   // per-host cap
    priority: true,                    // high:normal:low lanes serviced 4:2:1
    rateLimit: { requests: 10, interval: 1_000 },
  },
});

api.get("/urgent", { priority: "high" });                // priority lane
api.get("/users", { scheduler: { group: "users-page" } }); // queue group
api.scheduler().pauseGroup("users-page");                 // freeze queued work
api.scheduler().cancelGroup("users-page");                // drop the group
api.scheduler().prioritize("users-page", "high");         // re-prioritize queued jobs
api.scheduler().stats();                                  // { active, queued, delayed, completed, rejected, lanes }
```

During a retry backoff or `Retry-After` wait, a running request **parks and frees its network slot** so queued work proceeds — the slot is never held while waiting. Scheduler events: `request-queued`, `request-dequeued`, `request-started`, `request-delayed`, `request-scheduled`, `request-prioritized`, `request-rejected`, `queue-paused`, `queue-resumed`. See [scheduler.md](../docs/scheduler.md).

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
api.on("circuit-open",      ({ endpoint }) => {});
api.on("circuit-half-open", ({ endpoint }) => {});
api.on("circuit-closed",    ({ endpoint }) => {});
api.on("circuit-rejected",  ({ endpoint, error }) => {});
```

## API surface

- `createClient(options)` → `Client`
- `client.request(method, url, options?)`, `get`, `post`, `put`, `patch`, `delete`, `head`, `options`
- `client.on(event, listener)` → unsubscribe
- `client.subscribe(matcher, listener)` → unsubscribe
- `client.invalidate(target, { refetch })` → removed keys
- `client.cancelAll()`, `client.clearCache()`
- `client.intelligence()` → `IntelligenceController` (`snapshot()`, `endpoint(...)`, `reset()`)
- `client.circuitBreaker()` → `CircuitBreakerController` (`status(...)`, `statuses()`, `reset(...)`)
- `client.scheduler()` → `SchedulerController` (`stats()`, `pauseGroup(...)`, `resumeGroup(...)`, `cancelGroup(...)`, `prioritize(...)`)
- `client.cancelGroup(group)`

See [docs/api-reference.md](../docs/api-reference.md) for the full reference, and the [docs](../docs/INDEX.md) folder for deep guides on [caching & SWR](../docs/request-intelligence.md), [retries](../docs/retries-and-backoff.md), [cancellation](../docs/cancellation-and-timeouts.md), [invalidation](../docs/cache-invalidation.md), the [intelligence engine](../docs/intelligence.md), [resilience](../docs/resilience.md), and the [scheduler](../docs/scheduler.md).

## License

MIT