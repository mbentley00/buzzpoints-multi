import { useRef, useState } from "react";
import { refreshIndex } from "../data";
import { TOURNAMENT_LEVELS, Visibility } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(b: any) {
  const r = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
}

// Heavy bonus scraping makes the (Cloudflare-fronted) source throttle, which can
// push a later edition scrape past the function time limit (a bare 504). Retry
// those transient failures with a growing backoff so the throttle can subside;
// each op is idempotent, so re-running is safe.
const RETRYABLE = /\b(429|500|502|503|504)\b|timeout|network|fetch/i;
async function postRetry(b: any, onWait?: (s: number) => void, tries = 4) {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await post(b); }
    catch (e) {
      last = e;
      if (i === tries - 1 || !RETRYABLE.test(String((e as Error).message || e))) throw e;
      const secs = 10 * (i + 1); // 10s, 20s, 30s
      onWait?.(secs);
      await sleep(secs * 1000);
    }
  }
  throw last;
}

// One tournament queued for import, and what it will be called here.
interface Row {
  key: string;
  base: string;              // the site it was found at
  slug: string;              // its slug there
  kind: "set" | "tournament"; // which kind of source page to import from
  sourceName: string;        // what it's called there, for the "renamed from" note
  name: string;              // what it will be called here (editable)
  level: string;
  visibility: Visibility;
  selected: boolean;
}

const hostOf = (base: string) => { try { return new URL(base).host; } catch { return base; } };
const importUrlOf = (r: Row) => `${r.base}/${r.kind}/${r.slug}`;

