# Adaptive engine

The Adaptive Engine (v0.8) shapes traffic per endpoint from observed signal strength — **deterministically** (never ML, never AI), one step at a time, with every decision explainable.

Same input always produces the same decision: `Intelligence (observed signals) → Adaptive Engine (decision) → Scheduler / Retry / Cache`.

> **Opt-in.** With the `adaptive` block absent — or `adaptive.enabled: false` — the client is byte-for-byte the v0.7 client. Nothing is measured, nothing is decided, nothing changes.

## The four behaviors

Each is a separate opt-in switch inside `adaptive`:

```ts
const api = createClient({
  scheduler: { enabled: true, concurrency: 6 },
  adaptive: {
    enabled: true,
    concurrency: true,            // 1. per-endpoint concurrency ceiling
    retry: true,                  // 2. backoff scaling while pressured
    rateLimit: true,              // 3. 429 throttling (release on recovery)
    staleWhileRevalidate: true,   // 4. SWR for degraded endpoints
  },
});
```

### 1. Per-endpoint concurrency ceiling (`concurrency`)

The scheduler's fixed global `concurrency` becomes a per-endpoint **ceiling** that the engine adjusts. Movement is strictly gradual: the ceiling steps down (or up) by exactly **1** per change, and only after `degradeSamples`/`recoverySamples` consecutive pressured/healthy windows plus a `changeCooldown`.

```
GET /search  p95 3800ms (high = 2000ms) ──▶ 3 pressured windows ──▶ ceiling 6 → 5
GET /search  p95  420ms  (low = 1000ms) ──▶ 3 healthy windows   ──▶ ceiling 5 → 6
```

- **Hysteresis.** The gap between `lowLatencyMs` (healthy floor) and `highLatencyMs` (pressure ceiling) is a deadband: p95 inside it changes nothing, so the ceiling never sawtooths.
- **Bounds.** The ceiling can never drop below `minConcurrency` (default 1) and never exceeds the scheduler's configured concurrency.
- **Isolation.** State is keyed by `METHOD pathname`. `/search` degrading never leaks into `/feed`.
- **Pressure sources.** A window is pressured when p95 ≥ `highLatencyMs`, the 429 share ≥ `rateLimitRatio`, or the error share ≥ `errorRatio`.

### 2. Adaptive retry backoff (`retry`)

While an endpoint is **throttled** (see 3), new retries scale their base delay by `backoffFactor` (default 2), capped at `maxBackoffMs` (default 10s).

A server `Retry-After` header always wins — an explicit server deadline is never overridden by the multiplier.

### 3. 429 throttling (`rateLimit`)

The engine watches each endpoint's share of 429s over the outcome window.

- Entry is **immediate**: one pressured window switches the endpoint to `throttled` mode (retries get `backoffFactor`).
- Release is **gradual**: `recoverySamples` consecutive clean windows must pass before backoff returns to 1.

### 4. Adaptive stale-while-revalidate (`staleWhileRevalidate`)

While an endpoint is degraded (p95 ≥ `swrLatencyMs`, default 1500ms), **reads** flip to `stale-while-revalidate`: instant answers from cache, background refresh. This rides the same degraded flag as the concurrency decision, so the ceiling and the strategy move together — no flicker between strategies.

Priority per request: explicit `strategy` → adaptive → client default.

## Defaults

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` / `concurrency` / `retry` / `rateLimit` / `staleWhileRevalidate` | `false` | master + per-behavior switches |
| `highLatencyMs` | `2000` | p95 at/above this = pressured |
| `lowLatencyMs` | `1000` | p95 below this = healthy (deadband in between) |
| `degradeSamples` | `3` | consecutive pressured windows before a reduction |
| `recoverySamples` | `3` | consecutive healthy windows before a +1 recovery (also gates throttle release) |
| `changeCooldown` | `2` | minimum windows between two decisions per endpoint |
| `minConcurrency` | `1` | floor for the effective ceiling |
| `rateLimitRatio` | `0.2` | 429 share that flags rate-limit pressure |
| `errorRatio` | `0.1` | error share that flags pressure |
| `backoffFactor` | `2` | retry backoff multiplier while throttled |
| `maxBackoffMs` | `10_000` | cap for an adapted retry base delay |
| `swrLatencyMs` | `1500` | p95 at/above this flips reads to SWR |

## The controller

`client.adaptive()` exposes the full readout — including *why* each endpoint sits where it sits:

```ts
const snap = api.adaptive().snapshot();
snap.enabled;                            // true
snap.endpoints["GET /search"];           // EndpointAdaptiveState (below)

api.adaptive().endpoint("GET", "/search");
api.adaptive().metrics();                // rolled-up counters
api.adaptive().reset();                  // forget everything, back to configured
```

```ts
interface EndpointAdaptiveState {
  endpoint: string;          // "GET /search"
  configured: number;        // 6 — the scheduler's ceiling, never changes
  effective: number;         // 5 — what the scheduler applies right now
  mode: "nominal" | "reducing" | "recovering";
  health: "good" | "recovering" | "degraded" | "throttled";
  reason: string;            // explainable, human-readable decision
  retryMultiplier: number;   // backoff multiplier while throttled
  retryMode: "nominal" | "throttled";
  retryReason: string;
  strategy?: "stale-while-revalidate";
  strategyReason: string;
  signals: { avg, p50, p95, samples, errorRatio, rateLimitRatio, active };
  degradedSince?: number;    // timestamp of the first reduction
  counters: AdaptiveMetrics;
}
```

The counters are also rolled up onto the intelligence board:

```ts
api.intelligence().snapshot().summary.adaptive;
// { decisions, concurrencyReductions, concurrencyRecoveries, throttles, retryChanges }
```

## How it fits the pipeline

```
   lifecycle events (request, success, error, retry, cache-hit…)
        │  latency + outcome samples
        ▼
  Intelligence ──► Signals (bounded per-endpoint rings, p95 / ratios)
        │
        ▼
  Adaptive Engine ──► Decision (+ human-readable reason)
        │
        ├─ endpointCeiling(endpoint)  ──► scheduler per-endpoint ceiling (probes bypass)
        ├─ retryMultiplier(endpoint)  ──► retry base delay scaling (Retry-After wins)
        └─ cacheStrategy(...)         ──► read strategy (cache-first vs SWR)
```

- Latency is measured end-to-end: with the scheduler enabled it spans `request-started → request-delayed/success/error`; in transparent mode it spans `request → success/error`.
- The engine only **reads** events and only **suggests** limits — the scheduler, retry loop, and cache stay the single sources of truth.
- No AI, no randomness, no shared global state: identical signal history ⇒ identical decision.

## Design decisions

| Decision | Rationale |
| --- | --- |
| Deterministic, opt-in, per-endpoint | Same input → same output; nothing changes unless explicitly enabled |
| Steps of ±1 with hysteresis + cooldown | Gradual, oscillation-proof adaptation — the ceiling holds a plateau instead of sawtoothing |
| Separate feature switches | Concurrency, backoff, throttling, and SWR compose without coupling |
| Every decision carries a `reason` | The board is inspectable and auditable, not a black box |
| Data lives on the client, not in the scheduler | `scheduler.ts` gains only a `endpointLimit` callback — no engine internals |
| `Retry-After` beats the multiplier | Server deadlines always win over client heuristics |

Next: [events & lifecycle](events-and-lifecycle.md) · [architecture](architecture.md).