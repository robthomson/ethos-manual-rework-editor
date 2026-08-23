/* frontend/src/hooks/useNav.ts
 *
 * Description of responsibility:
 *   Owns the "browse ethos-manual-rework" state: available branches,
 *   the selected branch/locale, and the nav tree (annotated per page
 *   with translation status) for that pair — backed by
 *   backend/routes/navRoutes.ts, which is anonymous-capable, so none of
 *   this needs sign-in.
 *
 * Info:
 *   Defaults to "main" once branches load (falling back to whatever's
 *   first if "main" isn't there for some reason), and to English until
 *   the toc fetch's own locale list comes back — the locale dropdown
 *   only really becomes meaningful once that list exists.
 *
 *   addLocalPage()/addLocalSection() are the one thing here that doesn't
 *   come from a fetch: a brand-new page or section created via
 *   createNewPage()/createNewSection() (English-only,
 *   backend/workspaceStore.ts) only exists in that workspace's local
 *   mkdocs.yml, not upstream — the live /api/nav/toc this hook otherwise
 *   relies on has no way to know about it until a PR actually merges.
 *   Splicing it into the in-memory tree client-side is what makes a
 *   just-created page or section immediately reachable again (e.g. after
 *   navigating away and back) within the same session, without
 *   pretending the backend's own view of the nav has changed.
 */
import { useCallback, useEffect, useState } from "react";

export interface NavPage {
  title: string;
  mdPath: string | null;
  status?: "translated" | "missing" | "source";
  children: NavPage[];
}

export function useNav() {
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState<string>("main");
  const [locales, setLocales] = useState<Record<string, string>>({ en: "English" });
  const [locale, setLocale] = useState<string>("en");
  const [toc, setToc] = useState<NavPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/nav/branches")
      .then((res) => res.json())
      .then((data: { branches?: string[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        const list = data.branches || [];
        setBranches(list);
        if (list.length && !list.includes("main")) setBranch(list[0]);
      })
      .catch(() => setError("Couldn't reach the backend."));
  }, []);

  // Wrapped in useCallback (not just an effect) so refreshToc() below can
  // re-run the exact same fetch on demand — needed after discardChange()
  // deletes a page/section created this session, since that's the
  // backend's own view of the nav actually changing, unlike
  // addLocalPage()/addLocalSection()'s client-side-only splice.
  const loadToc = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/nav/toc?branch=${encodeURIComponent(branch)}&locale=${encodeURIComponent(locale)}`);
      const data: { locales?: Record<string, string>; toc?: NavPage[]; error?: string } = await res.json();
      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }
      setLocales(data.locales || { en: "English" });
      setToc(data.toc || []);
      setLoading(false);
    } catch {
      setError("Couldn't reach the backend.");
      setLoading(false);
    }
  }, [branch, locale]);

  useEffect(() => {
    loadToc();
  }, [loadToc]);

  // Appends a new leaf under the named top-level section — matches
  // backend/workspaceStore.ts:createNewPage()'s own "top-level section,
  // found by title" placement exactly, so what you see here is where it
  // actually landed in mkdocs.yml.
  function addLocalPage(sectionTitle: string, title: string, mdPath: string) {
    setToc((prev) =>
      prev.map((node) =>
        node.title === sectionTitle
          ? { ...node, children: [...node.children, { title, mdPath, status: "source", children: [] }] }
          : node,
      ),
    );
  }

  // Appends a brand-new top-level section (its own landing page, no
  // children yet) — matches backend/workspaceStore.ts:createNewSection()'s
  // own "push a new top-level nav entry" placement.
  function addLocalSection(title: string, mdPath: string) {
    setToc((prev) => [...prev, { title, mdPath, status: "source", children: [] }]);
  }

  return {
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
    refreshToc: loadToc,
  };
}
