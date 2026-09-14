# Cancellation & timeouts

Cancellation in ReqMind works at two levels: a **tracker state machine** that every request flows through, and an **underlying `fetch` signal** that is actually aborted so sockets/resources are released.

## `cancel()` — the cancellable promise

Every request returns a `CancellablePromise<ApiResponse<T>>`:

```ts
const request = api.get("/big-report", { timeout: 15_000 });

// …later
request.cancel();          // rejects with CancelledError
await request;             // throws
```

## External `AbortSignal`

```ts
const controller = new AbortController();
api.get("/users", { signal: controller.signal });

controller.abort();             // same cancellation path
```

An **already-aborted** signal rejects immediately.

## Timeouts

```ts
const api = createClient({ timeout: 5_000 });        // default for all requests
await api.get("/slow", { timeout: 1_000 });          // per-request override

const api = createClient({ timeout: 0 });            // disable globally
```

When the deadline hits, the abort fires and the request rejects with `TimeoutError`. The timeout only applies to the time a single network attempt is allowed to take (not the whole retry series).

## Error types

| Error | When |
| --- | --- |
| `CancelledError` | `cancel()` / external abort / already-aborted signal |
| `TimeoutError` | deadline exceeded |
| `HttpError` | non-2xx response (carries `.status`, `.statusText`, `.headers`) |

`isAbortError(err)` detects raw `AbortError`s (e.g. from a lower-level layer).

## Tracker states

Every request exposes its `Tracker`, emitting events as it moves:

```
idle → pending → retrying · retrying · … → success | error | cancelled
```

The tracker is available on `request`/`success`/`error`/`cancel`/`retry` event payloads and via `.state`:

```ts
api.on("cancel", ({ tracker }) => console.log(tracker.state)); // "cancelled"
```

## Notes

- `cancelAll()` cancels every in-flight request tracked by the client and clears the deduper and in-flight map.
- Cancelled/timed-out flights never populate the cache and never fire `success`.
- A cancelled in-flight read is removed from the in-flight/dedup registry so a later identical call starts fresh instead of joining a dead flight.

Next: [cache invalidation](cache-invalidation.md).