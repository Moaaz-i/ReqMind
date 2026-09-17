export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/** Lifecycle state of a request's tracker. */
export type RequestState =
  | "idle"
  | "pending"
  | "retrying"
  | "success"
  | "error"
  | "cancelled";

export type CacheStrategy = "cache-first" | "stale-while-revalidate";

export interface CacheOptions {
  /** Enable response caching for read requests (default: true at the client level). */
  enabled?: boolean;
  /** Time-to-live in milliseconds. Default: 30_000. */
  ttl?: number;
  /** Serve stale data instantly and refresh in the background (default: "cache-first"). */
  strategy?: CacheStrategy;
}

export interface RetryOptions {
  /** Maximum total attempts including the first (default: 3). */
  attempts?: number;
  /** Base delay in milliseconds (default: 1000). */
  baseDelay?: number;
  /** Upper bound for a single backoff delay in ms (default: 30_000). */
  maxDelay?: number;
  backoff?: "exponential" | "fixed";
  /** Add jitter to backoff delays to avoid thundering herds (default: true). */
  jitter?: boolean;
  /** Custom decision function. Overrides the built-in status table. */
  retryOn?: (status: number | undefined) => boolean;
  /** Respect the Retry-After header on 429/503 responses (default: true). */
  respectRetryAfter?: boolean;
}

/** Circuit breaker policy, applied per endpoint (`METHOD pathname`). */
export interface CircuitBreakerOptions {
  /** Master switch for circuit breaking (default: true). */
  enabled?: boolean;
  /** Consecutive failures that trip the circuit closed→open (default: 5). */
  failureThreshold?: number;
  /** How long the circuit stays open before letting one probe through, in ms (default: 10_000). */
  resetTimeout?: number;
}

/**
 * v0.8 Adaptive Engine: deterministic (never ML), explainable traffic shaping.
 *
 * This is a manual, inspectable layer — not heuristics coupled to the
 * scheduler. Every behavior is opt-in and every decision carries a human
 * readable `reason`. With the whole block absent or `enabled: false` the
 * client behaves exactly as it did in v0.7.
 */
export interface AdaptiveOptions {
  /** Master switch for all adaptive behavior (default: false). */
  enabled?: boolean;
  /** Adapt the per-endpoint scheduler concurrency ceiling (default: false). */
  concurrency?: boolean;
  /** Scale retry backoff while an endpoint is under pressure (default: false). */
  retry?: boolean;
  /** React to 429 pressure by throttling an endpoint (default: false). */
  rateLimit?: boolean;
  /** Prefer stale-while-revalidate reads while an endpoint is degraded (default: false). */
  staleWhileRevalidate?: boolean;
  /** p95 latency (ms) at/above which an endpoint is considered degraded (default: 2000). */
  highLatencyMs?: number;
  /** p95 latency (ms) below which an endpoint is healthy again (default: 1000). */
  lowLatencyMs?: number;
  /** Consecutive "bad" windows required before the first reduction (default: 3). */
  degradeSamples?: number;
  /** Consecutive healthy windows required before each +1 recovery step (default: 3). */
  recoverySamples?: number;
  /** Minimum windows between two consecutive decisions per endpoint (default: 2). */
  changeCooldown?: number;
  /** Floor for the effective concurrency ceiling (default: 1). */
  minConcurrency?: number;
  /** 429 share of the outcome window that flags rate-limit pressure (default: 0.2). */
  rateLimitRatio?: number;
  /** Failure share of the outcome window that flags high-error pressure (default: 0.1). */
  errorRatio?: number;
  /** Backoff multiplier applied while an endpoint is throttled (default: 2). */
  backoffFactor?: number;
  /** Cap for an adapted retry baseDelay in ms (default: 10_000). */
  maxBackoffMs?: number;
  /** Degraded p95 latency (ms) at which reads flip to stale-while-revalidate (default: 1500). */
  swrLatencyMs?: number;
  /** Latency samples kept per endpoint ring (default: 64). */
  latencyWindow?: number;
  /** Outcome samples kept for pressure ratios (default: 32). */
  outcomeWindow?: number;
}

/** Rolled-up adaptive counters exposed on `intelligence().snapshot()`. */
export interface AdaptiveMetrics {
  /** Number of effective decisions (reductions + recoveries + throttle changes). */
  decisions: number;
  /** Times an endpoint's effective concurrency was reduced by one. */
  concurrencyReductions: number;
  /** Times an endpoint's effective concurrency grew back by one. */
  concurrencyRecoveries: number;
  /** Times an endpoint entered throttled mode under 429 pressure. */
  throttles: number;
  /** Times an endpoint's retry backoff multiplier changed. */
  retryChanges: number;
}

