/* frontend/src/preview/renderMarkdown.tsx
 *
 * Description of responsibility:
 *   The actual markdown → React rendering pipeline: parse, GFM tables,
 *   strip attr_list noise, retag pymdownx admonitions/details/tabs
 *   (see pymdownxBlocks.ts), convert to hast, add heading anchors
 *   (mkdocs.yml's `toc: permalink: true`), rewrite relative image
 *   `src`s to real GitHub raw URLs, mark every link to open externally
 *   (see rehypeExternalLinks's own comment for why that's needed at
 *   all), and render straight to React elements (rehype-react) rather
 *   than building an HTML string and dangerously-setting it — keeps the
 *   door open for later interactivity (e.g. click an image to replace
 *   it) without a second DOM-walking pass.
 *
 * Info:
 *   Only the extensions actually listed in ethos-manual-rework's own
 *   mkdocs.yml are implemented (admonition, attr_list,
 *   pymdownx.details, pymdownx.superfences, pymdownx.tabbed, tables,
 *   toc:permalink) — verified directly against the live file, not
 *   guessed. remark-gfm covers tables (plus strikethrough/autolink/
 *   tasklist, which aren't actually enabled upstream — a known, minor
 *   overreach: those render in this preview but wouldn't on the real
 *   site. superfences' advanced features (nested/tabbed code blocks)
 *   aren't attempted — plain fenced code (```lang) already covers the
 *   overwhelming common case and is what remark-parse gives for free.
 *   Not chasing full pymdownx parity, same as preview.py's own stated
 *   goal — correct *behavior*, not a pixel-identical copy of the live
 *   site's theme.
 *
 *   Image src rewriting mirrors preview.py's own resolution, plus one
 *   thing preview.py never had to handle: mkdocs.yml's real i18n plugin
 *   config is `fallback_to_default: true` (docs_structure: folder) —
 *   any file, images included, missing under docs/<locale>/ falls back
 *   to the same relative path under docs/en/ on the real site.
 *   Screenshots are rarely re-shot per locale (translators translate
 *   the surrounding prose, not the UI in the image), so a translated
 *   page overwhelmingly references images that only exist under
 *   docs/en/ — resolving purely against docs/<locale>/ (what an earlier
 *   version of this file did) showed those as broken images. Fixed by
 *   resolving the reference to its repo-relative path first, checking
 *   it against the real repo tree (repoTree.ts — the same data
 *   backend/routes/navRoutes.ts's own translated/missing status already
 *   uses), and substituting the locale segment for "en" only when the
 *   locale-specific file genuinely doesn't exist.
 *
 *   A freshly-uploaded image (AddImageModal.tsx) is a third case on top
 *   of that: it doesn't exist upstream on GitHub *at all* yet (nothing's
 *   been committed — see gitRoutes.ts, not yet built), so neither the
 *   locale path nor the English-fallback path would ever resolve there.
 *   Checked first, before the upstream-tree logic: if the image's
 *   filename is one this workspace uploaded itself, it's served locally
 *   via backend/routes/workspaceRoutes.ts's own image-serving route
 *   instead of a raw.githubusercontent.com URL.
 *
 *   The actual resolution logic lives in imageResolver.ts now, shared
 *   with wysiwyg/WysiwygEditor.tsx's own image node override — Rich
 *   mode originally had no equivalent of this at all (caught live: it
 *   showed every image broken, while Preview mode worked correctly),
 *   and duplicating this fallback/local-upload logic a second time
 *   instead of sharing it would have meant two copies drifting apart.
 */
import { useEffect, useState } from "react";
import * as React from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeReact from "rehype-react";
import * as jsxRuntime from "react/jsx-runtime";
import { visit } from "unist-util-visit";
import { preprocessPymdownxBlocks, remarkPymdownxBlocks } from "./pymdownxBlocks";
import { remarkStripAttrList } from "./attrList";
import { fetchImageResolutionContext, resolveImageSrc, type ImageResolutionContext } from "./imageResolver";

function rehypeRewriteImages(ctx: ImageResolutionContext) {
  return () => (tree: any) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "img" || !node.properties?.src) return;
      const resolved = resolveImageSrc(String(node.properties.src), ctx);
      if (resolved) node.properties.src = resolved;
    });
  };
}

// A plain <a href> with no target, clicked inside this Electron app,
// navigates the *whole app window* to that URL rather than opening a new
// tab the way it would in a real browser — there's no separate handler
// for ordinary top-level navigation, only for target="_blank"/window.open
// (see electron/main.ts's setWindowOpenHandler, already relied on by
// every other external link in the app — PR links, the sign-in
// verification link, the GitHub App install link, all authored with
// target="_blank" for exactly this reason). Markdown-authored links
// (`[text](url)`) had no way to opt into that until now — this routes
// every rendered link through the same, already-proven path instead of
// inventing a new confirmation-dialog pattern that nothing else in the
// app uses.
function rehypeExternalLinks() {
  return () => (tree: any) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "a" || !node.properties?.href) return;
      node.properties.target = "_blank";
      node.properties.rel = ["noopener", "noreferrer"];
    });
  };
}

export interface RenderMarkdownOptions extends ImageResolutionContext {}

export function renderMarkdown(content: string, ctx: RenderMarkdownOptions): React.ReactNode {
  const { text, markers } = preprocessPymdownxBlocks(content);

  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStripAttrList)
    .use(remarkPymdownxBlocks, markers)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeRewriteImages(ctx))
    .use(rehypeExternalLinks())
    .use(rehypeReact, {
      Fragment: jsxRuntime.Fragment,
      jsx: jsxRuntime.jsx,
      jsxs: jsxRuntime.jsxs,
    } as any)
    .processSync(text);

  return file.result as React.ReactNode;
}

interface MarkdownPreviewProps {
  content: string;
  branch: string;
  locale: string;
  mdPath: string;
  // Set only from EditablePageView.tsx — lets an image uploaded this
  // session (not committed upstream anywhere yet) resolve to a local
  // serving route instead of a GitHub URL that wouldn't exist. Absent
  // entirely for read-only browsing (PageView.tsx), where there's no
  // workspace to check against.
  workspace?: string;
}

// Debounced to a short pause in typing rather than every keystroke —
// unified's own processing here is cheap (no MDX compile/dynamic-import
// dance like docEditor's own Preview.tsx needs), so this can be far
// shorter than that file's 3000ms without janking the UI.
const RENDER_DEBOUNCE_MS = 300;

export function MarkdownPreview({ content, branch, locale, mdPath, workspace }: MarkdownPreviewProps) {
  const [node, setNode] = useState<React.ReactNode>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const ctx = await fetchImageResolutionContext(branch, locale, mdPath, workspace ?? null);
        if (cancelled) return;
        setNode(renderMarkdown(content, ctx));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [content, branch, locale, mdPath, workspace]);

  if (error) {
    return (
      <div className="preview-error">
        <strong>Preview error:</strong> {error}
      </div>
    );
  }

  return <div className="rendered-preview">{node}</div>;
}
