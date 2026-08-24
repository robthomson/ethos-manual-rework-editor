/* frontend/src/preview/pymdownxBlocks.ts
 *
 * Description of responsibility:
 *   Recognizes ethos-manual-rework's real block-level pymdownx syntax —
 *   admonitions (`!!! type "Title"`), collapsible details
 *   (`??? type "Title"` / `???+ type "Title"` for open-by-default), and
 *   tabbed content (`=== "Label"`) — none of which any standard remark
 *   plugin understands (they're Python-Markdown/pymdownx-specific, not
 *   CommonMark, and not Docusaurus's `:::`/JSX syntax docEditor's own
 *   remarkAdmonitions.ts was built for).
 *
 * Info:
 *   Two-part approach, because these constructs rely on 4-space
 *   indentation to mark "this content belongs to the block above" the
 *   same way a blockquote's `>` prefix does in real CommonMark — and
 *   CommonMark's own indented-code-block rule means naively handing
 *   this text to remark-parse unchanged would swallow each block's body
 *   into an opaque `code` node, losing all its nested markdown
 *   structure (links, bold, lists, even nested code fences) before any
 *   AST-level plugin ever got a chance to see it.
 *
 *   1. preprocessPymdownxBlocks() rewrites the raw text BEFORE parsing:
 *      each recognized block's body gets reprefixed as a blockquote
 *      (`> `) instead of 4-space indentation — a construct remark
 *      already parses recursively and correctly — and a small
 *      `markers` list records, by the *line number that content ends
 *      up on in the rewritten text*, what that blockquote actually was
 *      (admonition/details/tab, its type/title/label). Consecutive tabs
 *      each become their own blockquote (blank-line-separated, so
 *      CommonMark doesn't merge them via lazy continuation into one).
 *
 *   2. remarkPymdownxBlocks() is a real remark plugin: it runs after
 *      parsing, finds the `blockquote` node whose `position.start.line`
 *      matches each recorded marker, and retags it via the same
 *      `data.hName`/`data.hProperties` mechanism docEditor's own
 *      remarkAdmonitions.ts uses (remark-rehype honors this when
 *      converting mdast → hast) — so the actual output element is a
 *      `div.admonition`/`details`/`div.tabbed-block`, not a real
 *      `<blockquote>`, while everything nested inside parsed as normal,
 *      real markdown. A second pass groups consecutive same-tab-set
 *      blocks into one `div.tabbed-set` wrapper.
 *
 *   Handles a block nested inside a list item (e.g. `!!! note` indented
 *   2 spaces to continue a `- ` bullet's own content) — real, confirmed
 *   usage in ethos-manual-rework (an earlier version of this file
 *   assumed otherwise from checking too few files, and broke on it:
 *   the marker showed as literal `!!! note` text instead of a styled
 *   box). The marker itself can start at any consistent indentation,
 *   not just column 0 — MARKER_RE below captures that leading
 *   whitespace, body lines are continuation-checked and dedented
 *   relative to it (not a fixed 4 spaces from column 0), and the
 *   emitted blockquote is re-prefixed with that *same* leading
 *   whitespace so it still aligns with whatever list item it was
 *   nested inside — CommonMark requires a list item's continuation
 *   lines to indent to its content's start column, and the blockquote
 *   needs to land on that same column to still parse as part of the
 *   item rather than as a new top-level block that ends the list.
 *   A block-inside-a-block (an admonition nested inside another
 *   admonition) still isn't attempted — no confirmed real usage of
 *   that specific case, and it would need recursive re-indentation
 *   handling on top of this.
 */
import { visit } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Root, BlockContent } from "mdast";

const ADMONITION_RE = /^(\s*)(!!!|\?\?\?\+?)\s+(\S+)(?:\s+"([^"]*)")?\s*$/;
const TAB_RE = /^(\s*)===\s+"([^"]*)"\s*$/;

// Used by EditablePageView.tsx's safety gate. Admonitions/details now
// have real custom-node support in Rich mode (frontend/src/wysiwyg/
// pymdownxSchema.ts/pymdownxRemark.ts/pymdownxViews.ts), so this only
// gates on tabs now — narrowed from also checking ADMONITION_RE, which
// it did before that support existed. Tabs still have no custom-node
// handling at all: CommonMark's own "lazy continuation" rule means
// naively round-tripping a page containing one would silently flatten
// its `=== "Label"`/indented-body structure into a plain paragraph on
// save — real data loss, not just a display quirk. No confirmed real
// usage of tabs in ethos-manual-rework today, so gating them out costs
// little in practice (see DEV_NOTES.md).
export function containsPymdownxBlocks(source: string): boolean {
  return source.split("\n").some((line) => TAB_RE.test(line));
}

