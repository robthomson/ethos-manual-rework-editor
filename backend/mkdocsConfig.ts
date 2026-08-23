/* backend/mkdocsConfig.ts
 *
 * Description of responsibility:
 *   Read-only access to ethos-manual-rework's structure: branches,
 *   locales, the docs nav (the page picker's table of contents), and
 *   individual page source — everything the translator-facing "browse
 *   and pick a page" flow needs, all anonymous by default.
 *
 * Info:
 *   Ported from ethos-manual-rework-editor's own src/github_repo.py
 *   (the Python app this project is replacing) — ethos-manual-rework is
 *   public, so browsing (this file) never requires sign-in; only actual
 *   commits/PRs (gitRoutes.ts, once ported) need a real token. A token
 *   is still accepted and used here when the caller has one (raises the
 *   GitHub rate limit from 60/hour to 5000/hour, same reasoning as the
 *   Python original), it's just never required.
 *
 *   buildToc() walks mkdocs.yml's `nav:` the same way
 *   ethos-manual-rework's own scripts/build_pdfs.py:nav_pages() does,
 *   fed a copy of mkdocs.yml fetched over the API instead of read from a
 *   local checkout — but keeps the tree shape (that script flattens to
 *   a list since it only needs render order for the PDF; a picker needs
 *   the section/child structure back).
 *
 *   fetchRepoTree() (new here — the Python app has no equivalent) does
 *   one recursive git-tree listing per branch rather than checking each
 *   nav page's translated path individually, so annotating an entire
 *   locale's nav with "translated vs. missing" status costs one GitHub
 *   API call regardless of how many pages the nav has. It deliberately
 *   does NOT attempt to also distinguish "stale" there — that needs each
 *   translated page's own `translated_from:` frontmatter compared
 *   against its English counterpart's *latest* commit SHA, which is
 *   inherently a per-page cost (frontmatter.ts + latestCommitSha() below)
 *   — left lazy, computed only for the one page actually opened, same
 *   as the Python original.
 *
 *   Every function here goes through githubCache.ts's cached() —
 *   without it, browsing (unlike workspaceStore.ts's edited pages, which
 *   are fetched once and then pure local disk I/O forever after)
 *   re-fetched mkdocs.yml and did a full recursive tree listing on
 *   every single nav render/locale switch, live and unauthenticated,
 *   burning through the 60-requests/hour anonymous rate limit in a
 *   handful of clicks. See that file's header comment for the TTLs and
 *   why a short cache is safe here (the underlying data only changes on
 *   a real push to the repo).
 */
import yaml from "js-yaml";
import { githubRequest, GitHubToken } from "./githubClient";
import { GITHUB_OWNER, GITHUB_REPO } from "./config/github";
import { cached, STRUCTURE_TTL_MS, COMMIT_SHA_TTL_MS, PAGE_TTL_MS } from "./githubCache";

export class RepoError extends Error {}

// mike's build output branch (see ethos-manual-rework's deploy.yml) — a
// real branch, but not a content/version branch anyone should pick to
// edit.
const NON_CONTENT_BRANCHES = new Set(["gh-pages"]);

async function wrapErrors<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RepoError) throw err; // already has a clean message
    const message = err instanceof Error ? err.message : String(err);
    throw new RepoError(`GitHub error while ${action}: ${message}`);
  }
}

