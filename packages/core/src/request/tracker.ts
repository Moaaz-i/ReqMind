import type { RequestState } from "../types.js";

export type StateListener = (state: RequestState) => void;

/**
 * Tracks the lifecycle of a single request:
 *
 *   IDLE → PENDING → SUCCESS
 *        → PENDING → RETRYING → SUCCESS
 *        → PENDING → ERROR
 *        → ... → CANCELLED
 */
export class Tracker {
  readonly key: string;
  readonly deduped: boolean;

  private _state: RequestState = "idle";
  private _attempts = 0;
  private controller = new AbortController();
  private timedOut = false;
  private stateListeners = new Set<StateListener>();

  constructor(key: string, deduped = false) {
    this.key = key;
    this.deduped = deduped;
  }

  get state(): RequestState {
    return this._state;
  }

  /** Number of network attempts performed so far. */
  get attempts(): number {
    return this._attempts;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get timeoutTriggered(): boolean {
    return this.timedOut;
  }

  setState(state: RequestState): void {
    if (state === this._state) return;
    this._state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  onChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  markAttempt(): void {
    this._attempts += 1;
  }

  cancel(): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort();
    }
    this.setState("cancelled");
  }

  /** Abort because the timeout fired. */
  timeout(): void {
    this.timedOut = true;
    this.controller.abort();
  }
}