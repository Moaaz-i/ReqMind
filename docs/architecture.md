# Architecture

ReqMind is organized as small, composable modules under `packages/core/src`. Everything is framework-agnostic and layered on the native `fetch`/`Response` primitives.

## Module map

```
src/
├── index.ts                    # public entry: client + utilities + types
├── types.ts                    # shared interfaces (options, responses, specs)
├── errors.ts                   # HttpError, TimeoutError, CancelledError, isAbortError
├── client/
│   └── client.ts               # createClient: orchestration layer (the "engine")
├── request/
│   ├── tracker.ts              # per-request state machine
│   └── response.ts             # parse/verify the fetch Response
├── cache/
│   └── cache-store.ts          # TTL cache + invalidation + subscriber bookkeeping
├── dedup/
│   └── deduper.ts              # in-flight request coalescing
├── intelligence/
│   └── intelligence.ts         # observation → per-endpoint recommendations
├── circuit/
│   └── circuit-breaker.ts      # per-endpoint failure isolation (closed/open/halfOpen)
├── retry/
│   └── policy.ts               # decideRetry / resolveRetryOptions
├── events/
│   └── event-emitter.ts        # typed emit/on, once/off, one-shot promises
└── utils/
    ├── url.ts                  # resolveURL, buildQuery, canonicalizeURL, urlPath
    ├── fingerprint.ts          # stable request keys
    ├── backoff.ts              # computeDelay (exponential/fixed + jitter)
    ├── status.ts               # isSuccessStatus, isRetriableStatus, parseRetryAfter
    └── timing.ts               # delay()
```

## Data flow for a read

```
client.get(url, opts)
        │
        ▼
   resolveSpec()          → merged headers/baseURL, cache+retry+timeout defaults,
                            canonical URL, fingerprint key
                            ↳ intelligence.recommend(spec) → adaptive timeout/strategy
        │
        ├─ 1. CACHE
        │      peek(key)
        │        ├─ fresh + cache-first      → cache-hit, resolve from memory
        │        └─ stale + stale-while-revalidare → cache-hit + schedule refetch
        │
        ├─ 2. DEDUP
        │      deduper.get(key)               → join an in-flight flight
        │
        ├─ 3. CIRCUIT GUARD (owner only)
        │      circuitBreaker.beforeRequest("GET /path")
        │        ├─ closed / open→halfOpen probe → proceed
        │        └─ open or probe in flight    → circuit-rejected + CircuitOpenError
        │
        └─ 4. OWNER
               deduper.attach(key, fetchNetwork(spec, tracker))
                     │
                     ▼
                fetchNetwork()
                  for each attempt:
                    fetch(url, { signal: attemptController.signal })
                      ✓ 2xx → parseResponse → afterSuccess (cache-write)
                      ✗     → decideRetry → delay() → retry / throw
                  tracker: idle→pending→retrying→success|error|cancelled
```

## Key contracts

### The cache entry

Entries store everything needed to serve, refetch, and invalidate:

```ts
interface CacheEntry<T> {
  key: string;            // fingerprint
  path: string;           // urlPath(url) for path-based invalidation
  response: ApiResponse<T>;
  spec: RequestSpec;      // full request description → refetch after invalidation
  tags: string[];
  storedAt: number;
  expiresAt: number;
  subscribers: Set<CacheSubscriber<T>>;  // waiting on a fresh copy
}
```

### Interest

`client.subscribe(matcher, …)` registers per-key **interest** (an incrementing count). Interest is what tells invalidation "somebody cares — refetch this key." It's reference-counted and cleaned up on unsubscribe.

### Intent over invalidation

- **Mutation invalidation** targets `[path(url), ...tags]`.
- **Path matching** is segment-aware: `/users` removes `/users`, `/users/10`, `/users?page=1`, but not `/users-evil`.
- Removed entries feed `refetchEntry(key, spec, subscribers)`, which coalesces through the deduper and emits `revalidate`.

### Tracker responsibilities

- Owns the notification/abort wiring for a flight (`pending → … state`).
- Its `signal` propagates to the current attempt's `AbortController`, so `cancel()`/external aborts/timeouts release the socket promptly.
- One tracker per flight — deduped consumers get lightweight trackers that mirror outcomes.

## Design decisions

| Decision | Rationale |
| --- | --- |
| Reads only (GET/HEAD/OPTIONS) participate in dedup | Mutations must never be coalesced |
| Only `GET` is cached | Prevents accidental mutation-logging via cache |
| Cache-first fresh reads skip the network and emit `cache-hit` | Latency + battery friendliness |
| Far-future SWR with background refresh | Response-time predictability |
| `.cancel()` on the returned promise (not `.abort()`) | Keeps the surface minimal and naming unambiguous |
| `HttpError` carries `.status`, `.statusText`, `.headers` | Programmatic retry decisions need full context |
| Intelligence listens to lifecycle events (never patched into fetch) | One source of truth; observation can't drift from execution |
| Failures are recorded by the circuit at the terminal flight outcome, not via `error` events | Deduped consumers never double-count; the counter reflects real network outcomes |
| Cache hits and dedup joins bypass the circuit guard; internal refetches are dropped silently when open | A cached copy beats an error, and nothing user-facing was attempted by a blocked refetch |
| Circuit states are keyed by `METHOD pathname`, ignoring query strings | Endpoint isolation — one endpoint's failure must not leak into its siblings |
| 4xx and cancellation are not countable failures | They describe a bad request or caller intent, not a failing server |
| Adaptive tips need ≥ 5 samples, `3×p95`, capped 100ms–60s | Avoids premature behavior changes from noisy single calls |
| The circuit breaker is deterministic and configured once (no runtime mutation, no adaptive breaker yet) | Predictable isolation; adaptive decisions arrive with the intelligence engine |
| Dual ESM+CJS via `tsc` | No bundler dependency; simplest reliable dual build |

## Publishing & versioning

- All layers live in one codebase, released as `v0.1.0 → v0.4.0` (intelligence in `v0.5.0`, circuit breaker in `v0.6.0`).
- CI: typecheck + test + build on every push; `npm publish` on `v*` tags using the `NPM_TOKEN` secret.

## Roadmap ideas

- Advanced cache (persistent, custom stores) — `v0.7.x`
- Observability (trace export, metrics hooks)
- Devtools (timeline, cache inspector, latency replay)
- Persistent cache (localStorage / in-memory polyfills)
- `useQuery`-style React adapter (framework-agnostic here)
- Request collision / mutation cancellation (cancel stale mutations)
- Offline queue with sync
- Response normalization callbacks (`transformResponse`)
- WebSocket / streaming subscriptions
- Request priority tiers (urgent, normal, background)