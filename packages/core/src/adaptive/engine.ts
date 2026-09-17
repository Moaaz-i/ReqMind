import type { AdaptiveMetrics, AdaptiveOptions, CacheStrategy, HttpMethod } from "../types.js";
import type { ClientEvents } from "../client/client.js";
import type { EventEmitter } from "../events/event-emitter.js";
import { urlPath } from "../utils/url.js";
import { EndpointSignals } from "./signals.js";
import {
  evaluateConcurrency,
  evaluateStrategy,
  evaluateThrottle,
  resolveAdaptivePolicy,
} from "./policies.js";
import type { ResolvedAdaptivePolicy } from "./policies.js";
import type { AdaptiveHealth, EndpointAdaptiveState } from "./decisions.js";

interface Profile {
  endpoint: string;
  configured: number;
  signals: EndpointSignals;
  effective: number;
  mode: "nominal" | "reducing" | "recovering";
  health: AdaptiveHealth;
  reason: string;
  consecutiveBad: number;
  consecutiveGood: number;
  cooldown: number;
  degraded: boolean;
  recovering: boolean;
  degradedSince?: number;
  throttled: boolean;
  throttleGood: number;
  retryMultiplier: number;
  retryMode: "nominal" | "throttled";
  retryReason: string;
  strategy?: CacheStrategy;
  strategyReason: string;
  active: number;
  counters: AdaptiveMetrics;
}

interface Attempt {
  endpoint: string;
  startedAt: number;
}

/**
 * v0.8 Adaptive Engine.
 *
 * Watches lifecycle events and turns observed per-endpoint signals into
 * deterministic, explainable decisions:
 *   - a per-endpoint concurrency ceiling (queryable by the scheduler),
 *   - a retry backoff multiplier (applied by the client before a retry),
 *   - an optional stale-while-revalidate strategy for reads,
 *   - 429 throttling.
 *
 * The engine never calls the scheduler; it only answers questions
 * (`endpointCeiling`, `retryMultiplier`, `cacheStrategy`). Same input events
 * with the same clock ⇒ the same decisions.
 */
export class AdaptiveEngine {
  private readonly enabled: boolean;
  private readonly concurrencyEnabled: boolean;
  private readonly retryEnabled: boolean;
  private readonly rateLimitEnabled: boolean;
  private readonly swrEnabled: boolean;
  private readonly policy: ResolvedAdaptivePolicy;
  private readonly configuredConcurrency: number;
  private readonly attemptEvents: boolean;
  private readonly profiles = new Map<string, Profile>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly getNow: () => number;

  constructor(
    options: AdaptiveOptions | undefined,
    attemptEvents: boolean,
    configuredConcurrency: number,
    events: EventEmitter<ClientEvents>,
    getNow: () => number = Date.now,
  ) {
    this.enabled = options?.enabled === true;
    this.concurrencyEnabled = this.enabled && options?.concurrency === true;
    this.retryEnabled = this.enabled && options?.retry === true;
    this.rateLimitEnabled = this.enabled && options?.rateLimit === true;
    this.swrEnabled = this.enabled && options?.staleWhileRevalidate === true;
    this.policy = resolveAdaptivePolicy(this.enabled ? options : undefined);
    this.configuredConcurrency = Math.max(1, configuredConcurrency);
    this.attemptEvents = attemptEvents;
    this.getNow = getNow;

    if (!this.enabled) return;
    this.attach(events);
  }

  /** Per-endpoint concurrency ceiling (undefined ⇒ the scheduler keeps its own). */
  endpointCeiling(endpoint: string): number | undefined {
    if (!this.concurrencyEnabled) return undefined;
    return this.profiles.get(endpoint)?.effective;
  }

  /** Retry backoff multiplier for an endpoint (1 when not throttled). */
  retryMultiplier(endpoint: string): number {
    if (!this.retryEnabled) return 1;
    return this.profiles.get(endpoint)?.retryMultiplier ?? 1;
  }

  /** Recommended cache strategy for a read (undefined when not engaged). */
  cacheStrategy(method: HttpMethod, path: string): CacheStrategy | undefined {
    if (!this.swrEnabled) return undefined;
    return this.profiles.get(method + " " + path)?.strategy;
  }

