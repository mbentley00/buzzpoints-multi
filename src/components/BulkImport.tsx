import { useRef, useState } from "react";
import { refreshIndex } from "../data";
import { TOURNAMENT_LEVELS, Visibility } from "../types";

async function post(b: any) {
  const r = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
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
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const stop = useRef(false);

  const pending = (sets ?? []).filter((s) => !existing.has(s.name.toLowerCase()));
  const addLog = (m: string) => setLog((l) => [...l.slice(-400), m]);

  async function discover() {
    setErr(""); setSets(null);
    try {
      // Read the live index fresh each time so already-imported sets are skipped
      // even on a re-run in the same tab (no reload needed).
      const [d, idx] = await Promise.all([
        post({ op: "import-sets", importUrl: baseUrl.trim() }),
        fetch("/api/index").then((r) => r.json()).catch(() => ({ sets: [] })),
      ]);
      setExisting(new Set((idx.sets ?? []).map((s: any) => String(s.name || "").toLowerCase())));
      setBase(d.base);
      setSets(d.sets);
      addLog(`Found ${d.sets.length} sets at ${d.base}.`);
    } catch (e) { setErr(String((e as Error).message || e)); }
  }

  async function importAll() {
    if (!sets) return;
    setErr(""); setRunning(true); stop.current = false;
    const todo = sets.filter((s) => !existing.has(s.name.toLowerCase()));
    addLog(`Importing ${todo.length} set${todo.length === 1 ? "" : "s"} (${sets.length - todo.length} already present, skipped)…`);
    let i = 0;
    for (const s of todo) {
      if (stop.current) { addLog("Stopped."); break; }
      i++;
      try {
        addLog(`[${i}/${todo.length}] ${s.name}: reading editions…`);
        const start = await post({ op: "import-start", importUrl: `${base}/set/${s.slug}` });
        for (let e = 0; e < start.total; e++) {
          if (stop.current) break;
          addLog(`    edition ${e + 1}/${start.total}${start.editions?.[e]?.name ? ` — ${start.editions[e].name}` : ""}`);
          await post({ op: "import-edition", jobId: start.jobId, index: e });
        }
        if (stop.current) { addLog("Stopped."); break; }
        const fin = await post({ op: "import-finish", jobId: start.jobId, name: s.name, level, visibility, autoPublicAt: null });
        addLog(`  ✓ ${s.name} → /set/${fin.slug} (${fin.editions} editions)`);
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
        are editions), tossup-only. Sets whose name already exists here are skipped. Keep this tab open — a full run can
        take a while.
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
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn-secondary" onClick={discover} disabled={running}>Discover sets</button>
          {sets && <button className="btn-primary" onClick={importAll} disabled={running || pending.length === 0}>
            {running ? "Importing…" : `Import all (${pending.length})`}
          </button>}
          {running && <button className="btn-link danger" onClick={() => { stop.current = true; }}>Stop</button>}
        </div>
      </div>
      {err && <div className="error-box">{err}</div>}
      {log.length > 0 && <pre className="bulk-log">{log.join("\n")}</pre>}
    </div>
  );
}
