/* backend/githubCache.ts
 *
 * Description of responsibility:
 *   A short-lived in-memory cache for read-only GitHub lookups
 *   (mkdocs.yml, the repo tree, branch lists, per-file commit SHAs) —
 *   the structural data behind nav browsing, which changes only when
 *   someone pushes to the repo, not on every click in the UI.
 *
 * Info:
 *   Without this, every nav-tree render/locale switch re-fetched
 *   mkdocs.yml and did a full recursive tree listing straight from
 *   GitHub, live, unauthenticated — burning through the anonymous
 *   60-requests/hour rate limit in a handful of clicks (signing in
 *   raises that to 5000/hour, but that's gated on the GitHub App, which
 *   registration is currently deferred). This is a separate concern
 *   from workspaceStore.ts's own local materialization: that's edited
 *   *page content*, fetched once per page and then pure local disk I/O
 *   forever after; this is the read-only *browsing* path (navRoutes.ts),
 *   which has no local copy of anything and, until now, re-hit GitHub
 *   on every single request.
 *
 *   Deliberately process-memory only (cleared on restart), not written
 *   to disk — a stale cache here is just a few extra minutes' lag
 *   behind a real upstream push, never a correctness issue serious
 *   enough to need surviving restarts, and every value here is cheaply
 *   re-derivable from GitHub whenever it does expire.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

// In-flight promises are cached too (not just settled values) — without
// this, two near-simultaneous requests for the same key (e.g. the nav
// tree fetch firing twice during a fast branch/locale switch) would each
// independently start their own GitHub call instead of sharing the one
// already in flight.
const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = fn()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

// Structural repo data (mkdocs.yml, the recursive tree listing, branch
// list) — changes only on a real push, so a generous TTL costs nothing
// in practice while eliminating almost all repeat calls during a normal
// browsing session.
export const STRUCTURE_TTL_MS = 5 * 60 * 1000;

// Per-file latest-commit-SHA lookups (staleness checks) — same repo-push
// cadence as the above, same TTL.
export const COMMIT_SHA_TTL_MS = 5 * 60 * 1000;

// Individual page content (English source + a translation) — shorter,
// since this is also what a translator might be actively re-checking
// against their own in-progress edits elsewhere.
export const PAGE_TTL_MS = 2 * 60 * 1000;
