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
 *   The title bar is a real `<input type="text">`, not a nested
 *   `contenteditable` div — caught live, the hard way: a nested
 *   `contenteditable` region inside ProseMirror's own contentEditable
 *   root never receives real DOM focus in Chromium at all
 *   (document.activeElement stayed on the outer ProseMirror root the
 *   whole time), so neither focus/blur NOR input/keydown/beforeinput
 *   ever fired on it — typed text still visually appeared (native
 *   contenteditable text insertion doesn't require the element to be
 *   "focused" in the DOM sense the way a form control does), but with no
 *   event ever reaching this file's own listeners, nothing ever
 *   committed the change to the node's `title` attr. A plain `<input>`
 *   sidesteps this entirely: browsers treat a form control nested inside
 *   a contenteditable ancestor as a normal independent interactive
 *   widget, not as part of the surrounding editable text — real
 *   focus/blur/input events, and (bonus) a native `placeholder` for the
 *   capitalized-type fallback instead of the CSS `:empty::before` trick
 *   an editable div would have needed.
 *
 *   The title bar lives OUTSIDE contentDOM so ProseMirror never tries to
 *   diff/manage it — synced to the node's `title` attr via a real
 *   transaction (tr.setNodeAttribute) on `input`. stopEvent()/
 *   ignoreMutation() tell ProseMirror to leave that element alone
 *   entirely rather than trying to reconcile it against the document —
 *   belt-and-suspenders now that it's a real form control (which
 *   ProseMirror already mostly ignores on its own), not load-bearing the
 *   way it would have been for the contenteditable-div design above.
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
// independently-editable title bar (a real <input>, outside contentDOM)
// synced to the node's `title` attr, and a contentDOM child holding the
// real body.
abstract class PymdownxBoxView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  protected titleEl: HTMLInputElement;
  protected getPos: () => number | undefined;
  protected view: LooseView;

  constructor(
    node: LooseNode,
    view: LooseView,
    getPos: () => number | undefined,
    rootTag: string,
  ) {
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement(rootTag);
    this.titleEl = document.createElement("input");
    this.titleEl.type = "text";
    this.titleEl.className = "admonition-title";
    // Genuinely empty (not pre-filled with the capitalized-type default)
    // when the source had no explicit title — the native `placeholder`
    // shows that default without it being real stored data. Pre-filling
    // `.value` itself would make a plain focus+blur with no real edit
    // look identical to the user having typed that exact text — see
    // pymdownxBlocks.ts's own comment on why the fallback has to stay a
    // display-only concern.
    this.titleEl.value = node.attrs.title;
    this.titleEl.placeholder = capitalize(node.attrs.admonitionType);
    this.externalRoot = this.titleEl;
    this.titleEl.addEventListener("input", () => this.commitTitle());
    this.titleEl.addEventListener("keydown", (e: KeyboardEvent) => {
      // A title bar is one line — Enter commits (input already fired) and
      // moves focus out rather than doing whatever Enter would otherwise
      // trigger inside an editor surface.
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
    const text = this.titleEl.value;
    if (text === this.view.state.doc.nodeAt(pos)?.attrs.title) return;
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "title", text));
  }

  update(node: LooseNode): boolean {
    if (node.type.name !== this.expectedType()) return false;
    // A real <input> gets real focus, so document.activeElement is a
    // reliable "is the user still typing in here" signal here (unlike
    // the contenteditable-div design this replaced) — only resync from
    // an *external* change (undo/redo, a replaceAll from outside this
    // editor) while it isn't focused, so this never fights in-progress
    // typing or resets the caret mid-edit.
    if (document.activeElement !== this.titleEl && this.titleEl.value !== node.attrs.title) {
      this.titleEl.value = node.attrs.title;
    }
    this.titleEl.placeholder = capitalize(node.attrs.admonitionType);
    this.applyType(node);
    return true;
  }

  // The non-content region ProseMirror should leave entirely alone —
  // just titleEl itself for admonitions, but titleEl's *parent*
  // <summary> for details (DetailsBoxView reassigns this after moving
  // titleEl inside one, in its own constructor — set here first so it's
  // never left undefined), since the summary's own disclosure-triangle
  // area is also outside titleEl but still not part of the document.
  protected externalRoot: HTMLElement;

  stopEvent(event: Event): boolean {
    return this.externalRoot.contains(event.target as globalThis.Node);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.externalRoot.contains(mutation.target as globalThis.Node);
  }
}

class AdmonitionBoxView extends PymdownxBoxView {
  constructor(node: LooseNode, view: LooseView, getPos: () => number | undefined) {
    super(node, view, getPos, "div");
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
    super(node, view, getPos, "details");
    const details = this.dom as HTMLDetailsElement;
    // The base constructor already appended titleEl (the <input>)
    // directly into `this.dom` — move it inside a real <summary> instead
    // (native disclosure-triangle rendering, matches pymdownxSchema.ts's
    // toDOM fallback and the live preview's own <summary> title bar).
    // appendChild here *moves* titleEl out of its current position, so
    // this only needs inserting the summary at the front afterward.
    const summary = document.createElement("summary");
    summary.appendChild(this.titleEl);
    details.insertBefore(summary, details.firstChild);
    this.externalRoot = summary;
    // <summary>'s own native behavior toggles open/closed on any click
    // inside it, which would fire on every click into the title input
    // too — stopPropagation on the input specifically (not the summary
    // itself) keeps that native toggle working for clicks on the
    // disclosure triangle/rest of the row while not hijacking normal
    // text-field interaction (click-to-place-cursor, drag-to-select).
    this.titleEl.addEventListener("click", (e) => e.stopPropagation());
    this.titleEl.addEventListener("mousedown", (e) => e.stopPropagation());
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
