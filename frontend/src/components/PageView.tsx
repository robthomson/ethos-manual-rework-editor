/* frontend/src/components/PageView.tsx
 *
 * Description of responsibility:
 *   Fetches and displays one selected page: English source (left) and
 *   the target locale's translation (right) — both read-only here
 *   (real editing is EditablePageView.tsx's job, once a workspace is
 *   active). Each side can be toggled between raw source and the real
 *   rendered preview (preview/renderMarkdown.tsx) independently.
 *
 * Info:
 *   Not translated yet (locale === "en" branch, or translation === null
 *   from a fresh fetch that hasn't landed) shows the English text on
 *   both sides — matches the editor's own "pre-filled with English as a
 *   starting point" behavior for a missing translation, not left blank.
 */
import { useEffect, useState } from "react";
import { MarkdownPreview } from "../preview/renderMarkdown";
import { ExternalLinkModal } from "./ExternalLinkModal";
import { useExternalLinkGuard } from "../hooks/useExternalLinkGuard";

interface PageData {
  source: string;
  translation: string | null;
  stale: boolean | null;
  frontmatter?: Record<string, unknown>;
  error?: string;
}

interface PageViewProps {
  branch: string;
  locale: string;
  localeName: string;
  mdPath: string;
  title: string;
  // See renderMarkdown.tsx's MarkdownPreviewProps.onNavigate — App.tsx's
  // own page-selection setter, so an in-content link navigates within
  // the app the same way clicking that page in the nav tree would.
  onNavigate: (mdPath: string) => void;
}

type PaneMode = "source" | "preview";

function PaneModeToggle({ mode, onChange }: { mode: PaneMode; onChange: (m: PaneMode) => void }) {
  return (
    <div className="pane-mode-toggle">
      <button className={mode === "source" ? "active" : ""} onClick={() => onChange("source")}>
        Source
      </button>
      <button className={mode === "preview" ? "active" : ""} onClick={() => onChange("preview")}>
        Preview
      </button>
    </div>
  );
}

export function PageView({ branch, locale, localeName, mdPath, title, onNavigate }: PageViewProps) {
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [englishMode, setEnglishMode] = useState<PaneMode>("source");
  const [translationMode, setTranslationMode] = useState<PaneMode>("source");
  const externalLinkGuard = useExternalLinkGuard();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);

    const params = new URLSearchParams({ branch, locale, path: mdPath });
    fetch(`/api/nav/page?${params}`)
      .then((res) => res.json())
      .then((json: PageData) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData({ source: "", translation: null, stale: null, error: "Couldn't load this page." });
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [branch, locale, mdPath]);

  if (loading) {
    return <div className="page-view-loading">Loading {title}…</div>;
  }

  if (!data || data.error) {
    return <div className="page-view-error">{data?.error || "Couldn't load this page."}</div>;
  }

  const isEnglish = locale === "en";
  const translationContent = data.translation ?? data.source;

  return (
    <div className="page-view">
      <div className="page-view-header">
        <h3>{title}</h3>
        {data.stale === true && (
          <span className="stale-badge" title="The English source has changed since this was translated">
            Stale — English source has since changed
          </span>
        )}
        {data.stale === false && <span className="fresh-badge">Up to date with English</span>}
      </div>

      <div className="page-view-panes">
        <div className="page-view-pane">
          <div className="page-view-pane-label">
            English (source)
            <PaneModeToggle mode={englishMode} onChange={setEnglishMode} />
          </div>
          {englishMode === "source" ? (
            <textarea readOnly value={data.source} />
          ) : (
            <div className="preview-scroll">
              <MarkdownPreview
                content={data.source}
                branch={branch}
                locale="en"
                mdPath={mdPath}
                onNavigate={onNavigate}
                onExternalLink={externalLinkGuard.requestOpen}
              />
            </div>
          )}
        </div>
        {!isEnglish && (
          <div className="page-view-pane">
            <div className="page-view-pane-label">
              {localeName}
              {translationContent === data.source ? " (not translated yet — showing English)" : ""}
              <PaneModeToggle mode={translationMode} onChange={setTranslationMode} />
            </div>
            {translationMode === "source" ? (
              <textarea readOnly value={translationContent} />
            ) : (
              <div className="preview-scroll">
                <MarkdownPreview
                  content={translationContent}
                  branch={branch}
                  locale={locale}
                  mdPath={mdPath}
                  onNavigate={onNavigate}
                  onExternalLink={externalLinkGuard.requestOpen}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {externalLinkGuard.pendingUrl && (
        <ExternalLinkModal
          url={externalLinkGuard.pendingUrl}
          onConfirm={externalLinkGuard.confirm}
          onCancel={externalLinkGuard.cancel}
        />
      )}
    </div>
  );
}
