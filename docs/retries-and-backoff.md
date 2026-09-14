# Retries & backoff

Failed attempts are retried according to a small, configurable policy. The policy is shared by the client and exported standalone as `decideRetry` / `resolveRetryOptions`.

## Defaults

```ts
{
  attempts: 3,            // max total attempts, including the first
  baseDelay: 1000,        // ms, base of the backoff series
  maxDelay: 30_000,       // ms, cap per attempt
  backoff: "exponential",
  jitter: true,           // smooth out thundering herds
  respectRetryAfter: true,// 429/503 honor the Retry-After header
}
```

## Status table

| Status | Behavior |
| --- | --- |
| `408`, `429`, `500`, `502`, `503`, `504` | retry |
| `400`, `401`, `403`, `404`, `409`, `422` | fail immediately |
| anything else | fail immediately |

Customize with `retryOn`:

```ts
const api = createClient({
  retry: {
    attempts: 5,
    retryOn: (status) => status === undefined || status >= 500, // network errors too
  },
});
```

`retryOn` fully replaces the built-in table.

## Backoff

`computeDelay({ attempts, baseDelay, maxDelay, backoff, jitter })`:

- **exponential**: `min(baseDelay * 2^(attempts - 1), maxDelay)` — with a single elementary jitter: a random factor drawn per attempt, distributed on `max(baseDelay * 0.2, …)` … `delay`.
- **fixed**: constant `min(baseDelay, maxDelay)`, also jittered when enabled.

Jittered delays cap at `maxDelay`. Delays shorter than `1s` are floored to `0` (no artificial sleeping).

## Retry-After

On `429` and `503`, when `respectRetryAfter` is on and the response has a `Retry-After` header, the header wins and overrides the computed delay. Both HTTP-date and delta-seconds forms parse.

## Lifecycle hooks

```ts
api.on("retry", ({ key, tracker, attempts, delay, error }) => {
  console.log(`attempt ${attempts} failed; retrying in ${delay}ms`);
  expect(tracker.state).toBe("retrying");
});
api.on("success", ({ key, tracker }) => expect(tracker.state).toBe("success"));
```

The `Tracker` exposes `state` and the outcome is visible on `success`/`error`/`cancel` event payloads.

## Standalone API

```ts
import { decideRetry, resolveRetryOptions, computeDelay } from "@reqmind/core";

const options = resolveRetryOptions({ attempts: 4, baseDelay: 200 });
const decision = decideRetry({
  error,      // an HttpError, carries .status, .headers
  options,
  attempts: 2, // attempts already performed including the failed one
});
// { shouldRetry: true, delayMs: 400 }
```

Next: [cancellation & timeouts](cancellation-and-timeouts.md).