export type BlockMarker =
  | { outputLine: number; kind: "admonition"; type: string; title: string }
  | { outputLine: number; kind: "details"; type: string; title: string; openByDefault: boolean }
  | {
      outputLine: number;
      kind: "tab";
      label: string;
      tabSetId: number;
      tabIndex: number;
      tabCount: number;
    };

export interface PreprocessResult {
  text: string;
  markers: BlockMarker[];
}

// A blank-or-(indent+4-space)-indented run is exactly pymdownx's own
// convention for "this line still belongs to the block above" — mirrors
// what Python-Markdown's own block processors do before this repo's
// real mkdocs build ever sees the content. `indent` is the marker
// line's own leading whitespace (not always empty — see this file's
// header comment on list-item-nested blocks).
function isContinuationLine(line: string, indent: string): boolean {
  return line.trim() === "" || line.startsWith(indent + "    ");
}

export function preprocessPymdownxBlocks(source: string): PreprocessResult {
  const lines = source.split("\n");
  const outLines: string[] = [];
  const markers: BlockMarker[] = [];
  let i = 0;
  let tabSetCounter = 0;

  function collectBody(indent: string): string[] {
    const body: string[] = [];
    while (i < lines.length && isContinuationLine(lines[i], indent)) {
      body.push(lines[i].startsWith(indent + "    ") ? lines[i].slice(indent.length + 4) : "");
      i++;
    }
    // Trailing blank lines belong to whatever comes after, not the body
    // itself — trimming them keeps the emitted blockquote from ending
    // in dangling empty "> " lines.
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    return body;
  }

  // Emits one blockquote block (marker line + body, blank-line
  // terminated), each line re-prefixed with the marker's own original
  // indentation so a block nested inside a list item still lands on
  // that item's continuation column — and returns the 1-indexed line
  // number remark will place its position.start.line at, which is
  // always where this function's own first emitted line lands, since
  // it's called immediately before pushing.
  function emitBlock(indent: string, body: string[]): number {
    const startLine = outLines.length + 1; // 1-indexed, matches mdast positions
    outLines.push(indent + ">");
    for (const bodyLine of body) {
      outLines.push(bodyLine.trim() === "" ? indent + ">" : `${indent}> ${bodyLine}`);
    }
    outLines.push(""); // blank line — ends the blockquote cleanly, no lazy-continuation bleed into whatever follows
    return startLine;
  }

  while (i < lines.length) {
    const line = lines[i];
    const admonitionMatch = line.match(ADMONITION_RE);
    const tabMatch = line.match(TAB_RE);

    if (admonitionMatch) {
      const [, indent, marker, type, titleAttr] = admonitionMatch;
      const isDetails = marker.startsWith("?");
      // "" (not the capitalized-type fallback) when no title was given —
      // that fallback is a *display* concern (applied by
      // remarkPymdownxBlocks below, and by wysiwyg/pymdownxViews.ts's
      // NodeViews), not something to bake into the marker itself. Baking
      // it in here used to mean an admonition with no explicit title
      // would round-trip through Rich mode as `!!! type "Type"` — a
      // spurious diff on save even when nothing was actually edited,
      // since wysiwyg/pymdownxRemark.ts's toMarkdown handlers only omit
      // the quoted title when it's genuinely empty.
      const title = titleAttr ?? "";
      i++;
      const body = collectBody(indent);
      const outputLine = emitBlock(indent, body);
      markers.push(
        isDetails
          ? { outputLine, kind: "details", type, title, openByDefault: marker === "???+" }
          : { outputLine, kind: "admonition", type, title },
      );
      continue;
    }

    if (tabMatch) {
      tabSetCounter++;
      const tabSetId = tabSetCounter;
      const tabs: { label: string; indent: string; body: string[] }[] = [];

      // A tab set is however many consecutive `=== "Label"` blocks
      // follow each other directly (at the SAME indentation as the
      // first) — matches pymdownx.tabbed's own convention of no blank
      // line needed between tabs.
      const setIndent = tabMatch[1];
      while (i < lines.length) {
        const m = lines[i].match(TAB_RE);
        if (!m || m[1] !== setIndent) break;
        const label = m[2];
        i++;
        tabs.push({ label, indent: setIndent, body: collectBody(setIndent) });
      }

      tabs.forEach((tab, tabIndex) => {
        const outputLine = emitBlock(tab.indent, tab.body);
        markers.push({
          outputLine,
          kind: "tab",
          label: tab.label,
          tabSetId,
          tabIndex,
          tabCount: tabs.length,
        });
      });
      continue;
    }

    outLines.push(line);
    i++;
  }

  return { text: outLines.join("\n"), markers };
}

