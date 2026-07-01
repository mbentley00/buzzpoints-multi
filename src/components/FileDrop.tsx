import { useRef, useState } from "react";

// A file picker that also accepts a whole folder — either by clicking
// "Choose folder" (webkitdirectory) or by dragging files/folders onto the
// drop zone. Dropped directories are read recursively. Files are filtered to
// the accepted extensions so dropping a folder full of other junk is safe.
export function FileDrop({
  accept,
  multiple = true,
  value,
  onChange,
  hint,
}: {
  accept: string; // e.g. ".json,.qbj"
  multiple?: boolean;
  value: File[];
  onChange: (files: File[]) => void;
  hint?: string; // shown when nothing is selected
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const exts = accept.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const matches = (name: string) => exts.length === 0 || exts.some((e) => name.toLowerCase().endsWith(e));

  function commit(files: File[]) {
    const kept = files.filter((f) => matches(f.name));
    onChange(multiple ? kept : kept.slice(0, 1));
  }

  function onPick(list: FileList | null) {
    if (list) commit(Array.from(list));
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const items = e.dataTransfer.items;
    // Prefer the entry API so dropped folders are walked recursively; fall
    // back to the flat file list where it isn't available.
    if (items && items.length && typeof items[0].webkitGetAsEntry === "function") {
      const entries = Array.from(items)
        .map((it) => it.webkitGetAsEntry())
        .filter(Boolean) as FileSystemEntry[];
      const files: File[] = [];
      for (const entry of entries) await walkEntry(entry, files);
      commit(files);
    } else {
      commit(Array.from(e.dataTransfer.files));
    }
  }

  return (
    <div>
      <div
        className={`file-drop${over ? " file-drop-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.current?.click(); } }}
      >
        <span className="file-drop-main">
          Drag {multiple ? "files or a folder" : "a file"} here, or{" "}
          <button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); fileInput.current?.click(); }}>
            choose {multiple ? "files" : "a file"}
          </button>
          {multiple && (
            <>
              {" / "}
              <button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); dirInput.current?.click(); }}>
                choose a folder
              </button>
            </>
          )}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => { onPick(e.target.files); e.target.value = ""; }}
      />
      {multiple && (
        // webkitdirectory lets the OS dialog select an entire folder.
        <input
          ref={dirInput}
          type="file"
          // @ts-expect-error non-standard but widely supported directory picker
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={(e) => { onPick(e.target.files); e.target.value = ""; }}
        />
      )}
      <small className="muted">{value.length ? `${value.length} selected` : hint}</small>
    </div>
  );
}

// Recursively collect files from a dropped FileSystemEntry tree.
function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file((f) => { out.push(f); resolve(); }, () => resolve());
    });
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return new Promise((resolve) => {
      const entries: FileSystemEntry[] = [];
      // readEntries returns at most ~100 entries per call, so drain it.
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) {
            for (const e of entries) await walkEntry(e, out);
            resolve();
          } else {
            entries.push(...batch);
            readBatch();
          }
        }, () => resolve());
      };
      readBatch();
    });
  }
  return Promise.resolve();
}
