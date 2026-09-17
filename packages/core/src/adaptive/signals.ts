/** Kind of outcome recorded into an endpoint's bounded outcome window. */
export type OutcomeKind = "success" | "error" | "rateLimited" | "retry";

/** Summarized signals over the endpoint's bounded windows. */
export interface SignalSummary {
  latencySamples: number;
  avg: number;
  p50: number;
  p95: number;
  /** Counts inside the outcome window (last `outcomeWindow` outcomes). */
  successes: number;
  errors: number;
  rateLimited: number;
  retries: number;
  total: number;
  errorRatio: number;
  rateLimitRatio: number;
}

/**
 * Bounded windows of observed signals for a single endpoint.
 *
 * Both windows are fixed-size rings so memory stays bounded no matter how
 * many requests flow through. All reads are pure (no mutation), which keeps
 * the whole engine deterministic for a given event sequence.
 */
export class EndpointSignals {
  private readonly latencies: number[] = [];
  private readonly outcomes: OutcomeKind[] = [];

  constructor(
    private readonly latencyWindow: number,
    private readonly outcomeWindow: number,
  ) {}

  recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.latencyWindow) this.latencies.shift();
  }

  recordOutcome(kind: OutcomeKind): void {
    this.outcomes.push(kind);
    if (this.outcomes.length > this.outcomeWindow) this.outcomes.shift();
  }

  windowSize(): number {
    return this.outcomes.length;
  }

  clear(): void {
    this.latencies.length = 0;
    this.outcomes.length = 0;
  }

  summarize(): SignalSummary {
    const n = this.outcomes.length;
    let successes = 0;
    let errors = 0;
    let rateLimited = 0;
    let retries = 0;
    for (const kind of this.outcomes) {
      if (kind === "success") successes += 1;
      else if (kind === "error") errors += 1;
      else if (kind === "rateLimited") rateLimited += 1;
      else retries += 1;
    }
    const m = this.latencies.length;
    let avg = 0;
    let p50 = 0;
    let p95 = 0;
    if (m > 0) {
      const sorted = [...this.latencies].sort((a, b) => a - b);
      avg = Math.round(this.latencies.reduce((a, b) => a + b, 0) / m);
      p50 = percentile(sorted, 0.5);
      p95 = percentile(sorted, 0.95);
    }
    return {
      latencySamples: m,
      avg,
      p50,
      p95,
      successes,
      errors,
      rateLimited,
      retries,
      total: n,
      errorRatio: n > 0 ? errors / n : 0,
      rateLimitRatio: n > 0 ? rateLimited / n : 0,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx] ?? 0;
}