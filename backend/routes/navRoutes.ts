/* backend/routes/navRoutes.ts
 *
 * Description of responsibility:
 *   The "browse ethos-manual-rework and pick a page" API: branches,
 *   locales, and the docs nav annotated with each page's translation
 *   status for a given locale. Entirely anonymous-capable (see
 *   mkdocsConfig.ts's header comment) — nothing here requires sign-in,
 *   matching ethos-manual-rework-editor's own Python app (browsing a
 *   public repo shouldn't need a token; only committing/opening a PR
 *   does).
 *
 * Info:
 *   Uses the caller's own token when they have one (raises GitHub's
 *   rate limit from 60/hour to 5000/hour) but never requires it —
 *   tokenForRequest() below returns null rather than 401ing when no
 *   session exists, unlike docsRoutes.ts/gitRoutes.ts's requireToken().
 */
import express from "express";
import { getTokenForUser } from "./authRoutes";
import {
  listBranches,
  fetchMkdocsConfig,
  localeNames,
  fetchToc,
  fetchRepoTree,
  docsPath,
  fetchPageSource,
  tryFetchPageSource,
  latestCommitSha,
  RepoError,
  type TocPage,
} from "../mkdocsConfig";
import { splitFrontmatter } from "../frontmatter";
import { GitHubToken } from "../githubClient";
import { cached, PAGE_TTL_MS } from "../githubCache";

const router = express.Router();

// async — getTokenForUser() may need to make a real refresh-token network
// call before it can answer (see authRoutes.ts:getUsableToken()).
async function tokenForRequest(req: express.Request): Promise<GitHubToken | null> {
  const login = req.session?.login;
  if (!login) return null;
  try {
    return await getTokenForUser(login);
  } catch {
    return null; // session says signed in but the stored token's gone — fall back to anonymous
  }
}

function handleRepoError(res: express.Response, err: unknown) {
  if (err instanceof RepoError) {
    return res.status(502).json({ error: err.message });
  }
  console.error("nav route error:", err);
  return res.status(500).json({ error: "Something went wrong talking to GitHub." });
}

router.get("/branches", async (req, res) => {
  try {
    const branches = await listBranches(await tokenForRequest(req));
    res.json({ branches });
  } catch (err) {
    handleRepoError(res, err);
  }
});

interface NavPage extends Omit<TocPage, "children"> {
  // "source" for English itself (nothing to translate); undefined when
  // no locale was requested at all (English-only browsing).
  status?: "translated" | "missing" | "source";
  children: NavPage[];
}

function annotate(pages: TocPage[], locale: string, existingPaths: Set<string>): NavPage[] {
  return pages.map((page) => ({
    ...page,
    status:
      locale === "en"
        ? "source"
        : page.mdPath
          ? existingPaths.has(docsPath(locale, page.mdPath))
            ? "translated"
            : "missing"
          : undefined,
    children: annotate(page.children, locale, existingPaths),
  }));
}

router.get("/toc", async (req, res) => {
  const branch = (req.query.branch as string) || "main";
  const locale = (req.query.locale as string) || "en";

  try {
    const token = await tokenForRequest(req);
    const config = await fetchMkdocsConfig(token, branch);
    const locales = localeNames(config);

    if (!(locale in locales)) {
      return res.status(400).json({ error: `Unknown locale "${locale}" for branch ${branch}.` });
    }

    const toc = await fetchToc(token, branch);

    // One tree listing regardless of locale — for "en" itself every page
    // in the nav trivially exists (it's the source of truth the nav was
    // built from), so the tree fetch is skipped entirely rather than
    // spending an API call confirming the obvious.
    const existingPaths = locale === "en" ? new Set<string>() : await fetchRepoTree(token, branch);

    res.json({ locales, toc: annotate(toc, locale, existingPaths) });
  } catch (err) {
    handleRepoError(res, err);
  }
});

// Every real file path in the repo at this branch — reuses the exact
// same cached fetchRepoTree() call /toc's own status annotation already
// makes (one GitHub call per branch per 5 minutes, see githubCache.ts),
// so this costs nothing extra in the common case. Exposed so the
// frontend's own image-src resolution (preview/renderMarkdown.tsx) can
// replicate mkdocs.yml's real `fallback_to_default: true` i18n
// behavior: a locale-specific asset that doesn't exist falls back to
// the English one at the same relative path, exactly like the real
// site does at build time — without this, a translated page's own
// screenshots (rarely re-shot per locale) would just show as broken
// images instead of correctly falling back.
router.get("/tree", async (req, res) => {
  const branch = (req.query.branch as string) || "main";
  try {
    const token = await tokenForRequest(req);
    const paths = await fetchRepoTree(token, branch);
    res.json({ paths: Array.from(paths) });
  } catch (err) {
    handleRepoError(res, err);
  }
});

router.get("/page", async (req, res) => {
  const branch = (req.query.branch as string) || "main";
  const locale = (req.query.locale as string) || "en";
  const mdPath = req.query.path as string;

  if (!mdPath) {
    return res.status(400).json({ error: "Missing path" });
  }

  try {
    const token = await tokenForRequest(req);

    const englishSource = await fetchPageSource(token, branch, "en", mdPath);

    if (locale === "en") {
      // Browsing English itself — no translation, no frontmatter to
      // strip (English pages don't carry translated_from:), no
      // staleness to compute.
      return res.json({ source: englishSource, translation: null, stale: null });
    }

    const rawTranslation = await tryFetchPageSource(token, branch, locale, mdPath);

    if (rawTranslation === null) {
      // Not translated yet — pre-filled with the English source as a
      // starting point, matching the Python app's editor behavior,
      // rather than left blank.
      return res.json({ source: englishSource, translation: englishSource, stale: null, frontmatter: {} });
    }

    const { frontmatter, body } = splitFrontmatter(rawTranslation);

    let stale: boolean | null = null;
    const translatedFrom = frontmatter.translated_from;
    if (typeof translatedFrom === "string") {
      const currentEnglishSha = await latestCommitSha(token, branch, docsPath("en", mdPath));
      stale = translatedFrom !== currentEnglishSha;
    }

    res.json({ source: englishSource, translation: body, stale, frontmatter });
  } catch (err) {
    handleRepoError(res, err);
  }
});

