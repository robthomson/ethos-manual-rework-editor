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
  buildToc,
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

const router = express.Router();

function tokenForRequest(req: express.Request): GitHubToken | null {
  const login = req.session?.login;
  if (!login) return null;
  try {
    return getTokenForUser(login);
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
    const branches = await listBranches(tokenForRequest(req));
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
    const token = tokenForRequest(req);
    const config = await fetchMkdocsConfig(token, branch);
    const locales = localeNames(config);

    if (!(locale in locales)) {
      return res.status(400).json({ error: `Unknown locale "${locale}" for branch ${branch}.` });
    }

    const toc = buildToc(config);

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

router.get("/page", async (req, res) => {
  const branch = (req.query.branch as string) || "main";
  const locale = (req.query.locale as string) || "en";
  const mdPath = req.query.path as string;

  if (!mdPath) {
    return res.status(400).json({ error: "Missing path" });
  }

  try {
    const token = tokenForRequest(req);

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

export default router;
