import { useRef, useState } from "react";

// Download the parts of the site that can't be recomputed, and put them back.
//
// Everything durable lives in one Blob store, every write overwrites in place, and
// deletes are permanent — so a bad rebuild or a mis-click has no undo. A backup
// carries the uploaded packets and games plus every hand correction; the stat files
// are left out because a restore rebuilds them from exactly that.

interface SetRow { slug: string; name: string }

export function BackupPanel({ sets }: { sets: SetRow[] }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [includeIndex, setIncludeIndex] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);
  const say = (l: string) => setLog((prev) => [...prev, l]);

  // Save one backup file to disk via a blob URL rather than navigating, so a run
  // across every tournament doesn't lose the page.
  async function download(url: string, name: string) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Failed (${r.status})`);
    const blob = await r.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  async function backupAll() {
    setBusy(true); setErr(null); setLog([]);
    try {
      setStatus("Accounts and tournament list…");
      await download("/api/admin?op=backup", `buzzpoints-core-${stamp()}.json`);
      say("core (accounts, tournament list): saved");
      for (let i = 0; i < sets.length; i++) {
        setStatus(`Saving ${i + 1} of ${sets.length}: ${sets[i].name}…`);
        try {
          await download(`/api/admin?op=backup&slug=${encodeURIComponent(sets[i].slug)}`, `buzzpoints-${sets[i].slug}-${stamp()}.json`);
          say(`${sets[i].name}: saved`);
        } catch (e) { say(`${sets[i].name}: ${(e as Error).message}`); }
      }
      setStatus(`Done — ${sets.length + 1} files. Your browser may have asked to allow multiple downloads.`);
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  async function restore(f: File) {
    setBusy(true); setErr(null); setLog([]); setStatus(`Reading ${f.name}…`);
    try {
      const backup = JSON.parse(await f.text());
      if (backup?.kind !== "buzzpoints-backup") throw new Error("That isn't a Buzzpoints backup file.");
      const what = backup.scope === "core" ? "accounts and settings" : `“${backup.slug}”`;
      if (!window.confirm(
        `Restore ${what} from a backup taken ${String(backup.at).slice(0, 10)}?\n\n` +
        `This overwrites what's on the site now with the backup's copy.${backup.scope === "set" ? " Stats are rebuilt from it." : ""}`
      )) { setStatus(null); setBusy(false); return; }
      setStatus("Restoring…");
      const r = await fetch("/api/admin", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "restore", backup, includeIndex }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
      setStatus(`Restored ${d.restored} file${d.restored === 1 ? "" : "s"}${d.slug ? ` into ${d.slug}` : ""}.`);
    } catch (e) { setErr(String((e as Error).message || e)); setStatus(null); } finally { setBusy(false); }
  }

  return (
    <div className="bulk-import">
      <p className="muted">
        Saves what can't be recomputed — the uploaded packets and games, plus every correction, rename, category
        mapping and invite — as one file per tournament, and one for accounts and the tournament list. Stat pages
        aren't in the file; a restore rebuilds them.
      </p>
      <div className="cat-toolbar">
        <button className="btn-primary btn-sm" disabled={busy || !sets.length} onClick={backupAll}>
          {busy ? "Working…" : `Download backup (${sets.length + 1} files)`}
        </button>
        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => download("/api/admin?op=backup", `buzzpoints-core-${stamp()}.json`).catch((e) => setErr(String(e.message || e)))}>
          Accounts &amp; list only
        </button>
        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => file.current?.click()}>Restore from a file…</button>
        <input
          ref={file} type="file" accept=".json,application/json" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) restore(f); }}
        />
      </div>
      <label className="field-inline" style={{ marginTop: 6, fontWeight: 400 }}>
        <input type="checkbox" checked={includeIndex} onChange={(e) => setIncludeIndex(e.target.checked)} />
        <span className="muted">
          When restoring accounts, also roll the tournament list back — this un-publishes anything created since the
          backup, so leave it off unless you're rebuilding the site.
        </span>
      </label>
      {status && <p className="muted">{status}</p>}
      {err && <div className="error-box">{err}</div>}
      {log.length > 0 && <div className="bulk-log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
    </div>
  );
}