  snapshot(): { enabled: boolean; endpoints: Record<string, EndpointAdaptiveState> } {
    const endpoints: Record<string, EndpointAdaptiveState> = {};
    for (const profile of this.profiles.values()) {
      endpoints[profile.endpoint] = this.toPublic(profile);
    }
    return { enabled: this.enabled, endpoints };
  }

  endpoint(endpoint: string): EndpointAdaptiveState | undefined {
    const profile = this.profiles.get(endpoint);
    return profile ? this.toPublic(profile) : undefined;
  }

  metrics(): AdaptiveMetrics {
    const total: AdaptiveMetrics = {
      decisions: 0,
      concurrencyReductions: 0,
      concurrencyRecoveries: 0,
      throttles: 0,
      retryChanges: 0,
    };
    for (const profile of this.profiles.values()) {
      total.decisions += profile.counters.decisions;
      total.concurrencyReductions += profile.counters.concurrencyReductions;
      total.concurrencyRecoveries += profile.counters.concurrencyRecoveries;
      total.throttles += profile.counters.throttles;
      total.retryChanges += profile.counters.retryChanges;
    }
    return total;
  }

  reset(): void {
    this.profiles.clear();
    this.attempts.clear();
  }

  private attach(events: EventEmitter<ClientEvents>): void {
    if (this.attemptEvents) {
      // Attempt timeline: request-started opens an attempt, request-delayed
      // closes it (failed attempt parked for backoff), success/error close it.
      events.on("request-started", ({ key, method, url }) => {
        this.markAttempt(key, method, url, this.getNow());
      });
      events.on("request-delayed", ({ key }) => {
        this.settleAttempt(key, "error", this.getNow());
      });
    } else {
      // Transparent mode (scheduler disabled): end-to-end from `request`.
      events.on("request", ({ key, method, url }) => {
        this.markAttempt(key, method, url, this.getNow());
      });
    }
    events.on("retry", ({ key, error }) => {
      const status = (error as { status?: number } | undefined)?.status;
      if (status !== 429) return;
      const attempt = this.attempts.get(key);
      if (!attempt) return;
      const profile = this.profile(attempt.endpoint);
      profile.signals.recordOutcome("rateLimited");
      this.flush(profile);
    });
    events.on("success", ({ key }) => {
      this.settleAttempt(key, "success", this.getNow());
    });
    events.on("error", ({ key }) => {
      this.settleAttempt(key, "error", this.getNow());
    });
    events.on("cancel", ({ key }) => {
      this.dropAttempt(key);
    });
    events.on("cache-hit", ({ key }) => {
      // Cache/dedup consumers are not network attempts — ignore them even in
      // transparent mode where `request` would otherwise mark an attempt.
      this.dropAttempt(key);
    });
  }

  private dropAttempt(key: string): void {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    this.attempts.delete(key);
    const profile = this.profile(attempt.endpoint);
    profile.active = Math.max(0, profile.active - 1);
  }

  private markAttempt(key: string, method: HttpMethod, url: string, now: number): void {
    if (this.attempts.has(key)) return;
    const endpoint = method + " " + urlPath(url);
    this.attempts.set(key, { endpoint, startedAt: now });
    const profile = this.profile(endpoint);
    profile.active += 1;
  }

  private settleAttempt(key: string, kind: "success" | "error", now: number): void {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    this.attempts.delete(key);
    const profile = this.profile(attempt.endpoint);
    profile.active = Math.max(0, profile.active - 1);
    const duration = Math.max(0, now - attempt.startedAt);
    profile.signals.recordLatency(duration);
    profile.signals.recordOutcome(kind);
    this.flush(profile);
  }

