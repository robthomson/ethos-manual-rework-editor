/* backend/workspaceStore.ts
 *
 * Description of responsibility:
 *   Local, on-disk workspaces — one per translation "session" (a
 *   locale + a name), scoped to a single desktop install rather than a
 *   GitHub login. Unlike docEditor's own workspace routes (which key
 *   everything off req.session.login, since that backend can in
 *   principle serve several signed-in users), this app is single-user
 *   per install — the OS's own per-user app-data directory (see
 *   electron/main.ts's userData redirect) already scopes "whose data is
 *   this", so gating local file operations behind a GitHub sign-in on
 *   top of that would only block editing on an OAuth round-trip that
 *   has nothing to do with local storage. Sign-in only becomes
 *   necessary at actual submit time (committing to the user's own fork,
 *   opening the PR — see gitRoutes.ts, once ported), which is exactly
 *   where this app already needs a real GitHub identity anyway.
 *
 * Info:
 *   Pages are materialized lazily, not by cloning a whole locale tree
 *   up front: the first time a workspace page is opened,
 *   ensurePageMaterialized() fetches it from GitHub once and writes it
 *   to two places — .baseline/ (an untouched snapshot of the starting
 *   point: the real upstream translation's body if one existed, or the
 *   English source if not — see below) and the plain working copy
 *   (pre-filled with the English source when no translation existed
 *   yet, matching the "missing translation starts from English" editor
 *   behavior). Every later open/save is pure local disk I/O, no GitHub
 *   call.
 *
 *   scanChanges() diffs working-copy content against .baseline/ and
 *   only reports a page at all once its content actually differs from
 *   that starting point — merely *opening* a not-yet-translated page
 *   (still byte-identical to its own English-fallback baseline) must
 *   not show up as a pending change, or every page a translator so much
 *   as glanced at would clutter the changes list with junk "translate
 *   this into a verbatim copy of English" entries nobody asked for.
 *   Whether a real translation existed before this session (the
 *   "added" vs. "modified" distinction commitChanges(), once ported,
 *   needs to build one commit's tree correctly) is tracked separately,
 *   by whether a frontmatter sidecar exists (see below) — not by
 *   .baseline/, which now always exists once a page is opened at all.
 *
 *   Frontmatter (translated_from: etc.) is deliberately never part of
 *   what the editor reads/writes here — split off into a per-page
 *   sidecar JSON file at materialize time (written only when a real
 *   upstream translation existed) and re-attached (with translated_from
 *   bumped to the current English commit) only at actual submit time.
 *   Translators shouldn't have to look at or accidentally mangle it;
 *   see frontmatter.ts's own header comment.
 *
 *   createNewPage() is the one exception to "translation only": adding a
 *   genuinely new page (not a translation of an existing one) is
 *   restricted to English-locale workspaces, on purpose — every other
 *   locale only ever translates pages the nav already lists, never
 *   invents its own. It writes the new page's own file (untracked
 *   baseline, so it shows as "added") AND a local working copy of
 *   mkdocs.yml with the new nav entry inserted, tracked the same way a
 *   page is — see that function's own comment for the YAML round-trip
 *   fidelity trade-off this makes.
 */
import fs from "fs-extra";
import path from "path";
import yaml from "js-yaml";
import { isSafePathSegment, isSafeRelativePath } from "./safePath";
import { fetchPageSource, tryFetchPageSource, fetchRawMkdocsYaml, docsPath, RepoError } from "./mkdocsConfig";
import { splitFrontmatter } from "./frontmatter";
import type { GitHubToken } from "./githubClient";

export class WorkspaceError extends Error {}

const WORKSPACES_ROOT = () => path.join(process.cwd(), "workspaces");

export interface WorkspaceMeta {
  name: string;
  locale: string;
  branch: string;
  createdAt: string;
}

function metaPath(name: string): string {
  return path.join(WORKSPACES_ROOT(), name, "workspace.json");
}