// ---------------------------------------------
// Search — full-text, across every real page's content for one
// branch+locale, not just titles (the sidebar nav already covers
// titles, always fully expanded — see NavTree.tsx). Deliberately
// workspace-agnostic, same as /toc and /tree above: searches the
// last-committed GitHub content, not any workspace's own unsaved local
// edits. Keeps this route as simple as /toc/tree (same functions, same
// caching) rather than needing to merge in per-workspace overlays; a
// real, scoped follow-up if that turns out to matter in practice.
// ---------------------------------------------

// Leaves only (skips pure section headers, mdPath: null) — same shape
// /toc already walks, just flattened instead of kept as a tree.
function flattenPages(pages: TocPage[]): { mdPath: string; title: string }[] {
  const out: { mdPath: string; title: string }[] = [];
  for (const page of pages) {
    if (page.mdPath) out.push({ mdPath: page.mdPath, title: page.title });
    out.push(...flattenPages(page.children));
  }
  return out;
}

// Bounded-concurrency map — GitHub's own abuse-detection (secondary
// rate limiting, distinct from the per-hour primary limit) can trigger
// on a sudden burst of many concurrent requests to the same repo. A
// locale with 80-150 pages firing one unbounded Promise.all on the
// first search after the index cache expires is a real risk, not a
// theoretical one — this caps it to a small worker pool instead.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface SearchIndexEntry {
  mdPath: string;
  title: string;
  content: string;
  // True when this page's content couldn't be fetched at all (see the
  // per-page try/catch below) — still searchable by title, but a
  // content match on this page can't be found. Surfaced in the
  // response as `partial` so the UI can be honest that results may be
  // incomplete, rather than silently presenting a rate-limited index
  // as if it were the whole repo.
  failed: boolean;
}

// ~60 chars either side of the first match, collapsed to one line (a
// match spanning a markdown line break should still read as one line
// in a results list) and ellipsized at the cut edges.
function buildSnippet(content: string, matchIndex: number, matchLength: number): string {
  const CONTEXT = 60;
  const start = Math.max(0, matchIndex - CONTEXT);
  const end = Math.min(content.length, matchIndex + matchLength + CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + content.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

router.get("/search", async (req, res) => {
  const branch = (req.query.branch as string) || "main";
  const locale = (req.query.locale as string) || "en";
  const q = ((req.query.q as string) || "").trim();

  // A 1-char query would still force building the full index for a
  // near-useless result set — not worth it.
  if (q.length < 2) return res.json({ results: [], partial: false });

  try {
    const token = await tokenForRequest(req);
    const config = await fetchMkdocsConfig(token, branch);

    if (!(locale in localeNames(config))) {
      return res.status(400).json({ error: `Unknown locale "${locale}" for branch ${branch}.` });
    }

    const pages = flattenPages(await fetchToc(token, branch));

    const index = await cached(`search-index:${branch}:${locale}`, PAGE_TTL_MS, () =>
      mapLimit<{ mdPath: string; title: string }, SearchIndexEntry>(pages, 8, async ({ mdPath, title }) => {
        // A single page's fetch failing — most commonly GitHub's own
        // 60-req/hour anonymous rate limit, which a repo with 70+ pages
        // exhausts partway through one single index build — must not
        // take down the whole search. Caught per-page so whichever pages
        // *did* succeed still return real results (title-searchable at
        // worst) instead of the entire request 502ing. Confirmed live:
        // an anonymous first search of this repo's ~76-page English toc
        // needs more calls than the hourly anonymous quota allows at
        // all, so this isn't a rare edge case here — it's close to the
        // common case for a signed-out user's very first search.
        try {
          let content = await tryFetchPageSource(token, branch, locale, mdPath);
          if (content === null && locale !== "en") {
            // Not translated yet — searches the English fallback instead,
            // matching the same fallback PageView.tsx already shows for
            // an untranslated page, so a term still surfaces even without
            // a translation yet.
            content = await fetchPageSource(token, branch, "en", mdPath).catch(() => null);
          }
          return { mdPath, title, content: content ?? "", failed: false };
        } catch {
          return { mdPath, title, content: "", failed: true };
        }
      }),
    );

    const partial = index.some((entry) => entry.failed);

    const needle = q.toLowerCase();
    const results = index
      .map((entry) => {
        const titleMatch = entry.title.toLowerCase().includes(needle);
        const contentIdx = entry.content.toLowerCase().indexOf(needle);
        if (!titleMatch && contentIdx === -1) return null;
        return {
          mdPath: entry.mdPath,
          title: entry.title,
          titleMatch,
          snippet: contentIdx === -1 ? "" : buildSnippet(entry.content, contentIdx, q.length),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      // Title matches first, then alphabetical within each group — no
      // real ranking algorithm needed for what's realistically a few
      // dozen results at most.
      .sort((a, b) => (a.titleMatch === b.titleMatch ? a.title.localeCompare(b.title) : a.titleMatch ? -1 : 1))
      .slice(0, 50);

    res.json({ results, partial });
  } catch (err) {
    handleRepoError(res, err);
  }
});

export default router;
