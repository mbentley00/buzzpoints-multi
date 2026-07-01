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

// Admin-only: discover every set at another Buzzpoints site and import them all,
// one set (and within it, one edition) per request, driven from the browser so
// each request stays within the function time limit.
export function BulkImport() {
  const [baseUrl, setBaseUrl] = useState("https://quizbowlstats.com/buzzpoints");
  const [level, setLevel] = useState("college");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [base, setBase] = useState("");
  const [sets, setSets] = useState<{ slug: string; name: string }[] | null>(null);
  // name (lowercased) -> existing set slug here, for skip/refresh decisions.
  const [existing, setExisting] = useState<Map<string, string>>(new Map());
  const [refreshExisting, setRefreshExisting] = useState(false);
  const [bonusResults, setBonusResults] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const stop = useRef(false);

  const slugFor = (s: { name: string }) => existing.get(s.name.toLowerCase());
  const fresh = (sets ?? []).filter((s) => !slugFor(s));
  const present = (sets ?? []).filter((s) => slugFor(s));
  // What "Import all" will process: new sets always; existing ones only in refresh mode.
  const todoCount = refreshExisting ? (sets ?? []).length : fresh.length;
  const addLog = (m: string) => setLog((l) => [...l.slice(-400), m]);

  async function discover() {
    setErr(""); setSets(null);
    try {
      // Read the live index fresh each time so already-imported sets are skipped
      // (or refreshed) even on a re-run in the same tab (no reload needed).
      const [d, idx] = await Promise.all([
        post({ op: "import-sets", importUrl: baseUrl.trim() }),
        fetch("/api/index").then((r) => r.json()).catch(() => ({ sets: [] })),
      ]);
      setExisting(new Map((idx.sets ?? []).map((s: any) => [String(s.name || "").toLowerCase(), s.slug] as const)));
      setBase(d.base);
      setSets(d.sets);
      addLog(`Found ${d.sets.length} sets at ${d.base}.`);
    } catch (e) { setErr(String((e as Error).message || e)); }
  }

  async function importAll() {
    if (!sets) return;
    setErr(""); setRunning(true); stop.current = false;
    const todo = refreshExisting ? sets : fresh;
    const nRefresh = refreshExisting ? present.length : 0;
    addLog(`Processing ${todo.length} set${todo.length === 1 ? "" : "s"} (${fresh.length} new${nRefresh ? `, ${nRefresh} refreshed in place` : `, ${present.length} already present skipped`})…`);
    let i = 0;
    for (const s of todo) {
      if (stop.current) { addLog("Stopped."); break; }
      i++;
      const refreshSlug = slugFor(s); // set => refresh in place, keeping settings
      try {
        addLog(`[${i}/${todo.length}] ${s.name}${refreshSlug ? " (refresh)" : ""}: reading editions…`);
        const waitLog = (secs: number) => addLog(`    …source is slow; retrying in ${secs}s`);
        const start = await postRetry({ op: "import-start", importUrl: `${base}/set/${s.slug}` }, waitLog);
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
        const fin = await postRetry({ op: "import-finish", jobId: start.jobId, name: s.name, level, visibility, autoPublicAt: null, ...(refreshSlug ? { refreshSlug } : {}) }, waitLog);
        addLog(`  ✓ ${s.name} → /set/${fin.slug} (${fin.editions} editions)${fin.refreshed ? " — refreshed" : ""}`);
        refreshIndex();
      } catch (e) {
        addLog(`  ✗ ${s.name}: ${String((e as Error).message || e)}`);
      }
    }
    setRunning(false);
    if (!stop.current) addLog("Done.");
  }

  return (
    <div className="bulk-import">
      <p className="muted">
        Discover every set at another Buzzpoints site and import them. Each set becomes one tournament (its mirror sites
        are editions). Sets whose name already exists here are skipped — or, with <em>Refresh existing</em> on, re-imported
        in place (keeping their slug, visibility, and corrections) to pick up bonuses and fixes. Keep this tab open — a
        full run can take a while.
      </p>
      <div className="create-form" style={{ maxWidth: 560 }}>
        <label className="field">
          <span>Buzzpoints base URL</span>
          <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={running} />
        </label>
        <div style={{ display: "flex", gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Type for all</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)} disabled={running}>
              {TOURNAMENT_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Visibility</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)} disabled={running}>
              <option value="listed">Listed</option>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </label>
        </div>
        {sets && present.length > 0 && (
          <label className="field-inline">
            <input type="checkbox" checked={refreshExisting} onChange={(e) => setRefreshExisting(e.target.checked)} disabled={running} />
            <span>Refresh the {present.length} set{present.length === 1 ? "" : "s"} already here (re-import in place)</span>
          </label>
        )}
        {sets && (
          <label className="field-inline">
            <input type="checkbox" checked={bonusResults} onChange={(e) => setBonusResults(e.target.checked)} disabled={running} />
            <span>Import full bonus data — question text + per-team results (slow; scrapes every bonus page, some may 504)</span>
          </label>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn-secondary" onClick={discover} disabled={running}>Discover sets</button>
          {sets && <button className="btn-primary" onClick={importAll} disabled={running || todoCount === 0}>
            {running ? "Importing…" : refreshExisting ? `Import + refresh (${todoCount})` : `Import all (${todoCount})`}
          </button>}
          {running && <button className="btn-link danger" onClick={() => { stop.current = true; }}>Stop</button>}
        </div>
      </div>
      {err && <div className="error-box">{err}</div>}
      {log.length > 0 && <pre className="bulk-log">{log.join("\n")}</pre>}
    </div>
  );
}
