export interface BackoffInput {
  /** Zero-based attempt index of the retry being scheduled. */
  attempts: number;
  baseDelay?: number;
  maxDelay?: number;
  backoff?: "exponential" | "fixed";
  jitter?: boolean;
}

/**
 * True exponential backoff produces 1s, 2s, 4s, 8s...
 * Jitter spreads retries across many clients so they don't all
 * hammer the server at the same instant.
 */
export function computeDelay({
  attempts,
  baseDelay = 1000,
  maxDelay = 30_000,
  backoff = "exponential",
  jitter = true,
}: BackoffInput): number {
  const raw = backoff === "exponential" ? baseDelay * 2 ** attempts : baseDelay * (attempts + 1);
  const capped = Math.min(raw, maxDelay);
  if (!jitter) return capped;

  const floor = Math.min(baseDelay, capped);
  return floor + Math.random() * Math.max(1, capped - floor);
}