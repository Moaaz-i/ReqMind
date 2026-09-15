# Events & lifecycle

The client is observable at every step. Two mechanisms exist:

1. **`client.on(event, listener)`** — fine-grained, typed lifecycle events.
2. **`client.subscribe(matcher, listener)`** — cache-region watching → `write` / `revalidate` / `invalidate` updates.

## Event reference

```ts
api.on("request",     ({ key, method, url, tracker }) => {});
api.on("retry",       ({ key, tracker, attempts, delay, error }) => {});
api.on("success",     ({ key, tracker, response }) => {});
api.on("error",       ({ key, tracker, error }) => {});
api.on("cancel",      ({ key, tracker }) => {});
api.on("dedup",       ({ key, method, url, consumers }) => {});
api.on("cache-hit",   ({ key, tracker }) => {});
api.on("cache-write", ({ key, response }) => {});
api.on("invalidate",  ({ keys, target }) => {});
api.on("revalidate",  ({ key, response }) => {});
api.on("circuit-open",      ({ endpoint, method, path }) => {});
api.on("circuit-half-open", ({ endpoint, method, path }) => {});
api.on("circuit-closed",    ({ endpoint, method, path }) => {});
api.on("circuit-rejected",  ({ endpoint, method, path, error }) => {});
```

| Event | Payload | Fires when |
| --- | --- | --- |
| `request` | `{ key, method, url, tracker }` | a request starts (before any cache/dedup short-circuit is skipped — only on the owner) |
| `cache-hit` | `{ key, tracker }` | response served from cache (fresh read or SWR) |
| `retry` | `{ key, tracker, attempts, delay, error }` | an attempt failed and a retry is scheduled; `delay` = backoff in ms; `attempts` = attempts so far |
| `success` | `{ key, tracker, response }` | a network attempt resolved with a `2xx` |
| `error` | `{ key, tracker, error }` | a request failed (after retries exhausted) |
| `cancel` | `{ key, tracker }` | a request was cancelled |
| `dedup` | `{ key, method, url, consumers }` | a request joined an in-flight flight; `consumers` = waiters now sharing it |
| `cache-write` | `{ key, response }` | a fresh response was stored in the cache |
| `revalidate` | `{ key, response }` | a background refetch (SWR or post-invalidation) landed a fresh copy |
| `invalidate` | `{ keys, target }` | cache entries were invalidated; `target` is the `InvalidateTarget` used |
| `circuit-open` | `{ endpoint, method, path }` | a circuit tripped: closed→open, or a failed probe reopened halfOpen→open |
| `circuit-half-open` | `{ endpoint, method, path }` | a circuit admitted its first request past the reset window (open→halfOpen) |
| `circuit-closed` | `{ endpoint, method, path }` | a half-open probe succeeded (halfOpen→closed) |
| `circuit-rejected` | `{ endpoint, method, path, error }` | a request was blocked before sending because its circuit was open (`error` is a `CircuitOpenError`) |

A rejected request is **never attempted**: it emits `circuit-rejected` (not `request`/`error`), touches no network socket, and rejects with `CircuitOpenError`. See the [resilience guide](resilience.md).

Every `on()` returns an **unsubscribe** function:

```ts
const off = api.on("error", logError);
off(); // done listening
```

## `subscribe` — watch a cache region

```ts
const unsubscribe = api.subscribe(
  (key: string) => key.includes("/users"),
  (update) => {
    switch (update.type) {
      case "write":       // first fill of a watched key
      case "revalidate":  // fresh copy after SWR refresh / invalidation refetch
        render(update.response!.data);
        break;
      case "invalidate":  // a watched key was dropped
        // update.key, no response
    }
  },
);
unsubscribe();
```

Watching a key also declares **interest** in it, which is what makes mutation invalidation refetch it in the background.

## Tracker state machine

Every request has a `Tracker`. Owning requests go

```
idle → pending → retrying → success | error | cancelled
```

Deduped (joined) requests reach `success`/`error`/`cancelled` to mirror the owner, but stay at `pending` through the shared wait.

```ts
api.on("success", ({ tracker }) => tracker.state);   // "success"
api.on("retry",   ({ tracker }) => tracker.state);   // "retrying"
```

## Typical wiring & observability flow

1. `request` → tracker `pending`
2. `cache-hit` (served from cache, no network flight owned) OR
   `retry` (per failed attempt) …
3. `success` + `cache-write` → tracker `success`
4. `invalidate` (mutation landed) → `revalidate` (background refetch landed) → subscribers updated

Next: [architecture](architecture.md).