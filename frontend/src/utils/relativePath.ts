/* frontend/src/utils/relativePath.ts
 *
 * Description of responsibility:
 *   Computes the relative markdown reference from a page's own
 *   directory to the shared assets/ folder an uploaded image lands in
 *   (see backend/workspaceStore.ts's own comment on why that's one
 *   shared folder per locale, not a per-page img/ folder) — e.g. a page
 *   at "model-setup/glasses.md" referencing "assets/foo.png" needs
 *   "../assets/foo.png"; a page at the docs root needs "assets/foo.png"
 *   with no "../" at all.
 */
export function relativeAssetPath(mdPath: string, assetRelPath: string): string {
  const mdDir = mdPath.includes("/") ? mdPath.slice(0, mdPath.lastIndexOf("/")) : "";
  if (!mdDir) return assetRelPath;

  const depth = mdDir.split("/").length;
  return "../".repeat(depth) + assetRelPath;
}
