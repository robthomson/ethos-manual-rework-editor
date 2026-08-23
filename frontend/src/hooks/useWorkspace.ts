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
 *
 *   ensureDefaultWorkspace() is App.tsx's own auto-provisioning hook:
 *   editing used to require explicitly creating/picking a workspace
 *   before it turned on at all, which wasn't discoverable enough (it
 *   read as "browsing is read-only, nothing obviously tells you why, or
 *   how to fix it"). Every (branch, locale) pair now gets a
 *   deterministically-named default workspace, created transparently the
 *   first time it's needed and reused after that — editing just works
 *   as soon as you pick a locale and open a page. The explicit named-
 *   workspace picker (createWorkspace/selectWorkspace, below) still
 *   exists for anyone who wants extra parallel sessions (e.g.
 *   "fr-batch-2") on top of that default.
 */
import { useCallback, useEffect, useRef, useState } from "react";

function defaultWorkspaceName(branch: string, locale: string): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9-]+/g, "-");
  return `default-${sanitize(branch)}-${sanitize(locale)}`;
}

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
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeName, setActiveName] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY) || null,
  );
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    const res = await fetch("/api/workspace");
    const data = await res.json();
    setWorkspaces(data.workspaces || []);
    setWorkspacesLoaded(true);
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

  // Guards against firing twice for the same (branch, locale) while the
  // create request for it is still in flight — workspaces (the list this
  // effect-driven call checks against) only updates once
  // refreshWorkspaces() resolves, so without this a fast branch/locale
  // bounce (or React's own effect double-invoke in dev) could kick off a
  // second createWorkspace() for the same default name before the first
  // one's response ever lands.
  const ensuringRef = useRef<string | null>(null);

  const ensureDefaultWorkspace = useCallback(
    async (branch: string, locale: string) => {
      const name = defaultWorkspaceName(branch, locale);
      if (activeName === name || ensuringRef.current === name) return;

      const existing = workspaces.find((w) => w.name === name);
      if (existing) {
        selectWorkspace(name);
        return;
      }

      ensuringRef.current = name;
      try {
        await createWorkspace(name, branch, locale);
      } finally {
        ensuringRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeName, workspaces],
  );

  return {
    workspaces,
    workspacesLoaded,
    active,
    selectWorkspace,
    createWorkspace,
    deleteWorkspace,
    ensureDefaultWorkspace,
    changes,
    refreshChanges,
    error,
  };
}
