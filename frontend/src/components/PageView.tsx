/* frontend/src/components/PageView.tsx
 *
 * Description of responsibility:
 *   Fetches and displays one selected page: English source (left,
 *   always read-only) and the target locale's translation (right) —
 *   read-only for now too, since actual editing needs the local
 *   workspace/save routes, not yet ported (see the approved plan).
 *   This is purely a "browse and verify the nav pipeline shows real
 *   content" step ahead of that.
 *
 * Info:
 *   Not translated yet (locale === "en" branch, or translation === null
 *   from a fresh fetch that hasn't landed) shows the English text on
 *   both sides — matches the eventual editor's own "pre-filled with
 *   English as a starting point" behavior for a missing translation,
 *   not left blank.
 */
import { useEffect, useState } from "react";

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
}

export function PageView({ branch, locale, localeName, mdPath, title }: PageViewProps) {
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);

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
          <div className="page-view-pane-label">English (source)</div>
          <textarea readOnly value={data.source} />
        </div>
        {!isEnglish && (
          <div className="page-view-pane">
            <div className="page-view-pane-label">
              {localeName}
              {data.translation === data.source ? " (not translated yet — showing English)" : ""}
            </div>
            <textarea readOnly value={data.translation ?? data.source} />
          </div>
        )}
      </div>
    </div>
  );
}
