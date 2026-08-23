/* frontend/src/components/WorkspaceBar.tsx
 *
 * Description of responsibility:
 *   Sidebar panel for local-workspace management: pick an existing
 *   workspace, create a new one (name + which branch/locale it's for),
 *   and see its pending changes (added/modified pages) — the frontend
 *   half of useWorkspace.ts.
 *
 * Info:
 *   The "new workspace" form always uses the branch currently selected
 *   in the top bar, not an editable field of its own — you're already
 *   looking at that branch when you click "+ New", so re-asking would
 *   just be a chance to accidentally create a workspace for a branch
 *   you're not actually looking at. Locale is still a real choice (the
 *   whole reason to have more than one workspace), pre-selected to the
 *   currently browsed locale as a starting point.
 *
 *   Each entry in the Changes list is clickable (onSelectChange), same
 *   as a NavTree row — App.tsx resolves the entry's bare mdPath back to
 *   its nav title (falling back to the path itself if the page isn't in
 *   the currently-loaded toc for some reason) rather than this component
 *   knowing anything about nav structure itself. `selectedPath` mirrors
 *   NavTree's own "active" highlighting, so a change opened from here
 *   reads as selected here too, not just in the nav tree above it.
 *
 *   Each entry also has its own discard ("↺") button, independent of
 *   whether that page happens to be the one currently open — App.tsx's
 *   discardPageChange() is the same one EditablePageView.tsx's own
 *   "Discard changes" button calls, just targeting a possibly-different
 *   path. Confirms first (unlike onDelete's own workspace-deletion
 *   button below, which doesn't) since this can throw away real,
 *   possibly-substantial translation work, not just an empty workspace
 *   shell. stopPropagation so clicking it doesn't also trigger the row's
 *   own onSelectChange and open the page you're discarding.
 */
import { useEffect, useState, type MouseEvent } from "react";
import type { ChangeEntry, WorkspaceMeta } from "../hooks/useWorkspace";

interface WorkspaceBarProps {
  workspaces: WorkspaceMeta[];
  active: WorkspaceMeta | null;
  onSelect: (name: string | null) => void;
  onCreate: (name: string, locale: string) => Promise<boolean>;
  onDelete: (name: string) => void;
  changes: ChangeEntry[];
  onSelectChange: (mdPath: string) => void;
  onDiscardChange: (mdPath: string) => Promise<{ ok: boolean; error?: string }>;
  selectedPath: string | null;
  createError: string | null;
  branch: string;
  defaultLocale: string;
  locales: Record<string, string>;
}

export function WorkspaceBar({
  workspaces,
  active,
  onSelect,
  onCreate,
  onDelete,
  changes,
  onSelectChange,
  onDiscardChange,
  selectedPath,
  createError,
  branch,
  defaultLocale,
  locales,
}: WorkspaceBarProps) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [locale, setLocale] = useState(defaultLocale);
  const [creating, setCreating] = useState(false);

  // Keeps the preselected locale in sync with whatever's currently
  // browsed if the form is opened fresh under a different one — but
  // only while it hasn't been touched yet (see the input below), so it
  // doesn't yank a choice out from under someone mid-edit of the form.
  useEffect(() => {
    if (!showNew) setLocale(defaultLocale);
  }, [defaultLocale, showNew]);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    const ok = await onCreate(name.trim(), locale);
    setCreating(false);
    if (ok) {
      setShowNew(false);
      setName("");
    }
  }

  async function handleDiscardClick(e: MouseEvent, mdPath: string) {
    e.stopPropagation();
    if (!window.confirm(`Discard local changes to "${mdPath}"? This can't be undone.`)) return;
    const result = await onDiscardChange(mdPath);
    if (!result.ok) window.alert(result.error || "Couldn't discard changes — please try again.");
  }

  return (
    <div className="workspace-bar">
      <div className="workspace-bar-header">
        <strong>Workspace</strong>
        <button className="link-button" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Cancel" : "+ New"}
        </button>
      </div>

      {showNew && (
        <div className="workspace-new-form">
          <input
            type="text"
            placeholder="e.g. fr-batch-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <div className="workspace-new-form-row">
            <span className="workspace-new-form-branch" title="Branch — matches whatever's browsed in the top bar">
              {branch}
            </span>
            <select value={locale} onChange={(e) => setLocale(e.target.value)}>
              {Object.entries(locales).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {createError && <p className="workspace-error">{createError}</p>}
          <button disabled={creating || !name.trim()} onClick={handleCreate}>
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      )}

      {workspaces.length > 0 && (
        <ul className="workspace-list">
          {workspaces.map((ws) => (
            <li key={ws.name} className={ws.name === active?.name ? "active" : ""}>
              <span onClick={() => onSelect(ws.name === active?.name ? null : ws.name)}>
                {ws.name} <em>({locales[ws.locale] || ws.locale})</em>
              </span>
              <button className="workspace-delete-btn" title="Delete workspace" onClick={() => onDelete(ws.name)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {active && (
        <div className="workspace-changes">
          <div className="workspace-changes-header">
            Changes ({changes.length})
          </div>
          {changes.length === 0 && <p className="workspace-changes-empty">Nothing edited yet.</p>}
          <ul>
            {changes.map((c) => (
              <li
                key={c.path}
                className={"clickable" + (c.path === selectedPath ? " active" : "")}
                onClick={() => onSelectChange(c.path)}
              >
                <span className={`change-badge change-${c.type}`}>{c.type === "added" ? "+" : "~"}</span>
                <span className="change-path">{c.path}</span>
                <button
                  className="change-discard-btn"
                  title="Discard changes to this page"
                  onClick={(e) => handleDiscardClick(e, c.path)}
                >
                  ↺
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
