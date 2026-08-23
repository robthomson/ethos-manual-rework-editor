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
import multer from "multer";
import path from "path";
import fs from "fs-extra";
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
  createNewSection,
  listWorkspaceImages,
  uploadImage,
  workspaceImageFilePath,
  WorkspaceError,
} from "../workspaceStore";
import { fetchMkdocsConfig, localeNames } from "../mkdocsConfig";
import type { GitHubToken } from "../githubClient";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// English-only — createNewSection() enforces this itself too, same
// reasoning as new-page above. A "section" is a brand-new top-level nav
// category (its own landing page, no children yet) — see that
// function's own comment for why a section is scoped to that shape.
router.post("/:name/new-section", async (req, res) => {
  const { title, slug } = req.body || {};
  if (!title || !slug) {
    return res.status(400).json({ error: "Missing title or slug." });
  }

  try {
    const token = tokenForRequest(req);
    const result = await createNewSection(token, req.params.name, title, slug);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// Images live in one shared assets/ folder per locale (see
// workspaceStore.ts's own comment on why, vs. docEditor's per-page
// img/ convention) — these three routes list/upload/serve within it.

router.get("/:name/images", async (req, res) => {
  try {
    res.json({ images: await listWorkspaceImages(req.params.name) });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/:name/images", upload.single("file"), async (req, res) => {
  const filename = (req.body?.filename as string) || req.file?.originalname;
  if (!req.file || !filename) {
    return res.status(400).json({ error: "Missing file or filename." });
  }

  try {
    const result = await uploadImage(req.params.name, filename, req.file.buffer);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// Serves a workspace's locally-uploaded image back — needed so the live
// preview (preview/renderMarkdown.tsx) can show an image that was just
// uploaded this session and doesn't exist upstream on GitHub yet at all;
// without this, a freshly-inserted image would show as broken until
// it's actually committed (which isn't built yet — see gitRoutes.ts).
router.get("/:name/images/:filename", async (req, res) => {
  try {
    const filePath = await workspaceImageFilePath(req.params.name, req.params.filename);
    if (!(await fs.pathExists(filePath))) {
      return res.status(404).json({ error: "Image not found in this workspace." });
    }
    res.sendFile(path.resolve(filePath));
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
