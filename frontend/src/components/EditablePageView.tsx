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
 *
 *   The editing pane has three modes now: Rich (real contentEditable
 *   WYSIWYG — WysiwygEditor.tsx/Milkdown), Source (plain textarea), and
 *   Preview (rendered, read-only, reflecting current in-progress
 *   content — not the last-saved version). Rich is disabled — falling
 *   back to Source — for any page containing pymdownx-specific syntax
 *   (admonitions/details/tabs): see pymdownxBlocks.ts:
 *   containsPymdownxBlocks()'s own comment for why that's not just a
 *   missing-feature limitation but an active data-loss risk with a
 *   generic rich-text editor. A page defaults to Rich mode on load when
 *   it's safe to, since that's the actual point of building it; Source
 *   otherwise.
 *
 *   "Insert image" captures the textarea's cursor position (selectionStart)
 *   BEFORE the modal opens — opening it moves focus away from the
 *   textarea, and reading selectionStart afterward would just see
 *   wherever focus last was instead of where the user actually clicked.
 *   Only wired up for Source mode so far — inserting at a Rich-mode
 *   (ProseMirror) cursor position needs different plumbing, not yet
 *   built.
 */
import { useEffect, useRef, useState } from "react";
import { MarkdownPreview } from "../preview/renderMarkdown";
import { AddImageModal } from "./AddImageModal";
import { relativeAssetPath } from "../utils/relativePath";
import { containsPymdownxBlocks } from "../preview/pymdownxBlocks";
import { WysiwygEditor } from "../wysiwyg/WysiwygEditor";

interface EditablePageData {
  content: string;
  isNew: boolean;
  error?: string;
}

type PaneMode = "source" | "rich" | "preview";

function PaneModeToggle({
  mode,
  onChange,
  richDisabled,
}: {
  mode: PaneMode;
  onChange: (m: PaneMode) => void;
  richDisabled: boolean;
}) {
  return (
    <div className="pane-mode-toggle">
      <button
        className={mode === "rich" ? "active" : ""}
        disabled={richDisabled}
        title={
          richDisabled
            ? "This page has admonitions/tabs — rich editing for those isn't built yet, to avoid corrupting them. Edit in Source."
            : undefined
        }
        onClick={() => onChange("rich")}
      >
        Rich
      </button>
      <button className={mode === "source" ? "active" : ""} onClick={() => onChange("source")}>
        Source
      </button>
      <button className={mode === "preview" ? "active" : ""} onClick={() => onChange("preview")}>
        Preview
      </button>
    </div>
  );
}

interface EditablePageViewProps {
  workspace: string;
  branch: string;
  locale: string;
  localeName: string;
  mdPath: string;
  title: string;
  onSaved: () => void;
}

export function EditablePageView({
  workspace,
  branch,
  locale,
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
  const [editMode, setEditMode] = useState<PaneMode>("source");
  const [showImageModal, setShowImageModal] = useState(false);
  const [existingImageNames, setExistingImageNames] = useState<string[]>([]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against saving stale content from a page that's since been
  // navigated away from — the debounce timer set up for page A shouldn't
  // still fire and save into page B just because this component instance
  // is being reused across the mdPath change.
  const currentKeyRef = useRef<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Captured when "Insert image" is clicked, before the modal (which
  // steals focus) opens — see this file's header comment.
  const insertCursorRef = useRef<number>(0);

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
        // Rich is the whole point when it's safe — default to it rather
        // than making every page start in Source and requiring an extra
        // click. Pages with pymdownx blocks default to Source instead
        // (richDisabled below keeps the button itself disabled too).
        setEditMode(containsPymdownxBlocks(pageData.content) ? "source" : "rich");

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

  async function openImageModal() {
    insertCursorRef.current = textareaRef.current?.selectionStart ?? content.length;
    try {
      const res = await fetch(`/api/workspace/${encodeURIComponent(workspace)}/images`);
      const data: { images?: string[] } = await res.json();
      setExistingImageNames(data.images || []);
    } catch {
      setExistingImageNames([]);
    }
    setShowImageModal(true);
  }

  function handleImageUploaded(filename: string) {
    const ref = relativeAssetPath(mdPath, `assets/${filename}`);
    const markdown = `![${filename.replace(/\.[a-z0-9]+$/i, "")}](${ref})`;
    const offset = insertCursorRef.current;
    const next = content.slice(0, offset) + markdown + content.slice(offset);
    handleChange(next);
  }

  if (loading) return <div className="page-view-loading">Loading {title}…</div>;
  if (loadError) return <div className="page-view-error">{loadError}</div>;

  const richDisabled = containsPymdownxBlocks(content);
  // The safety gate isn't just about *offering* Rich mode — content that
  // had admonitions/tabs added (or already had them) since Rich mode was
  // entered must not stay silently in a mode that would corrupt them on
  // the next edit.
  const effectiveMode = editMode === "rich" && richDisabled ? "source" : editMode;

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
          <div className="page-view-pane-label">
            {localeName} (editing)
            <PaneModeToggle mode={effectiveMode} onChange={setEditMode} richDisabled={richDisabled} />
          </div>
          {effectiveMode === "source" && (
            <div className="editor-toolbar">
              <button onClick={openImageModal}>Insert image</button>
            </div>
          )}
          {effectiveMode === "rich" ? (
            <div className="wysiwyg-scroll">
              <WysiwygEditor content={content} onChange={handleChange} />
            </div>
          ) : effectiveMode === "source" ? (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => handleChange(e.target.value)}
            />
          ) : (
            <div className="preview-scroll">
              <MarkdownPreview
                content={content}
                branch={branch}
                locale={locale}
                mdPath={mdPath}
                workspace={workspace}
              />
            </div>
          )}
        </div>
      </div>

      {showImageModal && (
        <AddImageModal
          workspace={workspace}
          existingNames={existingImageNames}
          onClose={() => setShowImageModal(false)}
          onUploaded={handleImageUploaded}
        />
      )}
    </div>
  );
}
