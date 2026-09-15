import type { CacheStrategy, HttpMethod, IntelligenceOptions } from "../types.js";
import type { ClientEvents } from "../client/client.js";
import type { EventEmitter } from "../events/event-emitter.js";
import type { Tracker } from "../request/tracker.js";
import { HttpError, TimeoutError } from "../errors.js";
import { urlPath } from "../utils/url.js";

/** Per-endpoint observation snapshot. */
export interface EndpointStats {
  method: HttpMethod;
  /** Pathname (no query string) the endpoint is bucketed by. */
  path: string;
  /** Total callers of this endpoint (cache hits + deduped + network). */
  requests: number;
  /** Requests whose owned network flight succeeded. */
  successes: number;
  /** Requests that ended in a terminal failure. */
  failures: number;
  /** Requests served from cache. */
  cacheHits: number;
  /** Requests that reached the network: requests - cacheHits - dedupPrevented. */
  cacheMisses: number;
  /** Requests that joined an in-flight duplicate instead of hitting the network. */
  dedupPrevented: number;
  /** Total retry attempts observed on this endpoint. */
  retriesPerformed: number;
  /** Successful requests that required at least one retry. */
  retriesRecovered: number;
  /** 429 responses observed (per attempt). */
  rateLimited: number;
  /** Terminal TimeoutError outcomes. */
  timeouts: number;
  /** Terminal cancellation outcomes. */
  cancels: number;
  /** End-to-end latency (including retries) across a bounded sample window. */
  latency: {
    avg: number;
    p50: number;
    p95: number;
    samples: number;
  };
}

/** Rolled-up counters over all observed endpoints. */
export interface IntelligenceSummary {
  totalRequests: number;
  /** Network flights currently in flight (owned). */
  activeRequests: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  deduplicated: number;
  retriesPerformed: number;
  retriesRecovered: number;
  failures: number;
  rateLimited: number;
  timeouts: number;
  cancels: number;
}

/** Full intelligence readout: roll-up + per-endpoint table. */
export interface IntelligenceSnapshot {
  summary: IntelligenceSummary;
  endpoints: EndpointStats[];
}

/** Per-request suggestions produced by the engine from observed stats. */
export interface IntelligenceRecommendation {
  timeout?: number;
  strategy?: CacheStrategy;
}

/** Public read surface exposed as `client.intelligence()`. */
export interface IntelligenceController {
  snapshot(): IntelligenceSnapshot;
  endpoint(method: HttpMethod, path: string): EndpointStats | undefined;
  reset(): void;
}

/** Minimum latency samples before adaptive behavior kicks in. */
const MIN_SAMPLES = 5;
/** Slow-endpoint threshold used to auto-enable stale-while-revalidate (ms). */
const SWR_LATENCY_THRESHOLD_MS = 500;
/** Upper bound for a recommended adaptive timeout in ms. */
const MAX_ADAPTIVE_TIMEOUT_MS = 60_000;
/** Latency sample window per endpoint (ring buffer). */
const MAX_LATENCY_SAMPLES = 64;

interface EndpointState {
  stats: Omit<EndpointStats, "cacheMisses">;
  latencies: number[];
}

interface TrackerMeta {
  method: HttpMethod;
  path: string;
  start: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function emptyStats(method: HttpMethod, path: string): Omit<EndpointStats, "cacheMisses"> {
  return {
    method,
    path,
    requests: 0,
    successes: 0,
    failures: 0,
    cacheHits: 0,
    dedupPrevented: 0,
    retriesPerformed: 0,
    retriesRecovered: 0,
    rateLimited: 0,
    timeouts: 0,
    cancels: 0,
    latency: { avg: 0, p50: 0, p95: 0, samples: 0 },
  };
}

/**
 * The observation + decision core of ReqMind.
 *
 * Listens to the client's lifecycle events and aggregates per-endpoint
 * statistics (latency, cache, dedup, retries, failures, rate limits,
 * timeouts, cancels). Adaptive knobs turn those observations into
 * per-request recommendations: endpoint-specific timeouts and automatic
 * stale-while-revalidate for slow endpoints.
 */
export class Intelligence {
  private readonly enabled: boolean;
  private readonly adaptiveTimeout: boolean;
  private readonly adaptiveSwr: boolean;
  private readonly endpoints = new Map<string, EndpointState>();
  private readonly trackerMeta = new WeakMap<Tracker, TrackerMeta>();

