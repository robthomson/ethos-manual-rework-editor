/* backend/routes/workspaceRoutes.ts
 *
 * Description of responsibility:
 *   The local-workspace editing API: create/list/delete a workspace,
 *   open a page for editing (materializing it locally on first open —
 *   see workspaceStore.ts), save it, and scan which pages have actually
 *   changed. Deliberately requires no GitHub sign-in at all — see
 *   workspaceStore.ts's header comment for why that's the right call
 *   for a single-user desktop install, unlike docEditor's own
 *   login-gated workspace routes.
 *
 * Info:
 *   tokenForRequest() mirrors navRoutes.ts's own — a signed-in user's
 *   token is used when present (raises the GitHub rate limit), but
 *   nothing here ever requires one. Submitting a workspace as a PR is
 *   the one action that will need real sign-in, once gitRoutes.ts is
 *   ported — not part of this slice.
 */
import express from "express";
import { getTokenForUser } from "./authRoutes";
import {
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
  readMeta,
  ensurePageMaterialized,
  savePage,
  scanChanges,
  createNewPage,
  WorkspaceError,
} from "../workspaceStore";
import { fetchMkdocsConfig, localeNames } from "../mkdocsConfig";
import type { GitHubToken } from "../githubClient";

const router = express.Router();

function tokenForRequest(req: express.Request): GitHubToken | null {
  const login = req.session?.login;
  if (!login) return null;
  try {
    return getTokenForUser(login);
  } catch {
    return null;
  }
}

function handleError(res: express.Response, err: unknown) {
  if (err instanceof WorkspaceError) {
    return res.status(400).json({ error: err.message });
  }
  console.error("workspace route error:", err);
  return res.status(500).json({ error: "Something went wrong." });
}

router.get("/", async (_req, res) => {
  try {
    res.json({ workspaces: await listWorkspaces() });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/", async (req, res) => {
  const { name, branch, locale } = req.body || {};

  if (!name || !branch || !locale) {
    return res.status(400).json({ error: "Missing name, branch, or locale." });
  }

  try {
    // Validate the locale actually exists on this branch before creating
    // anything — a typo'd locale code would otherwise silently create a
    // workspace that can never successfully materialize any page.
    const token = tokenForRequest(req);
    const config = await fetchMkdocsConfig(token, branch);
    const locales = localeNames(config);
    if (!(locale in locales)) {
      return res.status(400).json({ error: `Unknown locale "${locale}" for branch ${branch}.` });
    }

    const meta = await createWorkspace(name, locale, branch);
    res.json({ workspace: meta });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/:name", async (req, res) => {
  try {
    await deleteWorkspace(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/:name/page", async (req, res) => {
  const mdPath = req.query.path as string;
  if (!mdPath) return res.status(400).json({ error: "Missing path" });

  try {
    const token = tokenForRequest(req);
    const page = await ensurePageMaterialized(token, req.params.name, mdPath);
    res.json(page);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/:name/page", async (req, res) => {
  const { path: mdPath, content } = req.body || {};
  if (!mdPath || typeof content !== "string") {
    return res.status(400).json({ error: "Missing path or content" });
  }

  try {
    await savePage(req.params.name, mdPath, content);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// English-only — createNewPage() enforces this itself too (not just
// here), so this can never be reached any other way even if a future
// caller forgets the check.
router.post("/:name/new-page", async (req, res) => {
  const { title, slug, sectionTitle } = req.body || {};
  if (!title || !slug || !sectionTitle) {
    return res.status(400).json({ error: "Missing title, slug, or sectionTitle." });
  }

  try {
    const token = tokenForRequest(req);
    const result = await createNewPage(token, req.params.name, title, slug, sectionTitle);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/:name/changes", async (req, res) => {
  try {
    res.json({ changes: await scanChanges(req.params.name) });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/:name", async (req, res) => {
  try {
    res.json({ workspace: await readMeta(req.params.name) });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
