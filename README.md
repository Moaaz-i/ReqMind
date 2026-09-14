# ReqMind

A request intelligence engine for the fetch era: automatic request deduplication, an offline-first cache, instant retrieval with stale-while-revalidate, cancellation, smart retries, and mutation-driven cache invalidation — shaken together into one tiny, framework-agnostic client with a lifecycle event system.

## Quick start

```ts
import { createClient } from "@reqmind/core";

const api = createClient({
  baseURL: "https://api.example.com",
  cache: { enabled: true, ttl: 30_000, strategy: "stale-while-revalidate" },
  retry: { attempts: 3, baseDelay: 1000 },
  timeout: 10_000,
});
```

### GET with the request intelligence engine

```ts
const { data, status } = await api.get("/users", { tags: ["users"] });
```

- Concurrent identical GETs are coalesced into **one** network call (dedup).
- Responses are cached; **fresh** reads skip the network entirely.
- **Stale** reads return instantly and refresh in the background (SWR).
- Transient failures **(429, 5xx)** retry with exponential backoff + jitter and obey `Retry-After`.
- A timeout aborts the underlying fetch and rejects with `TimeoutError`.

### Cancellation

```ts
const request = api.get("/big-report", { timeout: 15_000 });
// ... later:
request.cancel(); // rejects with CancelledError

// or use an external signal
const controller = new AbortController();
api.get("/users", { signal: controller.signal });
controller.abort();
```

### Mutations invalidate caches

```ts
const users = await api.get("/users", { tags: ["users"] });
api.subscribe(
  (key) => key.includes("/users"),
  (update) => {
    if (update.type === "revalidate") { /* fresh data arrived */ }
  },
);

// success invalidates /users (and everything tagged "users") and refetches for subscribers
await api.post("/users", { name: "Moaaz" });
```

Explicit invalidation works too: `api.invalidate("/users")` or `api.invalidate(["users", "teams"])` or `api.invalidate((meta) => meta.tags.includes("users"))` — with optional automatic refetch for subscribed keys.

### Lifecycle events

```ts
api.on("request", ({ key }) => { /* started */ });
api.on("cache-hit", ({ key }) => { /* served from cache */ });
api.on("retry", ({ key, attempt, delay }) => { /* backing off */ });
api.on("success" | "error" | "cancel", ({ key, tracker }) => { /* done */ });
api.on("revalidate", ({ key, response }) => { /* SWR refresh */ });
```

## Core concepts

| Concept | What it does |
| --- | --- |
| **Dedup** | Coalesces concurrent identical reads into a single network call with one shared response. |
| **Cache** | In-memory TTL cache keyed by a stable request fingerprint (method, URL, headers). |
| **SWR** | `stale-while-revalidate` serves stale data instantly while refreshing in the background. |
| **Retry** | Configurable attempts, exponential backoff, jitter, timeout-based backoff, and `Retry-After` support. |
| **Cancellation** | `request.cancel()`, external `AbortSignal`, or timeouts — with a "cancelled" tracker state. |
| **Invalidation** | By exact path (with children + query variants), tags, or predicate; auto-refetches subscribed keys. |
| **Events** | Fine-grained lifecycle events + `subscribe` for watching cache regions. |

## Version story

- **v0.1.0** — MVP: request dedup, TTL cache, retry policy, cancellation, timeout, events, custom methods.
- **v0.2.0** — Stale-while-revalidate with background refresh and cache subscription notifications.
- **v0.3.0** — Mutation-driven cache invalidation (path / tag / predicate) with automatic refetch of subscribed and tracked keys, plus explicit `client.invalidate`.
- **v0.4.0** — Docs & hardening: full docs suite + JSDoc on the public API, invalidation/refetch fixes.

## Documentation

- Package docs (npm-facing): [`packages/core/README.md`](packages/core/README.md)
- Docs index: [`docs/INDEX.md`](docs/INDEX.md)
  - [Getting started](docs/getting-started.md)
  - [Request intelligence — dedup, cache & SWR](docs/request-intelligence.md)
  - [Retries & backoff](docs/retries-and-backoff.md)
  - [Cancellation & timeouts](docs/cancellation-and-timeouts.md)
  - [Cache invalidation](docs/cache-invalidation.md)
  - [Events & lifecycle](docs/events-and-lifecycle.md)
  - [Architecture](docs/architecture.md)
  - [API reference](docs/api-reference.md)

## Package status

This monorepo ships `@reqmind/core` from `packages/core`. Each semantic release is tagged (`v0.1.0`, `v0.2.0`, `v0.3.0`); CI typechecks, tests, and builds on every push, then publishes to npm from a version tag using the `NPM_TOKEN` secret.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit across the workspace
npm test            # vitest at packages/core
npm run build       # dual ESM+CJS build at packages/core
```

Framework-agnostic by design: bring your own fetch, storage, and layers.