  private flush(profile: Profile): void {
    const summary = profile.signals.summarize();

    const concurrency = evaluateConcurrency({
      signals: summary,
      state: {
        effective: profile.effective,
        configured: profile.configured,
        consecutiveBad: profile.consecutiveBad,
        consecutiveGood: profile.consecutiveGood,
        cooldown: profile.cooldown,
        degraded: profile.degraded,
        recovering: profile.recovering,
      },
      policy: this.policy,
    });

    if (concurrency.action === "reduce") {
      this.bump(profile, "concurrencyReductions");
      profile.degradedSince ??= this.getNow();
    }
    if (concurrency.action === "recover") {
      this.bump(profile, "concurrencyRecoveries");
    }
    profile.effective = concurrency.effective;
    profile.consecutiveBad = concurrency.consecutiveBad;
    profile.consecutiveGood = concurrency.consecutiveGood;
    profile.cooldown = concurrency.cooldown;
    profile.degraded = concurrency.degraded;
    profile.recovering = concurrency.recovering;
    profile.mode = concurrency.mode;
    profile.reason = concurrency.reason;
    if (!profile.degraded) profile.degradedSince = undefined;

    if (this.rateLimitEnabled) {
      const throttle = evaluateThrottle({
        signals: summary,
        state: { throttled: profile.throttled, goodWindows: profile.throttleGood },
        policy: this.policy,
      });
      if (throttle.changed) {
        this.bump(profile, "retryChanges");
        if (throttle.throttled && !profile.throttled) {
          this.bump(profile, "throttles");
        }
      }
      profile.throttled = throttle.throttled;
      profile.throttleGood = throttle.goodWindows;
      profile.retryMultiplier = throttle.multiplier;
      profile.retryReason = throttle.reason;
      profile.retryMode = throttle.throttled ? "throttled" : "nominal";
    } else {
      profile.throttled = false;
      profile.retryMultiplier = 1;
      profile.retryMode = "nominal";
      profile.retryReason = "adaptive retry disabled";
    }

    if (this.swrEnabled) {
      const strategy = evaluateStrategy({ signals: summary, degraded: profile.degraded, policy: this.policy });
      profile.strategy = strategy.strategy;
      profile.strategyReason = strategy.reason;
    } else {
      profile.strategy = undefined;
      profile.strategyReason = "adaptive stale-while-revalidate disabled";
    }

    this.refreshHealth(profile);
  }

  private refreshHealth(profile: Profile): void {
    const fullyHealthy = !profile.degraded && !profile.recovering && !profile.throttled;
    if (fullyHealthy) {
      profile.health = "good";
      profile.mode = "nominal";
      if (profile.effective >= profile.configured) {
        profile.reason = "endpoint is healthy — no adjustment needed";
      }
      return;
    }
    if (profile.throttled) {
      profile.health = "throttled";
    } else if (profile.degraded && profile.recovering) {
      profile.health = "recovering";
    } else if (profile.degraded) {
      profile.health = "degraded";
    } else {
      profile.health = "good";
    }
  }

  private bump(profile: Profile, key: keyof AdaptiveMetrics): void {
    profile.counters[key] = (profile.counters[key] as number) + 1;
    profile.counters.decisions += 1;
  }

  private profile(endpoint: string): Profile {
    let profile = this.profiles.get(endpoint);
    if (!profile) {
      profile = {
        endpoint,
        configured: this.configuredConcurrency,
        signals: new EndpointSignals(this.policy.latencyWindow, this.policy.outcomeWindow),
        effective: this.configuredConcurrency,
        mode: "nominal",
        health: "good",
        reason: "endpoint is healthy — no adjustment needed",
        consecutiveBad: 0,
        consecutiveGood: 0,
        cooldown: 0,
        degraded: false,
        recovering: false,
        throttled: false,
        throttleGood: 0,
        retryMultiplier: 1,
        retryMode: "nominal",
        retryReason: "",
        strategyReason: "",
        active: 0,
        counters: {
          decisions: 0,
          concurrencyReductions: 0,
          concurrencyRecoveries: 0,
          throttles: 0,
          retryChanges: 0,
        },
      };
      this.profiles.set(endpoint, profile);
    }
    return profile;
  }

  private toPublic(profile: Profile): EndpointAdaptiveState {
    const summary = profile.signals.summarize();
    return {
      endpoint: profile.endpoint,
      configured: profile.configured,
      effective: profile.effective,
      mode: profile.mode,
      health: profile.health,
      reason: profile.reason,
      retryMultiplier: profile.retryMultiplier,
      retryMode: profile.retryMode,
      retryReason: profile.retryReason,
      strategy: profile.strategy,
      strategyReason: profile.strategyReason,
      signals: {
        avg: summary.avg,
        p50: summary.p50,
        p95: summary.p95,
        samples: summary.latencySamples,
        errorRatio: summary.errorRatio,
        rateLimitRatio: summary.rateLimitRatio,
        active: profile.active,
      },
      degradedSince: profile.degradedSince,
      counters: { ...profile.counters },
    };
  }
}