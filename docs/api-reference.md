# API reference

Precise, complete signatures for `@reqmind/core`. Types are extracted verbatim from the source.

## `createClient`

```ts
function createClient(options?: ClientOptions): Client
```

### `ClientOptions`

```ts
interface ClientOptions {
  baseURL?: string;
  headers?: Record<string, string>;
  cache?: CacheOptions;
  retry?: RetryOptions;
  timeout?: number;
  fetch?: typeof fetch;
  intelligence?: IntelligenceOptions;
  circuitBreaker?: CircuitBreakerOptions;
  scheduler?: SchedulerOptions;
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `baseURL` | — | prepended to relative request URLs |
| `headers` | — | merged into every request (request headers win) |
| `cache` | `{ enabled: true, ttl: 30_000, strategy: "cache-first" }` | see `CacheOptions` |
| `retry` | `{ attempts: 3, baseDelay: 1000, maxDelay: 30_000, backoff: "exponential", jitter: true, respectRetryAfter: true }` | see `RetryOptions` |
| `timeout` | `0` (none) | default per-attempt timeout in ms |
| `fetch` | global `fetch` | inject a fetch implementation |
| `intelligence` | `{ enabled: true }` | see `IntelligenceOptions` |
| `circuitBreaker` | `{ enabled: true, failureThreshold: 5, resetTimeout: 10_000 }` | see `CircuitBreakerOptions` |
| `scheduler` | — (disabled) | see `SchedulerOptions` |

## `Client`

```ts
interface Client {
  request<T>(method: HttpMethod, url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  get<T>(url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  post<T>(url: string, body?: unknown, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  put<T>(url: string, body?: unknown, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  patch<T>(url: string, body?: unknown, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  delete<T>(url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  head<T>(url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  options<T>(url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;

  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void;
  subscribe<T>(matcher: (key: string) => boolean, listener: CacheSubscriber<T>): () => void;
  invalidate(target: InvalidateTarget, options?: { refetch?: boolean }): string[];
  cancelAll(): void;
  clearCache(): void;
  intelligence(): IntelligenceController;
  circuitBreaker(): CircuitBreakerController;
  scheduler(): SchedulerController;
  cancelGroup(group: string): void;
}
```

### Method notes

- `request` is the generic escape hatch; the sugar methods (`get`, `post`, …) wrap it.
- `get`/`delete`/`head`/`options` take `(url, options)`; `post`/`put`/`patch` take `(url, body, options)`.
- `delete` is typed like `get` (`Client["get"]`).
- Every method returns a `CancellablePromise`.
- `intelligence()` returns the observation board — see `IntelligenceController`.
- `circuitBreaker()` returns the circuit board — see `CircuitBreakerController`.
- `scheduler()` returns the traffic-shaping board — see `SchedulerController`.
- `cancelGroup(group)` is shorthand for `scheduler().cancelGroup(group)`.

## `CircuitBreakerOptions`

```ts
interface CircuitBreakerOptions {
  enabled?: boolean;              // default true
  failureThreshold?: number;      // default 5 — consecutive countable failures to trip open
  resetTimeout?: number;          // default 10_000 ms — how long a circuit stays open
}
```

Deterministic: options are read once at client creation. Runtime mutation is **not** supported, and there is no adaptive circuit breaker yet.

## `CircuitBreakerController`

```ts
interface CircuitBreakerController {
  status(method: HttpMethod, path: string): CircuitStatus;  // read (and lazily create) a circuit
  statuses(): CircuitStatus[];                              // every circuit ever observed
  reset(method?: HttpMethod, path?: string): void;          // force back to closed (all if args omitted)
}

type CircuitState = "closed" | "open" | "halfOpen";

interface CircuitStatus {
  endpoint: string;                 // "METHOD pathname"
  state: CircuitState;
  consecutiveFailures: number;      // counted failures since the last success
  openedAt?: number;                // when the circuit last opened (resetTimeout measured from here)
  probing: boolean;                 // a half-open probe is currently in flight
}
```

Guide: [resilience.md](resilience.md).

## `SchedulerOptions`

```ts
interface SchedulerOptions {
  enabled?: boolean;            // default true — the option's presence enables the scheduler
  concurrency?: number;         // max simultaneous network attempts; default 8
  priority?: boolean;           // enable high/normal/low lanes; default false (single FIFO queue)
  hosts?: Record<string, number>;   // per-host concurrency caps (hostname → max)
  rateLimit?: SchedulerRateLimitOptions;
}

interface SchedulerRateLimitOptions {
  requests: number;   // max network attempts per window
  interval: number;   // window length in ms
}
```

Opt-in: without this option (or with `enabled: false`) the client is byte-identical to a scheduler-less client.

## `SchedulerController`

```ts
interface SchedulerController {
  stats(): SchedulerStats;              // lived counters (below)
  pauseGroup(group: string): void;      // freeze queued work in a group (running requests finish)
  resumeGroup(group: string): void;     // re-admit a paused group
  cancelGroup(group: string): void;     // drop every queued/parked/running request in a group
  prioritize(selector: string, priority: Priority): number; // move matching queued jobs to a lane
}

type Priority = "high" | "normal" | "low";

interface SchedulerStats {
  active: number;       // holding a network slot right now
  queued: number;       // waiting in the priority lanes
  delayed: number;      // parked until a future moment
  completed: number;    // finished their full lifecycle
  rejected: number;     // dropped by the scheduler (group/all cancellation)
  lanes: Record<Priority, number>;
}
```

- `prioritize` selects queued jobs by **queue group name or request key** and returns how many moved. It requires `priority: true`.
- `cancelGroup` cancels queued, parked, and running jobs alike. Guide: [scheduler.md](scheduler.md).

## `IntelligenceOptions`

```ts
interface IntelligenceOptions {
  enabled?: boolean;                  // default true
  adaptiveTimeout?: boolean;          // default false
  adaptiveStaleWhileRevalidate?: boolean; // default false
}
```

With `adaptiveTimeout`, once an endpoint has ≥ 5 latency samples the engine recommends a per-endpoint timeout of **3×p95** (100ms…60s floor/cap).
With `adaptiveStaleWhileRevalidate`, endpoints whose p95 ≥ ~500ms are switched to stale-while-revalidate.
Priority: explicit `RequestOptions.timeout`/`strategy` → adaptive → client default. Guide: [intelligence.md](intelligence.md).

## `IntelligenceController`

```ts
interface IntelligenceController {
  snapshot(): IntelligenceSnapshot;                    // summary + all endpoints
  endpoint(method: string, pathname: string): EndpointStats | undefined;
  reset(): void;                                       // clears observation history
}

interface IntelligenceSummary {
  totalRequests; cacheHits; cacheMisses; deduplicated;
  retriesPerformed; retriesRecovered; failures; rateLimited; timeouts; cancels;
  activeRequests; cacheHitRate;         // cacheHits / totalRequests (0 if none)
  dedupRate; retryRate; failureRate; rateLimitRate;
}

interface IntelligenceSnapshot {
  summary: IntelligenceSummary;
  endpoints: EndpointStats[];
}

interface EndpointStats {
  method; path;
  requests; successes; failures; cacheHits; cacheMisses; dedupPrevented;
  retriesPerformed; retriesRecovered; rateLimited; timeouts; cancels;
  latency: { avg: number; p50: number; p95: number; samples: number };
}
```

## `RequestOptions`

```ts
interface RequestOptions {
  method: HttpMethod;
  url: string;
  baseURL?: string;
  headers?: Record<string, string>;
  params?: Record<string, ParamValue | ParamValue[]>;
  body?: unknown;
  signal?: AbortSignal;
  timeout?: number;
  cache?: boolean | CacheOptions;
  retry?: boolean | RetryOptions;
  tags?: string[];
  priority?: Priority;                    // "high" | "normal" | "low" (used when scheduler.priority is true)
  scheduler?: { group: string };          // queue group for pause/resume/cancel/prioritize
}

type ParamValue = string | number | boolean | null | undefined;
```

| Field | Notes |
| --- | --- |
| `params` | serialized into the query string via `buildQuery`; arrays repeat the key |
| `body` | JSON stringified unless already a `BodyInit` (`string`, `URLSearchParams`, `FormData`, `Blob`, `ArrayBuffer`, typed array) |
| `cache: false` | skip caching for this request |
| `retry: false` | fail on first attempt |
| `signal` | external abort handle; an already-aborted signal rejects immediately |
| `tags` | joined with the path during mutation invalidation |
| `priority` | route into a priority lane (ignored when `scheduler.priority` is false) |
| `scheduler.group` | queue group membership — control it as one unit |

## `CacheOptions`

```ts
interface CacheOptions {
  enabled?: boolean;   // default false at type level, client enables by default
  ttl?: number;        // ms; default 30_000
  strategy?: CacheStrategy; // "cache-first" | "stale-while-revalidate"
}
```

## `RetryOptions`

```ts
interface RetryOptions {
  attempts?: number;              // total attempts incl. first; default 3
  baseDelay?: number;             // ms; default 1000
  maxDelay?: number;              // ms; default 30_000
  backoff?: "exponential" | "fixed";
  jitter?: boolean;               // default true
  retryOn?: (status: number | undefined) => boolean;
  respectRetryAfter?: boolean;    // default true
}
```

Retry-eligible by default: `408 429 500 502 503 504`.

## `ApiResponse`

```ts
interface ApiResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}
```

## `CancellablePromise`

```ts
interface CancellablePromise<T> extends Promise<T> {
  cancel: () => void;   // rejects with CancelledError
}
```

## Events

```ts
interface ClientEvents {
  request:     { key: string; method: HttpMethod; url: string; tracker: Tracker };
  success:     { key: string; tracker: Tracker; response: ApiResponse };
  error:       { key: string; tracker: Tracker; error: unknown };
  retry:       { key: string; tracker: Tracker; attempts: number; delay: number; error: HttpError };
  cancel:      { key: string; tracker: Tracker };
  dedup:       { key: string; method: HttpMethod; url: string; consumers: number };
  "cache-hit": { key: string; tracker: Tracker };
  "cache-write": { key: string; response: ApiResponse };
  invalidate:  { keys: string[]; target: InvalidateTarget };
  revalidate:  { key: string; response: ApiResponse };
  "circuit-open": { endpoint: string; method: HttpMethod; path: string };
  "circuit-half-open": { endpoint: string; method: HttpMethod; path: string };
  "circuit-closed": { endpoint: string; method: HttpMethod; path: string };
  "circuit-rejected": { endpoint: string; method: HttpMethod; path: string; error: CircuitOpenError };
  "request-queued": { id: number; key: string; method: HttpMethod; url: string; priority: Priority; position: number };
  "request-dequeued": { id: number; key: string; method: HttpMethod; url: string; priority: Priority };
  "request-started": { id: number; key: string; method: HttpMethod; url: string; priority: Priority };
  "request-delayed": { id: number; key: string; method: HttpMethod; url: string; priority: Priority; reason: ParkReason; delay: number };
  "request-scheduled": { id: number; key: string; method: HttpMethod; url: string; priority: Priority };
  "request-prioritized": { id: number; key: string; method: HttpMethod; url: string; priority: Priority; from: Priority; to: Priority };
  "request-rejected": { id: number; key: string; method: HttpMethod; url: string; priority: Priority; reason: "cancelled" };
  "queue-paused": { group?: string };
  "queue-resumed": { group?: string };
}
```

`client.on(event, listener)` returns `() => void`.

## `subscribe`

```ts
type CacheSubscriber<T> = (update: CacheUpdate<T>) => void;

interface CacheUpdate<T = unknown> {
  type: "write" | "revalidate" | "invalidate";
  key: string;
  response?: ApiResponse<T>;   // absent for "invalidate"
}

client.subscribe<T>(matcher: (key: string) => boolean, listener: CacheSubscriber<T>): () => void
```

## `invalidate`

```ts
type InvalidateTarget = string | string[] | ((entry: CacheMeta) => boolean);

interface CacheMeta {
  key: string;
  tags: string[];
  storedAt: number;
  expiresAt: number;
}

client.invalidate(target: InvalidateTarget, options?: { refetch?: boolean }): string[];
```

- `string` → exact **path** with children + query variants
- `string[]` → **tags**
- `function` → **predicate** over `CacheMeta`
- returns removed keys

## Errors

```ts
class HttpError extends Error {
  status?: number;
  statusText?: string;
  headers?: Headers;
}
class TimeoutError extends Error {}
class CancelledError extends Error {}
class CircuitOpenError extends Error {
  endpoint: string;   // "METHOD pathname" for which the circuit is open
}
function isAbortError(err: unknown): boolean;
```

## Standalone utilities

| Export | Signature |
| --- | --- |
| `CacheStore` | `new CacheStore(defaultTtl?: number)` |
| `Deduper` | in-flight coalescing map |
| `Tracker` | request state machine |
| `EventEmitter<T>` | typed emitter (`on`, `once`, `off`, `emit`) |
| `decideRetry` | `(input: { error; options; attempts }) => RetryDecision` |
| `resolveRetryOptions` | `(options?: RetryOptions) => ResolvedRetryOptions` |
| `computeDelay` | `(input: { attempts; baseDelay; maxDelay; backoff; jitter }) => number` |
| `isSuccessStatus` | `(status?: number) => boolean` |
| `isRetriableStatus` | `(status?: number) => boolean` |
| `parseRetryAfter` | `(value: string \| null) => number` (ms; `-1` if unparsable) |
| `createFingerprint` | `(input: { method; url; headers?; body? }) => string` |
| `resolveURL` | `(url: string, base?: string) => string` |
| `buildQuery` | `(params) => string` |
| `canonicalizeURL` | `(url: string) => string` |

## Index of types

`HttpMethod`, `RequestState`, `CacheStrategy`, `ParamValue`, `RequestSpec`, `CacheOptions`, `RetryOptions`, `RequestOptions`, `ApiResponse`, `ClientOptions`, `CacheUpdate`, `CacheMeta`, `CacheSubscriber`, `InvalidateTarget`, `Client`, `ClientEvents`, `CancellablePromise`, `ResolvedCacheOptions`, `RetryDecision`, `ResolvedRetryOptions`, `CacheEntry`, `RemovedEntry`, `InvalidationResult`, `IntelligenceOptions`, `IntelligenceController`, `IntelligenceSummary`, `IntelligenceSnapshot`, `EndpointStats`, `IntelligenceRecommendation`, `CircuitBreakerOptions`, `CircuitBreakerController`, `CircuitState`, `CircuitStatus`, `Priority`, `SchedulerOptions`, `SchedulerRateLimitOptions`, `SchedulerRequestOptions`, `SchedulerController`, `SchedulerStats`, `ParkReason`.