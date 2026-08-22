/* frontend/src/preview/renderMarkdown.tsx
 *
 * Description of responsibility:
 *   The actual markdown → React rendering pipeline: parse, GFM tables,
 *   strip attr_list noise, retag pymdownx admonitions/details/tabs
 *   (see pymdownxBlocks.ts), convert to hast, add heading anchors
 *   (mkdocs.yml's `toc: permalink: true`), rewrite relative image
 *   `src`s to real GitHub raw URLs, and render straight to React
 *   elements (rehype-react) rather than building an HTML string and
 *   dangerously-setting it — keeps the door open for later
 *   interactivity (e.g. click an image to replace it) without a second
 *   DOM-walking pass.
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
import { fetchRepoTree } from "./repoTree";

// Matches backend/config/github.ts's own defaults — not currently
// shared between front/backend (this app has no shared-types package
// yet), so this needs to stay in sync by hand if that ever changes.
const GITHUB_OWNER = "robthomson";
const GITHUB_REPO = "ethos-manual-rework";

// Resolves a relative reference (e.g. "../assets/foo.png") against a
// repo-relative directory (e.g. "docs/nl/model-setup") to a repo-relative
// path — pure path algebra (no network), via the URL constructor against
// a throwaway origin so "./", "../", and bare-relative forms are all
// handled the same uniform way a browser resolves them.
function resolveRepoRelativePath(baseDir: string, ref: string): string {
  const resolved = new URL(ref, `https://x/${baseDir}/`);
  return resolved.pathname.replace(/^\//, "");
}

function rehypeRewriteImages(branch: string, locale: string, mdPath: string, existingPaths: Set<string>) {
  const mdDir = mdPath.includes("/") ? mdPath.slice(0, mdPath.lastIndexOf("/")) : "";
  const localeBaseDir = `docs/${locale}/${mdDir}`;

  return () => (tree: any) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "img" || !node.properties?.src) return;
      const src = String(node.properties.src);
      if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) return;

      try {
        const localePath = resolveRepoRelativePath(localeBaseDir, src);
        // existingPaths is only ever empty for locale === "en" itself
        // (see MarkdownPreview below — no fallback needed, or possible,
        // for English) or when the tree fetch failed; either way,
        // "assume it exists" is the safer default — a real 404 still
        // just shows as a broken image, whereas wrongly falling back
        // would point English's screenshot at a translated page that
        // actually has its own.
        const finalPath =
          existingPaths.size === 0 || existingPaths.has(localePath)
            ? localePath
            : localePath.replace(`docs/${locale}/`, "docs/en/");

        node.properties.src = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${finalPath}`;
      } catch {
        // Malformed relative path — leave it as-is rather than throwing
        // and blanking the whole preview over one bad image reference.
      }
    });
  };
}

export interface RenderMarkdownOptions {
  branch: string;
  locale: string;
  mdPath: string; // used only to resolve this page's own image references
  existingPaths: Set<string>; // see rehypeRewriteImages above
}

export function renderMarkdown(
  content: string,
  { branch, locale, mdPath, existingPaths }: RenderMarkdownOptions,
): React.ReactNode {
  const { text, markers } = preprocessPymdownxBlocks(content);

  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStripAttrList)
    .use(remarkPymdownxBlocks, markers)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeRewriteImages(branch, locale, mdPath, existingPaths))
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
}

// Debounced to a short pause in typing rather than every keystroke —
// unified's own processing here is cheap (no MDX compile/dynamic-import
// dance like docEditor's own Preview.tsx needs), so this can be far
// shorter than that file's 3000ms without janking the UI.
const RENDER_DEBOUNCE_MS = 300;

export function MarkdownPreview({ content, branch, locale, mdPath }: MarkdownPreviewProps) {
  const [node, setNode] = useState<React.ReactNode>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        // English has nothing to fall back to (it IS the default), so
        // skip the tree fetch entirely — matches navRoutes.ts's own
        // "toc" endpoint doing the same for the identical reason.
        const existingPaths = locale === "en" ? new Set<string>() : await fetchRepoTree(branch);
        if (cancelled) return;
        setNode(renderMarkdown(content, { branch, locale, mdPath, existingPaths }));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [content, branch, locale, mdPath]);

  if (error) {
    return (
      <div className="preview-error">
        <strong>Preview error:</strong> {error}
      </div>
    );
  }

  return <div className="rendered-preview">{node}</div>;
}
