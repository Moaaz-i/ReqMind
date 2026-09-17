# Intelligence engine

The Intelligence layer turns ReqMind from an HTTP client with caches into a library that **observes, decides, and acts** — not a dashboard.

```
Observation ──▶ Decision ──▶ Action
   │
   ├─ 429 detected          → delay per Retry-After → retry
   ├─ identical request pending → deduplicate       → reuse the flight
   ├─ /search is slow       → tighten its timeout   → abort at a sane bound
   ├─ /search is slow       → stale-while-revalidate → serve stale instantly
```

It works by listening to the same lifecycle events the client already emits — no changes to the network, cache, or retry machinery.

## The observation surface

`client.intelligence()` gives you the live board:

```ts
const { summary, endpoints } = client.intelligence().snapshot();

summary.cacheHitRate;   // 0 → 1
summary.cacheMisses;    // derived: requests - hits - deduplicated
summary.deduplicated;   // joins prevented from reaching the network
summary.retriesPerformed;
summary.retriesRecovered;  // successes that needed a retry
summary.failures;
summary.rateLimited;       // 429 responses observed
summary.timeouts;
summary.cancels;
summary.activeRequests;    // owned network flights in flight
```

Per endpoint (bucketed by `METHOD pathname`):

```ts
const users = client.intelligence().endpoint("GET", "/users");
users.latency;         // { avg, p50, p95, samples }
users.requests;
users.successes;
users.failures;
users.cacheHits;
users.cacheMisses;
users.dedupPrevented;
users.retriesPerformed;
users.retriesRecovered;
users.rateLimited;
users.timeouts;
users.cancels;
```

Latency is **end-to-end** (a response that needed two attempts counts the whole duration), measured over a bounded rolling window of the most recent samples.

```ts
client.intelligence().reset(); // clear history
```

Since v0.8.0 the board also rolls up the [Adaptive Engine's](adaptive.md) counters:

```ts
summary.adaptive; // { decisions, concurrencyReductions, concurrencyRecoveries, throttles, retryChanges }
```

These count the deterministic per-endpoint adaptations — see [the adaptive guide](adaptive.md) for the full readout.

## Adaptive behavior

Observation becomes **action** through per-endpoint recommendations:

```ts
const client = createClient({
  intelligence: {
    adaptiveTimeout: true,              // tighten timeouts for slow endpoints
    adaptiveStaleWhileRevalidate: true, // serve stale data for slow endpoints
  },
});
```

### `adaptiveTimeout`
Once an endpoint has ≥ 5 latency samples, the engine recommends a per-endpoint timeout of **3 × p95** (capped at 60s, floored at 100ms).

```
GET /users  → p95 120ms → effective timeout 360ms
GET /search → p95 1.8s  → effective timeout 5.4s
```

Priority: explicit `requestOptions.timeout` → adaptive → client default → none.

### `adaptiveStaleWhileRevalidate`
When an endpoint's p95 crosses ~500ms, the engine switches that endpoint to **stale-while-revalidate**: readers get cached data instantly (fresh or not), and a background refetch lands the latest copy via a `revalidate` update.

```
GET /search → p95 1.8s → becomes SWR: instant reads + background refresh
```

Priority: explicit per-request `strategy` → adaptive → client default.

Both knobs only engage with enough evidence (5 samples) and can be switched off with `enabled: false` (which also silences all observation).

## The decision loop in code

```ts
import { createClient } from "@reqmind/core";

const client = createClient({
  baseURL: "https://api.example.com",
  cache: { enabled: true, ttl: 60_000 },
  intelligence: { adaptiveTimeout: true, adaptiveStaleWhileRevalidate: true },
});

// Warm up (5 calls to establish a baseline)
for (let i = 0; i < 5; i++) await client.get("/search", { params: { q: "reqmind" } });

// From here on:
//  1. /search gets a tight, endpoint-specific timeout.
//  2. /search serves stale copies instantly and refreshes in the background.

const before = client.intelligence().snapshot();
console.log(`hit rate: ${(before.summary.cacheHitRate * 100).toFixed(1)}%`);
```

## Events that feed it

The engine derives everything from existing events, plus one new one:

| Event | What it feeds |
| --- | --- |
| `request` | request counters + latency start |
| `cache-hit` | `cacheHits` |
| `dedup` *(new)* | `deduplicated` / `dedupPrevented` |
| `retry` | `retriesPerformed`, `rateLimited` (429) |
| `success` | `successes`, latency p50/p95/avg, `retriesRecovered` |
| `error` | `failures`, `timeouts`, `rateLimited` |
| `cancel` | `cancels` |

## What it is not

- It is **not** a passive dashboard — both adaptive knobs change how requests are executed.
- It is **not** a circuit breaker. Endpoint isolation (OPEN/HALF-OPEN/CLOSED) is the next resilience layer and intentionally lives outside this feature.

Next: [resilience thinking in the architecture](architecture.md).