function workspaceRoot(name: string): string {
  if (!isSafePathSegment(name)) throw new WorkspaceError(`Invalid workspace name "${name}".`);
  return path.join(WORKSPACES_ROOT(), name);
}

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
  const root = WORKSPACES_ROOT();
  await fs.ensureDir(root);
  const entries = await fs.readdir(root, { withFileTypes: true });

  const workspaces: WorkspaceMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      workspaces.push(await readMeta(entry.name));
    } catch {
      // A directory with no valid workspace.json isn't one of ours —
      // skip it rather than failing the whole listing over it.
    }
  }
  return workspaces;
}

export async function readMeta(name: string): Promise<WorkspaceMeta> {
  const file = metaPath(name);
  if (!(await fs.pathExists(file))) {
    throw new WorkspaceError(`Workspace "${name}" doesn't exist.`);
  }
  return fs.readJson(file);
}

export async function createWorkspace(
  name: string,
  locale: string,
  branch: string,
): Promise<WorkspaceMeta> {
  if (!isSafePathSegment(name)) {
    throw new WorkspaceError("Workspace name can't be empty or contain path separators.");
  }
  const root = workspaceRoot(name);
  if (await fs.pathExists(metaPath(name))) {
    throw new WorkspaceError(`A workspace named "${name}" already exists.`);
  }

  const meta: WorkspaceMeta = { name, locale, branch, createdAt: new Date().toISOString() };
  await fs.ensureDir(root);
  await fs.writeJson(metaPath(name), meta, { spaces: 2 });
  return meta;
}

export async function deleteWorkspace(name: string): Promise<void> {
  await fs.remove(workspaceRoot(name));
}

function workingCopyPath(root: string, locale: string, mdPath: string): string {
  return path.join(root, docsPath(locale, mdPath));
}

// Always written once a page is opened at all (unlike the old "mirror"
// concept this replaced) — purely a diff baseline, not a signal of
// whether a real upstream translation existed. That signal now lives
// solely in frontmatterSidecarPath()'s existence, below.
function baselinePath(root: string, locale: string, mdPath: string): string {
  return path.join(root, ".baseline", docsPath(locale, mdPath));
}

// Written only when a real upstream translation existed at materialize
// time — its mere existence (regardless of contents) is what
// distinguishes "added" from "modified" in scanChanges() below.
function frontmatterSidecarPath(root: string, locale: string, mdPath: string): string {
  return path.join(root, ".frontmatter", locale, `${mdPath}.json`);
}

export interface WorkspacePage {
  content: string;
  isNew: boolean; // no upstream translation existed — pre-filled with English
}

// Idempotent: only actually hits GitHub the first time a given page is
// opened in this workspace; every call after that just reads local disk.
export async function ensurePageMaterialized(
  token: GitHubToken | null,
  name: string,
  mdPath: string,
): Promise<WorkspacePage> {
  if (!isSafeRelativePath(mdPath)) throw new WorkspaceError(`Invalid page path "${mdPath}".`);

  const meta = await readMeta(name);
  const root = workspaceRoot(name);
  const workingPath = workingCopyPath(root, meta.locale, mdPath);

  if (await fs.pathExists(workingPath)) {
    const content = await fs.readFile(workingPath, "utf8");
    const isNew = !(await fs.pathExists(frontmatterSidecarPath(root, meta.locale, mdPath)));
    return { content, isNew };
  }

  try {
    const rawTranslation = await tryFetchPageSource(token, meta.branch, meta.locale, mdPath);

    if (rawTranslation === null) {
      // No upstream translation — starting point is the English source.
      // No frontmatter sidecar is written (there was never any
      // translated_from: to preserve), which is exactly what marks this
      // as "added" rather than "modified" once it's actually edited.
      const english = await fetchPageSource(token, meta.branch, "en", mdPath);
      const baseline = baselinePath(root, meta.locale, mdPath);
      await fs.ensureDir(path.dirname(baseline));
      await fs.writeFile(baseline, english, "utf8");
      await fs.ensureDir(path.dirname(workingPath));
      await fs.writeFile(workingPath, english, "utf8");
      return { content: english, isNew: true };
    }

    const { frontmatter, body } = splitFrontmatter(rawTranslation);

    const sidecarPath = frontmatterSidecarPath(root, meta.locale, mdPath);
    await fs.ensureDir(path.dirname(sidecarPath));
    await fs.writeJson(sidecarPath, frontmatter, { spaces: 2 });

    const baseline = baselinePath(root, meta.locale, mdPath);
    await fs.ensureDir(path.dirname(baseline));
    await fs.writeFile(baseline, body, "utf8");

    await fs.ensureDir(path.dirname(workingPath));
    await fs.writeFile(workingPath, body, "utf8");

    return { content: body, isNew: false };
  } catch (err) {
    if (err instanceof RepoError) throw new WorkspaceError(err.message);
    throw err;
  }
}

