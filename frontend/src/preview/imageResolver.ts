/* frontend/src/preview/imageResolver.ts
 *
 * Description of responsibility:
 *   Shared image-src resolution logic, used by both the rendered
 *   preview (renderMarkdown.tsx's rehype step) and Rich mode
 *   (wysiwyg/WysiwygEditor.tsx's image node override) — factored out
 *   from renderMarkdown.tsx specifically so both places implement this
 *   exactly once, rather than two independently-maintained copies of
 *   the same fallback/local-upload logic drifting apart over time.
 *
 * Info:
 *   Resolves a relative markdown image reference (e.g.
 *   `../assets/foo.png`) to one of three real URLs, in priority order:
 *   1. A locally-uploaded-this-session image (AddImageModal.tsx) —
 *      doesn't exist upstream on GitHub at all yet, served from this
 *      app's own backend instead.
 *   2. The real raw.githubusercontent.com URL for this locale, if that
 *      exact file exists upstream.
 *   3. The English fallback at the same relative path, replicating
 *      mkdocs.yml's actual `i18n: fallback_to_default: true` behavior —
 *      screenshots are rarely re-shot per locale, so a translated page
 *      overwhelmingly references images that only exist under
 *      docs/en/.
 *
 *   fetchImageResolutionContext() is the async half (repo-tree +
 *   workspace-image-list fetches) — callers await this once, then pass
 *   the result into resolveImageSrc() synchronously for every image
 *   reference on the page. This split matters for Rich mode
 *   specifically: ProseMirror's toDOM must return synchronously, so the
 *   fetch has to fully resolve *before* the editor (and its image nodes)
 *   are ever created — see WysiwygEditor.tsx's own comment.
 */
import { fetchRepoTree } from "./repoTree";

// Matches backend/config/github.ts's own defaults — not currently
// shared between front/backend (this app has no shared-types package
// yet), so this needs to stay in sync by hand if that ever changes.
const GITHUB_OWNER = "robthomson";
const GITHUB_REPO = "ethos-manual-rework";

export interface ImageResolutionContext {
  branch: string;
  locale: string;
  mdPath: string; // resolves this page's own relative image references
  existingPaths: Set<string>; // real repo tree — empty for locale "en" (nothing to fall back from)
  workspace: string | null;
  workspaceImages: Set<string>; // filenames uploaded this session, not yet committed anywhere
}

export async function fetchImageResolutionContext(
  branch: string,
  locale: string,
  mdPath: string,
  workspace: string | null,
): Promise<ImageResolutionContext> {
  const [existingPaths, workspaceImages] = await Promise.all([
    // English has nothing to fall back to (it IS the default), so skip
    // the tree fetch entirely — matches navRoutes.ts's own "toc"
    // endpoint doing the same for the identical reason.
    locale === "en" ? Promise.resolve(new Set<string>()) : fetchRepoTree(branch),
    workspace
      ? fetch(`/api/workspace/${encodeURIComponent(workspace)}/images`)
          .then((res) => res.json())
          .then((data: { images?: string[] }) => new Set(data.images || []))
          .catch(() => new Set<string>())
      : Promise.resolve(new Set<string>()),
  ]);

  return { branch, locale, mdPath, existingPaths, workspace, workspaceImages };
}

// Pure path algebra (no network) — resolves a relative reference against
// a repo-relative directory via the URL constructor against a throwaway
// origin, so "./", "../", and bare-relative forms are all handled the
// same uniform way a browser resolves them.
function resolveRepoRelativePath(baseDir: string, ref: string): string {
  const resolved = new URL(ref, `https://x/${baseDir}/`);
  return resolved.pathname.replace(/^\//, "");
}

// Returns null for anything that isn't a genuinely relative reference
// (absolute http(s)/data: URLs pass through untouched) or that fails to
// resolve (a malformed relative path) — callers should fall back to the
// original src unchanged in that case, not throw and blank the whole
// page over one bad image reference.
export function resolveImageSrc(rawSrc: string, ctx: ImageResolutionContext): string | null {
  if (/^(https?:)?\/\//.test(rawSrc) || rawSrc.startsWith("data:")) return null;

  const mdDir = ctx.mdPath.includes("/") ? ctx.mdPath.slice(0, ctx.mdPath.lastIndexOf("/")) : "";
  const localeBaseDir = `docs/${ctx.locale}/${mdDir}`;

  try {
    const localePath = resolveRepoRelativePath(localeBaseDir, rawSrc);
    const filename = localePath.split("/").pop() ?? "";

    if (ctx.workspace && ctx.workspaceImages.has(filename)) {
      return `/api/workspace/${encodeURIComponent(ctx.workspace)}/images/${encodeURIComponent(filename)}`;
    }

    // existingPaths is only ever empty for locale === "en" itself (no
    // fallback needed, or possible) or when the tree fetch failed;
    // either way, "assume it exists" is the safer default — a real 404
    // still just shows as a broken image, whereas wrongly falling back
    // would point English's screenshot at a translated page that
    // actually has its own.
    const finalPath =
      ctx.existingPaths.size === 0 || ctx.existingPaths.has(localePath)
        ? localePath
        : localePath.replace(`docs/${ctx.locale}/`, "docs/en/");

    return `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${ctx.branch}/${finalPath}`;
  } catch {
    return null;
  }
}
