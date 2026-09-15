import type {
  ApiResponse,
  CacheOptions,
  CacheStrategy,
  CacheSubscriber,
  ClientOptions,
  HttpMethod,
  InvalidateTarget,
  RequestOptions,
  RequestSpec,
  RetryOptions,
} from "../types.js";
import { CacheStore } from "../cache/cache-store.js";
import { Deduper } from "../dedup/deduper.js";
import { EventEmitter } from "../events/event-emitter.js";
import { Intelligence } from "../intelligence/intelligence.js";
import type { IntelligenceController } from "../intelligence/intelligence.js";
import { CancelledError, HttpError, TimeoutError } from "../errors.js";
import { Tracker } from "../request/tracker.js";
import { parseResponse } from "../request/response.js";
import { resolveRetryOptions, decideRetry } from "../retry/policy.js";
import { createFingerprint } from "../utils/fingerprint.js";
import { buildQuery, resolveURL, urlPath } from "../utils/url.js";
import { delay } from "../utils/timing.js";
import { isSuccessStatus } from "../utils/status.js";

const READ_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);
const CACHEABLE_METHODS = new Set<HttpMethod>(["GET"]);

export interface ClientEvents {
  /** A network flight is about to start (owner of the request). */
  request: { key: string; method: HttpMethod; url: string; tracker: Tracker };
  /** A request resolved with a 2xx response. */
  success: { key: string; tracker: Tracker; response: ApiResponse };
  /** A request failed after retries were exhausted. */
  error: { key: string; tracker: Tracker; error: unknown };
  /** An attempt failed and a retry has been scheduled. */
  retry: { key: string; tracker: Tracker; attempts: number; delay: number; error: HttpError };
  /** A request was cancelled (cancel(), external signal, or abort). */
  cancel: { key: string; tracker: Tracker };
  /** A request joined an in-flight duplicate instead of hitting the network. */
  dedup: { key: string; method: HttpMethod; url: string; consumers: number };
  /** The response was served from cache (fresh read or SWR). */
  "cache-hit": { key: string; tracker: Tracker };
  /** A fresh response was stored in the cache. */
  "cache-write": { key: string; response: ApiResponse };
  /** Cache entries were invalidated. */
  invalidate: { keys: string[]; target: InvalidateTarget };
  /** A background refetch (SWR or post-invalidation) landed a fresh copy. */
  revalidate: { key: string; response: ApiResponse };
}

/** A normal promise extended with a `.cancel()` method. */
export interface CancellablePromise<T> extends Promise<T> {
  /** Abort the request and reject with `CancelledError`. */
  cancel: () => void;
}

export interface ResolvedCacheOptions {
  enabled: boolean;
  ttl: number;
  strategy: CacheStrategy;
}

interface ResolvedSpec extends RequestSpec {
  key: string;
  isRead: boolean;
  cacheable: boolean;
  cache: ResolvedCacheOptions;
  tags?: string[];
}

const DEFAULT_CACHE: CacheOptions = { enabled: true, ttl: 30_000, strategy: "cache-first" };
const DEFAULT_RETRY: RetryOptions = {
  attempts: 3,
  baseDelay: 1000,
  maxDelay: 30_000,
  backoff: "exponential",
  jitter: true,
  respectRetryAfter: true,
};

function resolveCache(options?: CacheOptions): ResolvedCacheOptions {
  return {
    enabled: options?.enabled ?? true,
    ttl: options?.ttl ?? DEFAULT_CACHE.ttl ?? 30_000,
    strategy: options?.strategy ?? "cache-first",
  };
}

function serializeBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return body as BodyInit;
  }
  return JSON.stringify(body);
}

