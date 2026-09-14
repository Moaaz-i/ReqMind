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
}
```

### Method notes

- `request` is the generic escape hatch; the sugar methods (`get`, `post`, …) wrap it.
- `get`/`delete`/`head`/`options` take `(url, options)`; `post`/`put`/`patch` take `(url, body, options)`.
- `delete` is typed like `get` (`Client["get"]`).
- Every method returns a `CancellablePromise`.

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
  "cache-hit": { key: string; tracker: Tracker };
  "cache-write": { key: string; response: ApiResponse };
  invalidate:  { keys: string[]; target: InvalidateTarget };
  revalidate:  { key: string; response: ApiResponse };
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

`HttpMethod`, `RequestState`, `CacheStrategy`, `ParamValue`, `RequestSpec`, `CacheOptions`, `RetryOptions`, `RequestOptions`, `ApiResponse`, `ClientOptions`, `CacheUpdate`, `CacheMeta`, `CacheSubscriber`, `InvalidateTarget`, `Client`, `ClientEvents`, `CancellablePromise`, `ResolvedCacheOptions`, `RetryDecision`, `ResolvedRetryOptions`, `CacheEntry`, `RemovedEntry`, `InvalidationResult`.