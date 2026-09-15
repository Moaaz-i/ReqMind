# Resilience — circuit breaker

A **per-endpoint circuit breaker** protects your client against cascading failures: when one endpoint starts failing in bulk, its circuit trips open and requests are rejected instantly **before any network call**, letting the server recover while other endpoints keep working normally.

The breaker is **deterministic** in v0.6.0: thresholds, reset windows, and failure classification are fixed and configured once at client creation. Runtime mutation of `circuitBreaker` options is **not supported**, and there is no adaptive (intelligence-driven) circuit breaker yet — that's coming later.

## The three states

Each endpoint (keyed by `METHOD pathname`) is in one state:

```
CLOSED ──(failures ≥ failureThreshold)──▶ OPEN
   ▲                                        │
   │                                   resetTimeout elapses
   └─────────(probe success)──────────▶ HALF_OPEN
```

| State | Behavior |
| --- | --- |
| `closed` | Requests are allowed. A success resets the consecutive-failure counter to `0`. |
| `open` | Requests are **rejected immediately** with a `CircuitOpenError` (no network call, no `request`/`error` event — only `circuit-rejected`). After `resetTimeout` ms the next request becomes the single **probe**. |
| `halfOpen` | Exactly **one** probe request is admitted. If it succeeds → `closed`. If it fails (a countable failure) → `open` again and the reset window restarts. While a probe is in flight, all other requests for that endpoint are rejected. |

## Endpoint isolation

Circuits are tracked per **`METHOD` + pathname**, so `GET /payments` failing has zero effect on `GET /users`. Query strings are ignored for isolation: `/payments?page=1` and `/payments?page=2` share the `GET /payments` circuit.

```ts
// after several 5xx responses to /payments:
api.circuitBreaker().status("GET", "/payments").state; // "open"
api.circuitBreaker().status("GET", "/users").state;    // "closed"
```

## What counts as a failure

| Outcome | Counts against the circuit? |
| --- | --- |
| `5xx` responses | ✅ yes |
| `429 Too Many Requests` | ✅ yes |
| Timeout (`TimeoutError`) | ✅ yes |
| Network error (server unreachable) | ✅ yes |
| `4xx` responses (400, 401, 403, 404, …) | ❌ no |
| Cancellation (`CancelledError` / abort) | ❌ no |

Client errors and cancellations are **not** circuit failures — they describe a bad request or the caller changing their mind, not a sick server.

## Configuration

```ts
import { createClient } from "@reqmind/core";

const api = createClient({
  circuitBreaker: {
    enabled: true,            // default true
    failureThreshold: 5,      // default 5 — consecutive countable failures to trip open
    resetTimeout: 10_000,     // default 10_000 ms — how long the circuit stays open
  },
});
```

Rejected requests reject with `CircuitOpenError`:

```ts
import { CircuitOpenError } from "@reqmind/core";

try {
  await api.get("/payments");
} catch (err) {
  if (err instanceof CircuitOpenError) {
    // circuit open for err.endpoint — request was never attempted
  }
}
```

## Events

| Event | Payload | Fires when |
| --- | --- | --- |
| `circuit-open` | `{ endpoint, method, path }` | a circuit trips (closed→open, or a failed probe reopens halfOpen→open) |
| `circuit-half-open` | `{ endpoint, method, path }` | a circuit admits its first probe (open→halfOpen) |
| `circuit-closed` | `{ endpoint, method, path }` | a probe succeeds (halfOpen→closed) |
| `circuit-rejected` | `{ endpoint, method, path, error: CircuitOpenError }` | a request was blocked before sending because its circuit was open |

A rejected request is **not attempted**: it never reaches the network and does **not** emit `request` or `error` — the only signal is the `circuit-rejected` event (plus your catch block).

## Placement in the request flow

The circuit guard sits between the cache/dedup short-circuits and the network:

1. **Frame-fresh cache hit** (or SWR stale-serve) — served from memory; the circuit is **ignored**. A cached copy is cheaper and safer than an error.
2. **Dedup join** — a request that would join an in-flight duplicate is allowed to join even if that flight is a half-open probe. The join does not create a second network call.
3. **Circuit guard** — owners travelling to the network consult the breaker and are rejected if the circuit won't admit them.
4. **Internal refetches** (SWR refresh, post-invalidation refetch) — blocked silently when the circuit is open: the refetch is dropped, with **no** `circuit-rejected` and **no** `error` event, since nothing user-facing was attempted.

## Reading & resetting

```ts
api.circuitBreaker().status("GET", "/payments"); // { endpoint: "GET /payments", state, consecutiveFailures, openedAt?, probing }
api.circuitBreaker().statuses();                 // every circuit that has been observed
api.circuitBreaker().reset("GET", "/payments");  // force one circuit back to closed
api.circuitBreaker().reset();                    // reset every circuit
```

## Intelligence integration

The circuit state is mirrored on the intelligence board:

```ts
const { summary, endpoints } = api.intelligence().snapshot();

summary.circuits;        // { open: 2, halfOpen: 0, closed: 8 }
summary.circuitRejected; // total requests blocked by the breaker

endpoints[0].circuit;          // "closed" | "open" | "halfOpen"
endpoints[0].circuitFailures;  // consecutive failures the circuit is counting
endpoints[0].circuitRejected;  // rejections served for this endpoint
```

## Testing & edge cases covered by the test suite

- Exactly one probe among several requests racing the open→halfOpen transition.
- The probe result (success → closed, failure → reopen).
- A fresh cache hit is still served while its circuit is open; an uncached key is rejected.
- Cancellation does not trip a circuit; 4xx does not trip it; 429 and timeouts do.
- Circuit failure is recorded once per request even when retries/timeouts are involved.
- Endpoint isolation: one endpoint failing leaves its siblings untouched.
- Success resets the counter; sustained failures reach the threshold and trip.

Next: [events & lifecycle](events-and-lifecycle.md).