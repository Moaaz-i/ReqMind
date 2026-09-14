export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type RequestState =
  | "idle"
  | "pending"
  | "retrying"
  | "success"
  | "error"
  | "cancelled";

export type CacheStrategy = "cache-first" | "stale-while-revalidate";

export interface CacheOptions {
  /** Enable response caching for read requests (default: false). */
  enabled?: boolean;
  /** Time-to-live in milliseconds. Default: 30_000. */
  ttl?: number;
  strategy?: CacheStrategy;
}

export interface RetryOptions {
  /** Maximum total attempts including the first (default: 3). */
  attempts?: number;
  /** Base delay in milliseconds (default: 1000). */
  baseDelay?: number;
  /** Upper bound for a single backoff delay in ms (default: 30_000). */
  maxDelay?: number;
  backoff?: "exponential" | "fixed";
  /** Add jitter to backoff delays to avoid thundering herds (default: true). */
  jitter?: boolean;
  /** Custom decision function. Overrides the built-in status table. */
  retryOn?: (status: number | undefined) => boolean;
  /** Respect the Retry-After header on 429/503 responses (default: true). */
  respectRetryAfter?: boolean;
}

export type ParamValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method: HttpMethod;
  url: string;
  baseURL?: string;
  headers?: Record<string, string>;
  params?: Record<string, ParamValue | ParamValue[]>;
  body?: unknown;
  /** External cancellation handle. */
  signal?: AbortSignal;
  timeout?: number;
  cache?: boolean | CacheOptions;
  retry?: boolean | RetryOptions;
  tags?: string[];
}

export interface ApiResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export interface ClientOptions {
  baseURL?: string;
  headers?: Record<string, string>;
  cache?: CacheOptions;
  retry?: RetryOptions;
  timeout?: number;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface CacheUpdate<T = unknown> {
  type: "write" | "revalidate" | "invalidate";
  key: string;
  response?: ApiResponse<T>;
}

export type InvalidateTarget = string | string[] | ((entry: CacheMeta) => boolean);

export interface CacheMeta {
  key: string;
  tags: string[];
  storedAt: number;
  expiresAt: number;
}

export type CacheSubscriber<T = unknown> = (update: CacheUpdate<T>) => void;

/**
 * Fully resolved request description, ready to be executed. Stored inside
 * cache entries so entries can be refetched after invalidation.
 */
export interface RequestSpec {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeout?: number;
  retry: RetryOptions;
}