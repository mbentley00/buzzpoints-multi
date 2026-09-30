import { useEffect, useState } from "react";
import { clearSetCache } from "../data";

// TEMPORARY (remove with api/_fills once applied): apply the bonus-text fill
// files that shipped with this deployment, one tournament at a time, and report
// what each one filled.
interface Result { slug: string; fills?: number; applied?: number; skipped?: string[]; stillBlank?: number; error?: string }

export function BundledFills() {
  const [slugs, setSlugs] = useState<string[] | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin?op=bundled-fills").then((r) => r.json()).then((d) => setSlugs(d.slugs || [])).catch(() => setSlugs([]));
  }, []);

  async function run() {
    if (!slugs?.length) return;
    setBusy(true); setResults([]);
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      setStatus(`Filling ${i + 1} of ${slugs.length}: ${slug}…`);
      let out: Result;
      try {
        const r = await fetch("/api/admin?op=bundled-fills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug }) });
        const d = await r.json().catch(() => ({}));
        out = r.ok ? (d as Result) : { slug, error: (d as { error?: string }).error || `Failed (${r.status})` };
      } catch (e) { out = { slug, error: String((e as Error).message || e) }; }
      clearSetCache(slug);
      setResults((rs) => [...rs, out]);
    }
    setStatus("Done.");
    setBusy(false);
  }

  if (!slugs?.length) return null;
  return (
    <div>
      <p className="muted">
        This deployment carries bonus text for {slugs.length} tournaments that were imported without it, built from their
        packets and matched to each bonus by its answer lines. Applying it fills lead-ins and parts only, then rebuilds
        each tournament's stats.
      </p>
      <button className="btn-primary btn-sm" disabled={busy} onClick={run}>
        {busy ? "Applying…" : `Apply bundled bonus text to ${slugs.length} tournaments`}
      </button>
      {status && <p className="muted">{status}</p>}
      {results.length > 0 && (
        <div className="table-wrap" style={{ maxWidth: 820 }}>
          <table className="data-table">
            <thead><tr><th>Tournament</th><th className="right">Filled</th><th className="right">Still blank</th><th>Skipped / error</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.slug}>
                  <td className="mono">{r.slug}</td>
                  <td className="right mono">{r.error ? "—" : `${r.applied} / ${r.fills}`}</td>
                  <td className="right mono">{r.error ? "—" : r.stillBlank}</td>
                  <td className={r.error ? "warn-text" : "muted"}>{r.error || (r.skipped?.length ? r.skipped.join(", ") : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
