export { createClient } from "./client/client.js";
export type {
  Client,
  ClientEvents,
  CancellablePromise,
  ResolvedCacheOptions,
  SchedulerController,
} from "./client/client.js";

export { Tracker } from "./request/tracker.js";
export { Scheduler } from "./scheduler/scheduler.js";
export type { JobControl, ParkReason, SchedulerStats } from "./scheduler/scheduler.js";
export { Intelligence } from "./intelligence/intelligence.js";
export type {
  EndpointStats,
  IntelligenceController,
  IntelligenceRecommendation,
  IntelligenceSnapshot,
  IntelligenceSummary,
} from "./intelligence/intelligence.js";
export { CircuitBreaker } from "./circuit/circuit-breaker.js";
export type {
  CircuitBreakerController,
  CircuitState,
  CircuitStatus,
} from "./circuit/circuit-breaker.js";
export { CacheStore } from "./cache/cache-store.js";
export type { CacheEntry, RemovedEntry, InvalidationResult } from "./cache/cache-store.js";
export { Deduper } from "./dedup/deduper.js";
export { EventEmitter } from "./events/event-emitter.js";
export { HttpError, TimeoutError, CancelledError, CircuitOpenError, isAbortError } from "./errors.js";
export { decideRetry, resolveRetryOptions } from "./retry/policy.js";
export type { RetryDecision, ResolvedRetryOptions } from "./retry/policy.js";
export { AdaptiveEngine } from "./adaptive/engine.js";
export type { AdaptiveController } from "./adaptive/controllers.js";
export type { EndpointAdaptiveState, AdaptiveHealth } from "./adaptive/decisions.js";
export {
  isRetriableStatus,
  isSuccessStatus,
  parseRetryAfter,
} from "./utils/status.js";
export { computeDelay } from "./utils/backoff.js";
export { createFingerprint } from "./utils/fingerprint.js";
export { canonicalizeURL, buildQuery, resolveURL } from "./utils/url.js";

export type {
  AdaptiveMetrics,
  AdaptiveOptions,
  ApiResponse,
  CacheMeta,
  CacheOptions,
  CacheStrategy,
  CacheSubscriber,
  CacheUpdate,
  CircuitBreakerOptions,
  ClientOptions,
  HttpMethod,
  IntelligenceOptions,
  InvalidateTarget,
  ParamValue,
  Priority,
  RequestOptions,
  RequestSpec,
  RequestState,
  RetryOptions,
  SchedulerOptions,
  SchedulerRateLimitOptions,
  SchedulerRequestOptions,
} from "./types.js";