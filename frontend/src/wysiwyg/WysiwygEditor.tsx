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
 *   Admonitions/details (`!!!`/`???`/`???+`) are now real custom nodes —
 *   see pymdownxSchema.ts/pymdownxRemark.ts/pymdownxViews.ts for the full
 *   three-piece round trip (ProseMirror<->mdast schema, mdast retagging,
 *   and the plain-DOM NodeViews that render/edit them) and this file's
 *   own wiring below. Tabs (`=== "Label"`) are still NOT supported here —
 *   pages containing one stay gated to Source mode
 *   (pymdownxBlocks.ts:containsPymdownxBlocks(), narrowed to only check
 *   for tabs now) since no confirmed real usage exists in
 *   ethos-manual-rework today to justify the extra work.
 *
 *   Unlike plain CommonMark, admonitions/details need their raw markdown
 *   preprocessed *before* Milkdown's own parser ever sees it —
 *   preprocessPymdownxBlocks() (reused unchanged from the preview
 *   pipeline) rewrites `!!!`/indented-body text into blockquote-form text
 *   remark can actually parse, and its `markers` output tells
 *   pymdownxRemark.ts's editor-side retag plugin which resulting
 *   blockquote nodes to turn into real "admonition"/"details" mdast
 *   types. That preprocessed text (not raw `content`) is what actually
 *   goes into defaultValueCtx below.
 *
 *   Image display resolution: caught live (Rich mode showed every image
 *   broken, while Preview mode worked) — Milkdown's built-in image node
 *   just uses the literal relative `src` from the markdown source
 *   (`../assets/foo.png`), which resolves to nothing against this app's
 *   own URL. Fixed via `imageSchema.extendSchema()` (the documented
 *   Milkdown pattern for overriding one property of a preset's built-in
 *   node — confirmed by reading @milkdown/preset-commonmark's own
 *   blockquote/image source) to override *only* `toDOM` — the node's
 *   real `attrs.src` (what parseMarkdown/toMarkdown read and write) stays
 *   the original relative reference, so saving is unaffected; only the
 *   DOM's own `src` attribute (what the browser actually fetches) is
 *   swapped for a resolved one, via the same resolveImageSrc() the
 *   rendered preview uses (see imageResolver.ts). Resolution needs the
 *   repo-tree/workspace-image-list fetch (fetchImageResolutionContext())
 *   to have *already completed* before the editor (and its image nodes)
 *   are created at all — toDOM must return synchronously, unlike the
 *   preview's own async-then-render flow — so this component renders a
 *   brief loading state until that fetch resolves, then mounts the real
 *   editor once, with the resolution context already in hand.
 *
 *   Verified end-to-end (headings, bold/italic, links, lists, a GFM
 *   table, a real blockquote, a fenced code block) against a real
 *   running instance: renders as genuine rich text, and round-trips
 *   back to correct markdown.
 *
 *   Bullet marker fixed to "-" (see `remarkStringifyOptionsCtx` below) —
 *   caught live in an actual submitted PR: remark-stringify's own
 *   default (`*`) rewrote every existing `-` bullet in a list the
 *   moment any one line in it changed, turning a one-word edit into an
 *   8-line diff of pure noise. `remarkStringifyOptionsCtx` is a real
 *   Milkdown ctx slice (confirmed by reading @milkdown/core's own
 *   source: `init.ts` builds the actual serializer as
 *   `unified().use(remarkParse).use(remarkStringify, ctx.get(remarkStringifyOptionsCtx))`,
 *   and preset-commonmark's own emphasis/strong nodes already read
 *   `.emphasis`/`.strong` off the same slice for their own marker
 *   choice) — not a guess past an undocumented gap.
 *
 *   Formatting commands (Bold/Italic/Link/Image) are exposed via an
 *   imperative handle (WysiwygEditorHandle) rather than rendered as a
 *   toolbar *inside* this component — caught live: a self-contained
 *   toolbar here added its own row inside the bordered/scrollable box,
 *   which made the box start lower on the Rich-mode side than the
 *   English reference pane's own box on the same row. EditablePageView.tsx
 *   owns the actual buttons, in its shared pane-label row (same one the
 *   Rich/Source/Preview toggle already lives in), and calls these methods
 *   via the ref — this file only supplies what needs the live ProseMirror
 *   instance (`get()`), via the same `editor.action(callCommand(command.key,
 *   payload))` pattern as before.
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
 *   regardless. The same reasoning applies to imageCtx below: this
 *   component only ever mounts the real editor once it's already
 *   resolved, so it's safe to close over without needing a
 *   replaceAll-style update path.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import {
  imageSchema,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleLinkCommand,
  insertImageCommand,
} from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { replaceAll, callCommand, $view } from "@milkdown/kit/utils";
import {
  fetchImageResolutionContext,
  resolveImageSrc,
  type ImageResolutionContext,
} from "../preview/imageResolver";
import { preprocessPymdownxBlocks } from "../preview/pymdownxBlocks";
import { admonitionSchema, detailsSchema } from "./pymdownxSchema";
import {
  admonitionRemark,
  admonitionToMarkdownHandler,
  detailsToMarkdownHandler,
} from "./pymdownxRemark";
import { admonitionView, detailsView } from "./pymdownxViews";

export interface WysiwygEditorHandle {
  toggleBold: () => void;
  toggleItalic: () => void;
  applyLink: (href: string) => void;
  insertImage: (src: string, alt: string) => void;
}