// Admin-only: gather sets from one or more other Buzzpoints sites and import
// them, one set (and within it, one edition) per request, driven from the
// browser so each request stays within the function time limit.
//
// Discovery ADDS to a visible queue rather than replacing it, so several sites
// can be gathered into one run — and every row is shown with the name and
// visibility it will land under, because those are decisions, not details to
// infer from a URL. A row whose name matches a set already here refreshes that
// set in place instead of creating a second copy; since that overwrites real
// data, those rows arrive unticked and say so.
export function BulkImport() {
  const [urlInput, setUrlInput] = useState("https://quizbowlstats.com/buzzpoints");
  const [level, setLevel] = useState("college");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [rows, setRows] = useState<Row[]>([]);
  // name (lowercased) -> existing set slug here, for refresh-in-place decisions.
  const [existing, setExisting] = useState<Map<string, string>>(new Map());
  // On by default: an import without it is missing bonus text and per-team
  // results, and backfilling that later means scraping the whole thing again.
  // The cost is time, which the log makes visible while it runs.
  const [bonusResults, setBonusResults] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const stop = useRef(false);

  // Recomputed from the CURRENT name on every render: renaming a row onto an
  // existing tournament makes it a refresh, and renaming it away makes it new.
  const refreshSlugFor = (r: Row) => existing.get(r.name.trim().toLowerCase());
  const selected = rows.filter((r) => r.selected && r.name.trim());
  const addLog = (m: string) => setLog((l) => [...l.slice(-400), m]);
  const patch = (key: string, up: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...up } : r)));

  async function discover() {
    setErr(""); setDiscovering(true);
    try {
      // Read the live index fresh each time so the already-here markers are
      // right even on a re-run in the same tab (no reload needed).
      const [d, idx] = await Promise.all([
        post({ op: "import-sets", importUrl: urlInput.trim() }),
        fetch("/api/index").then((r) => r.json()).catch(() => ({ sets: [] })),
      ]);
      const here = new Map<string, string>((idx.sets ?? []).map((s: any) => [String(s.name || "").toLowerCase(), s.slug] as const));
      setExisting(here);
      const found: { slug: string; name: string; kind: "set" | "tournament" }[] = d.sets || [];
      let added = 0, dupes = 0;
      setRows((prev) => {
        const seen = new Set(prev.map((r) => `${r.base}|${r.slug}`));
        const next = [...prev];
        for (const s of found) {
          const key = `${d.base}|${s.slug}`;
          if (seen.has(key)) { dupes++; continue; }
          seen.add(key);
          added++;
          next.push({
            key, base: d.base, slug: s.slug, kind: s.kind || "set",
            sourceName: s.name, name: s.name, level, visibility,
            // A name that already exists here would overwrite that tournament,
            // so it never rides along on a bulk tick — it has to be chosen.
            selected: !here.has(s.name.trim().toLowerCase()),
          });
        }
        return next;
      });
      addLog(`Found ${found.length} at ${hostOf(d.base)} — added ${added}${dupes ? `, ${dupes} already queued` : ""}.`);
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setDiscovering(false); }
  }

  async function importAll() {
    setErr(""); setRunning(true); stop.current = false;
    const todo = selected;
    const nRefresh = todo.filter((r) => refreshSlugFor(r)).length;
    addLog(`Processing ${todo.length} tournament${todo.length === 1 ? "" : "s"} (${todo.length - nRefresh} new${nRefresh ? `, ${nRefresh} refreshed in place` : ""})…`);
    let i = 0;
    for (const s of todo) {
      if (stop.current) { addLog("Stopped."); break; }
      i++;
      const name = s.name.trim();
      const refreshSlug = refreshSlugFor(s); // set => refresh in place, keeping settings
      try {
        addLog(`[${i}/${todo.length}] ${name}${refreshSlug ? " (refresh)" : ""} ← ${hostOf(s.base)}: reading editions…`);
        const waitLog = (secs: number) => addLog(`    …source is slow; retrying in ${secs}s`);
        const start = await postRetry({ op: "import-start", importUrl: importUrlOf(s) }, waitLog);
        for (let e = 0; e < start.total; e++) {
          if (stop.current) break;
          addLog(`    edition ${e + 1}/${start.total}${start.editions?.[e]?.name ? ` — ${start.editions[e].name}` : ""}`);
          const ed = await postRetry({ op: "import-edition", jobId: start.jobId, index: e }, waitLog);
          // Optional: scrape per-team bonus results + text in chunks (slow; some pages 504).
          if (bonusResults && ed.bonusTotal > 0) {
            let done = false;
            while (!done && !stop.current) {
              const r = await postRetry({ op: "import-bonus-chunk", jobId: start.jobId, index: e }, waitLog);
              addLog(`      bonus results ${Math.min(r.cursor, r.total)}/${r.total}`);
              done = r.done;
            }
            if (e < start.total - 1) await sleep(2000); // brief pause between editions to ease throttling
          }
        }
        if (stop.current) { addLog("Stopped."); break; }
        const fin = await postRetry({ op: "import-finish", jobId: start.jobId, name, level: s.level, visibility: s.visibility, autoPublicAt: null, ...(refreshSlug ? { refreshSlug } : {}) }, waitLog);
        addLog(`  ✓ ${name} → /set/${fin.slug} (${fin.editions} editions)${fin.refreshed ? " — refreshed" : ""}`);
        // Done rows leave the queue, so a re-run after a partial failure retries
        // only what's left instead of re-importing what already landed.
        setRows((rs) => rs.filter((r) => r.key !== s.key));
        setExisting((m) => new Map(m).set(name.toLowerCase(), fin.slug));
        refreshIndex();
      } catch (e) {
        addLog(`  ✗ ${name}: ${String((e as Error).message || e)}`);
      }
    }
    setRunning(false);
    if (!stop.current) addLog("Done.");
  }

  const busy = running || discovering;

  return (
    <div className="bulk-import">
      <p className="muted">
        Import tournaments from another Buzzpoints site. Paste the site to list every set there, or paste one set or
        tournament page to queue just that one; either way they collect below, so you can gather from several sites and
        run them together. Each set becomes one tournament here, with its mirror sites as editions. Keep this tab open —
        a full run can take a while.
      </p>
      <div className="create-form" style={{ maxWidth: 640 }}>
        <label className="field">
          <span>Buzzpoints site, set, or tournament URL</span>
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!busy) discover(); } }}
          />
        </label>
        <div style={{ display: "flex", gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Type for new rows</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)} disabled={busy}>
              {TOURNAMENT_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Visibility for new rows</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)} disabled={busy}>
              <option value="listed">Listed</option>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn-secondary" onClick={discover} disabled={busy}>
            {discovering ? "Looking…" : "Add from URL"}
          </button>
          {rows.length > 0 && (
            <button className="btn-secondary" disabled={busy} onClick={() => setRows((rs) => rs.map((r) => ({ ...r, level, visibility })))}>
              Apply type + visibility to all
            </button>
          )}
        </div>
      </div>

      {err && <div className="error-box">{err}</div>}

      {rows.length > 0 && (
        <>
          <div className="import-queue-head">
            <h3>Queued ({rows.length})</h3>
            <span className="muted">
              <button className="btn-link" disabled={busy} onClick={() => setRows((rs) => rs.map((r) => ({ ...r, selected: true })))}>select all</button>
              {" · "}
              <button className="btn-link" disabled={busy} onClick={() => setRows((rs) => rs.map((r) => ({ ...r, selected: false })))}>none</button>
              {" · "}
              <button className="btn-link danger" disabled={busy} onClick={() => setRows([])}>clear queue</button>
            </span>
          </div>
          <table className="data-table import-queue">
            <thead>
              <tr>
                <th />
                <th>Name here</th>
                <th>Source</th>
                <th>Type</th>
                <th>Visibility</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const refresh = refreshSlugFor(r);
                const renamed = r.name.trim() && r.name.trim() !== r.sourceName;
                return (
                  <tr key={r.key} className={r.selected ? "" : "row-off"}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.selected}
                        disabled={busy}
                        aria-label={`Import ${r.name}`}
                        onChange={(e) => patch(r.key, { selected: e.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        className="import-name"
                        value={r.name}
                        disabled={busy}
                        onChange={(e) => patch(r.key, { name: e.target.value })}
                      />
                      <div className="import-note muted">
                        {refresh ? (
                          <span className="warn-text">Refreshes the existing “{r.name.trim()}” in place — its settings and corrections are kept, its data replaced.</span>
                        ) : renamed ? (
                          <>New tournament · from “{r.sourceName}”</>
                        ) : (
                          <>New tournament</>
                        )}
                      </div>
                    </td>
                    <td className="muted import-src">
                      {hostOf(r.base)}
                      <div>/{r.kind}/{r.slug}</div>
                    </td>
                    {/* A refresh keeps the existing tournament's own type and
                        visibility — offering to set them here would be a lie. */}
                    <td>
                      {refresh ? <span className="muted">kept</span> : (
                        <select value={r.level} disabled={busy} onChange={(e) => patch(r.key, { level: e.target.value })}>
                          {TOURNAMENT_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      {refresh ? <span className="muted">kept</span> : (
                        <select value={r.visibility} disabled={busy} onChange={(e) => patch(r.key, { visibility: e.target.value as Visibility })}>
                          <option value="listed">Listed</option>
                          <option value="public">Public</option>
                          <option value="private">Private</option>
                        </select>
                      )}
                    </td>
                    <td>
                      <button className="btn-link danger" disabled={busy} title="Remove from queue"
                        onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <label className="field-inline" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={bonusResults} onChange={(e) => setBonusResults(e.target.checked)} disabled={busy} />
            <span>Import full bonus data — question text + per-team results (slow; scrapes every bonus page, some may 504)</span>
          </label>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
            <button className="btn-primary" onClick={importAll} disabled={busy || selected.length === 0}>
              {running ? "Importing…" : `Import ${selected.length} selected`}
            </button>
            {running && <button className="btn-link danger" onClick={() => { stop.current = true; }}>Stop</button>}
          </div>
        </>
      )}

      {log.length > 0 && <pre className="bulk-log">{log.join("\n")}</pre>}
    </div>
  );
}
