/* frontend/src/App.tsx
 *
 * Description of responsibility:
 *   Root application component. Browsing (branch/locale pick, the nav
 *   tree, reading a page) is anonymous-capable end to end — see
 *   navRoutes.ts's header comment — so it's the main screen regardless
 *   of sign-in state, matching ethos-manual-rework-editor's own Python
 *   app ("browsing doesn't require signing in at all"). Local-workspace
 *   editing (WorkspaceBar/useWorkspace, EditablePageView) is the same:
 *   no sign-in needed, see workspaceStore.ts's header comment for why.
 *   Sign-in is a compact top-bar action, needed only once actual
 *   submitting is wired up (not yet — see the approved plan).
 *
 * Info:
 *   Editing turns on automatically: a useEffect calls
 *   ensureDefaultWorkspace() (useWorkspace.ts) whenever the browsed
 *   branch/locale changes, which creates-or-reuses a deterministically-
 *   named default workspace for that exact pair — there's no separate
 *   "start editing" step to discover. Explicitly creating/picking a
 *   *named* workspace (WorkspaceBar's own "+ New"/list, still there for
 *   anyone who wants extra parallel sessions, e.g. "fr-batch-2") snaps
 *   the browse selectors to match it, same reasoning: editing only
 *   makes sense in that specific locale, so the two stay in sync rather
 *   than diverging. Switching branch/locale away from whatever's active
 *   doesn't lose anything, though — it just means the next page you open
 *   is edited in *that* pair's own (auto-provisioned or named) workspace
 *   instead, which isEditing below reflects directly.
 */
import "./App.css";
import { useEffect, useState } from "react";
import { useAuth } from "./hooks/useAuth";
import { useNav } from "./hooks/useNav";
import { useWorkspace } from "./hooks/useWorkspace";
import { NavTree } from "./components/NavTree";
import { PageView } from "./components/PageView";
import { EditablePageView } from "./components/EditablePageView";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { NewPageModal } from "./components/NewPageModal";
import { NewSectionModal } from "./components/NewSectionModal";

