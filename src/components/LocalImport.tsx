import { useRef, useState } from "react";
import { refreshIndex } from "../data";
import { uploadFiles } from "../upload";
import { TOURNAMENT_LEVELS, Visibility } from "../types";
import { scanDataFolder, filesFromPicker, mirrorPackets, FolderScan, SetGroup } from "../migratorFolder";
import { ingestPostRetry as postRetry } from "../ingestClient";

// Admin-only: import tournaments from a local quizbowlstats data export folder
// (question_sets/<set>/.../packet_files + tournaments/<mirror>/game_files/*.qbj).
// These native files carry full tossup/bonus text and per-game bonus results, so
// they produce complete stats with no scraping. Each set's mirrors become
// editions; each mirror's packets are numbered by the round it actually played
// them (from the QBJ `packets` field). Runs one edition per request.

export function LocalImport() {
  const dirInput = useRef<HTMLInputElement>(null);
  const scanRef = useRef<FolderScan | null>(null);
  const [level, setLevel] = useState("college");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [refreshExisting, setRefreshExisting] = useState(true);
  const [sets, setSets] = useState<SetGroup[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Map<string, string>>(new Map());
  const [reading, setReading] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const stop = useRef(false);
  const addLog = (m: string) => setLog((l) => [...l.slice(-500), m]);

  // Read the chosen folder (see migratorFolder.ts for the layout and matching).
  async function onPick(fileList: FileList | null) {
    setErr(""); setSets(null);
    if (!fileList?.length) return;
    try {
      const scan = await scanDataFolder(filesFromPicker(fileList), setReading);
      scanRef.current = scan;
      const list = scan.sets;
      const idx = await fetch("/api/index").then((r) => r.json()).catch(() => ({ sets: [] }));
      setExisting(new Map((idx.sets ?? []).map((s: any) => [String(s.name || "").toLowerCase(), s.slug] as const)));
      setSets(list);
      setChosen(new Set(list.map((g) => g.key)));
      setReading("");
      const skipped = [scan.noGames && `${scan.noGames} had no usable games`, scan.unmatched && `${scan.unmatched} matched no question set`].filter(Boolean).join(", ");
      addLog(`Found ${list.length} sets, ${scan.mirrorCount} mirrors${skipped ? ` (${skipped})` : ""}, ${scan.packetCount} packet files.`);
      if (!list.length && !scan.packetCount) addLog("No packet files found. Pick the folder containing question_sets/.");
    } catch (e) { setErr(String((e as Error).message || e)); setReading(""); }
  }

  async function importAll() {
    if (!sets || !scanRef.current) return;
    setErr(""); setRunning(true); stop.current = false;
    const todo = sets.filter((g) => chosen.has(g.key));
    addLog(`Importing ${todo.length} set${todo.length === 1 ? "" : "s"}…`);
    let n = 0;
    for (const g of todo) {
      if (stop.current) { addLog("Stopped."); break; }
      n++;
      const refreshSlug = refreshExisting ? existing.get(g.name.toLowerCase()) : undefined;
      const waitLog = (s: number) => addLog(`    …retrying in ${s}s`);
      try {
        addLog(`[${n}/${todo.length}] ${g.name}${refreshSlug ? " (refresh)" : ""}: ${g.mirrors.length} editions`);
        const start = await postRetry({ op: "local-start" }, waitLog);
        let edCount = 0;
        for (const m of g.mirrors) {
          if (stop.current) break;
          if (!m.games.length) continue;
          addLog(`    edition — ${m.label} (${m.games.length} games)`);
          // packet files named by the round this mirror played them, so the server assigns rounds
          const { files: packetFiles, missing: noPacket } = await mirrorPackets(scanRef.current!, g.key, m);
          if (noPacket) addLog(`      ⚠ ${noPacket} of ${m.roundPacket.size} rounds had no packet file`);
          // Uploading hundreds of files takes a while; say so as it goes, or the log
          // sits on the edition line and looks stuck.
          const progress = (what: string) => (d: number, t: number) => { if (d === t || d % 50 === 0) addLog(`      uploaded ${d}/${t} ${what}`); };
          const packetRefs = await uploadFiles(packetFiles, progress("packets"));
          const gameRefs = await uploadFiles(m.games, progress("games"));
          addLog(`      reading them back and building the edition…`);
          await postRetry({ op: "local-edition", jobId: start.jobId, index: edCount, label: m.label, packets: packetRefs, games: gameRefs }, waitLog);
          edCount++;
        }
        if (stop.current) { addLog("Stopped."); break; }
        const fin = await postRetry({ op: "local-finish", jobId: start.jobId, editionCount: edCount, name: g.name, scoring: g.scoring || "ACF", hasBonuses: g.hasBonuses, level, visibility, autoPublicAt: null, ...(refreshSlug ? { refreshSlug } : {}) }, waitLog);
        addLog(`  ✓ ${g.name} → /set/${fin.slug} (${fin.editions} editions)${fin.refreshed ? " — refreshed" : ""}`);
        refreshIndex();
      } catch (e) { addLog(`  ✗ ${g.name}: ${String((e as Error).message || e)}`); }
    }
    setRunning(false);
    if (!stop.current) addLog("Done.");
  }

  const toggle = (k: string) => setChosen((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <div className="bulk-import">
      <div className="create-form" style={{ maxWidth: 620 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Type for new sets</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)} disabled={running}>
              {TOURNAMENT_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Visibility (new sets)</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)} disabled={running}>
              <option value="listed">Listed</option><option value="public">Public</option><option value="private">Private</option>
            </select>
          </label>
        </div>
        <label className="field-inline">
          <input type="checkbox" checked={refreshExisting} onChange={(e) => setRefreshExisting(e.target.checked)} disabled={running} />
          <span>Refresh sets already here</span>
        </label>
        <div>
          <button className="btn-secondary" disabled={running || !!reading} onClick={() => dirInput.current?.click()}>
            {reading || "Choose data folder"}
          </button>
          <input
            ref={dirInput} type="file" hidden multiple
            // @ts-expect-error non-standard directory picker
            webkitdirectory="" directory=""
            onChange={(e) => { onPick(e.target.files); e.target.value = ""; }}
          />
        </div>

        {sets && (
          <div className="field">
            <span>{sets.length} sets found — {chosen.size} selected</span>
            <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid var(--line-strong)", borderRadius: 6, padding: 8 }}>
              {sets.map((g) => {
                const slug = existing.get(g.name.toLowerCase());
                return (
                  <label key={g.key} className="field-inline" style={{ fontWeight: 400 }}>
                    <input type="checkbox" checked={chosen.has(g.key)} onChange={() => toggle(g.key)} disabled={running} />
                    <span>{g.name} <span className="muted">· {g.mirrors.length} ed · {g.scoring || "?"}{slug ? (refreshExisting ? " · refresh" : " · exists") : ""}</span></span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {sets && <button className="btn-primary" onClick={importAll} disabled={running || chosen.size === 0}>
            {running ? "Importing…" : `Import ${chosen.size} set${chosen.size === 1 ? "" : "s"}`}
          </button>}
          {running && <button className="btn-link danger" onClick={() => { stop.current = true; }}>Stop</button>}
        </div>
      </div>
      {err && <div className="error-box">{err}</div>}
      {log.length > 0 && <pre className="bulk-log">{log.join("\n")}</pre>}
    </div>
  );
}