  constructor(
    options: IntelligenceOptions | undefined,
    events: EventEmitter<ClientEvents>,
    private readonly getActiveRequests: () => number,
  ) {
    this.enabled = options?.enabled !== false;
    this.adaptiveTimeout = options?.adaptiveTimeout === true;
    this.adaptiveSwr = options?.adaptiveStaleWhileRevalidate === true;

    if (!this.enabled) return;

    events.on("request", ({ tracker, method, url }) => {
      this.trackerMeta.set(tracker, { method, path: urlPath(url), start: Date.now() });
      this.state(method, urlPath(url)).stats.requests += 1;
    });
    events.on("cache-hit", ({ tracker }) => {
      const meta = this.trackerMeta.get(tracker);
      if (meta) this.state(meta.method, meta.path).stats.cacheHits += 1;
    });
    events.on("dedup", ({ method, url }) => {
      this.state(method, urlPath(url)).stats.dedupPrevented += 1;
    });
    events.on("retry", ({ tracker, error }) => {
      const meta = this.trackerMeta.get(tracker);
      if (meta) {
        const stats = this.state(meta.method, meta.path).stats;
        stats.retriesPerformed += 1;
        if (error instanceof HttpError && error.status === 429) stats.rateLimited += 1;
      }
    });
    events.on("success", ({ tracker }) => {
      const meta = this.trackerMeta.get(tracker);
      if (!meta) return;
      const state = this.state(meta.method, meta.path);
      state.stats.successes += 1;
      if (tracker.attempts > 1) state.stats.retriesRecovered += 1;
      state.latencies.push(Date.now() - meta.start);
      if (state.latencies.length > MAX_LATENCY_SAMPLES) state.latencies.shift();
      this.refreshLatency(state);
      this.trackerMeta.delete(tracker);
    });
    events.on("error", ({ tracker, error }) => {
      const meta = this.trackerMeta.get(tracker);
      if (!meta) return;
      const stats = this.state(meta.method, meta.path).stats;
      stats.failures += 1;
      if (error instanceof TimeoutError) stats.timeouts += 1;
      else if (error instanceof HttpError && error.status === 429) stats.rateLimited += 1;
      this.trackerMeta.delete(tracker);
    });
    events.on("cancel", ({ tracker }) => {
      const meta = this.trackerMeta.get(tracker);
      if (!meta) return;
      this.state(meta.method, meta.path).stats.cancels += 1;
      this.trackerMeta.delete(tracker);
    });
  }

  /**
   * Propose adaptive behavior for an upcoming request, based on what the
   * engine has observed about that endpoint.
   */
  recommend(method: HttpMethod, path: string): IntelligenceRecommendation {
    if (!this.enabled) return {};
    const state = this.endpoints.get(method + " " + path);
    if (!state || state.latencies.length < MIN_SAMPLES) return {};

    const sorted = [...state.latencies].sort((a, b) => a - b);
    const p95 = percentile(sorted, 0.95);
    const recommendation: IntelligenceRecommendation = {};

    if (this.adaptiveTimeout) {
      recommendation.timeout = Math.min(
        MAX_ADAPTIVE_TIMEOUT_MS,
        Math.max(Math.round(p95 * 3), 100),
      );
    }
    if (this.adaptiveSwr && p95 >= SWR_LATENCY_THRESHOLD_MS) {
      recommendation.strategy = "stale-while-revalidate";
    }
    return recommendation;
  }

  snapshot(): IntelligenceSnapshot {
    if (!this.enabled) {
      return {
        summary: emptySummary(this.getActiveRequests()),
        endpoints: [],
      };
    }
    const endpoints = [...this.endpoints.values()]
      .map((state) => this.toPublic(state))
      .sort((a, b) => a.requests - b.requests);
    return { summary: this.summary(), endpoints };
  }

  endpoint(method: HttpMethod, path: string): EndpointStats | undefined {
    if (!this.enabled) return undefined;
    const state = this.endpoints.get(method + " " + path);
    return state ? this.toPublic(state) : undefined;
  }

  reset(): void {
    this.endpoints.clear();
  }

  private summary(): IntelligenceSummary {
    const totalRequests = sum(this.endpoints, (s) => s.stats.requests);
    const cacheHits = sum(this.endpoints, (s) => s.stats.cacheHits);
    const deduplicated = sum(this.endpoints, (s) => s.stats.dedupPrevented);
    const cacheMisses = Math.max(0, totalRequests - cacheHits - deduplicated);
    return {
      totalRequests,
      activeRequests: this.getActiveRequests(),
      cacheHits,
      cacheMisses,
      cacheHitRate: totalRequests > 0 ? cacheHits / totalRequests : 0,
      deduplicated,
      retriesPerformed: sum(this.endpoints, (s) => s.stats.retriesPerformed),
      retriesRecovered: sum(this.endpoints, (s) => s.stats.retriesRecovered),
      failures: sum(this.endpoints, (s) => s.stats.failures),
      rateLimited: sum(this.endpoints, (s) => s.stats.rateLimited),
      timeouts: sum(this.endpoints, (s) => s.stats.timeouts),
      cancels: sum(this.endpoints, (s) => s.stats.cancels),
    };
  }

  private state(method: HttpMethod, path: string): EndpointState {
    const key = method + " " + path;
    let state = this.endpoints.get(key);
    if (!state) {
      state = { stats: emptyStats(method, path), latencies: [] };
      this.endpoints.set(key, state);
    }
    return state;
  }

  private refreshLatency(state: EndpointState): void {
    const { latencies } = state;
    const n = latencies.length;
    const avg = n > 0 ? latencies.reduce((a, b) => a + b, 0) / n : 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    state.stats.latency = {
      avg: Math.round(avg),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      samples: n,
    };
  }

  private toPublic(state: EndpointState): EndpointStats {
    return {
      ...state.stats,
      cacheMisses: Math.max(0, state.stats.requests - state.stats.cacheHits - state.stats.dedupPrevented),
      latency: { ...state.stats.latency },
    };
  }
}

function sum(endpoints: Map<string, EndpointState>, pick: (s: EndpointState) => number): number {
  let total = 0;
  for (const state of endpoints.values()) total += pick(state);
  return total;
}

function emptySummary(activeRequests: number): IntelligenceSummary {
  return {
    totalRequests: 0,
    activeRequests,
    cacheHits: 0,
    cacheMisses: 0,
    cacheHitRate: 0,
    deduplicated: 0,
    retriesPerformed: 0,
    retriesRecovered: 0,
    failures: 0,
    rateLimited: 0,
    timeouts: 0,
    cancels: 0,
  };
}