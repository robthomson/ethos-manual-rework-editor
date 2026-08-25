/* frontend/src/preview/linkResolver.ts
 *
 * Description of responsibility:
 *   Classifies a markdown-authored link href as either an internal
 *   cross-reference to another page in this same docs repo (should
 *   navigate within the app, not leave it) or a genuine external link
 *   (should open in the system browser — see renderMarkdown.tsx's
 *   rehypeExternalLinks and WysiwygEditor.tsx's linkAttr, which already
 *   mark every rendered link that way). Shared between MarkdownPreview
 *   (renderMarkdown.tsx) and Rich mode's own click handling
 *   (EditablePageView.tsx) so both implement this exactly once, the
 *   same pattern imageResolver.ts already established for images.
 *
 * Info:
 *   A page's mdPath doesn't need imageResolver.ts's upstream-existence
 *   check (does this exact file exist for this locale, or should it
 *   fall back to English?) — translations mirror English's page
 *   structure 1:1, and EditablePageView.tsx already handles "this page
 *   isn't translated yet" by pre-filling from English when it loads.
 *   Resolving to the bare mdPath and letting the normal page-load path
 *   take it from there is sufficient; no repo-tree fetch needed.
 *
 *   Deliberately narrow: only a relative reference ending in `.md`
 *   resolves as an internal page link. A relative reference to
 *   something else (a PDF, a firmware file — rare, no confirmed real
 *   usage) falls through to "external" same as before this file
 *   existed — still not a real fix for that case (a relative href
 *   opened externally resolves against this app's own localhost origin
 *   and fails), but a pre-existing gap this change doesn't attempt to
 *   close, not a new regression.
 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export type LinkClassification =
  | { kind: "internal"; mdPath: string }
  | { kind: "external" }
  | { kind: "same-page-anchor" };

// currentMdPath: the page the link was authored on (e.g.
// "system-setup/alerts.md") — relative hrefs resolve against its own
// directory, exactly like imageResolver.ts's mdDir computation.
export function classifyMarkdownLink(rawHref: string, currentMdPath: string): LinkClassification {
  if (!rawHref) return { kind: "external" };
  if (rawHref.startsWith("#")) return { kind: "same-page-anchor" };
  if (HAS_SCHEME_RE.test(rawHref) || rawHref.startsWith("//")) return { kind: "external" };

  const mdDir = currentMdPath.includes("/") ? currentMdPath.slice(0, currentMdPath.lastIndexOf("/")) : "";

  try {
    // Same throwaway-origin URL-constructor trick imageResolver.ts uses
    // — handles "./", "../", and bare-relative forms uniformly, the way
    // a browser actually resolves them.
    const resolved = new URL(rawHref, `https://x/${mdDir}/`);
    const path = resolved.pathname.replace(/^\//, "");
    if (!path.endsWith(".md")) return { kind: "external" };
    return { kind: "internal", mdPath: path };
  } catch {
    return { kind: "external" };
  }
}
