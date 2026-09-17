import type { AdaptiveMetrics, CacheStrategy } from "../types.js";

/** Overall health label for an endpoint, derived from decisions. */
export type AdaptiveHealth = "good" | "recovering" | "degraded" | "throttled";

/** Per-endpoint readout exposed via `client.adaptive().snapshot()`. */
export interface EndpointAdaptiveState {
  /** Endpoint key (`METHOD pathname`). */
  endpoint: string;
  /** The scheduler's original concurrency ceiling (never changes). */
  configured: number;
  /** The applied concurrency ceiling right now. */
  effective: number;
  mode: "nominal" | "reducing" | "recovering";
  health: AdaptiveHealth;
  /** Explainable: why the effective ceiling is where it is. */
  reason: string;
  /** Retry backoff multiplier applied to this endpoint. */
  retryMultiplier: number;
  retryMode: "nominal" | "throttled";
  retryReason: string;
  /** Recommended cache strategy (set when staleWhileRevalidate engaged). */
  strategy?: CacheStrategy;
  strategyReason: string;
  /** Observed signals behind the current decision. */
  signals: {
    avg: number;
    p50: number;
    p95: number;
    samples: number;
    errorRatio: number;
    rateLimitRatio: number;
    active: number;
  };
  /** Timestamp (getNow) of the first reduction, if the endpoint is still below its ceiling. */
  degradedSince?: number;
  counters: AdaptiveMetrics;
}