import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useIndex, clearSetCache } from "../data";

// The set or tournament slug a Buzzpoints URL points at, or null for a bare
// site link. Tolerates a deeper page (…/tournament/<slug>/tossup), which is
// what you get by copying the address bar rather than a listing link.
function targetSlug(u: string): string | null {
  try {
    const path = new URL(u.trim()).pathname.replace(/\/+$/, "");
    return path.match(/\/(?:set|tournament)\/([^/]+)/)?.[1] ?? null;
  } catch { return null; }
}
// Which tournament HERE that slug means. Source slugs and local names spell the
// same tournament differently ("2025-pace-nsc" / "2025 PACE NSC"), and mirrors
// reorder the words ("PACE NSC 2025"), so fall back to comparing the words
// themselves as a set before giving up.
const tokens = (x: string) => new Set(x.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const sameWords = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((t) => b.has(t));
function matchLocal<T extends { slug: string; name: string }>(sets: T[], slug: string): T | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const n = norm(slug);
  const exact = sets.find((s) => norm(s.slug) === n || norm(s.name) === n);
  if (exact) return exact;
  const words = tokens(slug);
  const loose = sets.filter((s) => sameWords(tokens(s.name), words) || sameWords(tokens(s.slug), words));
  return loose.length === 1 ? loose[0] : null;
}

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

  // The URL serves two purposes and used not to serve the first: it says where
  // the text is refetched FROM, and — when it names one set or tournament rather
  // than a bare site — which tournament here is being asked about. Scanning all
  // of them regardless made a link to one set answer with a dozen others.
  const target = useMemo(() => targetSlug(url), [url]);
  const scoped = useMemo(() => (target ? matchLocal(sets, target) : null), [target, sets]);
  const unmatched = !!target && !scoped;

  async function scan(list: { slug: string; name: string }[]) {
    setBusy(true); setErr(null); setLog([]); setScans(null);
    try {
      const out: Scan[] = [];
      for (let i = 0; i < list.length; i++) {
        setStatus(list.length === 1 ? `Checking ${list[0].name}…` : `Checking ${i + 1} of ${list.length}: ${list[i].name}…`);
        try {
          const d = await post({ op: "bonus-text-scan", slug: list[i].slug });
          if (d.missing > 0) out.push(d as unknown as Scan);
        } catch { /* a set we can't read isn't a repair candidate */ }
      }
      setScans(out);
      setStatus(out.length ? null : list.length === 1 ? `${list[0].name} already has its bonus text.` : "Every tournament has its bonus text.");
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  // Walk one set's editions, chunk by chunk, until the source stops giving text.
  async function repair(s: Scan) {
    for (const ed of s.editions) {
      if (!ed.missing) continue;
      let guard = 0, last = Infinity, flat = 0;
      const where = `${s.name}${s.editions.length > 1 ? ` · ${ed.label}` : ""}`;
      for (;;) {
        if (guard++ > 60) { say(`${where}: gave up after 60 chunks`); break; }
        const d = await post({ op: "bonus-text-chunk", slug: s.slug, edition: ed.index, importUrl: url.trim() });
        setStatus(`${where}: ${d.remaining} bonuses left…`);
        if (d.stalled) { say(`${where}: the source returned no bonus pages — ${d.remaining} still missing`); break; }
        if (d.done) break;
        // A chunk that fetched text but didn't lower the count is going in
        // circles; say so rather than spin quietly until the guard trips.
        flat = d.remaining < last ? 0 : flat + 1;
        last = d.remaining;
        if (flat >= 2) { say(`${where}: no progress — stuck at ${d.remaining} missing; moving on`); break; }
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
          aria-label="Source Buzzpoints site, set, or tournament URL"
          style={{ padding: "6px 8px", border: "1px solid #cdd5e0", borderRadius: 4, minWidth: 340 }}
        />
        <button className="btn-secondary btn-sm" disabled={busy || !ready || unmatched} onClick={() => scan(scoped ? [scoped] : sets)}>
          {!ready ? "Loading tournaments…" : busy && !scans ? "Checking…" : scoped ? `Check ${scoped.name}` : "Check every tournament"}
        </button>
        {scoped && (
          <button className="btn-link" disabled={busy} onClick={() => scan(sets)}>check every tournament instead</button>
        )}
        {scans && scans.length > 0 && (
          <button className="btn-primary btn-sm" disabled={busy || !url.trim()} onClick={() => repairAll(scans)}>
            Fetch text for {scans.length === 1 ? scans[0].name : `all ${scans.length}`}
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {unmatched ? (
          <span className="warn-text">
            That link names “{target}”, but no tournament here matches it — check the name, or use
            “check every tournament”.
          </span>
        ) : scoped ? (
          <>Scoped to <strong>{scoped.name}</strong>, and its text will be refetched from that link.</>
        ) : (
          <>A link to the whole site checks every tournament here. Link one set or tournament to check just that one.</>
        )}
      </p>
      {unmatched && (
        <p><button className="btn-link" disabled={busy || !ready} onClick={() => scan(sets)}>Check every tournament anyway</button></p>
      )}
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

// When the source site is gone, a set's bonus text can still come from its
// packets: a fill file (lead-ins and parts parsed from the packets, keyed to
// this set's rounds with each bonus's answer lines) is applied from the set's
// own Settings. The set is the page you're on, never read from the file — a file
// made for any other set is refused before anything is sent — and the server
// re-checks every answer line and skips what doesn't match.
interface FillFile { slug: string; bonuses: { round: number; num: number }[] }

export function PacketTextFill({ slug, name }: { slug: string; name: string }) {
  const [fill, setFill] = useState<FillFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    setFill(null); setMsg(null); setErr(null);
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (typeof d?.slug !== "string" || !Array.isArray(d?.bonuses)) throw new Error("Not a bonus-text fill file.");
      if (d.slug !== slug) throw new Error(`That file is for a different tournament ("${d.slug}"), not ${name}. Nothing was applied.`);
      setFill(d);
    } catch (e) { setErr((e as Error).message); }
  }

  async function apply() {
    if (!fill) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const d = await post({ op: "bonus-text-fill", slug, fileSlug: fill.slug, bonuses: fill.bonuses });
      clearSetCache(slug);
      const skipped: string[] = d.skipped || [];
      setMsg(`Filled ${d.applied} of ${fill.bonuses.length} bonuses and rebuilt the stats.` +
        (skipped.length ? ` Skipped (answer lines didn't match): ${skipped.join(", ")}.` : ""));
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="cat-toolbar">
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
        {fill && (
          <button className="btn-primary btn-sm" disabled={busy} onClick={apply}>
            {busy ? "Filling…" : `Fill ${fill.bonuses.length} bonuses in ${name}`}
          </button>
        )}
      </div>
      {msg && <p className="muted">{msg}</p>}
      {err && <div className="error-box">{err}</div>}
    </>
  );
}
