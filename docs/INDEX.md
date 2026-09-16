# ReqMind Docs

ReqMind is a **request intelligence engine**: a drop-in wrapper around `fetch` that makes HTTP requests deduplicated, cached, SWR-aware, retried, cancellable, and cache-consistent after mutations.

## Guides

| Guide | What you'll learn |
| --- | --- |
| [Getting started](getting-started.md) | Install, `createClient`, the `Client` surface, and your first requests |
| [Request intelligence](request-intelligence.md) | Dedup, caching, fingerprints, and stale-while-revalidate |
| [Retries & backoff](retries-and-backoff.md) | Retry policy, status table, exponential backoff, jitter, `Retry-After` |
| [Cancellation & timeouts](cancellation-and-timeouts.md) | `cancel()`, external `AbortSignal`s, timeouts, error types |
| [Cache invalidation](cache-invalidation.md) | Mutation invalidation, path/tag/predicate targets, auto-refetch |
| [Intelligence engine](intelligence.md) | Observation → Decision → Action: live stats + adaptive timeout & SWR |
| [Resilience](resilience.md) | Circuit breakers: per-endpoint fail-isolation, three states, circuit events |
| [Request scheduler](scheduler.md) | Priority lanes, concurrency caps, rate limiting, queue groups, park-on-backoff |
| [Events & lifecycle](events-and-lifecycle.md) | Every event, payloads, and the tracker state machine |
| [Architecture](architecture.md) | Modules, data flow, and internal contracts |
| [API reference](api-reference.md) | The complete, precise signature reference |

## Version story

- **v0.1.0** — MVP: dedup, TTL cache, retry policy, cancellation, timeouts, lifecycle events.
- **v0.2.0** — Stale-while-revalidate with background refresh and `revalidate` notifications.
- **v0.3.0** — Mutation-driven cache invalidation (path / tag / predicate) with automatic refetch.
- **v0.4.0** — Docs & hardening: docs suite + JSDoc, invalidation/refetch fixes.
- **v0.5.0** — Intelligence engine: per-endpoint observation, `client.intelligence()`, adaptive timeout & stale-while-revalidate.
- **v0.6.0** — Resilience engine: per-endpoint circuit breaker (closed/open/half-open), `circuit-*` events, `client.circuitBreaker()`, circuit stats on the intelligence board.
- **v0.7.0** — Request scheduler: priority lanes (weighted round-robin), global + per-host concurrency, client-side rate limiting, queue groups (`pauseGroup`/`resumeGroup`/`cancelGroup`/`prioritize`), park-on-backoff/`Retry-After`, and nine scheduler events.

Package entry point: [`@reqmind/core`](https://www.npmjs.com/package/@reqmind/core) — see [`packages/core/README.md`](../packages/core/README.md).