interface WysiwygEditorProps {
  content: string;
  onChange: (markdown: string) => void;
  branch: string;
  locale: string;
  mdPath: string;
  workspace?: string;
}

interface EditorInnerProps {
  content: string;
  onChange: (markdown: string) => void;
  imageCtx: ImageResolutionContext;
  handleRef: React.Ref<WysiwygEditorHandle>;
}

function EditorInner({ content, onChange, imageCtx, handleRef }: EditorInnerProps) {
  // Refs, not state — markdownUpdated's callback closure is captured
  // once at editor-creation time (deps: []), so it needs a stable way to
  // reach the *current* onChange/content without stale-closure issues.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastContentRef = useRef(content);

  const { get } = useEditor((root) => {
    // Overrides only toDOM (see this file's header comment) — attrs.src
    // stays the original relative reference, so parseMarkdown/toMarkdown
    // (which read/write attrs.src directly, unchanged from the preset's
    // own definition) are completely unaffected; only what the browser
    // actually renders changes.
    const resolvedImageSchema = imageSchema.extendSchema((prev) => (ctx) => {
      const schema = prev(ctx);
      return {
        ...schema,
        toDOM: (node) => {
          // Non-null assertion: confirmed by reading @milkdown/preset-
          // commonmark's own image.ts source directly — its toDOM is
          // always defined, this isn't guessing past a real gap.
          const [tag, attrs] = schema.toDOM!(node) as [string, Record<string, unknown>];
          const resolved = resolveImageSrc(String(attrs.src ?? ""), imageCtx);
          return [tag, resolved ? { ...attrs, src: resolved } : attrs];
        },
      };
    });

    // Preprocessed once, at mount, from the initial `content` prop — see
    // this file's own header comment on why admonitions/details need
    // this before Milkdown's parser ever runs. `markers` gets threaded
    // into admonitionRemark's own ctx slice just below, not passed as
    // static initialOptions, since a later replaceAll (external content
    // change) needs to refresh both together against whatever it's
    // parsing at that moment — see the effect below.
    const { text: initialText, markers: initialMarkers } = preprocessPymdownxBlocks(content);

    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialText);
        ctx.update(admonitionRemark.options.key, () => initialMarkers);
        // remark-stringify's own default is "*" — caught live in a real
        // submitted PR: a one-word edit inside a bullet list produced an
        // 8-line diff, every existing "-" bullet rewritten to "*" for no
        // real reason. This repo's own convention (and CommonMark's, and
        // every other markdown file in it) is "-", so match it instead of
        // the library default. `handlers.admonition`/`.details` are the
        // custom mdast->markdown-text serializers for the synthetic node
        // types pymdownxSchema.ts's toMarkdown runners build — see
        // pymdownxRemark.ts for why this ctx slice (not a deep import
        // into mdast-util-to-markdown) is the real, public extension
        // point for that.
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({
          ...prev,
          bullet: "-" as const,
          handlers: {
            ...prev.handlers,
            admonition: admonitionToMarkdownHandler,
            details: detailsToMarkdownHandler,
          },
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
          if (markdown === prevMarkdown) return;
          lastContentRef.current = markdown;
          onChangeRef.current(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(resolvedImageSchema) // after commonmark, so it overrides that preset's own image node
      .use(admonitionSchema)
      .use(detailsSchema)
      .use(admonitionRemark)
      .use($view(admonitionSchema.node, () => admonitionView))
      .use($view(detailsSchema.node, () => detailsView))
      .use(history)
      .use(listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (content === lastContentRef.current) return; // this editor's own edit, already reflected
    const editor = get();
    if (!editor) return;
    lastContentRef.current = content;
    // Same preprocessing needed here as at mount (see this file's own
    // header comment) — an external content change containing
    // admonitions/details must refresh admonitionRemark's markers before
    // the rewritten text is handed to replaceAll, or they'd still be
    // matched against the *previous* parse's line numbers.
    const { text, markers } = preprocessPymdownxBlocks(content);
    editor.action((ctx) => ctx.update(admonitionRemark.options.key, () => markers));
    editor.action(replaceAll(text));
  }, [content, get]);

  function runCommand(command: Parameters<typeof callCommand>[0], payload?: unknown) {
    get()?.action(callCommand(command as any, payload));
  }

  useImperativeHandle(
    handleRef,
    () => ({
      toggleBold: () => runCommand(toggleStrongCommand.key),
      toggleItalic: () => runCommand(toggleEmphasisCommand.key),
      applyLink: (href: string) => runCommand(toggleLinkCommand.key, { href }),
      insertImage: (src: string, alt: string) => runCommand(insertImageCommand.key, { src, alt }),
    }),
    [get],
  );

  return <Milkdown />;
}

export const WysiwygEditor = forwardRef<WysiwygEditorHandle, WysiwygEditorProps>(function WysiwygEditor(
  { content, onChange, branch, locale, mdPath, workspace },
  ref,
) {
  const [imageCtx, setImageCtx] = useState<ImageResolutionContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchImageResolutionContext(branch, locale, mdPath, workspace ?? null).then((ctx) => {
      if (!cancelled) setImageCtx(ctx);
    });
    return () => {
      cancelled = true;
    };
  }, [branch, locale, mdPath, workspace]);

  if (!imageCtx) {
    return <div className="page-view-loading">Loading editor…</div>;
  }

  return (
    <MilkdownProvider>
      <EditorInner content={content} onChange={onChange} imageCtx={imageCtx} handleRef={ref} />
    </MilkdownProvider>
  );
});
