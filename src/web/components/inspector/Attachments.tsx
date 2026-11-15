import { useRef, useState } from "react";
import { actions, attachmentDownloadUrl, attempt } from "../../api/queries";
import type { PreviewAttachment } from "../../lib/optimistic";
import { formatBytes } from "../../lib/entities";
import { Icon } from "../Icons";
import { toast } from "../Toasts";

const MAX_BYTES = 100 * 1024 * 1024;

/** Attachment list with download, delete, upload via picker or drag-drop, and image thumbnails. */
export function Attachments({ taskId, attachments }: { taskId: string; attachments: PreviewAttachment[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function upload(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast(`${file.name} is larger than 100 MB`, { kind: "error" });
        continue;
      }
      void attempt(actions.uploadAttachment(taskId, file));
    }
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg ${dragOver ? "ring-2 ring-accent" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Attachments">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-lg border border-line p-1.5" data-testid="attachment">
              {a.contentType.startsWith("image/") && !a.uploading ? (
                <img src={attachmentDownloadUrl(a.id)} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-md bg-surface-2 object-cover" />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                  <Icon name="file" size={18} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={a.name}>
                  {a.name}
                </p>
                <p className="text-xs text-muted">{a.uploading ? "Uploading…" : formatBytes(a.size)}</p>
              </div>
              {!a.uploading && (
                <>
                  <a className="pb-icon-btn" href={attachmentDownloadUrl(a.id)} download={a.name} aria-label={`Download ${a.name}`}>
                    <Icon name="download" size={18} />
                  </a>
                  <button
                    type="button"
                    className="pb-icon-btn hover:text-danger"
                    aria-label={`Delete ${a.name}`}
                    onClick={() => void attempt(actions.deleteAttachment(taskId, a.id))}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="Upload attachment"
        data-testid="attachment-input"
        onChange={(e) => {
          if (e.target.files?.length) upload(e.target.files);
          e.target.value = "";
        }}
      />
      <button type="button" className="pb-btn border-dashed text-sm text-muted" onClick={() => inputRef.current?.click()}>
        <Icon name="upload" size={16} />
        Add attachment (or drop a file here)
      </button>
    </div>
  );
}
