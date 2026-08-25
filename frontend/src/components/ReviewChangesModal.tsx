/* frontend/src/components/ReviewChangesModal.tsx
 *
 * Description of responsibility:
 *   Shows a real line-level diff of every pending change before
 *   "Submit for review" (WorkspaceBar.tsx) actually commits and
 *   opens/updates a PR — the confirmation step for what's genuinely a
 *   real, outward-facing action (a real GitHub commit + PR), not just a
 *   bare list of changed paths like the sidebar's own Changes list
 *   already shows.
 *
 * Info:
 *   Fetches backend/routes/workspaceRoutes.ts's GET /:name/diff on
 *   mount — same shape as the sidebar's own Changes list
 *   (scanChanges()), plus each entry's actual before/after text
 *   (workspaceStore.ts's getChangeDiffs()). Diffing itself happens here,
 *   client-side, via the `diff` package's diffLines() — the backend
 *   only ever hands over raw text, same division of labor as
 *   SearchModal.tsx's own snippet-highlighting (computed client-side
 *   from raw text the backend returns, not pre-rendered server-side).
 *
 *   Renders a real unified diff (context lines around each changed
 *   hunk, collapsing long unchanged runs) rather than a naive full
 *   dump of every line — a single-word edit deep in a long page
 *   shouldn't force scrolling through the entire file to find it.
 *
 *   Confirming doesn't submit itself — it just closes this modal and
 *   calls back into WorkspaceBar.tsx's own existing handleSubmit(),
 *   which already owns the submitting/result UI (the "Submitting…"
 *   button state, the PR-created banner). Two separate submit code
 *   paths (one here, one there) would drift; this stays a pure review
 *   step.
 */
import { useEffect, useState } from "react";
import { diffLines } from "diff";

interface ChangeDiff {
  path: string;
  type: "added" | "modified";
  isImage: boolean;
  baseline: string | null;
  working: string | null;
}

interface ReviewChangesModalProps {
  workspaceName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

type DiffLine =
  | { kind: "context" | "add" | "remove"; text: string }
  | { kind: "gap"; count: number };

// How many unchanged lines to keep on either side of a real change —
// same idea as `git diff`'s own default context, just a fixed constant
// instead of a --unified=N flag nothing here exposes.
const CONTEXT_LINES = 3;

// diffLines() gives whole multi-line chunks (a run of added lines, a
// run of removed lines, a run of unchanged lines) — flattened to
// individual lines here, then windowed down to only the lines actually
// worth showing, with a "N unchanged lines" marker standing in for any
// gap longer than 2×CONTEXT_LINES. A page with one small edit shouldn't
// force scrolling through hundreds of untouched lines to find it.
function buildUnifiedDiff(baseline: string, working: string): DiffLine[] {
  const parts = diffLines(baseline, working);

  const flat: { kind: "context" | "add" | "remove"; text: string }[] = [];
  for (const part of parts) {
    // A trailing newline splits into a trailing "" element — dropped,
    // it's not a real line.
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const kind = part.added ? "add" : part.removed ? "remove" : "context";
    for (const text of lines) flat.push({ kind, text });
  }

  const out: DiffLine[] = [];
  let i = 0;
  while (i < flat.length) {
    if (flat[i].kind !== "context") {
      out.push(flat[i]);
      i++;
      continue;
    }
    // Start of a context run — find where it ends.
    let j = i;
    while (j < flat.length && flat[j].kind === "context") j++;
    const runLength = j - i;
    const isFirstRun = i === 0;
    const isLastRun = j === flat.length;

    if (isFirstRun && isLastRun) {
      // The whole file is unchanged (shouldn't really happen — this
      // modal only opens for files scanChanges() already reported as
      // different — but keep it a no-op collapse rather than crash if
      // it ever does).
      out.push({ kind: "gap", count: runLength });
    } else if (isFirstRun) {
      // Only keep the tail (context immediately before the next change).
      const keep = Math.min(CONTEXT_LINES, runLength);
      if (runLength > keep) out.push({ kind: "gap", count: runLength - keep });
      for (let k = j - keep; k < j; k++) out.push(flat[k]);
    } else if (isLastRun) {
      // Only keep the head (context right after the previous change).
      const keep = Math.min(CONTEXT_LINES, runLength);
      for (let k = i; k < i + keep; k++) out.push(flat[k]);
      if (runLength > keep) out.push({ kind: "gap", count: runLength - keep });
    } else if (runLength <= CONTEXT_LINES * 2) {
      // Short enough to just show in full — collapsing it would save
      // one line at most.
      for (let k = i; k < j; k++) out.push(flat[k]);
    } else {
      for (let k = i; k < i + CONTEXT_LINES; k++) out.push(flat[k]);
      out.push({ kind: "gap", count: runLength - CONTEXT_LINES * 2 });
      for (let k = j - CONTEXT_LINES; k < j; k++) out.push(flat[k]);
    }
    i = j;
  }
  return out;
}

export function ReviewChangesModal({ workspaceName, onConfirm, onCancel }: ReviewChangesModalProps) {
  const [diffs, setDiffs] = useState<ChangeDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspace/${encodeURIComponent(workspaceName)}/diff`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setDiffs(data.diffs);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load the changes to review.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceName]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box review-modal-box" onClick={(e) => e.stopPropagation()}>
        <h3>Review changes</h3>

        {error && <p className="modal-error">{error}</p>}

        {!error && diffs === null && <p className="modal-hint">Loading…</p>}

        {!error && diffs !== null && diffs.length === 0 && (
          <p className="modal-hint">Nothing to review — no pending changes.</p>
        )}

        {!error && diffs !== null && diffs.length > 0 && (
          <div className="review-diff-list">
            {diffs.map((d) => (
              <div key={d.path} className="review-diff-file">
                <div className="review-diff-file-header">
                  <span className={`change-badge change-${d.type}`}>{d.type === "added" ? "+" : "~"}</span>
                  <span className="review-diff-path">{d.path}</span>
                </div>

                {d.isImage ? (
                  <p className="review-diff-image-note">Image {d.type === "added" ? "added" : "changed"} — no text diff.</p>
                ) : (
                  <pre className="review-diff-body">
                    {buildUnifiedDiff(d.baseline ?? "", d.working ?? "").map((line, idx) => {
                      if (line.kind === "gap") {
                        return (
                          <div key={idx} className="diff-line diff-gap">
                            ⋯ {line.count} unchanged line{line.count === 1 ? "" : "s"} ⋯
                          </div>
                        );
                      }
                      const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
                      return (
                        <div key={idx} className={`diff-line diff-${line.kind}`}>
                          {prefix} {line.text}
                        </div>
                      );
                    })}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="modal-buttons">
          <button onClick={onConfirm} disabled={diffs === null} title={error ? "Couldn't load changes to review." : undefined} autoFocus>
            Confirm &amp; Submit
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
