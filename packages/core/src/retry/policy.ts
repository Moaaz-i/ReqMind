import type { RetryOptions } from "../types.js";
import { HttpError } from "../errors.js";
import { computeDelay } from "../utils/backoff.js";
import { isRetriableStatus, parseRetryAfter } from "../utils/status.js";

export interface ResolvedRetryOptions {
  attempts: number;
  baseDelay: number;
  maxDelay: number;
  backoff: "exponential" | "fixed";
  jitter: boolean;
  retryOn?: (status: number | undefined) => boolean;
  respectRetryAfter: boolean;
}

export function resolveRetryOptions(options?: RetryOptions): ResolvedRetryOptions {
  return {
    attempts: options?.attempts ?? 3,
    baseDelay: options?.baseDelay ?? 1000,
    maxDelay: options?.maxDelay ?? 30_000,
    backoff: options?.backoff ?? "exponential",
    jitter: options?.jitter ?? true,
    retryOn: options?.retryOn,
    respectRetryAfter: options?.respectRetryAfter ?? true,
  };
}

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
}

/**
 * Decide whether a failed attempt should be retried and after how long.
 *
 * Status table:
 *   500, 502, 503, 504, 408, 429 → retry
 *   400, 401, 403, 404, 409, 422 → don't retry
 *
 * 429/503 respect a Retry-After header when present. The default delay
 * uses exponential backoff with jitter.
 */
export function decideRetry(input: {
  error: HttpError;
  options: ResolvedRetryOptions;
  /** Attempts already performed (including the one that just failed). */
  attempts: number;
}): RetryDecision {
  const { error, options, attempts } = input;

  if (attempts >= options.attempts) {
    return { shouldRetry: false, delayMs: 0 };
  }

  const shouldRetry = options.retryOn
    ? options.retryOn(error.status)
    : isRetriableStatus(error.status);

  if (!shouldRetry) {
    return { shouldRetry: false, delayMs: 0 };
  }

  let delayMs = computeDelay({
    attempts: Math.max(0, attempts - 1),
    baseDelay: options.baseDelay,
    maxDelay: options.maxDelay,
    backoff: options.backoff,
    jitter: options.jitter,
  });

  if (options.respectRetryAfter && error.headers) {
    const retryAfter = parseRetryAfter(error.headers.get("retry-after"));
    if (retryAfter >= 0) {
      delayMs = retryAfter;
    }
  }

  return { shouldRetry: true, delayMs };
}