export async function savePage(name: string, mdPath: string, content: string): Promise<void> {
  if (!isSafeRelativePath(mdPath)) throw new WorkspaceError(`Invalid page path "${mdPath}".`);
  const meta = await readMeta(name);
  const root = workspaceRoot(name);
  const workingPath = workingCopyPath(root, meta.locale, mdPath);
  await fs.ensureDir(path.dirname(workingPath));
  await fs.writeFile(workingPath, content, "utf8");
}

// mkdocs.yml itself — only ever touched by createNewPage() below, and
// only ever within an English workspace (new pages are English-only;
// every other locale only ever translates pages the nav already lists).
// Same working-copy/.baseline shape as a regular page, just rooted at
// the workspace itself rather than under docs/<locale>/.
function mkdocsWorkingPath(root: string): string {
  return path.join(root, "mkdocs.yml");
}

function mkdocsBaselinePath(root: string): string {
  return path.join(root, ".baseline", "mkdocs.yml");
}

// Finds a top-level nav section by its label and returns its own
// landing-page path (nav's own "first bare-string child is the
// section's landing page" convention — see mkdocsConfig.ts:buildToc()'s
// identical logic) — needed to derive what folder a new page under that
// section belongs in. Returns null if no such section exists, or it has
// no landing page of its own to derive a folder from.
function findSectionLandingPath(nav: any[], sectionTitle: string): string | null {
  for (const entry of nav) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const [label, value] of Object.entries(entry)) {
        if (label === sectionTitle && Array.isArray(value) && typeof value[0] === "string") {
          return value[0];
        }
      }
    }
  }
  return null;
}

// Same lookup, but returns the actual children array (mutated in place
// by createNewPage() to append the new page entry) rather than just the
// landing path.
function findSectionChildren(nav: any[], sectionTitle: string): any[] | null {
  for (const entry of nav) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const [label, value] of Object.entries(entry)) {
        if (label === sectionTitle && Array.isArray(value)) {
          return value;
        }
      }
    }
  }
  return null;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp)$/i;

// ethos-manual-rework's real convention (confirmed against live pages —
// `![Glasses](../assets/model-glasses.png)` resolves to
// docs/en/assets/model-glasses.png): one shared assets/ folder per
// locale, not a per-page img/ folder next to each doc the way
// docEditor's own AddImageModal.tsx assumes. Every upload lands here.
function assetsDir(root: string, locale: string): string {
  return path.join(root, "docs", locale, "assets");
}