export interface Client {
  /** Generic request. Sugar methods below wrap this one. */
  request<T>(method: HttpMethod, url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  get<T>(url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  post<T>(url: string, body?: unknown, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  put<T>(url: string, body?: unknown, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  patch<T>(url: string, body?: unknown, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  delete: Client["get"];
  head<T>(url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;
  options<T>(url: string, options?: RequestOptions): CancellablePromise<ApiResponse<T>>;

  /** Subscribe to a lifecycle event. Returns an unsubscribe function. */
  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void;
  /** Watch a cache region so mutation invalidation refetches matching keys. */
  subscribe<T>(matcher: (key: string) => boolean, listener: CacheSubscriber<T>): () => void;
  /**
   * Read the request intelligence engine: per-endpoint observations and the
   * roll-up (cache hit rate, deduplication, retries, failures, latency).
   */
  intelligence(): IntelligenceController;
  /**
   * Invalidate cached entries by path (with children + query variants), tag,
   * or predicate. By default subscribed/tracked keys are refetched (disable
   * with `{ refetch: false }`). Returns the removed keys.
   */
  invalidate(target: InvalidateTarget, options?: { refetch?: boolean }): string[];
  /** Cancel every in-flight request tracked by this client. */
  cancelAll(): void;
  /** Drop all cached entries. */
  clearCache(): void;
}

/**
 * Create a ReqMind client — a fetch wrapper that applies request
 * deduplication, caching, stale-while-revalidate, smart retries,
 * cancellation/timeouts, and mutation-driven cache invalidation.
 *
 * @param options - Client-wide configuration: base URL, default headers,
 *   cache/retry/timeout defaults, and an optional custom fetch.
 * @returns A `Client` with typed methods and a lifecycle event system.
 */
export function createClient(options: ClientOptions = {}): Client {
  const cache = new CacheStore(resolveCache(options.cache).ttl);
  const deduper = new Deduper();
  const events = new EventEmitter<ClientEvents>();
  const fetcher = options.fetch ?? fetch;
  const flightTrackers = new Map<string, Tracker>();
  /** Keys actively observed via `subscribe` — used to refetch after invalidation. */
  const interest = new Map<string, number>();
  /** Observation + adaptive decision layer. */
  const intelligence = new Intelligence(options.intelligence, events, () => flightTrackers.size);

  const defaultRetry: RetryOptions = { ...DEFAULT_RETRY, ...options.retry };

  function getKey(method: HttpMethod, url: string, headers: Record<string, string>, body?: unknown): string {
    return createFingerprint({ method, url, headers, body });
  }

  function resolveSpec(
    method: HttpMethod,
    url: string,
    requestOptions: RequestOptions = {} as RequestOptions,
  ): ResolvedSpec {
    const baseURL = requestOptions.baseURL ?? options.baseURL;
    const mergedHeaders: Record<string, string> = {
      ...(options.headers ?? {}),
      ...(requestOptions.headers ?? {}),
    };

    const body = requestOptions.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string" &&
      !mergedHeaders["content-type"] &&
      !mergedHeaders["Content-Type"]
    ) {
      mergedHeaders["content-type"] = "application/json";
      mergedHeaders["Accept"] ??= "application/json";
    }

    const fetchURL = buildQuery(resolveURL(baseURL, url), requestOptions.params);
    const isRead = READ_METHODS.has(method);
    const cacheable = CACHEABLE_METHODS.has(method);
    const recommendation = intelligence.recommend(method, urlPath(fetchURL));

    let retry: RetryOptions;
    if (requestOptions.retry === false) {
      retry = { attempts: 1 };
    } else if (typeof requestOptions.retry === "object") {
      retry = { ...defaultRetry, ...requestOptions.retry };
    } else {
      retry = defaultRetry;
    }

    const cacheDefaults = resolveCache(options.cache);
    const requestCacheObject = typeof requestOptions.cache === "object" ? requestOptions.cache : undefined;
    const cacheEnabled =
      cacheable && requestOptions.cache !== false && (requestCacheObject?.enabled ?? cacheDefaults.enabled);
    const ttl = requestCacheObject?.ttl ?? cacheDefaults.ttl;
    const strategy =
      requestCacheObject?.strategy ?? recommendation.strategy ?? cacheDefaults.strategy;

    return {
      method,
      url: fetchURL,
      headers: mergedHeaders,
      body,
      timeout: requestOptions.timeout ?? recommendation.timeout ?? options.timeout,
      retry,
      tags: requestOptions.tags,
      key: getKey(method, fetchURL, mergedHeaders, body),
      isRead,
      cacheable,
      cache: { enabled: cacheEnabled, ttl, strategy },
    };
  }

  /**
   * Raw network execution with retry + timeout + cancellation.
   * Rejects with HttpError | TimeoutError | CancelledError.
   */
  async function fetchNetwork(spec: RequestSpec, tracker: Tracker): Promise<ApiResponse> {
    const retry = resolveRetryOptions(spec.retry);
    let attempts = 0;

    for (;;) {
      attempts += 1;
      tracker.markAttempt();

      const attemptController = new AbortController();
      const propagateAbort = (): void => attemptController.abort();
      if (tracker.signal.aborted) {
        attemptController.abort();
      } else {
        tracker.signal.addEventListener("abort", propagateAbort, { once: true });
      }

      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (spec.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          attemptController.abort();
        }, spec.timeout);
      }

      let response: Response | undefined;
      try {
        response = await fetcher(spec.url, {
          method: spec.method,
          headers: spec.headers,
          body: serializeBody(spec.body),
          signal: attemptController.signal,
        });
      } catch (err) {
        if (timedOut) throw new TimeoutError(spec.timeout ?? 0);
        if (tracker.cancelled) throw new CancelledError();
        if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
        throw new HttpError(undefined, "Network Error", String(err));
      } finally {
        if (timer) clearTimeout(timer);
        tracker.signal.removeEventListener("abort", propagateAbort);
      }

      if (isSuccessStatus(response.status)) {
        tracker.setState("success");
        return parseResponse(response);
      }

      const httpError = new HttpError(
        response.status,
        response.statusText,
        undefined,
        response.headers,
      );

      const decision = decideRetry({ error: httpError, options: retry, attempts });
      if (!decision.shouldRetry) {
        tracker.setState("error");
        throw httpError;
      }

      tracker.setState("retrying");
      events.emit("retry", {
        key: tracker.key,
        tracker,
        attempts,
        delay: decision.delayMs,
        error: httpError,
      });
      await delay(decision.delayMs, tracker.signal);
    }
  }

  /**
   * Await a flight that may be shared. On cancellation:
   *  - owned flights abort the network call,
   *  - deduped flights detach from the shared request (last consumer aborts it).
   */
  function awaitFlight<T>(
    flight: Promise<ApiResponse>,
    tracker: Tracker,
    key: string,
    owned: boolean,
  ): Promise<ApiResponse<T>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        if (!owned) {
          const hasOthers = deduper.detach(key);
          if (!hasOthers) {
            flightTrackers.get(key)?.cancel();
          }
        }
        settled = true;
        reject(new CancelledError());
      };
      tracker.signal.addEventListener("abort", onAbort, { once: true });
      flight.then(
        (res) => {
          if (!settled) {
            settled = true;
            resolve(res as ApiResponse<T>);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );
    });
  }

  function handleFailure(tracker: Tracker, error: unknown): void {
    if (error instanceof CancelledError) {
      events.emit("cancel", { key: tracker.key, tracker });
      tracker.setState("cancelled");
    } else {
      events.emit("error", { key: tracker.key, tracker, error });
      tracker.setState("error");
    }
  }

  function afterSuccess(spec: ResolvedSpec, response: ApiResponse): void {
    if (spec.cacheable && spec.cache.enabled) {
      const entry = cache.set({
        key: spec.key,
        path: urlPath(spec.url),
        response,
        spec,
        tags: spec.tags,
        ttl: spec.cache.ttl,
      });
      events.emit("cache-write", { key: spec.key, response });
      if (entry.subscribers.size) {
        cache.notifySubscribers(entry, { key: spec.key, response });
      }
    } else if (!spec.isRead) {
      invalidateAfterMutation(spec);
    }
  }

  function invalidateAfterMutation(spec: ResolvedSpec): void {
    const path = urlPath(spec.url);
    const target: InvalidateTarget = spec.tags?.length ? [path, ...spec.tags] : path;
    const result = cache.invalidate(target);
    events.emit("invalidate", { keys: result.removedKeys, target });
    for (const removed of result.removed) {
      if (removed.subscribers.size > 0 || hasInterest(removed.key)) {
        refetchEntry(removed.key, removed.spec, removed.subscribers);
      }
    }
  }

  /** Background refetch of a stale/removed entry, coalesced via the deduper. */
  function refetchEntry(key: string, spec: RequestSpec, subscribers: Set<CacheSubscriber>): void {
    const tracker = new Tracker(key);
    flightTrackers.set(key, tracker);

    const inflight = deduper.get(key);
    const flight =
      inflight?.promise ?? deduper.attach(key, fetchNetwork(spec, tracker)).promise;

    flight
      .then((res) => {
        const entry = cache.set({ key, path: urlPath(spec.url), response: res, spec });
        const notify = new Set([...subscribers, ...entry.subscribers]);
        for (const subscriber of notify) {
          subscriber({ type: "revalidate", key, response: res });
        }
        events.emit("revalidate", { key, response: res });
      })
      .catch(() => undefined)
      .finally(() => {
        flightTrackers.delete(key);
        if (inflight) {
          deduper.detach(key);
        }
      });
  }

  function hasInterest(key: string): boolean {
    return (interest.get(key) ?? 0) > 0;
  }

  function wireExternalCancel(signal: AbortSignal | undefined, tracker: Tracker): void {
    if (!signal) return;
    if (signal.aborted) {
      tracker.cancel();
      return;
    }
    signal.addEventListener("abort", () => tracker.cancel(), { once: true });
  }

  function request<T>(
    method: HttpMethod,
    url: string,
    requestOptions: RequestOptions = {} as RequestOptions,
  ): CancellablePromise<ApiResponse<T>> {
    const spec = resolveSpec(method, url, requestOptions);
    const { key } = spec;
    let consumerTracker: Tracker;

    // 1. Cache short-circuit for fresh / SWR reads.
    if (spec.cacheable && spec.cache.enabled) {
      const entry = cache.peek(key);
      if (entry) {
        const fresh = cache.isFresh(entry);
        if (spec.cache.strategy === "cache-first" && fresh) {
          consumerTracker = new Tracker(key);
          events.emit("request", { key, method, url: spec.url, tracker: consumerTracker });
          events.emit("cache-hit", { key, tracker: consumerTracker });
          consumerTracker.setState("success");
          return boxed(consumerTracker, Promise.resolve(entry.response as ApiResponse<T>));
        }
        if (spec.cache.strategy === "stale-while-revalidate") {
          consumerTracker = new Tracker(key);
          events.emit("request", { key, method, url: spec.url, tracker: consumerTracker });
          events.emit("cache-hit", { key, tracker: consumerTracker });
          consumerTracker.setState("success");
          if (!fresh) {
            refetchEntry(entry.key, entry.spec, entry.subscribers);
          }
          return boxed(consumerTracker, Promise.resolve(entry.response as ApiResponse<T>));
        }
      }
    }

    // 2. Join an in-flight duplicate instead of starting a new network call.
    if (spec.isRead) {
      const inflight = deduper.get(key);
      if (inflight) {
        consumerTracker = new Tracker(key, true);
        wireExternalCancel(requestOptions.signal, consumerTracker);
        events.emit("request", { key, method, url: spec.url, tracker: consumerTracker });
        consumerTracker.setState("pending");
        const joined = deduper.attach(key, inflight.promise);
        events.emit("dedup", { key, method, url: spec.url, consumers: joined.consumers });
        const flight = awaitFlight<T>(inflight.promise, consumerTracker, key, false);
        return boxed(
          consumerTracker,
          flight.catch((err) => {
            handleFailure(consumerTracker, err);
            throw err;
          }),
        );
      }
    }

    // 3. Own the request lifecycle.
    consumerTracker = new Tracker(key);
    wireExternalCancel(requestOptions.signal, consumerTracker);
    events.emit("request", { key, method, url: spec.url, tracker: consumerTracker });
    consumerTracker.setState("pending");
    flightTrackers.set(key, consumerTracker);

    const flight = spec.isRead
      ? deduper.attach(key, fetchNetwork(spec, consumerTracker)).promise
      : fetchNetwork(spec, consumerTracker);

    const chain = flight
      .then((res) => {
        consumerTracker.setState("success");
        afterSuccess(spec, res);
        events.emit("success", { key, tracker: consumerTracker, response: res });
        return res as ApiResponse<T>;
      })
      .catch((err) => {
        handleFailure(consumerTracker, err);
        throw err;
      })
      .finally(() => {
        flightTrackers.delete(key);
      });

    return boxed(consumerTracker, chain);
  }

  function boxed<T>(tracker: Tracker, promise: Promise<ApiResponse<T>>): CancellablePromise<ApiResponse<T>> {
    const box = promise as CancellablePromise<ApiResponse<T>>;
    box.cancel = (): void => tracker.cancel();
    return box;
  }

  return {
    request,
    get<T>(url: string, requestOptions?: RequestOptions) {
      return request<T>("GET", url, requestOptions);
    },
    post<T>(url: string, body?: unknown, requestOptions: RequestOptions = {} as RequestOptions) {
      return request<T>("POST", url, { ...requestOptions, body });
    },
    put<T>(url: string, body?: unknown, requestOptions: RequestOptions = {} as RequestOptions) {
      return request<T>("PUT", url, { ...requestOptions, body });
    },
    patch<T>(url: string, body?: unknown, requestOptions: RequestOptions = {} as RequestOptions) {
      return request<T>("PATCH", url, { ...requestOptions, body });
    },
    delete<T>(url: string, requestOptions: RequestOptions = {} as RequestOptions) {
      return request<T>("DELETE", url, requestOptions);
    },
    head<T>(url: string, requestOptions: RequestOptions = {} as RequestOptions) {
      return request<T>("HEAD", url, requestOptions);
    },
    options<T>(url: string, requestOptions: RequestOptions = {} as RequestOptions) {
      return request<T>("OPTIONS", url, requestOptions);
    },

    on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void) {
      return events.on(event, listener);
    },

    subscribe<T>(matcher: (key: string) => boolean, listener: CacheSubscriber<T>) {
      const tracked = new Set<string>();
      const track = (key: string): void => {
        if (!tracked.has(key) && matcher(key)) {
          tracked.add(key);
          interest.set(key, (interest.get(key) ?? 0) + 1);
        }
      };
      const unsubscribes = [
        events.on("cache-write", ({ key, response }) => {
          track(key);
          if (matcher(key)) listener({ type: "write", key, response: response as ApiResponse<T> });
        }),
        events.on("revalidate", ({ key, response }) => {
          track(key);
          if (matcher(key)) listener({ type: "revalidate", key, response: response as ApiResponse<T> });
        }),
        events.on("invalidate", ({ keys }) => {
          for (const key of keys) {
            track(key);
            if (matcher(key)) listener({ type: "invalidate", key });
          }
        }),
      ];
      return () => {
        for (const key of tracked) {
          const current = interest.get(key);
          if (current === undefined) continue;
          if (current <= 1) interest.delete(key);
          else interest.set(key, current - 1);
        }
        unsubscribes.forEach((unsubscribe) => unsubscribe());
      };
    },

    invalidate(target: InvalidateTarget, refetchOptions?: { refetch?: boolean }): string[] {
      const result = cache.invalidate(target);
      events.emit("invalidate", { keys: result.removedKeys, target });
      const refetch = refetchOptions?.refetch !== false;
      for (const removed of result.removed) {
        if (refetch && (removed.subscribers.size > 0 || hasInterest(removed.key))) {
          refetchEntry(removed.key, removed.spec, removed.subscribers);
        }
      }
      return result.removedKeys;
    },

    intelligence() {
      return {
        snapshot: () => intelligence.snapshot(),
        endpoint: (method: HttpMethod, path: string) => intelligence.endpoint(method, path),
        reset: () => intelligence.reset(),
      };
    },

    cancelAll() {
      for (const tracker of flightTrackers.values()) tracker.cancel();
      flightTrackers.clear();
      deduper.clear();
    },

    clearCache() {
      cache.clear();
    },
  };
}