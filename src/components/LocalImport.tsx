import { useRef, useState } from "react";
import { refreshIndex } from "../data";
import { uploadFiles } from "../upload";
import { TOURNAMENT_LEVELS, Visibility } from "../types";

// Admin-only: import tournaments from a local quizbowlstats data export folder
// (question_sets/<set>/.../packet_files + tournaments/<mirror>/game_files/*.qbj).
// These native files carry full tossup/bonus text and per-game bonus results, so
// they produce complete stats with no scraping. Each set's mirrors become
// editions; each mirror's packets are numbered by the round it actually played
// them (from the QBJ `packets` field). Runs one edition per request.

// Normalize a packet name for matching: drop a trailing "(2)" duplicate-read
// marker the source adds, then keep only alphanumerics (so "Packet-J_McGill-A…"
// and "Packet J - McGill A, …" collapse to the same key).
const norm = (s: string) => s.toLowerCase().replace(/\(\d+\)\s*$/, "").replace(/[^a-z0-9]/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Scoring format from the distinct buzz values (mirrors src/detectScoring).
function scoringFromValues(vals: Set<number>): string | null {
  if (!vals.size) return null;
  const has = (n: number) => vals.has(n);
  const hasNeg = [...vals].some((v) => v < 0);
  const maxPos = Math.max(0, ...[...vals].filter((v) => v > 0));
  if (has(20) && has(15)) return "SUPERPOWER";
  if (has(20) && hasNeg) return "SUPERPOWER";
  if (has(20)) return "PACE";
  if (has(15) || maxPos === 15) return "mACF";
  if (maxPos === 10) return "ACF";
  return null;
}

async function post(b: any) {
  const r = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
}
const RETRYABLE = /\b(429|500|502|503|504)\b|timeout|network|fetch/i;
async function postRetry(b: any, onWait?: (s: number) => void, tries = 4) {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await post(b); }
    catch (e) { last = e; if (i === tries - 1 || !RETRYABLE.test(String((e as Error).message || e))) throw e; const s = 10 * (i + 1); onWait?.(s); await sleep(s * 1000); }
  }
  throw last;
}

interface Mirror { name: string; games: File[]; roundPacket: Map<number, string> }
interface SetGroup { key: string; name: string; hasBonuses: boolean; scoring: string | null; mirrors: Mirror[] }

// Segment list after `anchor` in a "/"-split path, or null.
function afterAnchor(parts: string[], anchor: string): string[] | null {
  const i = parts.indexOf(anchor);
  return i >= 0 ? parts.slice(i + 1) : null;
}

