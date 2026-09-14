export { createClient } from "./client/client.js";
export type {
  Client,
  ClientEvents,
  CancellablePromise,
  ResolvedCacheOptions,
} from "./client/client.js";

export { Tracker } from "./request/tracker.js";
export { CacheStore } from "./cache/cache-store.js";
export type { CacheEntry, RemovedEntry, InvalidationResult } from "./cache/cache-store.js";
export { Deduper } from "./dedup/deduper.js";
export { EventEmitter } from "./events/event-emitter.js";
export { HttpError, TimeoutError, CancelledError, isAbortError } from "./errors.js";
export { decideRetry, resolveRetryOptions } from "./retry/policy.js";
export type { RetryDecision, ResolvedRetryOptions } from "./retry/policy.js";
export {
  isRetriableStatus,
  isSuccessStatus,
  parseRetryAfter,
} from "./utils/status.js";
export { computeDelay } from "./utils/backoff.js";
export { createFingerprint } from "./utils/fingerprint.js";
export { canonicalizeURL, buildQuery, resolveURL } from "./utils/url.js";

export type {
  ApiResponse,
  CacheMeta,
  CacheOptions,
  CacheStrategy,
  CacheSubscriber,
  CacheUpdate,
  ClientOptions,
  HttpMethod,
  InvalidateTarget,
  ParamValue,
  RequestOptions,
  RequestSpec,
  RequestState,
  RetryOptions,
} from "./types.js";