export async function listWorkspaceImages(name: string): Promise<string[]> {
  const meta = await readMeta(name);
  const dir = assetsDir(workspaceRoot(name), meta.locale);
  if (!(await fs.pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  return entries.filter((n) => IMAGE_EXTENSIONS.test(n));
}

// For workspaceRoutes.ts's serve-image route — keeps the docs/<locale>/
// assets/ path convention defined in exactly one place.
export async function workspaceImageFilePath(name: string, filename: string): Promise<string> {
  if (!isSafePathSegment(filename)) throw new WorkspaceError(`Invalid image filename "${filename}".`);
  const meta = await readMeta(name);
  return path.join(assetsDir(workspaceRoot(name), meta.locale), filename);
}

export interface UploadedImage {
  filename: string;
  relPath: string; // relative to docs/<locale>/ — "assets/<filename>"
}

// Deliberately does not diff against a baseline the way page edits do
// (see scanChanges() below) — this app never lazily materializes an
// existing upstream image the way it does a page, so any image file
// present in a workspace only ever got there via this function, in
// this session. That means a re-upload replacing an existing upstream
// screenshot under the same filename shows as "added" rather than the
// more precise "modified" — a known, deliberate scope cut (the
// alternative needs fetching and diffing the original binary from
// GitHub first); the practical effect on what gets committed is the
// same either way.
export async function uploadImage(
  name: string,
  filename: string,
  data: Buffer,
): Promise<UploadedImage> {
  if (!isSafePathSegment(filename)) {
    throw new WorkspaceError(`Invalid image filename "${filename}".`);
  }
  if (!IMAGE_EXTENSIONS.test(filename)) {
    throw new WorkspaceError("Only .png, .jpg, .jpeg, .gif, .svg, or .webp images are supported.");
  }

  const meta = await readMeta(name);
  const dir = assetsDir(workspaceRoot(name), meta.locale);
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(dir, filename), data);

  return { filename, relPath: `assets/${filename}` };
}

export interface NewPageResult {
  mdPath: string;
}

// English-only (enforced here, not just at the route layer, so this
// can never be reached any other way even if a future caller forgets
// the check) — writes the new page's own file AND inserts its nav
// entry into a local working copy of mkdocs.yml, both tracked by
// scanChanges() below ready for a future commit/PR. Re-dumping the
// whole parsed YAML config (rather than a targeted text insertion)
// means the committed mkdocs.yml will come out fully reformatted —
// correct content, but a much noisier diff than "one line added". A
// known, deliberate scope cut for now; revisit with a line-based
// insertion if that turns out to matter in practice.
export async function createNewPage(
  token: GitHubToken | null,
  name: string,
  title: string,
  slug: string,
  sectionTitle: string,
): Promise<NewPageResult> {
  const meta = await readMeta(name);
  if (meta.locale !== "en") {
    throw new WorkspaceError(
      "New pages can only be authored in English — every other locale only ever translates pages that already exist in English.",
    );
  }
  if (!title.trim()) {
    throw new WorkspaceError("Enter a title for the new page.");
  }
  if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new WorkspaceError("Slug must be lowercase letters, numbers, and hyphens only.");
  }

  const root = workspaceRoot(name);
  const mkdocsWorking = mkdocsWorkingPath(root);
  const mkdocsBaseline = mkdocsBaselinePath(root);

  let rawYaml: string;
  if (await fs.pathExists(mkdocsWorking)) {
    rawYaml = await fs.readFile(mkdocsWorking, "utf8");
  } else {
    try {
      rawYaml = await fetchRawMkdocsYaml(token, meta.branch);
    } catch (err) {
      if (err instanceof RepoError) throw new WorkspaceError(err.message);
      throw err;
    }
    await fs.ensureDir(path.dirname(mkdocsBaseline));
    await fs.writeFile(mkdocsBaseline, rawYaml, "utf8");
  }

  const config = (yaml.load(rawYaml) as Record<string, any>) || {};
  const nav: any[] = Array.isArray(config.nav) ? config.nav : [];

  const landingPath = findSectionLandingPath(nav, sectionTitle);
  if (landingPath === null) {
    throw new WorkspaceError(`Couldn't find a section named "${sectionTitle}" with its own landing page.`);
  }
  const folder = landingPath.includes("/") ? landingPath.slice(0, landingPath.lastIndexOf("/")) : "";
  const mdPath = folder ? `${folder}/${slug}.md` : `${slug}.md`;

  const children = findSectionChildren(nav, sectionTitle);
  if (!children) {
    // Can't actually happen (findSectionLandingPath already confirmed
    // this section exists with a list value) — narrows the type for
    // the push() below rather than asserting past a real code path.
    throw new WorkspaceError(`Couldn't find section "${sectionTitle}" to add the new page to.`);
  }

  const alreadyExists = children.some(
    (c) => c && typeof c === "object" && !Array.isArray(c) && Object.values(c).includes(mdPath),
  );
  if (alreadyExists) {
    throw new WorkspaceError(`A page at "${mdPath}" already exists in "${sectionTitle}".`);
  }

  children.push({ [title]: mdPath });
  config.nav = nav;

  const newYaml = yaml.dump(config, { flowLevel: -1, sortKeys: false, lineWidth: -1 });
  await fs.ensureDir(path.dirname(mkdocsWorking));
  await fs.writeFile(mkdocsWorking, newYaml, "utf8");

  const workingPagePath = workingCopyPath(root, "en", mdPath);
  await fs.ensureDir(path.dirname(workingPagePath));
  await fs.writeFile(workingPagePath, `# ${title}\n\n`, "utf8");
  // Deliberately no .baseline/ or frontmatter sidecar written for the
  // new page itself — scanChanges()'s existing "no baseline at all"
  // branch already reports that as "added", which is exactly right: this
  // page never existed upstream at all, unlike an edited translation.

  return { mdPath };
}

