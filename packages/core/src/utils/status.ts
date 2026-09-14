/**
 * Statuses where a retry is usually worthwhile.
 */
const DEFAULT_RETRIABLE = new Set([408, 429, 500, 502, 503, 504]);

export function isRetriableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return DEFAULT_RETRIABLE.has(status);
}

export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Parse a Retry-After header value (seconds or HTTP-date) into
 * milliseconds. Returns -1 when absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return -1;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;

  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return -1;
}