/* frontend/src/utils/slugify.ts
 *
 * Description of responsibility:
 *   Turns a free-typed page title into a filename-safe slug — must
 *   match backend/workspaceStore.ts:createNewPage()'s own validation
 *   (lowercase letters, digits, hyphens only) or a title that looks
 *   fine here would still get rejected server-side.
 */
export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
