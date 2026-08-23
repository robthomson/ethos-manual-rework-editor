/* frontend/src/wysiwyg/WysiwygEditor.tsx
 *
 * Description of responsibility:
 *   Real contentEditable rich-text editing (Milkdown — built on
 *   ProseMirror + remark specifically for round-tripping to clean
 *   markdown, unlike TipTap's HTML-first design) for standard markdown:
 *   headings, bold/italic/strikethrough, lists, blockquotes, links,
 *   images, code, and GFM tables. Type directly into formatted text; no
 *   visible markdown syntax.
 *
 * Info:
 *   Only ever mounted for content EditablePageView.tsx has already
 *   confirmed doesn't contain pymdownx-specific syntax (see
 *   pymdownxBlocks.ts:containsPymdownxBlocks()) — CommonMark's own
 *   "lazy continuation" rule means a page with a `!!!` admonition would
 *   have its `!!!`/indented-body structure silently flattened into a
 *   plain paragraph on save if edited here, since neither Milkdown's
 *   default schema nor its default markdown serializer know that syntax
 *   exists. That's real data loss, not a display quirk, so those pages
 *   stay in Source mode until real custom-node support for
 *   admonitions/details/tabs is built (documented, not yet done — see
 *   DEV_NOTES.md for the researched approach: reuse
 *   preprocessPymdownxBlocks()'s text rewrite + a custom
 *   mdast-util-to-markdown extension, mirroring how Milkdown's own
 *   built-in blockquote node round-trips).
 *
 *   Verified end-to-end (headings, bold/italic, links, lists, a GFM
 *   table, a real blockquote, a fenced code block) against a real
 *   running instance: renders as genuine rich text, and round-trips
 *   back to correct markdown. One confirmed, minor, cosmetic
 *   difference: bullet lists round-trip using `*` markers regardless of
 *   whether the source used `-` — stylistically different, not
 *   incorrect, but will show as a no-op diff line in a real PR if not
 *   addressed (remark-stringify's default `bullet` option; Milkdown
 *   likely exposes overriding it, not yet investigated).
 *
 *   The editor instance is created once per mount (empty `deps` to
 *   useEditor) with the *initial* content baked in via defaultValueCtx —
 *   deliberately NOT recreated on every keystroke, which would destroy
 *   and rebuild the whole ProseMirror view (losing cursor position and
 *   undo history) on every single character typed. A later *external*
 *   content change (not one that originated from this editor's own
 *   markdownUpdated callback, guarded via lastContentRef) is instead
 *   pushed in through action(replaceAll(...)). In practice
 *   EditablePageView.tsx already remounts this component fresh (via a
 *   `key` prop) on every page switch, so defaultValueCtx alone covers
 *   the common case; the replaceAll path exists for full correctness
 *   regardless.
 */
import { useEffect, useRef } from "react";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { replaceAll } from "@milkdown/kit/utils";

interface WysiwygEditorProps {
  content: string;
  onChange: (markdown: string) => void;
}

function EditorInner({ content, onChange }: WysiwygEditorProps) {
  // Refs, not state — markdownUpdated's callback closure is captured
  // once at editor-creation time (deps: []), so it needs a stable way to
  // reach the *current* onChange/content without stale-closure issues.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastContentRef = useRef(content);

  const { get } = useEditor((root) => {
    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
          if (markdown === prevMarkdown) return;
          lastContentRef.current = markdown;
          onChangeRef.current(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (content === lastContentRef.current) return; // this editor's own edit, already reflected
    const editor = get();
    if (!editor) return;
    lastContentRef.current = content;
    editor.action(replaceAll(content));
  }, [content, get]);

  return <Milkdown />;
}

export function WysiwygEditor(props: WysiwygEditorProps) {
  return (
    <MilkdownProvider>
      <EditorInner {...props} />
    </MilkdownProvider>
  );
}
