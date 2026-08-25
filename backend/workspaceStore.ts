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
 *   docs/en/SUMMARY.md with one new line inserted, tracked the same way a
 *   page is — see that function's own comment.
 */
import fs from "fs-extra";
import path from "path";
import { isSafePathSegment, isSafeRelativePath } from "./safePath";
import {
  fetchPageSource,
  tryFetchPageSource,
  fetchSummaryMarkdown,
  docsPath,
  latestCommitSha,
  RepoError,
} from "./mkdocsConfig";
import { splitFrontmatter, joinFrontmatter } from "./frontmatter";
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

// Nav lives at docs/en/SUMMARY.md now (the mkdocs-literate-nav plugin's
// own nav source on the real repo, replacing mkdocs.yml's old YAML nav:
// block) — only ever touched by createNewPage()/createNewSection() below,
// and only ever within an English workspace (new pages/sections are
// English-only; every other locale only ever translates pages the nav
// already lists). Reuses the exact same working-copy/.baseline path
// helpers a real page gets (workingCopyPath()/baselinePath() above),
// since it genuinely is one: a real file at a real docs/<locale>/ path.
function summaryWorkingPath(root: string): string {
  return workingCopyPath(root, "en", "SUMMARY.md");
}

function summaryBaselinePath(root: string): string {
  return baselinePath(root, "en", "SUMMARY.md");
}

// One line of docs/en/SUMMARY.md: "<indent>* [title](path)". Mirrors
// mkdocsConfig.ts:buildToc()'s identical regex and ethos-manual-rework's
// own scripts/_nav.py (_BULLET_RE) — three independent parsers of the
// same file format (two languages, two repos, can't share one real
// implementation), kept in sync by comment cross-reference.
const SUMMARY_BULLET_RE = /^(\s*)[*-]\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;

