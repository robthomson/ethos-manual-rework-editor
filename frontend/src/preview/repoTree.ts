/* frontend/src/preview/repoTree.ts
 *
 * Description of responsibility:
 *   Fetches (and caches per-branch, module-level) the set of every real
 *   file path in the repo — used by renderMarkdown.tsx to replicate
 *   mkdocs.yml's real `i18n: fallback_to_default: true` behavior for
 *   locale-specific images: a screenshot that doesn't exist under
 *   docs/<locale>/ falls back to the same path under docs/en/, exactly
 *   like the real site does at build time, rather than showing a
 *   broken image.
 *
 * Info:
 *   Module-level cache (not React state) deliberately — this is the
 *   same data backend/routes/navRoutes.ts's own /toc endpoint already
 *   uses for translated/missing status, itself backed by
 *   githubCache.ts's 5-minute TTL, so a short-lived client-side cache
 *   on top doesn't risk staleness beyond what the backend already
 *   accepts; it just avoids re-fetching the same ~thousands-of-paths
 *   list every time a new Preview pane mounts.
 */
const cache = new Map<string, Promise<Set<string>>>();

export function fetchRepoTree(branch: string): Promise<Set<string>> {
  let pending = cache.get(branch);
  if (!pending) {
    pending = fetch(`/api/nav/tree?branch=${encodeURIComponent(branch)}`)
      .then((res) => res.json())
      .then((data: { paths?: string[] }) => new Set(data.paths || []))
      .catch(() => new Set<string>());
    cache.set(branch, pending);
  }
  return pending;
}
