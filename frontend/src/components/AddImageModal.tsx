/* frontend/src/components/AddImageModal.tsx
 *
 * Description of responsibility:
 *   Upload an image into the current workspace's shared assets/ folder
 *   (see backend/workspaceStore.ts's own comment on that convention) via
 *   click-to-browse, drag-and-drop, or paste (e.g. a Snipping Tool
 *   capture) — same three-input-method pattern as docEditor's own
 *   AddImageModal.tsx, adapted to this app's shared-per-locale-folder
 *   convention instead of a per-page img/ folder.
 *
 * Info:
 *   All three input methods converge on handleImageBlob() — paste is
 *   captured via a window-level listener (not an onPaste prop on the
 *   drop-zone) since paste events only fire on the currently-focused
 *   element, and a plain <div> isn't reliably focused the instant the
 *   modal opens.
 *
 *   The extension is derived from the actual image data (the source
 *   file's own extension if recognized, else its MIME type) rather than
 *   trusting user input — a pasted clipboard image typically has no
 *   meaningful filename at all for the extension to come from.
 */
import { useEffect, useRef, useState } from "react";

interface AddImageModalProps {
  workspace: string;
  existingNames: string[];
  onClose: () => void;
  onUploaded: (filename: string) => void;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function determineExtension(file: File | Blob): string {
  const name = "name" in file ? file.name : "";
  const match = name.match(/\.([a-z0-9]+)$/i);
  if (match && /^(png|jpe?g|gif|webp|svg)$/i.test(match[1])) {
    return match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  }
  return MIME_EXT[file.type] || "png";
}

function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function AddImageModal({ workspace, existingNames, onClose, onUploaded }: AddImageModalProps) {
  const [name, setName] = useState("");
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageExt, setImageExt] = useState("png");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  function handleImageBlob(blob: Blob, suggestedName?: string) {
    if (!blob.type.startsWith("image/")) {
      setError("That doesn't look like an image file.");
      return;
    }
    setError(null);
    setImageBlob(blob);
    setImageExt(determineExtension(blob));
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
    if (suggestedName && !name) {
      setName(suggestedName.replace(/\.[a-z0-9]+$/i, ""));
    }
  }

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            handleImageBlob(blob);
          }
          return;
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function doUpload(finalName: string) {
    if (!imageBlob) return;
    const formData = new FormData();
    formData.append("filename", finalName);
    formData.append("file", imageBlob, finalName);

    setUploading(true);
    setError(null);

    try {
      const res = await fetch(`/api/workspace/${encodeURIComponent(workspace)}/images`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      onUploaded(finalName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleUpload() {
    if (!imageBlob) return;
    const safeName = slugifyName(name);
    if (!safeName) {
      setError("Enter a name for the image.");
      return;
    }
    const finalName = `${safeName}.${imageExt}`;

    if (existingNames.includes(finalName)) {
      setConfirmOverwrite(finalName);
      return;
    }
    doUpload(finalName);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h3>Add image</h3>

        <div
          className={`add-image-dropzone${dragOver ? " drag-over" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleImageBlob(file, file.name);
          }}
        >
          {previewUrl ? (
            <img src={previewUrl} alt="" className="add-image-preview" />
          ) : (
            <div className="add-image-dropzone-hint">
              Click to choose a file, drag one here, or paste (Ctrl+V)
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImageBlob(file, file.name);
            e.target.value = "";
          }}
        />

        {imageBlob && (
          <>
            <label className="modal-field" style={{ marginTop: "0.75rem" }}>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <p className="modal-hint">
              Will be saved as <code>assets/{slugifyName(name) || "…"}.{imageExt}</code>
            </p>
          </>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-buttons">
          <button disabled={!imageBlob || uploading} onClick={handleUpload}>
            {uploading ? "Adding…" : "Add Image"}
          </button>
          <button disabled={uploading} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>

      {confirmOverwrite && (
        <div className="modal-overlay">
          <div className="modal-box">
            <p>&ldquo;{confirmOverwrite}&rdquo; already exists in this workspace. Overwrite it?</p>
            <div className="modal-buttons">
              <button
                onClick={() => {
                  const finalName = confirmOverwrite;
                  setConfirmOverwrite(null);
                  doUpload(finalName);
                }}
              >
                Overwrite
              </button>
              <button onClick={() => setConfirmOverwrite(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
