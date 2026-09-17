import type { CacheStrategy } from "../types.js";
import type { SignalSummary } from "./signals.js";

/** Fully resolved adaptive tuning knobs. */
export interface ResolvedAdaptivePolicy {
  highLatencyMs: number;
  lowLatencyMs: number;
  degradeSamples: number;
  recoverySamples: number;
  changeCooldown: number;
  minConcurrency: number;
  rateLimitRatio: number;
  errorRatio: number;
  backoffFactor: number;
  maxBackoffMs: number;
  swrLatencyMs: number;
  latencyWindow: number;
  outcomeWindow: number;
}

/** Stable defaults — every decision is explainable against these. */
export const DEFAULT_ADAPTIVE_POLICY: ResolvedAdaptivePolicy = {
  highLatencyMs: 2000,
  lowLatencyMs: 1000,
  degradeSamples: 3,
  recoverySamples: 3,
  changeCooldown: 2,
  minConcurrency: 1,
  rateLimitRatio: 0.2,
  errorRatio: 0.1,
  backoffFactor: 2,
  maxBackoffMs: 10_000,
  swrLatencyMs: 1500,
  latencyWindow: 64,
  outcomeWindow: 32,
};

export function resolveAdaptivePolicy(options?: {
  highLatencyMs?: number;
  lowLatencyMs?: number;
  degradeSamples?: number;
  recoverySamples?: number;
  changeCooldown?: number;
  minConcurrency?: number;
  rateLimitRatio?: number;
  errorRatio?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  swrLatencyMs?: number;
  latencyWindow?: number;
  outcomeWindow?: number;
}): ResolvedAdaptivePolicy {
  const base = DEFAULT_ADAPTIVE_POLICY;
  return {
    highLatencyMs: options?.highLatencyMs ?? base.highLatencyMs,
    lowLatencyMs: options?.lowLatencyMs ?? base.lowLatencyMs,
    degradeSamples: Math.max(1, options?.degradeSamples ?? base.degradeSamples),
    recoverySamples: Math.max(1, options?.recoverySamples ?? base.recoverySamples),
    changeCooldown: Math.max(0, options?.changeCooldown ?? base.changeCooldown),
    minConcurrency: Math.max(1, options?.minConcurrency ?? base.minConcurrency),
    rateLimitRatio: options?.rateLimitRatio ?? base.rateLimitRatio,
    errorRatio: options?.errorRatio ?? base.errorRatio,
    backoffFactor: Math.max(1, options?.backoffFactor ?? base.backoffFactor),
    maxBackoffMs: options?.maxBackoffMs ?? base.maxBackoffMs,
    swrLatencyMs: options?.swrLatencyMs ?? base.swrLatencyMs,
    latencyWindow: Math.max(4, options?.latencyWindow ?? base.latencyWindow),
    outcomeWindow: Math.max(2, options?.outcomeWindow ?? base.outcomeWindow),
  };
}

export type ConcurrencyAction = "reduce" | "recover" | "hold";
export type ConcurrencyMode = "nominal" | "reducing" | "recovering";

export interface ConcurrencyEvaluationInput {
  signals: SignalSummary;
  state: {
    effective: number;
    configured: number;
    consecutiveBad: number;
    consecutiveGood: number;
    cooldown: number;
    degraded: boolean;
    recovering: boolean;
  };
  policy: ResolvedAdaptivePolicy;
}

export interface ConcurrencyEvaluation {
  action: ConcurrencyAction;
  mode: ConcurrencyMode;
  degraded: boolean;
  recovering: boolean;
  consecutiveBad: number;
  consecutiveGood: number;
  cooldown: number;
  effective: number;
  reason: string;
}

