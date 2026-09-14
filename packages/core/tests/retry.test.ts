import { describe, expect, it } from "vitest";
import { decideRetry, resolveRetryOptions } from "../src/retry/policy.js";
import { HttpError } from "../src/errors.js";

function errorWith(status: number | undefined, headers?: Record<string, string>): HttpError {
  return new HttpError(status, "n/a", undefined, new Headers(headers));
}

function decide(status: number | undefined, opts: Record<string, unknown> = {}, attempts = 1) {
  return decideRetry({
    error: errorWith(status),
    options: resolveRetryOptions(opts as never),
    attempts,
  });
}

describe("retry policy", () => {
  it("retries server errors and rate limits", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(decide(status).shouldRetry).toBe(true);
    }
  });

  it("does not retry client errors", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 418]) {
      expect(decide(status).shouldRetry).toBe(false);
    }
  });

  it("stops after max attempts", () => {
    expect(decide(500, { attempts: 2 }, 2).shouldRetry).toBe(false);
    expect(decide(500, { attempts: 3 }, 3).shouldRetry).toBe(false);
  });

  it("honors a custom retryOn predicate", () => {
    const options = { retryOn: (s: number | undefined) => s === 200 };
    expect(decide(200, options).shouldRetry).toBe(true);
    expect(decide(500, options).shouldRetry).toBe(false);
  });

  it("respects Retry-After on 429 responses", () => {
    const decision = decideRetry({
      error: errorWith(429, { "retry-after": "2" }),
      options: resolveRetryOptions({ baseDelay: 60_000, jitter: false, attempts: 3 }),
      attempts: 1,
    });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBe(2000);
  });
});