/* frontend/src/preview/attrList.ts
 *
 * Description of responsibility:
 *   Strips trailing `{: .class #id key=val}` attr_list markers
 *   (mkdocs.yml's `attr_list` extension) from rendered text, so they
 *   don't show up as literal syntax noise in the preview.
 *
 * Info:
 *   Deliberately a strip, not a real implementation — actually applying
 *   the referenced classes/ids/attributes to the right element would
 *   need real attr_list semantics (which element an attribute block
 *   attaches to varies by position and block type). For a translator
 *   verifying their text is readable and correctly placed, dropping the
 *   marker cleanly reads far better than leaving `{: .some-class}`
 *   visible at the end of a paragraph, and is honest about not
 *   reproducing the site's exact styling — same "behavior over pixel
 *   fidelity" trade-off preview.py's own docstring already accepted.
 *   Only strips from the last text child of paragraph/heading nodes —
 *   narrow enough that a translator's prose genuinely containing a
 *   literal `{...}` (e.g. describing a Lua table) elsewhere in a line
 *   is never touched.
 */
import { visit } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Root } from "mdast";

const ATTR_LIST_RE = /\s*\{:\s*[^}]*\}\s*$/;

export const remarkStripAttrList: Plugin<[], Root> = () => {
  return (tree: Root) => {
    visit(tree, ["paragraph", "heading"], (node: any) => {
      const children = node.children;
      const last = children[children.length - 1];
      if (last?.type === "text" && ATTR_LIST_RE.test(last.value)) {
        last.value = last.value.replace(ATTR_LIST_RE, "");
      }
    });
  };
};
