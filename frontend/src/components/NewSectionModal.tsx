/* frontend/src/components/NewSectionModal.tsx
 *
 * Description of responsibility:
 *   The "add a brand-new top-level nav section" form — sibling to
 *   NewPageModal.tsx, only ever shown from an English-locale workspace
 *   (App.tsx gates this; createNewSection() on the backend enforces it
 *   again regardless). Unlike a new page, a section has nowhere existing
 *   to be placed under — it becomes its own top-level nav entry, with a
 *   fresh landing page at "<slug>/index.md" (see
 *   backend/workspaceStore.ts:createNewSection()'s own comment for why
 *   that's the real shape every existing section already has).
 */
import { useState } from "react";
import { slugify } from "../utils/slugify";

interface NewSectionModalProps {
  onCreate: (title: string, slug: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

export function NewSectionModal({ onCreate, onClose }: NewSectionModalProps) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleTitleChange(next: string) {
    setTitle(next);
    if (!slugTouched) setSlug(slugify(next));
  }

  async function handleCreate() {
    if (!title.trim() || !slug) return;
    setCreating(true);
    setError(null);
    const result = await onCreate(title.trim(), slug);
    setCreating(false);
    if (!result.ok) {
      setError(result.error || "Failed to create the section.");
      return;
    }
    onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h3>New section (English)</h3>

        <label className="modal-field">
          Title
          <input type="text" value={title} onChange={(e) => handleTitleChange(e.target.value)} autoFocus />
        </label>

        <label className="modal-field">
          Slug
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(slugify(e.target.value));
              setSlugTouched(true);
            }}
          />
        </label>

        {slug && (
          <p className="modal-hint">
            Will be created as a new top-level nav entry, landing on <code>docs/en/{slug}/index.md</code>.
          </p>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-buttons">
          <button disabled={creating || !title.trim() || !slug} onClick={handleCreate}>
            {creating ? "Creating…" : "Create"}
          </button>
          <button disabled={creating} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
