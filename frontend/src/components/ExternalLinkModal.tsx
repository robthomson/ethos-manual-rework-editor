/* frontend/src/components/ExternalLinkModal.tsx
 *
 * Description of responsibility:
 *   A confirmation step before a click on a genuinely external link
 *   (linkResolver.ts:classifyMarkdownLink's "external" case) actually
 *   opens it — a translator working through a page shouldn't have their
 *   system browser pop up with no warning. Internal cross-references
 *   (other pages in this same docs repo) never show this — they
 *   navigate straight within the app, exactly like clicking that page in
 *   the nav tree would; this is only for links that really do leave the
 *   app.
 *
 * Info:
 *   Same modal-overlay/modal-box/modal-buttons structure every other
 *   modal in this app already uses (AddImageModal.tsx, NewPageModal.tsx,
 *   NewSectionModal.tsx) — no new CSS needed, those classes are already
 *   generic.
 */
interface ExternalLinkModalProps {
  url: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ExternalLinkModal({ url, onConfirm, onCancel }: ExternalLinkModalProps) {
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h3>Open external link?</h3>

        <p className="modal-hint">This will open in your default browser, outside the app:</p>
        <p className="modal-hint">
          <code>{url}</code>
        </p>

        <div className="modal-buttons">
          <button onClick={onConfirm} autoFocus>
            Open in browser
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
