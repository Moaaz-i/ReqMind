import type {
  ApiResponse,
  CacheMeta,
  CacheOptions,
  CacheSubscriber,
  CacheUpdate,
  InvalidateTarget,
  RequestSpec,
} from "../types.js";

export interface CacheEntry<T = unknown> {
  key: string;
  /** Normalized resource path of the request (e.g. `/users`). */
  path: string;
  response: ApiResponse<T>;
  tags: string[];
  storedAt: number;
  expiresAt: number;
  /** Request description needed to refetch this entry later (SWR / invalidation). */
  spec: RequestSpec;
  /** Consumers waiting for a fresh copy after the entry went stale. */
  subscribers: Set<CacheSubscriber<T>>;
}

export interface RemovedEntry<T = unknown> {
  key: string;
  /** Request description needed to refetch this entry after invalidation. */
  spec: RequestSpec;
  /** Subscribers still waiting on a fresh copy of this entry. */
  subscribers: Set<CacheSubscriber<T>>;
}

export interface InvalidationResult {
  removedKeys: string[];
  /** Removed entries, used to refetch after invalidation. */
  removed: RemovedEntry[];
}

const DEFAULT_TTL = 30_000;

function collectRemoved(
  entries: Map<string, CacheEntry>,
  match: (key: string, entry: CacheEntry) => boolean,
): InvalidationResult {
  const removedKeys: string[] = [];
  const removed: RemovedEntry[] = [];
  for (const [key, entry] of entries) {
    if (match(key, entry)) {
      entries.delete(key);
      removedKeys.push(key);
      removed.push({ key, spec: entry.spec, subscribers: entry.subscribers });
    }
  }
  return { removedKeys, removed };
}

export class CacheStore {
  private entries = new Map<string, CacheEntry>();

  constructor(private defaultTtl: number = DEFAULT_TTL) {}

  getDefaultTtl(): number {
    return this.defaultTtl;
  }

  peek(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return this.isFresh(entry) ? entry : undefined;
  }

  isFresh(entry: CacheEntry, now = Date.now()): boolean {
    return now < entry.expiresAt;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(input: {
    key: string;
    path?: string;
    response: ApiResponse;
    spec: RequestSpec;
    tags?: string[];
    ttl?: number;
  }): CacheEntry {
    const now = Date.now();
    const ttl = input.ttl ?? this.defaultTtl;
    const entry: CacheEntry = {
      key: input.key,
      path: input.path ?? "/",
      response: input.response,
      tags: input.tags ?? [],
      spec: input.spec,
      storedAt: now,
      expiresAt: now + ttl,
      subscribers: new Set(),
    };

    const existing = this.entries.get(input.key);
    if (existing?.subscribers.size) {
      entry.subscribers = existing.subscribers;
    }
    this.entries.set(input.key, entry);
    return entry;
  }

  subscribe(key: string, subscriber: CacheSubscriber): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => {};
    entry.subscribers.add(subscriber);
    return () => entry.subscribers.delete(subscriber);
  }

  notifySubscribers(entry: CacheEntry, update: Omit<CacheUpdate, "type">): void {
    for (const subscriber of [...entry.subscribers]) {
      subscriber({ type: "revalidate", ...update });
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Remove entries created in the same resource realm as `path`
   * (`/users` also matches `/users`, `/users/10`, `/users?page=1`).
   */
  invalidateByPath(path: string): InvalidationResult {
    const raw = path.split("?")[0] ?? "";
    const target = raw.startsWith("/") ? raw.replace(/\/+$/, "") : `/${raw.replace(/\/+$/, "")}`;
    return collectRemoved(this.entries, (_key, entry) => {
      return entry.path === target || entry.path.startsWith(`${target}/`);
    });
  }

  invalidateByTags(tags: string[]): InvalidationResult {
    const set = new Set(tags);
    return collectRemoved(this.entries, (_key, entry) => entry.tags.some((tag) => set.has(tag)));
  }

  invalidateByPredicate(predicate: (meta: CacheMeta) => boolean): InvalidationResult {
    return collectRemoved(this.entries, (key, entry) => {
      const meta: CacheMeta = {
        key: entry.key,
        tags: entry.tags,
        storedAt: entry.storedAt,
        expiresAt: entry.expiresAt,
      };
      return predicate(meta);
    });
  }

  /**
   * Generic invalidation. Accepts a path, a tag, several of both, or a
   * predicate. Returns the keys that were removed.
   */
  invalidate(target: InvalidateTarget): InvalidationResult {
    if (typeof target === "function") {
      return this.invalidateByPredicate(target);
    }

    const tags = Array.isArray(target) ? (target as string[]) : [target];
    const byPath = this.invalidateByPath(tags[0] ?? "");
    const byTag = this.invalidateByTags(tags);

    const removedKeys = [...new Set([...byPath.removedKeys, ...byTag.removedKeys])];
    const removed = [...byPath.removed, ...byTag.removed];
    return { removedKeys, removed };
  }
}

export type { CacheOptions };