// Finds a top-level section by title — its own link doubles as both its
// title and its landing page (see mkdocsConfig.ts:buildToc()'s identical
// convention) — and the line-index range of its indented children, which
// createNewPage() below needs both to derive what folder a new page
// belongs in and to know exactly where to splice a new line. Returns
// null if no such section exists.
function findSummarySection(
  lines: string[],
  sectionTitle: string,
): { sectionIndex: number; landingPath: string; childrenEnd: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = SUMMARY_BULLET_RE.exec(lines[i]);
    if (!m || m[1].length !== 0 || m[2] !== sectionTitle) continue;
    let end = i + 1;
    // Advance past this section's own indented children (and any blank/
    // comment lines among them) until the next top-level bullet or EOF.
    while (end < lines.length) {
      const next = SUMMARY_BULLET_RE.exec(lines[end]);
      if (next && next[1].length === 0) break;
      end++;
    }
    return { sectionIndex: i, landingPath: m[3], childrenEnd: end };
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

// Shared by createNewPage() and createNewSection() below — both need to
// read docs/en/SUMMARY.md's current *working* state (a prior new-page/
// new-section call this session, if any) or else fetch+baseline it fresh
// from GitHub exactly once, split into lines ready to splice.
async function loadWorkingSummaryLines(
  token: GitHubToken | null,
  root: string,
  branch: string,
): Promise<string[]> {
  const working = summaryWorkingPath(root);
  const baseline = summaryBaselinePath(root);

  let text: string;
  if (await fs.pathExists(working)) {
    text = await fs.readFile(working, "utf8");
  } else {
    try {
      text = await fetchSummaryMarkdown(token, branch);
    } catch (err) {
      if (err instanceof RepoError) throw new WorkspaceError(err.message);
      throw err;
    }
    await fs.ensureDir(path.dirname(baseline));
    await fs.writeFile(baseline, text, "utf8");
  }

  return text.split("\n");
}

// Writes the (possibly spliced) lines back — a genuine line-level change,
// not a full parse/re-dump, so the real diff a translator sees
// (ReviewChangesModal.tsx) is just the one line added or removed, not the
// whole file reformatted. This was the actual reason nav moved to
// SUMMARY.md in the first place — the old mkdocs.yml YAML round-trip this
// replaced always re-dumped the entire config for one nav entry (see this
// file's own git history) — worth preserving deliberately, not an
// incidental win to lose again with a parse-tree-then-rerender approach.
async function saveWorkingSummaryLines(root: string, lines: string[]): Promise<void> {
  const working = summaryWorkingPath(root);
  await fs.ensureDir(path.dirname(working));
  await fs.writeFile(working, lines.join("\n"), "utf8");
}

// English-only (enforced here, not just at the route layer, so this
// can never be reached any other way even if a future caller forgets
// the check) — writes the new page's own file AND inserts one new line
// into a local working copy of docs/en/SUMMARY.md, both tracked by
// scanChanges() below ready for a future commit/PR.
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
  const lines = await loadWorkingSummaryLines(token, root, meta.branch);

  const section = findSummarySection(lines, sectionTitle);
  if (!section) {
    throw new WorkspaceError(`Couldn't find a section named "${sectionTitle}" with its own landing page.`);
  }
  const folder = section.landingPath.includes("/")
    ? section.landingPath.slice(0, section.landingPath.lastIndexOf("/"))
    : "";
  const mdPath = folder ? `${folder}/${slug}.md` : `${slug}.md`;

  const alreadyExists = lines
    .slice(section.sectionIndex, section.childrenEnd)
    .some((line) => line.includes(`(${mdPath})`));
  if (alreadyExists) {
    throw new WorkspaceError(`A page at "${mdPath}" already exists in "${sectionTitle}".`);
  }

  lines.splice(section.childrenEnd, 0, `    * [${title}](${mdPath})`);
  await saveWorkingSummaryLines(root, lines);

  const workingPagePath = workingCopyPath(root, "en", mdPath);
  await fs.ensureDir(path.dirname(workingPagePath));
  await fs.writeFile(workingPagePath, `# ${title}\n\n`, "utf8");
  // Deliberately no .baseline/ or frontmatter sidecar written for the
  // new page itself — scanChanges()'s existing "no baseline at all"
  // branch already reports that as "added", which is exactly right: this
  // page never existed upstream at all, unlike an edited translation.

  return { mdPath };
}

export interface NewSectionResult {
  mdPath: string; // the new section's own landing page, e.g. "wiring/index.md"
}

