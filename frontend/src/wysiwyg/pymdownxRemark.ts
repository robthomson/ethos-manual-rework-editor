/* frontend/src/wysiwyg/pymdownxRemark.ts
 *
 * Description of responsibility:
 *   The mdast-level half of pymdownx admonition/details support in Rich
 *   mode: retags the blockquote-form mdast nodes preprocessPymdownxBlocks()
 *   produces into real "admonition"/"details" mdast node types, so
 *   Milkdown's own parseMarkdown dispatch (which reads real node.type,
 *   see pymdownxSchema.ts) picks them up as those custom nodes instead of
 *   plain blockquotes.
 *
 * Info:
 *   Deliberately NOT a reuse of preview/pymdownxBlocks.ts's own
 *   remarkPymdownxBlocks() — that plugin sets hast-only data
 *   (hName/hProperties), consumed by remark-rehype in the *preview*'s
 *   separate pipeline. Milkdown's own remarkCtx never runs remark-rehype
 *   at all (confirmed: @milkdown/core's remarkCtx is a bare
 *   unified().use(remarkParse).use(remarkStringify), no rehype) — so this
 *   plugin mutates node.type for real instead, which is what
 *   parseMarkdown.match (pymdownxSchema.ts) actually dispatches on. The
 *   line-position marker-matching logic itself (byLine map, keyed on the
 *   *preprocessed* text's own line numbers) is copied from
 *   remarkPymdownxBlocks() unchanged — same trick, different output
 *   shape.
 *
 *   Tabs are deliberately left untouched here (still literal blockquote
 *   nodes) — pages containing `=== "Label"` stay gated to Source mode
 *   entirely (see pymdownxBlocks.ts:containsPymdownxBlocks(), narrowed to
 *   only check for tabs now that admonitions/details are supported), so
 *   this plugin never actually sees a real page containing a tab marker
 *   in practice; skipping them here is just defensive, not load-bearing.
 *
 *   Markers must be supplied fresh per parse, not baked in once at editor-
 *   creation time — a $remark plugin's options are just another ctx slice
 *   (admonitionRemark.options.key below), updatable the same way
 *   WysiwygEditor.tsx already updates remarkStringifyOptionsCtx for the
 *   bullet-marker fix. See that file for where this actually gets
 *   refreshed (mount, and any later replaceAll on external content
 *   change) — each call to preprocessPymdownxBlocks() produces markers
 *   whose outputLine values are only valid against that exact call's own
 *   rewritten text, so stale markers from a previous parse would silently
 *   mismatch.
 */
import { visit } from "unist-util-visit";
import { $remark } from "@milkdown/kit/utils";
import type { BlockMarker } from "../preview/pymdownxBlocks";

export const admonitionRemark = $remark(
  "pymdownxAdmonitions",
  () => (markers: BlockMarker[] = []) => (tree: any) => {
    const byLine = new Map(markers.map((m) => [m.outputLine, m]));

    visit(tree, "blockquote", (node: any) => {
      const line = node.position?.start.line;
      const marker = line != null ? byLine.get(line) : undefined;
      if (!marker || marker.kind === "tab") return;

      if (marker.kind === "admonition") {
        node.type = "admonition";
        node.admonitionType = marker.type;
        node.title = marker.title;
      } else {
        node.type = "details";
        node.admonitionType = marker.type;
        node.title = marker.title;
        node.openByDefault = marker.openByDefault;
      }
    });
  },
  [] as BlockMarker[],
);

// ---------------------------------------------------------------------
// mdast -> markdown-text handlers for the synthetic "admonition"/
// "details" node types built by pymdownxSchema.ts's toMarkdown runners
// (via Milkdown's SerializerState.openNode/next/closeNode — produces a
// plain {type, admonitionType, title, children} object, mdast-shaped but
// not a real mdast type remark-stringify knows). Registered via
// WysiwygEditor.tsx's ctx.update(remarkStringifyOptionsCtx, ...) — the
// same public `handlers` extension point remark-gfm/remark-frontmatter
// themselves use, confirmed reachable without any deep import into
// mdast-util-to-markdown's own internals (its package.json `exports`
// field blocks those anyway).
//
// Modeled directly on that package's own built-in blockquote handler
// (mdast-util-to-markdown/lib/handle/blockquote.js — not importable, but
// readable from disk as the exact template): a Tracker for the heading
// line, then state.indentLines(state.containerFlow(node, ...), map) for
// the body, just with a 4-space `map` instead of blockquote's `"> "`.
//
// Deliberately skips state.enter()/exit() (unlike blockquote's own
// handler) — mdast-util-to-markdown's `ConstructName` is a closed union
// of its own built-in construct names, so "admonition"/"details" aren't
// valid arguments to it. enter/exit only matters for that package's own
// construct-aware unsafe-character-escaping rules, which nothing here
// defines or needs.
function fourSpaceMap(line: string, _index: number, blank: boolean): string {
  return blank ? "" : `    ${line}`;
}

export function admonitionToMarkdownHandler(node: any, _parent: any, state: any, info: any): string {
  const heading = `!!! ${node.admonitionType}${node.title ? ` "${node.title}"` : ""}\n`;
  const tracker = state.createTracker(info);
  tracker.move(heading);
  const body = state.indentLines(state.containerFlow(node, tracker.current()), fourSpaceMap);
  return heading + body;
}

export function detailsToMarkdownHandler(node: any, _parent: any, state: any, info: any): string {
  const marker = node.openByDefault ? "???+" : "???";
  const heading = `${marker} ${node.admonitionType}${node.title ? ` "${node.title}"` : ""}\n`;
  const tracker = state.createTracker(info);
  tracker.move(heading);
  const body = state.indentLines(state.containerFlow(node, tracker.current()), fourSpaceMap);
  return heading + body;
}