// hast-compatible mdast data (hName/hProperties) — same mechanism
// docEditor's own remarkAdmonitions.ts relies on. Applied here to
// `blockquote` nodes that preprocessPymdownxBlocks() synthesized;
// unaffected by any blockquote a translator wrote for real (its
// position never matches a recorded marker line).
export const remarkPymdownxBlocks: Plugin<[BlockMarker[]], Root> = (markers) => {
  const byLine = new Map(markers.map((m) => [m.outputLine, m]));

  return (tree: Root) => {
    visit(tree, "blockquote", (node) => {
      const line = node.position?.start.line;
      const marker = line != null ? byLine.get(line) : undefined;
      if (!marker) return;

      const data = node.data || (node.data = {});

      // marker.title is "" when no explicit title was given in the
      // source (see preprocessPymdownxBlocks()'s own comment) — the
      // capitalized-type fallback below is applied here, at display time
      // only, so it never gets baked into data that Rich mode's
      // serializer might write back out.
      if (marker.kind === "admonition") {
        const displayTitle = marker.title || marker.type.charAt(0).toUpperCase() + marker.type.slice(1);
        data.hName = "div";
        data.hProperties = { className: ["admonition", marker.type] };
        node.children.unshift({
          type: "paragraph",
          data: { hName: "div", hProperties: { className: ["admonition-title"] } },
          children: [{ type: "text", value: displayTitle }],
        });
      } else if (marker.kind === "details") {
        const displayTitle = marker.title || marker.type.charAt(0).toUpperCase() + marker.type.slice(1);
        // Real <details>/<summary> — free native collapse/expand, and
        // pymdownx's "???+" (open by default) vs "???" (collapsed)
        // maps directly onto the one HTML attribute that already means
        // exactly that, rather than needing any JS to reimplement it.
        data.hName = "details";
        data.hProperties = {
          className: [marker.type],
          open: marker.openByDefault || undefined,
        };
        node.children.unshift({
          type: "paragraph",
          data: { hName: "summary", hProperties: {} },
          children: [{ type: "text", value: displayTitle }],
        });
      } else {
        data.hName = "div";
        data.hProperties = {
          className: ["tabbed-block"],
          "data-tab-set": marker.tabSetId,
          "data-tab-index": marker.tabIndex,
        };
        node.children.unshift({
          type: "paragraph",
          data: { hName: "div", hProperties: { className: ["tabbed-label"] } },
          children: [{ type: "text", value: marker.label }],
        });
      }
    });

    // Second pass: group consecutive same-tab-set blocks (now tagged
    // div.tabbed-block by the visit above) into one div.tabbed-set
    // wrapper — recurses into every level, not just the document root,
    // since a tab set can appear nested (e.g. inside a list item).
    function groupTabs(parent: { children: BlockContent[] }) {
      const children = parent.children;
      const out: BlockContent[] = [];
      let idx = 0;

      while (idx < children.length) {
        const node = children[idx] as any;
        const tabSetId = node.data?.hProperties?.["data-tab-set"];

        if (tabSetId != null && node.data.hProperties["data-tab-index"] === 0) {
          const group = [node];
          let j = idx + 1;
          while (
            j < children.length &&
            (children[j] as any).data?.hProperties?.["data-tab-set"] === tabSetId
          ) {
            group.push(children[j] as any);
            j++;
          }
          out.push({
            type: "blockquote",
            data: { hName: "div", hProperties: { className: ["tabbed-set"] } },
            children: group,
          } as unknown as BlockContent);
          idx = j;
          continue;
        }

        if ("children" in node && Array.isArray(node.children)) {
          groupTabs(node);
        }
        out.push(node);
        idx++;
      }

      parent.children = out;
    }

    groupTabs(tree as unknown as { children: BlockContent[] });
  };
};