// A "section" here means a new top-level nav category with its own
// landing page — confirmed against the real docs/en/SUMMARY.md (every
// existing top-level bullet is exactly this shape: a title+link, then
// indented child bullets; there's no deeper nesting in practice). Same
// English-only restriction and working-copy-of-SUMMARY.md mechanics as
// createNewPage() above (see that function's own comments) — a section
// is just a page-less nav entry until its own landing page is written.
export async function createNewSection(
  token: GitHubToken | null,
  name: string,
  title: string,
  slug: string,
): Promise<NewSectionResult> {
  const meta = await readMeta(name);
  if (meta.locale !== "en") {
    throw new WorkspaceError(
      "New sections can only be authored in English — every other locale only ever translates pages that already exist in English.",
    );
  }
  if (!title.trim()) {
    throw new WorkspaceError("Enter a title for the new section.");
  }
  if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new WorkspaceError("Slug must be lowercase letters, numbers, and hyphens only.");
  }

  const root = workspaceRoot(name);
  const lines = await loadWorkingSummaryLines(token, root, meta.branch);

  const topLevel = lines
    .map((line) => SUMMARY_BULLET_RE.exec(line))
    .filter((m): m is RegExpExecArray => !!m && m[1].length === 0);

  const titleCollision = topLevel.some((m) => m[2] === title);
  if (titleCollision) {
    throw new WorkspaceError(`A section named "${title}" already exists.`);
  }
  // The folder is what actually has to be unique on disk — two
  // differently-titled sections both slugified to "wiring" would
  // otherwise silently collide and overwrite each other's landing page.
  const folderCollision = topLevel.some(
    (m) => m[3] === `${slug}/index.md` || m[3].startsWith(`${slug}/`),
  );
  if (folderCollision) {
    throw new WorkspaceError(`A section already uses the "${slug}/" folder — pick a different slug.`);
  }

  const mdPath = `${slug}/index.md`;
  // Appended at end-of-file, matching the old YAML nav's own
  // nav.push(...) behavior — a new section always lands last.
  lines.push(`* [${title}](${mdPath})`);
  await saveWorkingSummaryLines(root, lines);

  const workingPagePath = workingCopyPath(root, "en", mdPath);
  await fs.ensureDir(path.dirname(workingPagePath));
  await fs.writeFile(workingPagePath, `# ${title}\n\n`, "utf8");
  // Same reasoning as createNewPage(): no .baseline/ or frontmatter
  // sidecar for a page that never existed upstream — scanChanges()
  // already reports that correctly as "added".

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

      // SUMMARY.md (only ever written by createNewPage()/createNewSection()
      // above, always in an English workspace) has no frontmatter-sidecar
      // concept at all — it's a nav file, not a translated page — so the
      // usual sidecar-existence check below would always read as "added"
      // even though it always genuinely exists upstream already (it's a
      // required file, never something legitimately new). Short-circuited
      // here rather than folded into the sidecar check itself, which is
      // real per-page translation-provenance logic this file doesn't
      // apply to at all.
      if (relPath === "SUMMARY.md") {
        changes.push({ path: relPath, type: "modified" });
        continue;
      }

      const hadUpstreamTranslation = await fs.pathExists(
        frontmatterSidecarPath(root, meta.locale, relPath),
      );
      changes.push({ path: relPath, type: hadUpstreamTranslation ? "modified" : "added" });
    }
  }

  // SUMMARY.md itself is walked here too, as an ordinary file under
  // docs/en/ — no separate pass needed the way mkdocs.yml (a repo-root
  // file, outside this walk entirely) used to require; see the
  // relPath === "SUMMARY.md" special case above for its one real
  // difference from a translated page (always "modified", never "added").
  await walk(docsRoot, "");

  return changes;
}

export interface ChangeDiff {
  path: string;
  type: "added" | "modified";
  // Images have no baseline/text-diff concept at all (see uploadImage()'s
  // own comment) — the frontend shows these as a plain "image added"
  // entry instead of attempting a text diff.
  isImage: boolean;
  // null baseline means "added" (nothing to diff against — the whole
  // working content is new). Never null for "modified".
  baseline: string | null;
  working: string | null; // null only for an image
}

// The content half of scanChanges() above — same walk, same baseline
// paths, but reading the actual before/after text instead of just
// noting that it differs. Kept separate rather than folded into
// scanChanges() itself: every other caller of scanChanges() (the
// sidebar's own Changes list, discardChange()) only ever needed the
// list, not the content, and reading every changed file's full text on
// every one of those calls would be wasted I/O they don't need.
export async function getChangeDiffs(name: string): Promise<ChangeDiff[]> {
  const changes = await scanChanges(name);
  const meta = await readMeta(name);
  const root = workspaceRoot(name);
  const docsRoot = path.join(root, docsPath(meta.locale, ""));

  const diffs: ChangeDiff[] = [];
  for (const change of changes) {
    if (IMAGE_EXTENSIONS.test(change.path)) {
      diffs.push({ path: change.path, type: change.type, isImage: true, baseline: null, working: null });
      continue;
    }

    // SUMMARY.md included here too, as an ordinary path under docsRoot —
    // no special case needed the way mkdocs.yml (a repo-root file) used
    // to require.
    const working = await fs.readFile(path.join(docsRoot, change.path), "utf8");
    const baselineFile = baselinePath(root, meta.locale, change.path);
    const baseline = (await fs.pathExists(baselineFile)) ? await fs.readFile(baselineFile, "utf8") : null;
    diffs.push({ path: change.path, type: change.type, isImage: false, baseline, working });
  }

  return diffs;
}

