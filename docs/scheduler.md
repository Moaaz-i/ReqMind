# Request scheduler

ReqMind's scheduler decides **when** (and how many) requests touch the network. It adds priority lanes, global and per-host concurrency caps, client-side rate limiting, and queue groups — on top of the plain request pipeline.

> **Opt-in.** When the `scheduler` option is absent (or `enabled: false`) the scheduler runs in **transparent mode**: every request starts immediately, exactly as a scheduler-less client would. No event, state change, or latency difference. The scheduler never changes *what* is sent — only *when*.

The scheduler is deterministic: all configuration is read once at client creation and there is no adaptive routing. Dynamic control happens at runtime through `client.scheduler()`.

## Options

```ts
interface ClientOptions {
  scheduler?: SchedulerOptions;
}

interface SchedulerOptions {
  enabled?: boolean;      // default true — the option's presence enables the scheduler
  concurrency?: number;   // max simultaneous network attempts (client-wide); default 8
  priority?: boolean;     // enable high/normal/low lanes; default false (single FIFO queue)
  hosts?: Record<string, number>;   // per-host concurrency caps (hostname → max)
  rateLimit?: { requests: number; interval: number };
}
```

```ts
const api = createClient({
  scheduler: {
    concurrency: 4,                    // at most 4 network attempts at once
    hosts: { "api.example.com": 2 },   // at most 2 concurrent against this host
    priority: true,                    // weight lanes high:normal:low = 4:2:1
    rateLimit: { requests: 10, interval: 1_000 },  // ≤ 10 attempts / second, client-wide
  },
});
```

A `rateLimit` is a *budget* on network attempts: once the window is exhausted the shuffled job is **parked** and its slot is freed until the window rolls over, so a rate-limited client never holds a network slot while waiting.

## Priority lanes

With `priority: true` up to three lanes exist — `high`, `normal`, `low` — serviced **weighted round-robin (4:2:1)** with strict FIFO inside a lane. Weighting guarantees liveness: a flood of high-priority work can never starve low-priority traffic (roughly every 7 admissions include 4 high, 2 normal, 1 low).

```ts
const high = api.get("/urgent", { priority: "high" });
const normal = api.get("/default");            // "normal" is the default
const low = api.get("/background", { priority: "low" });
```

When `priority` is false (default) there is a single FIFO queue; per-request `priority` and `prioritize()` are inert.

Re-prioritize **queued** work at any time — by queue group name or request key:

```ts
const changed = api.scheduler().prioritize("users-page", "high");  // moves matching jobs to high
```

`prioritize` returns the number of jobs moved and only touches queued jobs — already-running requests are unaffected.

## Queue groups

Attach requests to a logical group (a page, component, view) and control them as one unit:

```ts
const list = api.get("/users", { scheduler: { group: "users-page" } });
const detail = api.get("/users/10", { scheduler: { group: "users-page" } });

api.scheduler().pauseGroup("users-page");   // freeze queued work (running requests finish)
api.scheduler().resumeGroup("users-page");  // re-admit the frozen queue
api.scheduler().cancelGroup("users-page");  // drop every queued + running request in the group
```

- `pauseGroup` / `resumeGroup` only affect **queued** jobs; requests already holding a slot keep running to completion.
- `cancelGroup` cancels queued, parked, and running jobs alike (like `cancelAll` scoped to one group).
- `client.cancelGroup(group)` is a shorthand for the same thing.

## Backoff and `Retry-After` never hold a slot

During a retry backoff (or when the server answers `429`/`503` with `Retry-After`), the scheduler **parks** the running job: its network slot is released so other queued work proceeds, and the job re-enters the queue when its wait ends. Parked requests appear in `stats().delayed`.

The same mechanism applies to rate limiting (see below).

## Events

The scheduler emits nine events (all also available through `client.on`). Payloads carry `id` (scheduler job id), `key` (request fingerprint), `method`, `url`, and `priority`.

| Event | Fires when |
| --- | --- |
| `request-queued` | a request joined a priority lane (`position` = index in its lane) |
| `request-dequeued` | a queued request was selected and holds a slot |
| `request-started` | the scheduler began a network attempt (slot held) |
| `request-delayed` | a running request was parked (backoff / `Retry-After` / rate budget) and freed its slot; `reason`, `delay` |
| `request-scheduled` | a parked request's wait ended and it re-entered the queue |
| `request-prioritized` | `prioritize()` moved a queued request to another lane (`from`, `to`) |
| `request-rejected` | the scheduler dropped a request (group/all cancellation); `reason: "cancelled"` |
| `queue-paused` | `pauseGroup` froze a group (`group` is the group name) |
| `queue-resumed` | `resumeGroup` re-admitted a group |

```ts
api.on("request-delayed", ({ key, url, reason, delay }) => {
  console.log(`${url} parked (${reason}) for ${delay}ms`);
});
```

In transparent mode no scheduler events fire — the scheduler is invisible.

## Stats & controller

```ts
api.scheduler().stats();  // lived view
```

| Field | Meaning |
| --- | --- |
| `active` | requests holding a network slot right now |
| `queued` | requests waiting in the priority lanes |
| `delayed` | requests parked until a future moment |
| `completed` | requests that finished their full lifecycle |
| `rejected` | requests dropped by the scheduler (group/all cancellation) |
| `lanes` | `{ high, normal, low }` — how many queued jobs sit in each lane |

## How it fits the pipeline

The scheduler sits between the **dedup/circuit** decision and the raw `fetch`:

```
start → dedup join (a queued duplicate joins and waits) → circuit gate (reject before queueing)
        → scheduler.submit()
            ├─ enabled: lane queue → WRR select → slot → circuit re-check → fetchNetwork
            └─ transparent: run now
        → fetchNetwork (retries / park on backoff / Retry-After / rate budget)
```

- **Dedup spans the queue.** Duplicate GETs coalesce even while [queued]: the requester waits on the same scheduled flight, so a page of identical tiles is one network attempt.
- **The circuit gate runs twice.** Once before queueing (reject fast when open) and again before the first attempt of a job newly admitted after a long wait (`circuit-rejected` if it opened meanwhile). Half-open probes are exempt from the second gate so a recovery attempt always runs.
- The scheduler knows nothing about cache, dedup, or circuit internals — it only schedules executor callbacks.

## Design notes

- **Deterministic.** All shaping is fixed or rule-based; nothing adapts at runtime. (With the [adaptive engine](adaptive.md) enabled, per-endpoint concurrency ceilings evolve deterministically through an `endpointLimit` callback.)
- **No batching.** Each request stays its own network attempt; only scheduling is shared.
- **Transparent default.** Without the option the client is byte-for-byte the scheduler-less client.

Next: [events & lifecycle](events-and-lifecycle.md) · [architecture](architecture.md).