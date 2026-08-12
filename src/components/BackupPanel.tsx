import { useRef, useState } from "react";
import { zipFiles, unzipFiles, ZipEntry } from "../zip";

// Download the parts of the site that can't be recomputed, and put them back.
//
// Everything durable lives in one Blob store, every write overwrites in place, and
// deletes are permanent — so a bad rebuild or a mis-click has no undo. A backup
// carries the uploaded packets and games plus every hand correction; the stat files
// are left out because a restore rebuilds them from exactly that.

interface SetRow { slug: string; name: string }
interface BackupFile { kind?: string; scope?: string; slug?: string; at?: string }

export function BackupPanel({ sets }: { sets: SetRow[] }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [includeIndex, setIncludeIndex] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);
  const say = (l: string) => setLog((prev) => [...prev, l]);

  // Fetch one backup as bytes; the whole run is collected and written out as a
  // single archive rather than a download per tournament.
  async function fetchBackup(url: string): Promise<Uint8Array> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Failed (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  }

  function save(blob: Blob, name: string) {
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
      const entries: ZipEntry[] = [];
      setStatus("Accounts and tournament list…");
      entries.push({ name: "core.json", data: await fetchBackup("/api/admin?op=backup") });
      for (let i = 0; i < sets.length; i++) {
        setStatus(`Reading ${i + 1} of ${sets.length}: ${sets[i].name}…`);
        try {
          entries.push({ name: `sets/${sets[i].slug}.json`, data: await fetchBackup(`/api/admin?op=backup&slug=${encodeURIComponent(sets[i].slug)}`) });
        } catch (e) { say(`${sets[i].name}: skipped — ${(e as Error).message}`); }
      }
      setStatus("Compressing…");
      const zip = await zipFiles(entries);
      save(zip, `buzzpoints-backup-${stamp()}.zip`);
      setStatus(`Saved one archive: ${entries.length} file${entries.length === 1 ? "" : "s"}, ${(zip.size / 1e6).toFixed(1)} MB.`);
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  // One backup object at the server: each is written and re-aggregated on its own,
  // so restoring a whole archive is this in a loop.
  async function restoreOne(backup: unknown) {
    const r = await fetch("/api/admin", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "restore", backup, includeIndex }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
    return d as { restored: number; slug?: string };
  }

  async function restore(f: File) {
    setBusy(true); setErr(null); setLog([]); setStatus(`Reading ${f.name}…`);
    try {
      // The whole archive, or a single entry someone pulled out of one.
      const dec = new TextDecoder();
      const backups: BackupFile[] = f.name.toLowerCase().endsWith(".zip")
        ? (await unzipFiles(await f.arrayBuffer())).map((e) => JSON.parse(dec.decode(e.data)))
        : [JSON.parse(await f.text())];
      if (!backups.length || backups.some((b) => b?.kind !== "buzzpoints-backup"))
        throw new Error("That isn't a Buzzpoints backup.");

      const setCount = backups.filter((b) => b.scope === "set").length;
      const hasCore = backups.some((b) => b.scope === "core");
      const what = backups.length === 1
        ? (backups[0].scope === "core" ? "accounts and settings" : `“${backups[0].slug}”`)
        : `${setCount} tournament${setCount === 1 ? "" : "s"}${hasCore ? " and the accounts file" : ""}`;
      if (!window.confirm(
        `Restore ${what} from a backup taken ${String(backups[0].at).slice(0, 10)}?\n\n` +
        `This overwrites what's on the site now with the backup's copy. Stats are rebuilt from it.`
      )) { setStatus(null); setBusy(false); return; }

      let n = 0;
      for (const b of backups) {
        setStatus(`Restoring ${++n} of ${backups.length}${b.slug ? `: ${b.slug}` : ""}…`);
        try { const d = await restoreOne(b); say(`${b.slug || "core"}: ${d.restored} file${d.restored === 1 ? "" : "s"}`); }
        catch (e) { say(`${b.slug || "core"}: ${(e as Error).message}`); }
      }
      setStatus(`Finished — ${backups.length} restored.`);
    } catch (e) { setErr(String((e as Error).message || e)); setStatus(null); } finally { setBusy(false); }
  }

  return (
    <div className="bulk-import">
      <p className="muted">
        Saves what can't be recomputed — the uploaded packets and games, plus every correction, rename, category
        mapping and invite — as a single zip: one entry per tournament plus one for accounts and the tournament
        list. Stat pages aren't in it; a restore rebuilds them. Restoring takes the whole zip back, or one entry
        pulled out of it.
      </p>
      <div className="cat-toolbar">
        <button className="btn-primary btn-sm" disabled={busy || !sets.length} onClick={backupAll}>
          {busy ? "Working…" : `Download backup (.zip, ${sets.length + 1} files)`}
        </button>
        <button
          className="btn-secondary btn-sm" disabled={busy}
          onClick={() => fetchBackup("/api/admin?op=backup")
            .then((d) => save(new Blob([d as BlobPart], { type: "application/json" }), `buzzpoints-core-${stamp()}.json`))
            .catch((e) => setErr(String(e.message || e)))}
        >
          Accounts &amp; list only
        </button>
        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => file.current?.click()}>Restore from a file…</button>
        <input
          ref={file} type="file" accept=".zip,.json,application/zip,application/json" style={{ display: "none" }}
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