/** Dominant pressure source for a degraded window (deterministic). */
export function dominantPressure(signals: SignalSummary, policy: ResolvedAdaptivePolicy): string {
  const degradedLatency =
    signals.latencySamples >= 1 && signals.p95 >= policy.highLatencyMs;
  const rlPressure = signals.total >= 1 && signals.rateLimitRatio >= policy.rateLimitRatio;
  const errPressure = signals.total >= 1 && signals.errorRatio >= policy.errorRatio;
  if (degradedLatency) {
    return `p95 latency ${signals.p95}ms is at/above the ${policy.highLatencyMs}ms ceiling`;
  }
  if (rlPressure) {
    return `the 429 ratio (${fmt(signals.rateLimitRatio)}) exceeds ${fmt(policy.rateLimitRatio)}`;
  }
  return `the error ratio (${fmt(signals.errorRatio)}) exceeds ${fmt(policy.errorRatio)}`;
}

/**
 * Per-endpoint concurrency ceiling decision.
 *
 * Movement is strictly gradual: the ceiling steps down (or up) by exactly 1
 * per change, and only after `degradeSamples`/`recoverySamples` consecutive
 * windows plus a cooldown. Hysteresis (a gap between high/low latency
 * thresholds) plus the cooldown guarantee the ceiling never oscillates.
 */
export function evaluateConcurrency(input: ConcurrencyEvaluationInput): ConcurrencyEvaluation {
  const { signals, policy } = input;
  let { effective, consecutiveBad, consecutiveGood, cooldown } = input.state;
  const degraded = input.state.degraded;
  let recovering = input.state.recovering;

  const bad =
    (signals.latencySamples >= 1 && signals.p95 >= policy.highLatencyMs) ||
    (signals.total >= 1 && signals.rateLimitRatio >= policy.rateLimitRatio) ||
    (signals.total >= 1 && signals.errorRatio >= policy.errorRatio);
  const healthyNoPressure =
    signals.total >= 1 &&
    (signals.latencySamples === 0 || signals.p95 < policy.lowLatencyMs) &&
    signals.rateLimitRatio < policy.rateLimitRatio &&
    signals.errorRatio < policy.errorRatio;

  cooldown = Math.max(0, cooldown - 1);

  if (bad) {
    recovering = false;
    consecutiveGood = 0;
    consecutiveBad += 1;
    if (consecutiveBad >= policy.degradeSamples && cooldown === 0 && effective > policy.minConcurrency) {
      const next = effective - 1;
      return {
        action: "reduce",
        mode: "reducing",
        degraded: true,
        recovering: false,
        consecutiveBad: 0,
        consecutiveGood: 0,
        cooldown: policy.changeCooldown,
        effective: next,
        reason: `${dominantPressure(signals, policy)} for ${policy.degradeSamples} consecutive windows`,
      };
    }
    return {
      action: "hold",
      mode: degraded ? "reducing" : "nominal",
      degraded,
      recovering: false,
      consecutiveBad,
      consecutiveGood: 0,
      cooldown,
      effective,
      reason: `${dominantPressure(signals, policy)} (holding ${consecutiveBad}/${policy.degradeSamples} windows)`,
    };
  }

  if (healthyNoPressure) {
    consecutiveBad = 0;
    if (!degraded && !recovering) {
      return {
        action: "hold",
        mode: "nominal",
        degraded: false,
        recovering: false,
        consecutiveBad: 0,
        consecutiveGood: 0,
        cooldown,
        effective,
        reason: "endpoint is healthy — no adjustment needed",
      };
    }
    recovering = true;
    consecutiveGood += 1;
    if (consecutiveGood >= policy.recoverySamples && cooldown === 0 && effective < input.state.configured) {
      const next = effective + 1;
      return {
        action: "recover",
        mode: next >= input.state.configured ? "nominal" : "recovering",
        degraded: next < input.state.configured,
        recovering: next < input.state.configured,
        consecutiveBad: 0,
        consecutiveGood: 0,
        cooldown: policy.changeCooldown,
        effective: next,
        reason: `p95 latency ${signals.p95}ms is below the ${policy.lowLatencyMs}ms healthy floor`,
      };
    }
    const stillDegraded = effective < input.state.configured;
    return {
      action: "hold",
      mode: stillDegraded ? "recovering" : "nominal",
      degraded: stillDegraded,
      recovering: stillDegraded,
      consecutiveBad: 0,
      consecutiveGood,
      cooldown,
      effective,
      reason: recovering
        ? `recovering (${consecutiveGood}/${policy.recoverySamples} healthy windows)`
        : "endpoint is healthy — no adjustment needed",
    };
  }

  // Deadband between the low and high thresholds: neither pressure nor
  // recovery. Do nothing — this is the hysteresis zone that kills oscillation.
  return {
    action: "hold",
    mode: degraded || recovering ? (recovering ? "recovering" : "reducing") : "nominal",
    degraded,
    recovering: recovering && degraded,
    consecutiveBad,
    consecutiveGood,
    cooldown,
    effective,
    reason: "signals are in the hysteresis deadband — holding steady",
  };
}

