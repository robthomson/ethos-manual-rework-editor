/* frontend/src/components/NavTree.tsx
 *
 * Description of responsibility:
 *   Recursive sidebar rendering of the nav tree from useNav, with a
 *   status badge per page (translated/missing — nothing shown while
 *   browsing English itself) and click-to-select on any page that has
 *   its own content (mdPath set — a pure section header with none
 *   doesn't get a click handler, matching build_toc()'s own "section
 *   header vs. section landing page" distinction on the backend).
 *
 * Info:
 *   Always fully expanded rather than collapsible — the real nav is
 *   only two levels deep (see the live fetch this was verified against),
 *   so collapsing adds UI complexity for no real payoff yet; worth
 *   revisiting if a deeper nav ever needs it.
 */
import type { NavPage } from "../hooks/useNav";

interface NavTreeProps {
  nodes: NavPage[];
  selectedPath: string | null;
  onSelect: (mdPath: string, title: string) => void;
  depth?: number;
}

function StatusBadge({ status }: { status?: NavPage["status"] }) {
  if (!status || status === "source") return null;
  const label = status === "translated" ? "✓" : "—";
  const title = status === "translated" ? "Translated" : "Not translated yet";
  return (
    <span className={`nav-status nav-status-${status}`} title={title}>
      {label}
    </span>
  );
}

export function NavTree({ nodes, selectedPath, onSelect, depth = 0 }: NavTreeProps) {
  return (
    <ul className="nav-tree" style={{ paddingLeft: depth ? "1rem" : 0 }}>
      {nodes.map((node) => {
        const key = `${depth}-${node.mdPath ?? node.title}`;
        const clickable = !!node.mdPath;
        return (
          <li key={key}>
            <div
              className={
                "nav-tree-row" +
                (clickable ? " clickable" : "") +
                (clickable && node.mdPath === selectedPath ? " active" : "")
              }
              onClick={clickable ? () => onSelect(node.mdPath!, node.title) : undefined}
            >
              <span className="nav-tree-title">{node.title}</span>
              <StatusBadge status={node.status} />
            </div>
            {node.children.length > 0 && (
              <NavTree
                nodes={node.children}
                selectedPath={selectedPath}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
