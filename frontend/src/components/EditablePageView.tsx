/* frontend/src/components/EditablePageView.tsx
 *
 * Description of responsibility:
 *   The editing counterpart to PageView.tsx: English source stays
 *   read-only on the left (fetched via the same anonymous nav endpoint
 *   PageView.tsx uses — the workspace only ever materializes the
 *   *target locale* page, never English, since English is never
 *   edited), but the right pane is a real editable textarea bound to a
 *   local workspace page (materialized/saved via
 *   backend/routes/workspaceRoutes.ts), autosaving on a short pause in
 *   typing rather than requiring an explicit save click.
 *
 * Info:
 *   isNew (no upstream translation existed — this page starts from the
 *   English source, matching ensurePageMaterialized()'s own behavior)
 *   is shown as a badge rather than silently indistinguishable from an
 *   existing translation someone's editing further — same reasoning as
 *   PageView's stale badge. When isNew, the workspace's own materialized
 *   content already *is* the English text, so that single fetch is
 *   reused for both panes instead of asking the backend for the same
 *   bytes twice.
 *
 *   Autosave debounce (1200ms of no typing) mirrors the general shape
 *   of docEditor's own useAutosave hook, just inlined here rather than
 *   factored out yet — worth revisiting once more editor surfaces need
 *   the same pattern.
 */
import { useEffect, useRef, useState } from "react";

interface EditablePageData {
  content: string;
  isNew: boolean;
  error?: string;
}

interface EditablePageViewProps {
  workspace: string;
  branch: string;
  localeName: string;
  mdPath: string;
  title: string;
  onSaved: () => void;
}

export function EditablePageView({
  workspace,
  branch,
  localeName,
  mdPath,
  title,
  onSaved,
}: EditablePageViewProps) {
  const [englishSource, setEnglishSource] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against saving stale content from a page that's since been
  // navigated away from — the debounce timer set up for page A shouldn't
  // still fire and save into page B just because this component instance
  // is being reused across the mdPath change.
  const currentKeyRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    const key = `${workspace}:${mdPath}`;
    currentKeyRef.current = key;

    setLoading(true);
    setLoadError(null);
    setEnglishSource(null);

    async function load() {
      try {
        const pageRes = await fetch(
          `/api/workspace/${encodeURIComponent(workspace)}/page?path=${encodeURIComponent(mdPath)}`,
        );
        const pageData: EditablePageData = await pageRes.json();
        if (cancelled) return;

        if (pageData.error) {
          setLoadError(pageData.error);
          setLoading(false);
          return;
        }

        setContent(pageData.content);
        setIsNew(pageData.isNew);

        if (pageData.isNew) {
          // The materialized workspace copy already *is* a straight copy
          // of English — reuse it rather than fetching the same bytes
          // again from the nav endpoint.
          setEnglishSource(pageData.content);
          setLoading(false);
          return;
        }

        const englishParams = new URLSearchParams({ branch, locale: "en", path: mdPath });
        const englishRes = await fetch(`/api/nav/page?${englishParams}`);
        const englishData: { source?: string; error?: string } = await englishRes.json();
        if (cancelled) return;

        setEnglishSource(englishData.source ?? "");
        setLoading(false);
      } catch {
        if (!cancelled) {
          setLoadError("Couldn't load this page.");
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [workspace, branch, mdPath]);

  function handleChange(next: string) {
    setContent(next);
    setSaveState("idle");

    if (saveTimer.current) clearTimeout(saveTimer.current);
    const key = currentKeyRef.current;

    saveTimer.current = setTimeout(async () => {
      if (currentKeyRef.current !== key) return; // navigated away — don't save into the wrong page
      setSaveState("saving");
      try {
        const res = await fetch(`/api/workspace/${encodeURIComponent(workspace)}/page`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: mdPath, content: next }),
        });
        if (!res.ok) throw new Error("save failed");
        if (currentKeyRef.current === key) {
          setSaveState("saved");
          onSaved();
        }
      } catch {
        if (currentKeyRef.current === key) setSaveState("error");
      }
    }, 1200);
  }

  if (loading) return <div className="page-view-loading">Loading {title}…</div>;
  if (loadError) return <div className="page-view-error">{loadError}</div>;

  return (
    <div className="page-view">
      <div className="page-view-header">
        <h3>{title}</h3>
        {isNew && <span className="stale-badge">New translation — not yet saved upstream</span>}
        {saveState === "saving" && <span className="save-indicator">Saving…</span>}
        {saveState === "saved" && <span className="save-indicator saved">Saved locally</span>}
        {saveState === "error" && <span className="save-indicator error">Save failed</span>}
      </div>

      <div className="page-view-panes">
        <div className="page-view-pane">
          <div className="page-view-pane-label">English (source)</div>
          <textarea readOnly value={englishSource ?? ""} />
        </div>
        <div className="page-view-pane">
          <div className="page-view-pane-label">{localeName} (editing)</div>
          <textarea value={content} onChange={(e) => handleChange(e.target.value)} />
        </div>
      </div>
    </div>
  );
}