export interface ChangeEntry {
  path: string; // page path relative to the locale (matches nav mdPath)
  type: "added" | "modified";
}

// Walks the working-copy docs/<locale> tree (only ever populated by
// ensurePageMaterialized/savePage above — nothing else writes there),
// compares each file against its .baseline/ counterpart, and reports it
// only if that content actually differs — a page that was merely opened
// and never edited is not a pending change, regardless of whether a
// real upstream translation existed for it.
export async function scanChanges(name: string): Promise<ChangeEntry[]> {
  const meta = await readMeta(name);
  const root = workspaceRoot(name);
  const docsRoot = path.join(root, docsPath(meta.locale, ""));

  if (!(await fs.pathExists(docsRoot))) return [];

  const changes: ChangeEntry[] = [];

  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, relPath);
        continue;
      }
      if (IMAGE_EXTENSIONS.test(entry.name)) {
        // No baseline concept for images (see uploadImage()'s own
        // comment) — every image present only ever got there via a
        // real upload in this session, so it's unconditionally a
        // pending change.
        changes.push({ path: relPath, type: "added" });
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;

      const baseline = baselinePath(root, meta.locale, relPath);

      // Every file under docs/<locale> was put there by
      // ensurePageMaterialized/savePage, both of which always also write
      // .baseline/ — a missing baseline here would mean something wrote
      // into the workspace outside that path. Treat it as a change
      // (safest default: don't silently drop a real edit) rather than
      // throwing and breaking the whole scan over one odd file.
      if (!(await fs.pathExists(baseline))) {
        changes.push({ path: relPath, type: "added" });
        continue;
      }

      const [working, baselineContent] = await Promise.all([
        fs.readFile(full, "utf8"),
        fs.readFile(baseline, "utf8"),
      ]);
      if (working === baselineContent) continue; // opened, never actually edited

      const hadUpstreamTranslation = await fs.pathExists(
        frontmatterSidecarPath(root, meta.locale, relPath),
      );
      changes.push({ path: relPath, type: hadUpstreamTranslation ? "modified" : "added" });
    }
  }

  await walk(docsRoot, "");

  // mkdocs.yml — only ever touched by createNewPage() above. Unlike a
  // page there's no "added" case for it (it always exists upstream
  // already); "modified" is the only possible outcome once it's been
  // locally edited at all, so a missing .baseline/ here (which
  // shouldn't happen — createNewPage() always writes one before ever
  // touching the working copy) is treated the same way, rather than
  // silently skipping a real change over an unexpected missing file.
  const mkdocsWorking = mkdocsWorkingPath(root);
  if (await fs.pathExists(mkdocsWorking)) {
    const mkdocsBaseline = mkdocsBaselinePath(root);
    const working = await fs.readFile(mkdocsWorking, "utf8");
    const baselineContent = (await fs.pathExists(mkdocsBaseline))
      ? await fs.readFile(mkdocsBaseline, "utf8")
      : null;
    if (baselineContent === null || working !== baselineContent) {
      changes.push({ path: "mkdocs.yml", type: "modified" });
    }
  }

  return changes;
}
