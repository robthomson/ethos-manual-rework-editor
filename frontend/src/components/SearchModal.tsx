/* frontend/src/components/SearchModal.tsx
 *
 * Description of responsibility:
 *   Full-text search across every page's content for the currently
 *   browsed branch+locale (backend/routes/navRoutes.ts's GET
 *   /api/nav/search) — not just titles, which the sidebar's own
 *   always-expanded nav tree already covers by scrolling/scanning.
 *   Useful for a translator checking how a term was translated
 *   elsewhere, or finding every mention of a specific menu name to keep
 *   translations consistent.
 *
 * Info:
 *   Same modal-overlay/modal-box shell every other modal in this app
 *   already uses (NewPageModal.tsx, NewSectionModal.tsx,
 *   ExternalLinkModal.tsx) — no new CSS pattern needed for the shell
 *   itself, just a couple of search-specific classes (search-results,
 *   search-result, search-empty) added alongside the existing modal.css
 *   rules.
 *
 *   Debounced the same way renderMarkdown.tsx's own MarkdownPreview
 *   debounces re-rendering (useEffect + `let cancelled` + clearTimeout)
 *   — no shared debounce hook exists anywhere in this codebase to reuse
 *   instead, confirmed; this is a third instance of that same
 *   already-established inline pattern, not a new one.
 *
 *   Highlighting the query inside each snippet is done here, client
 *   side, via a simple case-insensitive split-and-wrap on the already-
 *   short (~120 char) snippet string the backend returns — no need for
 *   the backend to report match character offsets separately just for
 *   this.
 */
import { useEffect, useState } from "react";

interface SearchResult {
  mdPath: string;
  title: string;
  titleMatch: boolean;
  snippet: string;
}

interface SearchResponse {
  results: SearchResult[];
  // True when one or more pages couldn't be fetched while building the
  // index — most commonly GitHub's own anonymous rate limit, which a
  // repo this size (~76 pages) can exhaust in a single search (see
  // navRoutes.ts's own comment on this). Shown as a small honest note
  // rather than silently presenting a partial index as if it were
  // complete.
  partial: boolean;
}

interface SearchModalProps {
  branch: string;
  locale: string;
  onNavigate: (mdPath: string) => void;
  onClose: () => void;
}

// Same minimum the backend enforces (navRoutes.ts) — kept in sync so a
// 1-char query never even fires a request, not just relies on the
// server to reject it cheaply.
const MIN_QUERY_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 350;

// Wraps every case-insensitive occurrence of `query` in `text` with
// <mark>. `text` here is always one already-short snippet or title, so
// no need to worry about this being expensive.
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let idx: number;
  while ((idx = lower.indexOf(needle, i)) !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + query.length)}</mark>);
    i = idx + query.length;
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

export function SearchModal({ branch, locale, onNavigate, onClose }: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ branch, locale, q: trimmed });
        const res = await fetch(`/api/nav/search?${params}`);
        const json: SearchResponse & { error?: string } = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || "Search failed.");
          setResults(null);
          setPartial(false);
        } else {
          setResults(json.results);
          setPartial(json.partial);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("Search failed.");
          setResults(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, branch, locale]);

  function handleSelect(mdPath: string) {
    onNavigate(mdPath);
    onClose();
  }

  const trimmed = query.trim();
  const showEmptyHint = trimmed.length < MIN_QUERY_LENGTH;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box search-modal-box" onClick={(e) => e.stopPropagation()}>
        <h3>Search</h3>

        <input
          type="text"
          className="search-input"
          placeholder="Search page content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        {showEmptyHint && <p className="modal-hint">Type at least {MIN_QUERY_LENGTH} characters to search.</p>}

        {!showEmptyHint && loading && <p className="modal-hint">Searching…</p>}

        {!showEmptyHint && error && <p className="modal-error">{error}</p>}

        {!showEmptyHint && !loading && !error && partial && (
          <p className="search-partial-note">
            GitHub's rate limit interrupted indexing some pages — results may be incomplete. Signing in with GitHub
            (top right) raises this limit substantially.
          </p>
        )}

        {!showEmptyHint && !loading && !error && results && results.length === 0 && (
          <p className="search-empty">No pages match "{trimmed}".</p>
        )}

        {!showEmptyHint && !loading && !error && results && results.length > 0 && (
          <ul className="search-results">
            {results.map((r) => (
              <li key={r.mdPath} className="search-result" onClick={() => handleSelect(r.mdPath)}>
                <div className="search-result-title">{highlight(r.title, trimmed)}</div>
                {r.snippet && <div className="search-result-snippet">{highlight(r.snippet, trimmed)}</div>}
              </li>
            ))}
          </ul>
        )}

        <div className="modal-buttons">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