// Removes mdPath's own line from the workspace's local docs/en/SUMMARY.md
// — the reverse of createNewPage()/createNewSection()'s own insertion.
// Only ever called for a path that genuinely has no baseline (a page or
// section created this session, never existed upstream at all) — see
// discardChange() below. Handles both shapes a nav entry can be: a plain
// child page line inside some section, or a section's own top-level line
// (in which case the whole section — its own line plus every indented
// line under it — is removed, not just the one line; a section with
// pages already added under it is a known, deliberate scope cut, same
// spirit as this file's other trade-offs — those child pages' own
// working files aren't touched, so discarding the section separately
// from discarding each child it contains can leave their files on disk
// with no nav entry pointing at them any more).
async function removeNavEntry(root: string, mdPath: string): Promise<void> {
  const working = summaryWorkingPath(root);
  if (!(await fs.pathExists(working))) return; // nothing to clean up

  const lines = (await fs.readFile(working, "utf8")).split("\n");

  const sectionIdx = lines.findIndex((line) => {
    const m = SUMMARY_BULLET_RE.exec(line);
    return !!m && m[1].length === 0 && m[3] === mdPath;
  });
  if (sectionIdx !== -1) {
    let end = sectionIdx + 1;
    while (end < lines.length) {
      const next = SUMMARY_BULLET_RE.exec(lines[end]);
      if (next && next[1].length === 0) break;
      end++;
    }
    lines.splice(sectionIdx, end - sectionIdx);
    await saveWorkingSummaryLines(root, lines);
    return;
  }

  const childIdx = lines.findIndex((line) => {
    const m = SUMMARY_BULLET_RE.exec(line);
    return !!m && m[1].length > 0 && m[3] === mdPath;
  });
  if (childIdx !== -1) {
    lines.splice(childIdx, 1);
    await saveWorkingSummaryLines(root, lines);
  }
}

// Undoes one pending change (whatever scanChanges() above would report
// for this exact path) rather than the whole workspace — asked for
// directly: "what if we want to cancel changes to the page?". Three
// distinct cases, keyed off what's actually on disk rather than trusting
// a caller-supplied ChangeEntry.type (which labels an untranslated-
// page's *first* translation "added" too, same as a genuinely new page —
// see scanChanges()'s own comment — but those need completely different
// discard behavior):
//   1. An image (no baseline concept at all — see uploadImage()'s own
//      comment): delete the uploaded file outright.
//   2. A real per-page baseline exists (either a prior real translation,
//      or the English-fallback text a first-time translation started
//      from): overwrite the working copy with it — exactly what
//      scanChanges() itself already treats as "no longer a change".
//   3. No baseline at all: this page/section was created *this session*
//      (createNewPage()/createNewSection() deliberately skip writing
//      one) — undo the creation entirely: delete the file and remove
//      its nav entry.
export interface DiscardResult {
  // true for cases 1 and 3 above (the file itself is gone — an upload,
  // or a page/section that never existed upstream) — false for case 2
  // (the page still exists, just reverted). workspaceRoutes.ts's own
  // caller (frontend App.tsx) uses this to decide whether to keep
  // showing the now-reverted page or fall back to "pick a page", since a
  // discard's own {ok:true} alone can't tell those apart.
  deleted: boolean;
}