export default function App() {
  const {
    user,
    login,
    isAuthenticated,
    authStep,
    userCode,
    verificationUri,
    authError,
    appInstalled,
    appInstallUrl,
    startGitHubLogin,
    logout,
  } = useAuth();

  const {
    branches,
    branch,
    setBranch,
    locales,
    locale,
    setLocale,
    toc,
    loading,
    error,
    addLocalPage,
    addLocalSection,
  } = useNav();

  const {
    workspaces,
    workspacesLoaded,
    active: activeWorkspace,
    selectWorkspace,
    createWorkspace,
    deleteWorkspace,
    ensureDefaultWorkspace,
    changes,
    refreshChanges,
    error: workspaceError,
  } = useWorkspace();

  const [selectedPage, setSelectedPage] = useState<{ mdPath: string; title: string } | null>(null);
  const [showNewPageModal, setShowNewPageModal] = useState(false);
  const [showNewSectionModal, setShowNewSectionModal] = useState(false);

  // Editing just works as soon as a locale's picked — see this file's
  // header comment for why this replaced requiring an explicit "create a
  // workspace" step. Waits on workspacesLoaded so the very first render
  // (before the initial GET /api/workspace has even resolved) doesn't
  // create a duplicate of a default workspace that already exists.
  useEffect(() => {
    if (!workspacesLoaded || !branch || !locale) return;
    ensureDefaultWorkspace(branch, locale);
  }, [branch, locale, workspacesLoaded, ensureDefaultWorkspace]);

  function changeBranch(next: string) {
    setBranch(next);
    setSelectedPage(null);
  }

  function changeLocale(next: string) {
    setLocale(next);
    setSelectedPage(null);
  }

  // Editing only makes sense while browsing the exact branch/locale the
  // active workspace was created for — selecting/creating one snaps the
  // browse selectors to match, once, rather than leaving them wherever
  // they happened to be.
  function selectWorkspaceAndSync(name: string | null) {
    selectWorkspace(name);
    const ws = workspaces.find((w) => w.name === name);
    if (ws) {
      setBranch(ws.branch);
      setLocale(ws.locale);
      setSelectedPage(null);
    }
  }

  // branch is never a caller-supplied choice here — a new workspace
  // always targets whichever branch is currently being browsed (see
  // WorkspaceBar's own header comment for why offering it as a separate
  // editable field was a mistake: you're already looking at that
  // branch, so re-asking is just a chance to create one for the wrong
  // branch by accident).
  async function handleCreateWorkspace(name: string, wsLocale: string) {
    const ok = await createWorkspace(name, branch, wsLocale);
    if (ok) {
      setLocale(wsLocale);
      setSelectedPage(null);
    }
    return ok;
  }

  const isEditing =
    !!activeWorkspace && activeWorkspace.branch === branch && activeWorkspace.locale === locale;

  // "New page" is only ever available from an English workspace —
  // every other locale only ever translates pages the nav already
  // lists, never invents its own (createNewPage() enforces this
  // server-side too, this is just what shows the button at all).
  const canAuthorNewPages = isEditing && activeWorkspace!.locale === "en";

  // Sections a new page can go under: top-level nav nodes with their
  // own landing page — matches backend/workspaceStore.ts's own
  // findSectionLandingPath() requirement exactly (it derives the new
  // page's folder from that landing page's path).
  const newPageSections = toc.filter((node) => !!node.mdPath);

  async function handleCreateNewPage(title: string, slug: string, sectionTitle: string) {
    if (!activeWorkspace) return { ok: false, error: "No active workspace." };

    const res = await fetch(`/api/workspace/${encodeURIComponent(activeWorkspace.name)}/new-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, slug, sectionTitle }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "Failed to create the page." };

    addLocalPage(sectionTitle, title, data.mdPath);
    await refreshChanges();
    setSelectedPage({ mdPath: data.mdPath, title });
    return { ok: true };
  }

  async function handleCreateNewSection(title: string, slug: string) {
    if (!activeWorkspace) return { ok: false, error: "No active workspace." };

    const res = await fetch(`/api/workspace/${encodeURIComponent(activeWorkspace.name)}/new-section`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, slug }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "Failed to create the section." };

    addLocalSection(title, data.mdPath);
    await refreshChanges();
    setSelectedPage({ mdPath: data.mdPath, title });
    return { ok: true };
  }

  // Re-check the change list whenever the selected page or editing
  // context changes — cheap (a local directory diff, no GitHub call —
  // see scanChanges()), and keeps the sidebar's count from lagging a
  // save made while looking at a different page.
  useEffect(() => {
    if (isEditing) refreshChanges();
  }, [isEditing, selectedPage, refreshChanges]);

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <h1 className="app-title">Ethos Manual Translator</h1>

        <div className="app-topbar-controls">
          <label>
            Branch{" "}
            <select value={branch} onChange={(e) => changeBranch(e.target.value)}>
              {(branches.length ? branches : [branch]).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>

          <label>
            Language{" "}
            <select value={locale} onChange={(e) => changeLocale(e.target.value)}>
              {Object.entries(locales).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="app-topbar-auth">
          {isAuthenticated ? (
            <>
              <span className="auth-status">
                Signed in as <strong>{user?.name || login}</strong>
                {appInstalled === false && appInstallUrl && (
                  <>
                    {" — "}
                    <a href={appInstallUrl} target="_blank" rel="noopener noreferrer">
                      install the GitHub App to submit
                    </a>
                  </>
                )}
              </span>
              <button onClick={logout}>Sign out</button>
            </>
          ) : authStep === "polling" ? (
            <span className="auth-status">
              Enter <strong>{userCode}</strong> at{" "}
              <a href={verificationUri} target="_blank" rel="noopener noreferrer">
                github.com
              </a>
            </span>
          ) : (
            <>
              {authError && <span className="auth-error-inline">{authError}</span>}
              <button onClick={startGitHubLogin}>Sign in with GitHub</button>
            </>
          )}
        </div>
      </header>

      <div className="app-body">
        <aside className="app-sidebar">
          <WorkspaceBar
            workspaces={workspaces}
            active={activeWorkspace}
            onSelect={selectWorkspaceAndSync}
            onCreate={handleCreateWorkspace}
            onDelete={deleteWorkspace}
            changes={changes}
            createError={workspaceError}
            branch={branch}
            defaultLocale={locale === "en" ? Object.keys(locales).find((l) => l !== "en") || "en" : locale}
            locales={locales}
          />

          {canAuthorNewPages && (
            <div className="new-page-row">
              <button className="new-item-button" onClick={() => setShowNewPageModal(true)}>
                + New Page
              </button>
              <button className="new-item-button" onClick={() => setShowNewSectionModal(true)}>
                + New Section
              </button>
            </div>
          )}

          {loading && <div className="nav-loading">Loading nav…</div>}
          {error && <div className="nav-error">{error}</div>}
          {!loading && !error && (
            <NavTree
              nodes={toc}
              selectedPath={selectedPage?.mdPath ?? null}
              onSelect={(mdPath, title) => setSelectedPage({ mdPath, title })}
            />
          )}
        </aside>

        {showNewPageModal && (
          <NewPageModal
            sections={newPageSections}
            onCreate={handleCreateNewPage}
            onClose={() => setShowNewPageModal(false)}
          />
        )}

        {showNewSectionModal && (
          <NewSectionModal onCreate={handleCreateNewSection} onClose={() => setShowNewSectionModal(false)} />
        )}

        <main className="app-main">
          {selectedPage ? (
            isEditing ? (
              <EditablePageView
                key={`${activeWorkspace!.name}:${selectedPage.mdPath}`}
                workspace={activeWorkspace!.name}
                branch={activeWorkspace!.branch}
                locale={locale}
                localeName={locales[locale] || locale}
                mdPath={selectedPage.mdPath}
                title={selectedPage.title}
                onSaved={refreshChanges}
              />
            ) : (
              <PageView
                key={`${branch}:${locale}:${selectedPage.mdPath}`}
                branch={branch}
                locale={locale}
                localeName={locales[locale] || locale}
                mdPath={selectedPage.mdPath}
                title={selectedPage.title}
              />
            )
          ) : (
            <div className="app-main-placeholder">Pick a page from the nav to view it.</div>
          )}
        </main>
      </div>
    </div>
  );
}
