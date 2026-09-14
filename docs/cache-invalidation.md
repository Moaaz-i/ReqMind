# Cache invalidation

Invalidation keeps cached data consistent when the world changes: after a successful mutation, or on demand.

## Mutation-driven invalidation

A successful **mutation** (`POST`, `PUT`, `PATCH`, `DELETE` — anything that is not a read) automatically invalidates:

1. the **path** of the mutated resource (`/users`), and
2. any **tags** you declared on the request (`["users"]`).

```ts
// Watch the region you care about.
const unsubscribe = api.subscribe(
  (key) => key.includes("/users"),
  ({ type, response }) => {
    if (type === "revalidate") { /* fresh copy arrived after a mutation */ }
  },
);

await api.get("/users", { tags: ["users"] });          // populate + track interest

await api.post("/users", { name: "Moaaz" });           // invalidates "/users" path
await api.put("/users/1", body, { tags: ["users"] });  // invalidates path + "users" tag
await api.delete("/users/1", { tags: ["users"] });     // also invalidates plans if tagged
```

### Path matching

Invalidating `/users` also invalidates **children and query variants**:

- `/users/10`
- `/users?page=1`

…while **sibling paths** survive:

- `/users-evil` (a different path segment, not a child)

Matching is segment-aware on the pathname, then applies to every cached entry whose pathname starts with the segment boundary of the target.

## Auto-refetch

After invalidation, affected keys are **refetched in the background** when someone is listening:

- keys returned to **cache subscribers** (`CacheStore`), or
- keys under active **`client.subscribe`** interest.

The refetch is coalesced through the deduper and notifies watchers with a `revalidate` update. To suppress it, subscribe with no active interest or use explicit invalidation with `refetch: false`.

## Explicit invalidation

```ts
api.invalidate("/users");                                        // path + children/query variants
api.invalidate(["users", "teams"]);                              // tags
api.invalidate((meta) => meta.tags.includes("users"));           // predicate
api.invalidate("/users", { refetch: false });                    // clear only
```

`api.invalidate(...)` **returns the removed keys**, and by default also refetches subscribed/tracked keys — same rule as mutation invalidation.

### What a predicate sees

```ts
interface CacheMeta {
  key: string;
  tags: string[];
  storedAt: number;
  expiresAt: number;
}
```

```ts
api.invalidate((meta) => meta.expiresAt < Date.now()); // drop all already-stale entries
```

## Lower level

The `CacheStore` exposes the same invalidation targeting for custom layers:

```ts
import { CacheStore } from "@reqmind/core";

const store = new CacheStore(30_000);
store.set({ key: "k1", path: "/users", response, spec, tags: ["users"], ttl: 30_000 });
store.invalidate("/users");          // path
store.invalidate(["users"]);         // tags
store.invalidate(() => true);        // predicate
store.clear();
```

Next: [events & lifecycle](events-and-lifecycle.md).