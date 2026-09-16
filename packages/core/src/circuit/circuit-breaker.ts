import type { ClientEvents } from "../client/client.js";
import type { EventEmitter } from "../events/event-emitter.js";
import { CancelledError, HttpError, TimeoutError } from "../errors.js";
import type { CircuitBreakerOptions, HttpMethod } from "../types.js";

/** Lifecycle state of an endpoint's circuit. */
export type CircuitState = "closed" | "open" | "halfOpen";

/** Observable snapshot of one endpoint's circuit. */
export interface CircuitStatus {
  /** Endpoint key: `METHOD pathname`. */
  endpoint: string;
  state: CircuitState;
  /** Consecutive counted failures since the last success (drives closed→open). */
  consecutiveFailures: number;
  /** When the circuit last opened (resetTimeout is measured from here). */
  openedAt?: number;
  /** A half-open probe is currently in flight. */
  probing: boolean;
}

/** Public read/write surface exposed as `client.circuitBreaker()`. */
export interface CircuitBreakerController {
  /** Read (and lazily create) the circuit for a method + pathname. */
  status(method: HttpMethod, path: string): CircuitStatus;
  /** All circuits that have ever had a network attempt or rejection. */
  statuses(): CircuitStatus[];
  /** Force a circuit (or all of them) back to closed. */
  reset(method?: HttpMethod, path?: string): void;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_RESET_MS = 10_000;

const CLOSED: CircuitState = "closed";
const OPEN: CircuitState = "open";
const HALF_OPEN: CircuitState = "halfOpen";

interface CircuitEntry {
  status: CircuitStatus;
}

/**
 * Per-endpoint circuit breaker.
 *
 * Network outcomes are reported by the client and the breaker decides, per
 * request, whether that endpoint may touch the network:
 *   closed   → allowed; a success resets the counter, counted failures trip open
 *   open     → rejected until resetTimeout elapses
 *   halfOpen → a single probe is admitted; success closes it, failure reopens
 */
export class CircuitBreaker {
  private readonly enabled: boolean;
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;
  private readonly circuits = new Map<string, CircuitEntry>();

  constructor(
    options: CircuitBreakerOptions | undefined,
    private readonly events: EventEmitter<ClientEvents>,
    private readonly getNow: () => number = Date.now,
  ) {
    this.enabled = options?.enabled !== false;
    this.threshold = options?.failureThreshold ?? DEFAULT_THRESHOLD;
    this.resetTimeoutMs = options?.resetTimeout ?? DEFAULT_RESET_MS;
  }

  /**
   * Decide whether a network call for this endpoint may proceed.
   * `probe: true` marks the caller as the half-open probe whose outcome moves
   * the circuit one way or the other.
   */
  beforeRequest(endpoint: string): { allowed: boolean; probe: boolean } {
    if (!this.enabled) return { allowed: true, probe: false };
    const status = this.status(endpoint);

    if (status.state === CLOSED) return { allowed: true, probe: false };

    if (status.state === OPEN) {
      const elapsed = this.getNow() - (status.openedAt ?? this.getNow());
      if (elapsed < this.resetTimeoutMs) return { allowed: false, probe: false };
      // Open past its reset window: admit exactly one probe.
      status.state = HALF_OPEN;
      status.probing = true;
      this.transition(endpoint, HALF_OPEN);
      return { allowed: true, probe: true };
    }

    // halfOpen: only one probe may be in flight at a time.
    if (status.probing) return { allowed: false, probe: false };
    status.probing = true;
    return { allowed: true, probe: true };
  }

  /**
   * Side-effect-free check: may a request that was queued hit the network for
   * this endpoint right now? No transition, no probe claim — just a peek.
   */
  permits(endpoint: string): boolean {
    if (!this.enabled) return true;
    return this.status(endpoint).state === CLOSED;
  }

  /** A network flight for this endpoint resolved successfully. */
  recordSuccess(endpoint: string): void {
    if (!this.enabled) return;
    const status = this.status(endpoint);
    if (status.state === HALF_OPEN) {
      status.probing = false;
      status.consecutiveFailures = 0;
      status.openedAt = undefined;
      status.state = CLOSED;
      this.transition(endpoint, CLOSED);
    } else if (status.state === CLOSED) {
      status.consecutiveFailures = 0;
    }
    // An open circuit ignores stray late successes.
  }

  /** A network flight for this endpoint reached a terminal error or cancellation. */
  recordFailure(endpoint: string, error: unknown): void {
    if (!this.enabled) return;
    const status = this.status(endpoint);

    if (status.state === HALF_OPEN) {
      status.probing = false;
      if (isCountableFailure(error)) this.open(endpoint, status);
      return;
    }

    if (status.state === CLOSED && isCountableFailure(error)) {
      status.consecutiveFailures += 1;
      if (status.consecutiveFailures >= this.threshold) this.open(endpoint, status);
    }
  }

  status(endpoint: string): CircuitStatus {
    let entry = this.circuits.get(endpoint);
    if (!entry) {
      entry = { status: emptyStatus(endpoint) };
      this.circuits.set(endpoint, entry);
    }
    return entry.status;
  }

  statuses(): CircuitStatus[] {
    return [...this.circuits.values()].map((entry) => ({ ...entry.status }));
  }

  reset(endpoint?: string): void {
    if (endpoint === undefined) {
      this.circuits.clear();
      return;
    }
    const entry = this.circuits.get(endpoint);
    if (entry) this.circuits.set(endpoint, { status: emptyStatus(endpoint) });
  }

  private open(endpoint: string, status: CircuitStatus): void {
    status.state = OPEN;
    status.openedAt = this.getNow();
    this.transition(endpoint, OPEN);
  }

  private transition(endpoint: string, state: CircuitState): void {
    const space = endpoint.indexOf(" ");
    const method = (space === -1 ? "GET" : endpoint.slice(0, space)) as HttpMethod;
    const path = space === -1 ? endpoint : endpoint.slice(space + 1);
    const payload = { endpoint, method, path };
    if (state === OPEN) this.events.emit("circuit-open", payload);
    else if (state === HALF_OPEN) this.events.emit("circuit-half-open", payload);
    else this.events.emit("circuit-closed", payload);
  }
}

function emptyStatus(endpoint: string): CircuitStatus {
  return { endpoint, state: CLOSED, consecutiveFailures: 0, probing: false };
}

/**
 * Which terminal outcomes trip a circuit:
 *   5xx, 429, timeouts and network errors count; 4xx and cancellation do not.
 */
function isCountableFailure(error: unknown): boolean {
  if (error instanceof CancelledError) return false;
  if (error instanceof TimeoutError) return true;
  if (error instanceof HttpError) {
    const status = error.status;
    if (status === undefined) return true; // network error — server unreachable
    if (status === 429) return true;
    return status >= 500 && status < 600;
  }
  return true;
}