/* frontend/src/wysiwyg/pymdownxSchema.ts
 *
 * Description of responsibility:
 *   Milkdown $nodeSchema definitions for pymdownx admonitions (`!!! type
 *   "Title"`) and collapsible details (`??? type "Title"` / `???+ type
 *   "Title"`) — the ProseMirror <-> mdast half of round-tripping these
 *   blocks in Rich mode. See pymdownxRemark.ts for the mdast <-> markdown-
 *   text half (retagging the blockquote-form text preprocessPymdownxBlocks()
 *   produces into these node types) and pymdownxViews.ts for how they're
 *   actually rendered/edited (a NodeView per node, not toDOM alone, since
 *   the title needs to be independently editable without being part of
 *   ProseMirror's own content).
 *
 * Info:
 *   Modeled directly on @milkdown/preset-commonmark's own blockquote/
 *   code-block node schemas (content:"block+"/group:"block" for
 *   blockquote's container shape; attrs + state.openNode(type, attrs) for
 *   code-block's non-content `language` attr) — confirmed by reading that
 *   package's real source rather than guessing at the NodeSchema shape.
 *
 *   Title is a node ATTR, not editable ProseMirror content — matches
 *   DEV_NOTES.md's own recommendation ("type/title as node attrs, not
 *   child nodes"). This is also faithful to the source format, not a
 *   simplification: pymdownx's title comes from ADMONITION_RE's quoted
 *   capture group, a literal string that's never itself parsed as
 *   markdown, so there's no inline-formatting capability being lost by
 *   not making it real ProseMirror content.
 *
 *   toDOM/parseDOM below are only a best-effort fallback (e.g. paste from
 *   elsewhere, or clipboard copy-out) — pymdownxViews.ts's NodeViews are
 *   what Milkdown actually mounts for live editing, registered separately
 *   via $view in WysiwygEditor.tsx; toDOM is never even called while a
 *   NodeView is registered for the type, except as ProseMirror's own
 *   internal clipboard-serialization fallback.
 */
import { $nodeSchema } from "@milkdown/kit/utils";

export const admonitionSchema = $nodeSchema("admonition", () => ({
  content: "block+",
  group: "block",
  defining: true,
  isolating: true,
  attrs: {
    admonitionType: { default: "note" },
    title: { default: "" },
  },
  parseDOM: [
    {
      tag: "div.admonition",
      getAttrs: (dom) => {
        const el = dom as HTMLElement;
        const type = Array.from(el.classList).find((c) => c !== "admonition") ?? "note";
        const title = el.querySelector(":scope > .admonition-title")?.textContent ?? "";
        return { admonitionType: type, title };
      },
      contentElement: ((dom: HTMLElement) =>
        dom.querySelector(":scope > .admonition-body") ?? dom) as unknown as string,
    },
  ],
  toDOM: (node) => [
    "div",
    { class: `admonition ${node.attrs.admonitionType}` },
    ["div", { class: "admonition-title" }, node.attrs.title],
    ["div", { class: "admonition-body" }, 0],
  ],
  parseMarkdown: {
    match: (node) => node.type === "admonition",
    runner: (state, node: any, type) => {
      state.openNode(type, {
        admonitionType: node.admonitionType ?? "note",
        title: node.title ?? "",
      });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "admonition",
    runner: (state, node) => {
      state
        .openNode("admonition", undefined, {
          admonitionType: node.attrs.admonitionType,
          title: node.attrs.title,
        })
        .next(node.content)
        .closeNode();
    },
  },
}));

export const detailsSchema = $nodeSchema("details", () => ({
  content: "block+",
  group: "block",
  defining: true,
  isolating: true,
  attrs: {
    admonitionType: { default: "note" },
    title: { default: "" },
    openByDefault: { default: false },
  },
  parseDOM: [
    {
      tag: "details",
      getAttrs: (dom) => {
        const el = dom as HTMLDetailsElement;
        const type = el.classList[0] ?? "note";
        const title = el.querySelector(":scope > summary")?.textContent ?? "";
        return { admonitionType: type, title, openByDefault: el.open };
      },
      contentElement: ((dom: HTMLElement) =>
        dom.querySelector(":scope > .admonition-body") ?? dom) as unknown as string,
    },
  ],
  toDOM: (node) => [
    "details",
    node.attrs.openByDefault
      ? { class: node.attrs.admonitionType, open: "" }
      : { class: node.attrs.admonitionType },
    ["summary", { class: "admonition-title" }, node.attrs.title],
    ["div", { class: "admonition-body" }, 0],
  ],
  parseMarkdown: {
    match: (node) => node.type === "details",
    runner: (state, node: any, type) => {
      state.openNode(type, {
        admonitionType: node.admonitionType ?? "note",
        title: node.title ?? "",
        openByDefault: node.openByDefault ?? false,
      });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "details",
    runner: (state, node) => {
      state
        .openNode("details", undefined, {
          admonitionType: node.attrs.admonitionType,
          title: node.attrs.title,
          openByDefault: node.attrs.openByDefault,
        })
        .next(node.content)
        .closeNode();
    },
  },
}));