// main first (if present), then the rest alphabetically — matches how
// ethos-manual-rework's own versioning convention treats main as the
// active branch and everything else as a frozen prior version.
export async function listBranches(token: GitHubToken | null): Promise<string[]> {
  return cached("branches", STRUCTURE_TTL_MS, () =>
    wrapErrors("listing branches", async () => {
      const branches = await githubRequest<Array<{ name: string }>>(
        token,
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/branches?per_page=100`,
      );
      const names = branches
        .map((b) => b.name)
        .filter((name) => !NON_CONTENT_BRANCHES.has(name));
      names.sort((a, b) => {
        if (a === "main" && b !== "main") return -1;
        if (b === "main" && a !== "main") return 1;
        return a.localeCompare(b);
      });
      return names;
    }),
  );
}

interface ContentsResponse {
  content: string;
  encoding: string;
}

async function fetchTextFile(
  token: GitHubToken | null,
  branch: string,
  path: string,
  missingOk = false,
): Promise<string | null> {
  return cached(`file:${branch}:${path}:${missingOk}`, PAGE_TTL_MS, () =>
    wrapErrors(`fetching ${path}@${branch}`, async () => {
      try {
        const file = await githubRequest<ContentsResponse>(
          token,
          `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`,
        );
        return Buffer.from(file.content, file.encoding as BufferEncoding).toString("utf8");
      } catch (err: any) {
        if (err?.status === 404) {
          if (missingOk) return null;
          throw new RepoError(`${path} not found on branch ${branch}.`);
        }
        throw err;
      }
    }),
  );
}

export function docsPath(locale: string, mdPath: string): string {
  return `docs/${locale}/${mdPath}`;
}

// English (or any locale expected to exist) — a 404 here is a real
// error, not a "not translated yet" case.
export async function fetchPageSource(
  token: GitHubToken | null,
  branch: string,
  locale: string,
  mdPath: string,
): Promise<string> {
  const text = await fetchTextFile(token, branch, docsPath(locale, mdPath), false);
  // fetchTextFile only returns null when missingOk is true, so this is
  // unreachable in practice — narrows the return type for callers.
  if (text === null) throw new RepoError(`${docsPath(locale, mdPath)} not found on branch ${branch}.`);
  return text;
}

// A non-English locale's page — null means "not translated yet", which
// is an expected, common, non-error outcome here.
export async function tryFetchPageSource(
  token: GitHubToken | null,
  branch: string,
  locale: string,
  mdPath: string,
): Promise<string | null> {
  return fetchTextFile(token, branch, docsPath(locale, mdPath), true);
}

// The raw text — workspaceStore.ts's new-page flow needs to parse,
// mutate, and re-dump this itself (to insert a nav entry), not just the
// already-parsed object fetchMkdocsConfig() below returns.
export async function fetchRawMkdocsYaml(token: GitHubToken | null, branch: string): Promise<string> {
  const text = await fetchTextFile(token, branch, "mkdocs.yml", false);
  return text as string;
}

export async function fetchMkdocsConfig(
  token: GitHubToken | null,
  branch: string,
): Promise<Record<string, any>> {
  // Cached at this level (not just inside fetchTextFile) with the
  // longer STRUCTURE_TTL_MS, and so the yaml.load() parse itself isn't
  // redone on every repeat call either.
  return cached(`mkdocs:${branch}`, STRUCTURE_TTL_MS, async () => {
    const text = await fetchRawMkdocsYaml(token, branch);
    try {
      return (yaml.load(text) as Record<string, any>) || {};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RepoError(`mkdocs.yml on ${branch} isn't valid YAML: ${message}`);
    }
  });
}

// locale -> display name (e.g. "fr" -> "Français"). "en" isn't listed
// under plugins.i18n.languages in mkdocs.yml (it's the implicit
// default), so it's added here to match — same as
// ethos-manual-rework/scripts/build_pdfs.py:locale_names().
export function localeNames(config: Record<string, any>): Record<string, string> {
  const names: Record<string, string> = { en: "English" };
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  for (const plugin of plugins) {
    if (plugin && typeof plugin === "object" && "i18n" in plugin) {
      const languages = plugin.i18n?.languages;
      if (Array.isArray(languages)) {
        for (const language of languages) {
          if (language?.locale) names[language.locale] = language.name ?? language.locale;
        }
      }
    }
  }
  return names;
}

export interface TocPage {
  title: string;
  mdPath: string | null; // null for a pure section header with no page of its own
  children: TocPage[];
}

// Walks nav:. A section (dict value is a list) whose first child is a
// bare, unlabeled string is treated as that section's own landing page
// — matches both mkdocs' own interpretation (clicking a nav tab opens
// it) and how every section in this repo's nav is actually written.
export function buildToc(config: Record<string, any>): TocPage[] {
  function walk(entries: any[]): TocPage[] {
    const pages: TocPage[] = [];
    for (const entry of entries || []) {
      if (typeof entry === "string") {
        pages.push({ title: entry, mdPath: entry, children: [] });
        continue;
      }
      if (entry && typeof entry === "object") {
        for (const [label, value] of Object.entries(entry)) {
          if (typeof value === "string") {
            pages.push({ title: label, mdPath: value, children: [] });
            continue;
          }
          let sectionPath: string | null = null;
          let rest = Array.isArray(value) ? value : [];
          if (rest.length > 0 && typeof rest[0] === "string") {
            sectionPath = rest[0];
            rest = rest.slice(1);
          }
          pages.push({ title: label, mdPath: sectionPath, children: walk(rest) });
        }
      }
    }
    return pages;
  }

  return walk(config.nav || []);
}

// One recursive tree listing (not one call per nav page) so annotating
// a whole locale's nav with "translated vs. missing" costs a single
// GitHub API call regardless of how many pages the nav has. Returns the
// set of every real file path in the repo at this branch — callers
// check docsPath(locale, page.mdPath) membership against it.
export async function fetchRepoTree(
  token: GitHubToken | null,
  branch: string,
): Promise<Set<string>> {
  return cached(`tree:${branch}`, STRUCTURE_TTL_MS, () =>
    wrapErrors(`listing the repo tree for ${branch}`, async () => {
      const data = await githubRequest<{
        tree: Array<{ path: string; type: string }>;
        truncated: boolean;
      }>(
        token,
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      );
      if (data.truncated) {
        console.warn(
          `fetchRepoTree: GitHub truncated the tree listing for ${branch} — ` +
            `some deeply-nested paths may be missing from the "translated" check.`,
        );
      }
      return new Set(data.tree.filter((e) => e.type === "blob").map((e) => e.path));
    }),
  );
}

// Mirrors ethos-manual-rework's own hooks/i18n_status.py: `git log -1 --
// <path>` — the most recent commit that touched this exact file on this
// branch. Used both to bump a submitted translation's `translated_from:`
// and (lazily, per opened page) to decide whether an existing
// translation is stale.
export async function latestCommitSha(
  token: GitHubToken | null,
  branch: string,
  path: string,
): Promise<string> {
  return cached(`commitsha:${branch}:${path}`, COMMIT_SHA_TTL_MS, () =>
    wrapErrors(`looking up the last commit for ${path}@${branch}`, async () => {
      const commits = await githubRequest<Array<{ sha: string }>>(
        token,
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`,
      );
      if (!commits.length) {
        throw new RepoError(`No commits found for ${path}@${branch}.`);
      }
      return commits[0].sha;
    }),
  );
}
