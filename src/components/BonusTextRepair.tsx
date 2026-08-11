import { useState } from "react";
import { Link } from "react-router-dom";
import { useIndex, clearSetCache } from "../data";

// Re-runs the one import step that quietly fails: the per-bonus detail pages that
// carry the leadin and part prompts. A scraped set gets its answers and conversion
// from a single cheap index page, so it lands looking complete while every bonus
// reads blank. This scans for that, then refetches — set by set, chunked, because
// the source serves those pages slowly and often not at all.

interface EdScan { index: number; label: string; total: number; missing: number }
interface Scan { slug: string; name: string; editions: EdScan[]; missing: number }

async function post(body: unknown) {
  const r = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
  return d as Record<string, any>;
}

export function BonusTextRepair() {
  const { data: index } = useIndex();
  const [url, setUrl] = useState("");
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const say = (line: string) => setLog((l) => [...l, line]);

  // Clicking before the tournament list has loaded would scan nothing and look
  // like "no sets need repair", so wait for it.
  const sets = index?.sets ?? [];
  const ready = !!index;

  async function scanAll() {
    setBusy(true); setErr(null); setLog([]); setScans(null);
    try {
      const out: Scan[] = [];
      for (let i = 0; i < sets.length; i++) {
        setStatus(`Checking ${i + 1} of ${sets.length}: ${sets[i].name}…`);
        try {
          const d = await post({ op: "bonus-text-scan", slug: sets[i].slug });
          if (d.missing > 0) out.push(d as unknown as Scan);
        } catch { /* a set we can't read isn't a repair candidate */ }
      }
      setScans(out);
      setStatus(out.length ? null : "Every set has its bonus text.");
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  // Walk one set's editions, chunk by chunk, until the source stops giving text.
  async function repair(s: Scan) {
    for (const ed of s.editions) {
      if (!ed.missing) continue;
      let guard = 0;
      for (;;) {
        if (guard++ > 60) { say(`${s.name}: gave up after 60 chunks`); break; }
        const d = await post({ op: "bonus-text-chunk", slug: s.slug, edition: ed.index, importUrl: url.trim() });
        setStatus(`${s.name}${s.editions.length > 1 ? ` · ${ed.label}` : ""}: ${d.remaining} bonuses left…`);
        if (d.stalled) { say(`${s.name}: the source returned no bonus pages — ${d.remaining} still missing`); break; }
        if (d.done) break;
      }
    }
    await post({ op: "bonus-text-finish", slug: s.slug });
    clearSetCache(s.slug);
  }

  async function repairAll(list: Scan[]) {
    if (!url.trim()) { setErr("Paste the Buzzpoints site you imported these from."); return; }
    setBusy(true); setErr(null); setLog([]);
    try {
      for (const s of list) {
        try { await repair(s); say(`${s.name}: done`); }
        catch (e) { say(`${s.name}: ${(e as Error).message}`); }
      }
      setStatus("Finished. Re-scan to see what's left.");
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  return (
    <div className="bulk-import">
      <p className="muted">
        Imported sets often arrive with bonus answers and conversion but no leadin or part prompts: that text lives
        only on the source's per-bonus pages, which are slow and frequently fail — and when they do, the import
        finishes anyway without saying so. This refetches just that text and rebuilds the affected sets.
      </p>
      <div className="cat-toolbar">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://the-source-buzzpoints-site.example"
          style={{ padding: "6px 8px", border: "1px solid #cdd5e0", borderRadius: 4, minWidth: 340 }}
        />
        <button className="btn-secondary btn-sm" disabled={busy || !ready} onClick={scanAll}>
          {!ready ? "Loading tournaments…" : busy && !scans ? "Checking…" : "Find sets missing bonus text"}
        </button>
        {scans && scans.length > 0 && (
          <button className="btn-primary btn-sm" disabled={busy || !url.trim()} onClick={() => repairAll(scans)}>
            Fetch text for all {scans.length}
          </button>
        )}
      </div>
      {status && <p className="muted">{status}</p>}
      {err && <div className="error-box">{err}</div>}

      {scans && scans.length > 0 && (
        <div className="table-wrap" style={{ maxWidth: 720 }}>
          <table className="data-table">
            <thead><tr><th>Tournament</th><th className="right">Bonuses missing text</th><th>Actions</th></tr></thead>
            <tbody>
              {scans.map((s) => (
                <tr key={s.slug}>
                  <td><Link className="link" to={`/set/${s.slug}/bonus`}>{s.name}</Link></td>
                  <td className="right mono">{s.missing}</td>
                  <td className="admin-actions">
                    <button className="btn-link" disabled={busy || !url.trim()} onClick={() => repairAll([s])}>Fetch this one</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {log.length > 0 && <div className="bulk-log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
    </div>
  );
}
