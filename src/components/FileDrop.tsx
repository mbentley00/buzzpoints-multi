import { useRef, useState } from "react";

// A file picker that also accepts a whole folder — either by clicking
// "Choose a folder…" (webkitdirectory) or by dragging files/folders onto the
// drop zone. Dropped directories are read recursively. Files are filtered to
// the accepted extensions so dropping a folder full of other junk is safe.
//
// The two ways in are deliberately separate buttons rather than one run-on
// line: picking files and picking a folder open different OS dialogs, and
// which one you're about to get should be obvious before you click. What came
// back is then reported the same way — named folder, loose files, and how many
// of what was offered actually matched — so a folder of mixed contents can't
// quietly contribute three of its forty files.

// What the current selection came from, for the summary line.
type Source = { kind: "files" } | { kind: "folder"; name: string | null };

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
  const [source, setSource] = useState<Source | null>(null);
  // How many of the picked files the extension filter dropped. Counted here
  // rather than as (picked - selected), which on a single-file drop zone would
  // blame the extension filter for the extras it truncated.
  const [skipped, setSkipped] = useState(0);

  const exts = accept.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const matches = (name: string) => exts.length === 0 || exts.some((e) => name.toLowerCase().endsWith(e));
  const extList = exts.join(" / ");

  function commit(files: File[], src: Source) {
    const kept = files.filter((f) => matches(f.name));
    setSource(files.length ? src : null);
    setSkipped(files.length - kept.length);
    onChange(multiple ? kept : kept.slice(0, 1));
  }

  function clear() {
    setSource(null);
    setSkipped(0);
    onChange([]);
  }

  // A folder picked through the OS dialog: every file carries its path
  // relative to the folder that was chosen, so the first segment names it.
  function onPickFolder(list: FileList | null) {
    if (!list) return;
    const files = Array.from(list);
    const rel = (files[0] as { webkitRelativePath?: string } | undefined)?.webkitRelativePath || "";
    commit(files, { kind: "folder", name: rel.split("/")[0] || null });
  }

  function onPickFiles(list: FileList | null) {
    if (list) commit(Array.from(list), { kind: "files" });
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
      // Dropped files carry no relative path, so the dropped entries are the
      // only record of whether this was a folder and what it was called.
      const dirs = entries.filter((en) => en.isDirectory);
      commit(files, dirs.length ? { kind: "folder", name: dirs.length === 1 ? dirs[0].name : null } : { kind: "files" });
    } else {
      commit(Array.from(e.dataTransfer.files), { kind: "files" });
    }
  }

  // What was taken, and from where. The skipped count only appears when the
  // pick actually contained files this drop zone won't accept.
  function summary(): string {
    const n = value.length;
    const noun = `${n} file${n === 1 ? "" : "s"}`;
    const where =
      source?.kind === "folder"
        ? source.name
          ? ` from folder “${source.name}”`
          : " from the dropped folders"
        : "";
    return `${noun} selected${where}` + (skipped > 0 ? ` · ${skipped} skipped (not ${extList})` : "");
  }

  return (
    <div>
      <div
        className={`file-drop${over ? " file-drop-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        // Clicking the zone is a mouse shortcut to the files dialog. The two
        // buttons below are the real controls — hence no role/tabIndex here,
        // which would put an interactive element around interactive elements
        // and add a tab stop that does nothing the buttons don't do.
        onClick={() => fileInput.current?.click()}
      >
        <span className="file-drop-main">Drag {multiple ? "files or a folder" : "a file"} here</span>
        <span className="file-drop-or">or</span>
        <span className="file-drop-actions">
          <button type="button" className="file-drop-btn" onClick={(e) => { e.stopPropagation(); fileInput.current?.click(); }}>
            {multiple ? "Choose files…" : "Choose a file…"}
          </button>
          {multiple && (
            <button type="button" className="file-drop-btn" onClick={(e) => { e.stopPropagation(); dirInput.current?.click(); }}>
              Choose a folder…
            </button>
          )}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => { onPickFiles(e.target.files); e.target.value = ""; }}
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
          onChange={(e) => { onPickFolder(e.target.files); e.target.value = ""; }}
        />
      )}
      <small className="muted file-drop-summary">
        {value.length || skipped ? (
          <>
            <span>{summary()}</span>
            <button type="button" className="linkish" onClick={clear}>clear</button>
          </>
        ) : (
          hint
        )}
      </small>
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
