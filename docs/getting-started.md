# Getting started

## Install

```sh
npm install @reqmind/core
```

The package ships both ESM and CJS with TypeScript types. Node ≥ 18 (or any runtime with a global `fetch`).

## Create a client

```ts
import { createClient } from "@reqmind/core";

const api = createClient({
  baseURL: "https://api.example.com",
  headers: { Authorization: "Bearer …", "X-Client": "reqmind" },
  cookies: undefined,            // (fetch handles credentials; pass anything you need here)
  cache: { enabled: true, ttl: 30_000, strategy: "cache-first" },
  retry: { attempts: 3, baseDelay: 1000, maxDelay: 30_000 },
  timeout: 10_000,
  fetch: undefined,              // defaults to the global fetch
});
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `baseURL` | `string` | — | Resolved before every relative URL |
| `headers` | `Record<string,string>` | — | Merged into every request |
| `cache` | `CacheOptions` | `{ enabled: true, ttl: 30_000, strategy: "cache-first" }` | Cache behavior |
| `retry` | `RetryOptions` | `{ attempts: 3, baseDelay: 1000, maxDelay: 30_000, backoff: "exponential", jitter: true, respectRetryAfter: true }` | Retry behavior |
| `timeout` | `number` | — | Default timeout in ms (0/absent = none) |
| `fetch` | `typeof fetch` | global `fetch` | Custom fetch implementation (testing, mocking, adapters) |
| `intelligence` | `IntelligenceOptions` | `{ enabled: true }` | Observation + adaptive behaviors ([guide](intelligence.md)) |

## Make requests

```ts
const users = await api.get<{ id: number }[]>("/users", { params: { page: 1, sort: "name" } });
console.log(users.data, users.status, users.statusText, users.headers);

await api.post("/users", { name: "Moaaz" });
await api.put("/users/1", { name: "Moaaz" });
await api.patch("/users/1", { name: "Moaaz" });
await api.delete("/users/1");
await api.head("/health");
await api.options("/users");

// The generic escape hatch:
await api.request("GET", "/users", { params: { page: 2 } });
```

Every method returns a `CancellablePromise<ApiResponse<T>>` — a normal `Promise` augmented with a `.cancel()` method.

### Request options

| Option | Type | Description |
| --- | --- | --- |
| `baseURL` | `string` | Override the client base URL for this request |
| `headers` | `Record<string,string>` | Merge on top of client headers |
| `params` | `Record<string, ParamValue \| ParamValue[]>` | Serialized into the query string |
| `body` | `unknown` | JSON-serialized unless it's already a `BodyInit` |
| `signal` | `AbortSignal` | External cancellation |
| `timeout` | `number` | Per-request timeout override |
| `cache` | `boolean \| CacheOptions` | Override caching for this request |
| `retry` | `boolean \| RetryOptions` | Override retrying for this request |
| `tags` | `string[]` | Mark the response for tag-based invalidation |

## Response shape

```ts
interface ApiResponse<T> {
  data: T;              // parsed body (JSON by default)
  status: number;       // 200, 201…
  statusText: string;
  headers: Headers;     // native Headers
}
```

Success is a `2xx` status. Non-2xx responses throw an `HttpError` carrying `.status`, `.statusText`, `.headers`, and the original `Response`-based diagnostics.

## Errors

```ts
import { HttpError, TimeoutError, CancelledError, isAbortError } from "@reqmind/core";

try {
  await api.get("/users");
} catch (err) {
  if (err instanceof HttpError) {
    console.log("HTTP", err.status, err.statusText);
  } else if (err instanceof TimeoutError) {
    console.log("took too long");
  } else if (err instanceof CancelledError) {
    console.log("aborted");
  }
}
```

Next: [request intelligence — dedup, cache & SWR](request-intelligence.md).