export interface ThrottleEvaluationInput {
  signals: SignalSummary;
  state: { throttled: boolean; goodWindows: number };
  policy: ResolvedAdaptivePolicy;
}

export interface ThrottleEvaluation {
  throttled: boolean;
  multiplier: number;
  changed: boolean;
  goodWindows: number;
  reason: string;
}

/**
 * Retry backoff multiplier under 429 pressure. Entering throttled mode is
 * immediate (a single pressured window), release requires `recoverySamples`
 * consecutive clean windows. A server Retry-After header always wins over
 * this multiplier at the request level.
 */
export function evaluateThrottle(input: ThrottleEvaluationInput): ThrottleEvaluation {
  const { signals, policy } = input;
  let { throttled, goodWindows } = input.state;
  const pressured = signals.total >= 1 && signals.rateLimitRatio >= policy.rateLimitRatio;

  if (pressured) {
    goodWindows = 0;
    if (throttled) {
      return { throttled: true, multiplier: policy.backoffFactor, changed: false, goodWindows, reason: "429 pressure persists" };
    }
    return { throttled: true, multiplier: policy.backoffFactor, changed: true, goodWindows, reason: "429 pressure detected" };
  }

  if (throttled) {
    goodWindows += 1;
    if (goodWindows >= policy.recoverySamples) {
      return {
        throttled: false,
        multiplier: 1,
        changed: true,
        goodWindows,
        reason: "429 pressure cleared",
      };
    }
    return {
      throttled: true,
      multiplier: policy.backoffFactor,
      changed: false,
      goodWindows,
      reason: "waiting for 429 pressure to clear",
    };
  }

  return { throttled: false, multiplier: 1, changed: false, goodWindows: 0, reason: "no 429 pressure" };
}

export interface StrategyEvaluationInput {
  signals: SignalSummary;
  degraded: boolean;
  policy: ResolvedAdaptivePolicy;
}

export interface StrategyEvaluation {
  strategy: CacheStrategy | undefined;
  reason: string;
}

/**
 * Recommend stale-while-revalidate for reads while an endpoint is degraded
 * past the SWR latency threshold. Gated on the same degraded flag as the
 * concurrency decision so strategy and ceiling move together (no flicker).
 */
export function evaluateStrategy(input: StrategyEvaluationInput): StrategyEvaluation {
  const { signals, degraded, policy } = input;
  if (degraded && signals.latencySamples >= 1 && signals.p95 >= policy.swrLatencyMs) {
    return {
      strategy: "stale-while-revalidate",
      reason: `p95 latency ${signals.p95}ms is at/over the ${policy.swrLatencyMs}ms SWR threshold`,
    };
  }
  return { strategy: undefined, reason: "endpoint is responsive — cache-first is fine" };
}

function fmt(ratio: number): string {
  return (Math.round(ratio * 1000) / 1000).toString();
}