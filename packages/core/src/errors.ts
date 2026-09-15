import { isRetriableStatus } from "./utils/status.js";

export class HttpError extends Error {
  readonly status?: number;
  readonly statusText: string;
  readonly headers?: Headers;

  constructor(status: number | undefined, statusText: string, message?: string, headers?: Headers) {
    super(message ?? `${statusText} (${status ?? "network"})`);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
  }

  get isRetriable(): boolean {
    return isRetriableStatus(this.status);
  }
}

export class TimeoutError extends Error {
  constructor(timeout: number) {
    super(`Request timed out after ${timeout}ms`);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends Error {
  constructor(message = "Request was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Thrown when a request is rejected without being sent because its circuit is open. */
export class CircuitOpenError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, message?: string) {
    super(message ?? `Circuit is open for endpoint ${endpoint}; request was not attempted`);
    this.name = "CircuitOpenError";
    this.endpoint = endpoint;
  }
}

/**
 * True when an error came from aborting the request (user cancellation,
 * timeout, or fetch's own AbortError).
 */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof CancelledError ||
    error instanceof TimeoutError ||
    (error instanceof Error && error.name === "AbortError")
  );
}