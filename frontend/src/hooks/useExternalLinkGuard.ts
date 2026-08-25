/* frontend/src/hooks/useExternalLinkGuard.ts
 *
 * Description of responsibility:
 *   Owns the "confirm before actually leaving the app" state for a
 *   genuinely external link click — shared by EditablePageView.tsx and
 *   PageView.tsx (both render MarkdownPreview at least once, and
 *   EditablePageView.tsx also needs the identical behavior for Rich
 *   mode's own click handling), so this state/logic exists exactly once
 *   rather than two near-identical copies.
 *
 * Info:
 *   Deliberately does NOT let the browser's own default target="_blank"
 *   click-through happen at all — every internal/external link click is
 *   preventDefault()'d upstream (renderMarkdown.tsx's MarkdownPreview,
 *   EditablePageView.tsx's Rich-mode handler), and confirm() here opens
 *   the link programmatically instead, via the same window.open() call
 *   a real target="_blank" click would have made — Electron's own
 *   setWindowOpenHandler (electron/main.ts) intercepts that identically
 *   either way, so this doesn't need any new IPC/preload bridge.
 */
import { useState } from "react";

export function useExternalLinkGuard() {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  function requestOpen(url: string) {
    setPendingUrl(url);
  }

  function confirm() {
    if (pendingUrl) window.open(pendingUrl, "_blank");
    setPendingUrl(null);
  }

  function cancel() {
    setPendingUrl(null);
  }

  return { pendingUrl, requestOpen, confirm, cancel };
}