export type ParamValue = string | number | boolean | null | undefined;

/** Traffic priority for a request (used when the scheduler's `priority` option is enabled). */
export type Priority = "high" | "normal" | "low";

/** Client-side attempt budget: at most `requests` network attempts per `interval` ms. */
export interface SchedulerRateLimitOptions {
  requests: number;
  interval: number;
}

/**
 * When & how requests are sent. Deterministic, opt-in: when the `scheduler`
 * option is absent the client behaves exactly as without a scheduler.
 */
export interface SchedulerOptions {
  /** Master switch (default: true — the option's presence enables the scheduler). */
  enabled?: boolean;
  /** Max concurrent network attempts at the client level (default: 8). */
  concurrency?: number;
  /**
   * Enable high/normal/low priority lanes. When false (default) every request
   * shares a single FIFO queue and request-level `priority` / `prioritize()`
   * are inert. When true, lanes are serviced weighted round-robin (4:2:1) so
   * low-priority traffic is never starved.
   */
  priority?: boolean;
  /** Per-host concurrency caps: hostname → max concurrent attempts. */
  hosts?: Record<string, number>;
  /** Client-side rate limiting for network attempts (default: none). */
  rateLimit?: SchedulerRateLimitOptions;
}

/** Per-request scheduler hints. */
export interface SchedulerRequestOptions {
  /**
   * Logical group (e.g. a page/component) that can be paused, resumed,
   * cancelled, or re-prioritized as one unit via `client.scheduler`.
   */
  group?: string;
}

/** Per-request configuration. Overrides client defaults. */
export interface RequestOptions {
  method: HttpMethod;
  url: string;
  baseURL?: string;
  headers?: Record<string, string>;
  params?: Record<string, ParamValue | ParamValue[]>;
  body?: unknown;
  /** External cancellation handle. An already-aborted signal rejects immediately. */
  signal?: AbortSignal;
  timeout?: number;
  cache?: boolean | CacheOptions;
  retry?: boolean | RetryOptions;
  /** Tags joined with the request path during mutation-driven invalidation. */
  tags?: string[];
  /** Traffic priority (used when the scheduler's `priority` option is enabled). */
  priority?: Priority;
  /** Per-request scheduler hints (group assignment). */
  scheduler?: SchedulerRequestOptions;
}

/** A resolved response carrying parsed body and HTTP metadata. */
export interface ApiResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export interface ClientOptions {
  baseURL?: string;
  headers?: Record<string, string>;
  cache?: CacheOptions;
  retry?: RetryOptions;
  timeout?: number;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Observation + adaptive behaviors (see IntelligenceOptions). */
  intelligence?: IntelligenceOptions;
  /** Adaptive Engine (v0.8): deterministic per-endpoint traffic shaping (see AdaptiveOptions). */
  adaptive?: AdaptiveOptions;
  /** Circuit breaker policy per endpoint (see CircuitBreakerOptions). */
  circuitBreaker?: CircuitBreakerOptions;
  /** Traffic shaping: priority, concurrency, per-host caps, rate limiting (see SchedulerOptions). */
  scheduler?: SchedulerOptions;
}

/** Update delivered to cache subscribers via `client.subscribe`. */
export interface CacheUpdate<T = unknown> {
  type: "write" | "revalidate" | "invalidate";
  key: string;
  response?: ApiResponse<T>;
}

/** What to invalidate: an exact path, tag list, or a predicate over metadata. */
export type InvalidateTarget = string | string[] | ((entry: CacheMeta) => boolean);

/** Metadata stored alongside every cached response. */
export interface CacheMeta {
  key: string;
  tags: string[];
  storedAt: number;
  expiresAt: number;
}

/** Engine-level intelligence: observation stats + adaptive behaviors. */
export interface IntelligenceOptions {
  /** Master switch for observation + adaptive behavior (default: true). */
  enabled?: boolean;
  /** Auto-tune per-endpoint timeouts from observed latency (default: false). */
  adaptiveTimeout?: boolean;
  /** Auto-enable stale-while-revalidate for slow endpoints (default: false). */
  adaptiveStaleWhileRevalidate?: boolean;
}

export type CacheSubscriber<T = unknown> = (update: CacheUpdate<T>) => void;

/**
 * Fully resolved request description, ready to be executed. Stored inside
 * cache entries so entries can be refetched after invalidation.
 */
export interface RequestSpec {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeout?: number;
  retry: RetryOptions;
}