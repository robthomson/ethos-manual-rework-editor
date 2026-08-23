/* frontend/src/components/NewPageModal.tsx
 *
 * Description of responsibility:
 *   The "add a genuinely new page" form — only ever shown from an
 *   English-locale workspace (App.tsx gates this; createNewPage() on
 *   the backend enforces it again regardless). Picks an existing
 *   top-level nav section to place the new page under (new pages always
 *   land inside a section that already has its own landing page — see
 *   backend/workspaceStore.ts:findSectionLandingPath()) and derives a
 *   slug from the title, editable in case the auto-derived one collides
 *   or just isn't wanted.
 */
import { useState } from "react";
import { slugify } from "../utils/slugify";
import type { NavPage } from "../hooks/useNav";

interface NewPageModalProps {
  sections: NavPage[]; // top-level nodes that have their own landing page + children
  onCreate: (title: string, slug: string, sectionTitle: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

export function NewPageModal({ sections, onCreate, onClose }: NewPageModalProps) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [sectionTitle, setSectionTitle] = useState(sections[0]?.title ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleTitleChange(next: string) {
    setTitle(next);
    if (!slugTouched) setSlug(slugify(next));
  }

  async function handleCreate() {
    if (!title.trim() || !slug || !sectionTitle) return;
    setCreating(true);
    setError(null);
    const result = await onCreate(title.trim(), slug, sectionTitle);
    setCreating(false);
    if (!result.ok) {
      setError(result.error || "Failed to create the page.");
      return;
    }
    onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h3>New page</h3>

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

        <label className="modal-field">
          Section
          <select value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)}>
            {sections.map((s) => (
              <option key={s.title} value={s.title}>
                {s.title}
              </option>
            ))}
          </select>
        </label>

        {slug && sectionTitle && (
          <p className="modal-hint">
            Will be created as <code>docs/en/…/{slug}.md</code> under &ldquo;{sectionTitle}&rdquo;.
          </p>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-buttons">
          <button disabled={creating || !title.trim() || !slug || !sectionTitle} onClick={handleCreate}>
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