export async function discardChange(name: string, mdPath: string): Promise<DiscardResult> {
  if (mdPath === "SUMMARY.md") {
    // Not really a page — it shows up as its own "modified" entry only as
    // a side effect of one or more new page/section creations, each
    // independently discardable via case 3 above. Discarding it directly
    // would revert *every* pending new-page/section's nav entry at once
    // while leaving their own working files behind, orphaned — safer to
    // just not support this as its own target (same reasoning as the old
    // mkdocs.yml special case this replaced).
    throw new WorkspaceError('Discard the new page/section itself, not "SUMMARY.md" directly.');
  }
  if (!isSafeRelativePath(mdPath)) throw new WorkspaceError(`Invalid path "${mdPath}".`);

  const meta = await readMeta(name);
  const root = workspaceRoot(name);

  if (IMAGE_EXTENSIONS.test(mdPath)) {
    await fs.remove(path.join(root, docsPath(meta.locale, mdPath)));
    return { deleted: true };
  }

  const workingPath = workingCopyPath(root, meta.locale, mdPath);
  const baseline = baselinePath(root, meta.locale, mdPath);

  if (await fs.pathExists(baseline)) {
    const original = await fs.readFile(baseline, "utf8");
    await fs.writeFile(workingPath, original, "utf8");
    return { deleted: false };
  }

  await fs.remove(workingPath);
  await removeNavEntry(root, mdPath);
  return { deleted: true };
}

export interface PreparedChange {
  repoPath: string; // repo-root-relative — e.g. "docs/fr/getting-started/main-views.md"
  binary: boolean;
  content?: string; // text files
  buffer?: Buffer; // images
}

// Turns one scanChanges() entry into exactly what gitRoutes.ts needs to
// build a Git tree item — the one place that knows how a workspace's raw
// on-disk file becomes the actual bytes to commit, so gitRoutes.ts itself
// only has to deal with GitHub's API, never this project's own workspace
// layout or frontmatter convention.
//
// Two cases:
//   1. An image — read as a raw Buffer (see gitRoutes.ts's own comment on
//      why a binary file needs a real blob, not inline UTF-8 content).
//   2. A .md page — the working copy never carries frontmatter at all
//      (stripped at materialize time, see this file's header comment).
//      An English page is committed as-is; a translation gets
//      `translated_from:` re-attached, bumped to the English page's
//      *current* commit SHA (not whatever it was when this page was
//      materialized) — matching submit.py's own behavior, and the whole
//      reason hooks/i18n_status.py's staleness check exists at all. Any
//      other frontmatter fields a real prior translation already carried
//      (from its own `.frontmatter/` sidecar) are preserved alongside it.
//      SUMMARY.md (nav) falls into this same case, not a special one —
//      it's a plain English .md file at a real docs/en/ path like any
//      other, just one this app never attaches translated_from: to since
//      meta.locale === "en" is guaranteed whenever changePath is it.
export async function prepareChangeForCommit(
  token: GitHubToken | null,
  name: string,
  changePath: string,
): Promise<PreparedChange> {
  const meta = await readMeta(name);
  const root = workspaceRoot(name);

  if (IMAGE_EXTENSIONS.test(changePath)) {
    const buffer = await fs.readFile(path.join(root, docsPath(meta.locale, changePath)));
    return { repoPath: docsPath(meta.locale, changePath), binary: true, buffer };
  }

  const rawBody = await fs.readFile(workingCopyPath(root, meta.locale, changePath), "utf8");

  if (meta.locale === "en") {
    // English is the source of truth — no translated_from concept applies
    // to it at all.
    return { repoPath: docsPath("en", changePath), binary: false, content: rawBody };
  }

  const sidecarPath = frontmatterSidecarPath(root, meta.locale, changePath);
  const existingFrontmatter = (await fs.pathExists(sidecarPath)) ? await fs.readJson(sidecarPath) : {};

  const englishSha = await latestCommitSha(token, meta.branch, docsPath("en", changePath));
  const content = joinFrontmatter({ ...existingFrontmatter, translated_from: englishSha }, rawBody);

  return { repoPath: docsPath(meta.locale, changePath), binary: false, content };
}
