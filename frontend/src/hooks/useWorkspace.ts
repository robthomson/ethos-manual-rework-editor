/* frontend/src/hooks/useWorkspace.ts
 *
 * Description of responsibility:
 *   Owns local-workspace state: the list of existing workspaces, which
 *   one (if any) is active, and its change list — backed by
 *   backend/routes/workspaceRoutes.ts, which needs no GitHub sign-in at
 *   all (see workspaceStore.ts's header comment for why).
 *
 * Info:
 *   The active workspace's name is persisted to localStorage so
 *   reopening the app resumes the same editing session rather than
 *   dropping back to plain browsing — purely a per-viewer convenience,
 *   not a trust boundary (workspaces live entirely on local disk here,
 *   unlike docEditor's own login-scoped ones).
 */
import { useCallback, useEffect, useState } from "react";

export interface WorkspaceMeta {
  name: string;
  locale: string;
  branch: string;
  createdAt: string;
}

export interface ChangeEntry {
  path: string;
  type: "added" | "modified";
}

const ACTIVE_KEY = "ethos_active_workspace";

export function useWorkspace() {
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
  const [activeName, setActiveName] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY) || null,
  );
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    const res = await fetch("/api/workspace");
    const data = await res.json();
    setWorkspaces(data.workspaces || []);
  }, []);

  useEffect(() => {
    refreshWorkspaces();
  }, [refreshWorkspaces]);

  const refreshChanges = useCallback(async () => {
    if (!activeName) {
      setChanges([]);
      return;
    }
    const res = await fetch(`/api/workspace/${encodeURIComponent(activeName)}/changes`);
    const data = await res.json();
    setChanges(data.changes || []);
  }, [activeName]);

  useEffect(() => {
    refreshChanges();
  }, [refreshChanges]);

  const active = workspaces.find((w) => w.name === activeName) || null;

  // A previously-active workspace that no longer exists (e.g. deleted on
  // a prior run, or its localStorage entry is stale) shouldn't silently
  // keep claiming to be "active" with no real backing data.
  useEffect(() => {
    if (activeName && workspaces.length > 0 && !active) {
      setActiveName(null);
      localStorage.removeItem(ACTIVE_KEY);
    }
  }, [activeName, active, workspaces]);

  function selectWorkspace(name: string | null) {
    setActiveName(name);
    if (name) localStorage.setItem(ACTIVE_KEY, name);
    else localStorage.removeItem(ACTIVE_KEY);
  }

  async function createWorkspace(name: string, branch: string, locale: string) {
    setError(null);
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, branch, locale }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to create workspace.");
      return false;
    }
    await refreshWorkspaces();
    selectWorkspace(name);
    return true;
  }

  async function deleteWorkspace(name: string) {
    await fetch(`/api/workspace/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (activeName === name) selectWorkspace(null);
    await refreshWorkspaces();
  }

  return {
    workspaces,
    active,
    selectWorkspace,
    createWorkspace,
    deleteWorkspace,
    changes,
    refreshChanges,
    error,
  };
}