export function LocalImport() {
  const dirInput = useRef<HTMLInputElement>(null);
  const packetFileRef = useRef<Map<string, File>>(new Map()); // `${setKey}|${normPacket}` -> packet File
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

  // Read the chosen folder: index packet files, then read every mirror's games
  // to build its round -> packet map, vote its set, and detect scoring.
  async function onPick(fileList: FileList | null) {
    setErr(""); setSets(null);
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    try {
      setReading("Scanning files…");
      const packetFile = new Map<string, File>();      // `${setKey}|${normPkt}` -> File
      const pkt2set = new Map<string, Set<string>>();  // normPkt -> setKeys
      const setName = new Map<string, string>();
      const setBonuses = new Map<string, boolean>();
      const mirrorFiles = new Map<string, File[]>();
      const setIndexFiles: { setKey: string; f: File }[] = [];

      for (const f of files) {
        const parts = (f.webkitRelativePath || f.name).split("/");
        const qs = afterAnchor(parts, "question_sets");
        if (qs) {
          const setKey = qs[0];
          if (qs.length === 2 && qs[1] === "index.json") setIndexFiles.push({ setKey, f });
          else if (qs[2] === "packet_files" && qs[qs.length - 1].endsWith(".json")) {
            const n = norm(qs[qs.length - 1].replace(/\.json$/i, ""));
            packetFile.set(`${setKey}|${n}`, f);
            if (!pkt2set.has(n)) pkt2set.set(n, new Set());
            pkt2set.get(n)!.add(setKey);
          }
          continue;
        }
        const tj = afterAnchor(parts, "tournaments");
        if (tj && tj[1] === "game_files" && tj[tj.length - 1].toLowerCase().endsWith(".qbj")) {
          const mirror = tj[0];
          if (!mirrorFiles.has(mirror)) mirrorFiles.set(mirror, []);
          mirrorFiles.get(mirror)!.push(f);
        }
      }
      packetFileRef.current = packetFile;
      for (const { setKey, f } of setIndexFiles) {
        try { const j = JSON.parse(await f.text()); setName.set(setKey, j.name || setKey); setBonuses.set(setKey, j.bonuses !== false); }
        catch { setName.set(setKey, setKey); }
      }
      if (!mirrorFiles.size) throw new Error("No tournaments/<mirror>/game_files/*.qbj found. Pick the exported data folder (with question_sets/ and tournaments/).");

      const groups = new Map<string, SetGroup>();
      const setValues = new Map<string, Set<number>>();
      let mi = 0, unmapped = 0;
      for (const [mirror, games] of mirrorFiles) {
        setReading(`Reading games… ${++mi}/${mirrorFiles.size} mirrors`);
        const roundPacket = new Map<number, string>();
        const vals = new Set<number>();
        for (const gf of games) {
          let g: any;
          try { g = JSON.parse(await gf.text()); } catch { continue; }
          const r = Number(g._round);
          if (Number.isInteger(r) && g.packets && !roundPacket.has(r)) roundPacket.set(r, String(g.packets));
          for (const mq of g.match_questions || []) for (const bz of mq.buzzes || []) { const v = bz?.result?.value; if (typeof v === "number") vals.add(v); }
        }
        if (!roundPacket.size) { unmapped++; continue; } // no games / no round info
        // vote the set whose packet files match the most of this mirror's packets
        const votes = new Map<string, number>();
        for (const pk of roundPacket.values()) for (const sk of pkt2set.get(norm(pk)) || []) votes.set(sk, (votes.get(sk) || 0) + 1);
        let setKey: string | undefined, best = -1;
        for (const [sk, c] of votes) if (c > best) { best = c; setKey = sk; }
        if (!setKey) { unmapped++; continue; }
        if (!groups.has(setKey)) groups.set(setKey, { key: setKey, name: setName.get(setKey) || setKey, hasBonuses: setBonuses.get(setKey) !== false, scoring: null, mirrors: [] });
        groups.get(setKey)!.mirrors.push({ name: mirror, games, roundPacket });
        if (!setValues.has(setKey)) setValues.set(setKey, new Set());
        for (const v of vals) setValues.get(setKey)!.add(v);
      }
      for (const g of groups.values()) g.scoring = scoringFromValues(setValues.get(g.key) || new Set());
      const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

      const idx = await fetch("/api/index").then((r) => r.json()).catch(() => ({ sets: [] }));
      setExisting(new Map((idx.sets ?? []).map((s: any) => [String(s.name || "").toLowerCase(), s.slug] as const)));
      setSets(list);
      setChosen(new Set(list.map((g) => g.key)));
      setReading("");
      addLog(`Found ${list.length} sets, ${mirrorFiles.size} mirrors${unmapped ? ` (${unmapped} had no usable games)` : ""}.`);
    } catch (e) { setErr(String((e as Error).message || e)); setReading(""); }
  }

  async function importAll() {
    if (!sets) return;
    const packetFile = packetFileRef.current;
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
          addLog(`    edition — ${m.name} (${m.games.length} games)`);
          // packet files named by the round this mirror played them, so the server assigns rounds
          const packetFiles: File[] = [];
          for (const [rnd, pktName] of m.roundPacket) {
            const pf = packetFile.get(`${g.key}|${norm(pktName)}`);
            if (pf) packetFiles.push(new File([await pf.text()], `Round_${rnd}.json`, { type: "application/json" }));
          }
          const packetRefs = await uploadFiles(packetFiles);
          const gameRefs = await uploadFiles(m.games);
          await postRetry({ op: "local-edition", jobId: start.jobId, index: edCount, label: m.name, packets: packetRefs, games: gameRefs }, waitLog);
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
      <p className="muted">
        Import from a local quizbowlstats data export (the folder with <code>question_sets/</code> and <code>tournaments/</code>).
        These native files give full tossup &amp; bonus text and per-team results — no scraping. Each set's mirror sites become
        editions. Keep this tab open; a full run uploads many files.
      </p>
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
          <span>Refresh sets already here, in place (keep slug, visibility, invites, corrections)</span>
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
