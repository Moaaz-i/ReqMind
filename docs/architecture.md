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
├── scheduler/
│   └── scheduler.ts            # priority lanes, concurrency caps, rate limits, groups
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
        └─ 4. SCHEDULER (owner only)
               scheduler.submit(job)
                 ├─ transparent (no option) → run now, exactly like a plain client
                 └─ enabled:
                       lane push (FIFO within priority, WRR 4:2:1 across lanes)
                         ↳ dedup already coalesced the flight → one scheduled attempt
                         └─ on slot: circuit re-check (gate) → fetchNetwork
                                 attempts:
                                   fetch(url, { signal })
                                     ✓ 2xx → parseResponse → afterSuccess (cache-write)
                                     ✗ Retry-After / backoff / rate budget
                                         → control.park(delay) → slot FREED
                                         → re-queue when the wait ends
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

### Scheduler contracts

- The scheduler gates **when** an executor runs; it never inspects cache, dedup, or circuit internals. Its only inputs are the job descriptor and a control handle.
- Jobs wait in lanes (`high`/`normal`/`low`) as FIFO queues; selection is weighted round-robin (`4:2:1`). With `priority` off, all jobs land in a single `normal` lane (plain FIFO) and per-request priority / `prioritize()` are inert.
- **Parking frees the slot**: `control.park(ms, reason)` releases the job's network slot while it waits (backoff, `Retry-After`, rate budget), re-queueing the job when the wait ends. Parked jobs show in `stats().delayed`, not `active`.
- **Admission is re-gated.** A job that sits queued past the pre-start gate runs the `beforeStart` check (the client's circuit `permits()` peek) again: if the endpoint opened meanwhile, the job is rejected instead of touching the network. Half-open probes skip the gate so recovery can always proceed.
- **Rate limit is a budget over attempts**, parked the same way as backoff — a rate-limited client holds no slots while waiting.
- Host saturation leapfrogs: a job whose host is at its cap keeps its lane position but doesn't block other hosts' traffic.
- Transparent mode (no `scheduler` option / `enabled: false`) runs executors immediately and emits no scheduler events — byte-identical to a scheduler-less client.

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
| The scheduler is opt-in and transparent by default | Existing scheduler-less clients are byte-identical; shaping must be explicitly requested |
| `priority: true` uses weighted round-robin (4:2:1), not pure strict priority | Guarantees low-priority traffic is never starved by a high-priority flood |
| Parked jobs (backoff / `Retry-After` / rate budget) free their network slot | Waits shouldn't occupy the scarce resource they're waiting on |
| The circuit gate re-runs when a long-queued job is about to start | A queued request must not hit an endpoint whose circuit opened while it waited |
| Dedup coalescence spans the scheduler queue | N identical queued requests share one scheduled network attempt |
| No batching in v0.7; every request is its own attempt | Batching composes differently with caching/SSE; deferred to adaptive v0.8 |
| Dual ESM+CJS via `tsc` | No bundler dependency; simplest reliable dual build |

## Publishing & versioning

- All layers live in one codebase, released as `v0.1.0 → v0.4.0` (intelligence in `v0.5.0`, circuit breaker in `v0.6.0`, request scheduler in `v0.7.0`).
- CI: typecheck + test + build on every push; `npm publish` on `v*` tags using the `NPM_TOKEN` secret.

## Roadmap ideas

- Adaptive scheduling (batching, latency-aware rate) — `v0.8.x`
- Advanced cache (persistent, custom stores) — `v0.8.x`
- Observability (trace export, metrics hooks)
- Devtools (timeline, cache inspector, latency replay)
- Persistent cache (localStorage / in-memory polyfills)
- `useQuery`-style React adapter (framework-agnostic here)
- Request collision / mutation cancellation (cancel stale mutations)
- Offline queue with sync
- Response normalization callbacks (`transformResponse`)
- WebSocket / streaming subscriptions