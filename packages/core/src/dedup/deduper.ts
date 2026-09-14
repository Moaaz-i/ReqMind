import type { ApiResponse } from "../types.js";

interface InFlightEntry {
  key: string;
  promise: Promise<ApiResponse>;
  /** Number of concurrent consumers sharing this in-flight request. */
  consumers: number;
}

/**
 * Coalesces identical in-flight requests so N consumers fire one network
 * call. Tracks how many consumers are attached to each flight.
 */
export class Deduper {
  private inflight = new Map<string, InFlightEntry>();

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  get(key: string): InFlightEntry | undefined {
    return this.inflight.get(key);
  }

  attach(key: string, promise: Promise<ApiResponse>): InFlightEntry {
    const existing = this.inflight.get(key);
    if (existing) {
      existing.consumers += 1;
      return existing;
    }
    const entry: InFlightEntry = { key, promise, consumers: 1 };
    this.inflight.set(key, entry);
    promise
      .finally(() => {
        // The flight is over; later callers must start a fresh request.
        this.inflight.delete(key);
      })
      .catch(() => undefined);
    return entry;
  }

  /** Detach a single consumer. Returns true when the flight still has consumers. */
  detach(key: string): boolean {
    const entry = this.inflight.get(key);
    if (!entry) return false;
    entry.consumers -= 1;
    if (entry.consumers <= 0) {
      this.inflight.delete(key);
      return false;
    }
    return true;
  }

  consumersOf(key: string): number {
    return this.inflight.get(key)?.consumers ?? 0;
  }

  clear(): void {
    this.inflight.clear();
  }
}