/* frontend/src/wysiwyg/pymdownxViews.ts
 *
 * Description of responsibility:
 *   Hand-written ProseMirror NodeViews (plain DOM, not React) for the
 *   admonition/details node types (pymdownxSchema.ts) — owns the actual
 *   rendered box: a styled container, an independently-editable title
 *   bar (a node ATTR, not ProseMirror content — see pymdownxSchema.ts's
 *   own comment on why), and the real ProseMirror-managed body content.
 *
 * Info:
 *   Not React: confirmed via research that @milkdown/react (this
 *   version, 7.22.1) has no NodeView bridge (no useNodeViewFactory or
 *   similar — only @milkdown/components, which is Vue-based) and no
 *   @prosemirror-adapter package is present anywhere in this dependency
 *   tree. Embedding a React root inside a hand-rolled NodeView would add
 *   real reconciliation/focus risk for no benefit here — these are
 *   simple styled containers around normal editable content, the exact
 *   shape blockquote/image's plain toDOM already handles for everything
 *   except the title bar.
 *
 *   The title bar lives OUTSIDE contentDOM specifically so ProseMirror's
 *   own mutation observer never tries to diff/manage it — it's a plain
 *   contenteditable element synced back to the node's `title` attr via a
 *   real transaction (tr.setNodeAttribute) on blur, a standard pattern
 *   for an externally-editable non-content region in a ProseMirror
 *   NodeView. stopEvent()/ignoreMutation() tell ProseMirror to leave that
 *   element alone entirely rather than trying to reconcile it against the
 *   document.
 *
 *   Reuses the exact same CSS classes (.admonition, .admonition-title,
 *   .admonition-body, per-type modifiers) the live preview already uses
 *   (frontend/src/App.css) — see that file for the matching
 *   .wysiwyg-scroll-scoped rules added alongside this feature, so Rich
 *   mode looks the same as Preview mode for the same content.
 *
 *   getPos/view are typed loosely (not the real EditorView/Node types)
 *   deliberately — this file only needs a handful of methods off each
 *   (dispatch/state/doc.nodeAt), and pulling in the full ProseMirror
 *   generics here bought nothing but friction; the exported constructors
 *   are still typed against the real NodeViewConstructor contract $view()
 *   expects, so a real type mismatch at the registration site would still
 *   be caught.
 */
import type { NodeViewConstructor, NodeView, ViewMutationRecord } from "@milkdown/prose/view";

// Same fallback preview/pymdownxBlocks.ts:remarkPymdownxBlocks() applies
// for an admonition/details with no explicit title — kept in sync there
// (both are display-only, neither writes this into real stored data).
function capitalize(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

interface LooseNode {
  attrs: Record<string, any>;
  type: { name: string };
}

interface LooseView {
  dispatch: (tr: any) => void;
  state: { tr: any; doc: { nodeAt: (pos: number) => LooseNode | null | undefined } };
}

// Shared behavior between the admonition and details NodeViews: an
// externally-editable title bar (outside contentDOM) synced to the
// node's `title` attr, and a contentDOM child holding the real body.
abstract class PymdownxBoxView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  protected titleEl: HTMLElement;
  protected getPos: () => number | undefined;
  protected view: LooseView;

  constructor(
    node: LooseNode,
    view: LooseView,
    getPos: () => number | undefined,
    rootTag: string,
    titleTag: string,
  ) {
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement(rootTag);
    this.titleEl = document.createElement(titleTag);
    this.titleEl.className = "admonition-title";
    this.titleEl.contentEditable = "true";
    // Genuinely empty (not pre-filled with the capitalized-type default)
    // when the source had no explicit title — App.css shows that default
    // as CSS placeholder text (:empty::before, via data-placeholder) so
    // it's still visible without it being real content. Pre-filling the
    // DOM text itself would make a plain focus+blur with no real edit
    // look identical to the user having typed that exact text, which
    // commitTitle() would then write back as a spurious real attr change
    // — see pymdownxBlocks.ts's own comment on why the fallback has to
    // stay a display-only concern, not stored data.
    this.titleEl.textContent = node.attrs.title;
    this.titleEl.setAttribute("data-placeholder", capitalize(node.attrs.admonitionType));
    this.titleEl.addEventListener("blur", () => this.commitTitle());
    this.titleEl.addEventListener("keydown", (e: KeyboardEvent) => {
      // A title bar is one line — Enter commits and moves focus out
      // rather than inserting a literal newline into the attr text.
      if (e.key === "Enter") {
        e.preventDefault();
        this.titleEl.blur();
      }
    });

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "admonition-body";

    this.dom.appendChild(this.titleEl);
    this.dom.appendChild(this.contentDOM);
    this.applyType(node);
  }

  protected abstract applyType(node: LooseNode): void;
  protected abstract expectedType(): string;

  protected commitTitle() {
    const pos = this.getPos();
    if (pos == null) return;
    const text = this.titleEl.textContent ?? "";
    if (text === this.view.state.doc.nodeAt(pos)?.attrs.title) return;
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "title", text));
  }

  update(node: LooseNode): boolean {
    if (node.type.name !== this.expectedType()) return false;
    // Only resync the DOM's title text from an *external* change (undo/
    // redo, or a replaceAll from outside this editor) — never while the
    // title bar itself still has focus, which would fight the user's own
    // in-progress typing.
    if (document.activeElement !== this.titleEl && this.titleEl.textContent !== node.attrs.title) {
      this.titleEl.textContent = node.attrs.title;
    }
    this.titleEl.setAttribute("data-placeholder", capitalize(node.attrs.admonitionType));
    this.applyType(node);
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.titleEl.contains(event.target as globalThis.Node);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.titleEl.contains(mutation.target as globalThis.Node);
  }
}

class AdmonitionBoxView extends PymdownxBoxView {
  constructor(node: LooseNode, view: LooseView, getPos: () => number | undefined) {
    super(node, view, getPos, "div", "div");
  }
  protected expectedType() {
    return "admonition";
  }
  protected applyType(node: LooseNode) {
    this.dom.className = `admonition ${node.attrs.admonitionType}`;
  }
}

class DetailsBoxView extends PymdownxBoxView {
  constructor(node: LooseNode, view: LooseView, getPos: () => number | undefined) {
    super(node, view, getPos, "details", "summary");
    const details = this.dom as HTMLDetailsElement;
    details.open = !!node.attrs.openByDefault;
    details.addEventListener("toggle", () => {
      const pos = this.getPos();
      if (pos == null) return;
      const isOpen = details.open;
      const current = this.view.state.doc.nodeAt(pos)?.attrs.openByDefault;
      if (isOpen === !!current) return;
      this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "openByDefault", isOpen));
    });
  }
  protected expectedType() {
    return "details";
  }
  protected applyType(node: LooseNode) {
    this.dom.className = node.attrs.admonitionType;
    const details = this.dom as HTMLDetailsElement;
    if (details.open !== !!node.attrs.openByDefault) details.open = !!node.attrs.openByDefault;
  }
}

export const admonitionView: NodeViewConstructor = (node, view, getPos) =>
  new AdmonitionBoxView(node as unknown as LooseNode, view as unknown as LooseView, getPos);

export const detailsView: NodeViewConstructor = (node, view, getPos) =>
  new DetailsBoxView(node as unknown as LooseNode, view as unknown as LooseView, getPos);
