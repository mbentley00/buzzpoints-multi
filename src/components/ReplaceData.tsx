import { useMemo, useRef, useState } from "react";
import { clearSetCache, refreshIndex } from "../data";
import { scanDataFolder, filesFromPicker, filesFromZip, mirrorPackets, mirrorCoverage, attachKlaxonLogs, FolderScan } from "../migratorFolder";
import { stageEditions, ingestPostRetry, StageEdition } from "../ingestClient";

// Settings → "Replace all data": swap every edition's packets and games for a
// fresh buzzpoint-migrator export (data folder or .zip) while the set keeps
// its address, name, owner, visibility, invites and corrections.

interface Ed { id: string; label: string; numGames?: number }

// Words that tell two site names apart once the set's own name is removed.
function siteWords(label: string, setName: string): Set<string> {
  const drop = new Set(setName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).concat(["at", "the", "of", "site", "mirror"]));
  return new Set(label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !drop.has(w)));
}
function guessOld(label: string, old: Ed[], setName: string): string {
  const exact = old.find((e) => e.label.trim().toLowerCase() === label.trim().toLowerCase());
  if (exact) return exact.id;
  const w = siteWords(label, setName);
  let best = "", bestN = 0, tie = false;
  for (const e of old) {
    const o = siteWords(e.label, setName);
    const n = [...w].filter((x) => o.has(x)).length;
    if (n > bestN) { best = e.id; bestN = n; tie = false; } else if (n && n === bestN) tie = true;
  }
  return bestN && !tie ? best : "";
}

export function ReplaceData({ slug, setName, scoring, editions, onDone }: {
  slug: string; setName: string; scoring: string; editions: Ed[]; onDone: () => void;
}) {
  const dirInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [setKey, setSetKey] = useState("");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState<Record<string, string>>({});
  // mirror folder name -> existing edition id it replaces ("" = added as new)
  const [replaces, setReplaces] = useState<Record<string, string>>({});
  const [scanMsg, setScanMsg] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const group = scan?.sets.find((g) => g.key === setKey) || null;
  const oldById = useMemo(() => new Map(editions.map((e) => [e.id, e])), [editions]);

  function pickSet(sc: FolderScan, key: string) {
    const g = sc.sets.find((x) => x.key === key);
    if (!g) return;
    setSetKey(key); setSkip(new Set()); setConfirm(false);
    const rep: Record<string, string> = {};
    const used = new Set<string>();
    for (const m of g.mirrors) {
      const id = guessOld(m.label, editions, setName);
      if (id && !used.has(id)) { rep[m.name] = id; used.add(id); } else rep[m.name] = "";
    }
    setReplaces(rep);
    // A mirror that takes over an existing edition keeps that edition's name.
    setLabels(Object.fromEntries(g.mirrors.map((m) => [m.name, rep[m.name] ? oldById.get(rep[m.name])!.label : m.label])));
  }

  async function onPick(list: FileList | null, zip?: File) {
    setErr(null); setDone(null); setScan(null); setScanMsg("");
    try {
      let files;
      if (zip) { setScanMsg("Unzipping…"); files = await filesFromZip(zip); }
      else files = list ? filesFromPicker(list) : [];
      if (!files.length) { setScanMsg(""); return; }
      const sc = await scanDataFolder(files, setScanMsg);
      if (!sc.sets.length) throw new Error("No question set matched any site's games.");
      // Prefer the set whose name matches this tournament, else the biggest.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const pick = sc.sets.find((g) => norm(g.name) === norm(setName)) || [...sc.sets].sort((a, b) => b.mirrors.length - a.mirrors.length)[0];
      setScan(sc);
      pickSet(sc, pick.key);
      setScanMsg("");
    } catch (e) { setErr(String((e as Error).message || e)); setScanMsg(""); }
  }

  const chosen = group ? group.mirrors.filter((m) => !skip.has(m.name)) : [];
  const usedIds = chosen.map((m) => replaces[m.name]).filter(Boolean);
  const dupIds = new Set(usedIds.filter((id, i) => usedIds.indexOf(id) !== i));
  const dropped = editions.filter((e) => !usedIds.includes(e.id));

  async function run() {
    if (!scan || !group) return;
    setErr(null); setBusy(true);
    try {
      const out: StageEdition[] = [];
      for (const m of chosen) {
        const { files } = await mirrorPackets(scan, group.key, m);
        const keepId = replaces[m.name] || undefined;
        out.push({ label: (labels[m.name] || "").trim() || m.label, packets: files, games: m.games, keepId });
      }
      const { jobId, editionCount } = await stageEditions(out, setStatus);
      setStatus("Rebuilding stats…");
      const r = await ingestPostRetry({
        op: "local-finish", jobId, editionCount, refreshSlug: slug,
        name: setName, scoring: group.scoring || scoring, hasBonuses: group.hasBonuses,
      }, (s) => setStatus(`Server busy; retrying in ${s}s…`));
      // The new games replaced the old ones, Klaxon presses and all, so attach
      // any buzz points that came with this export.
      const kx = scan.klaxonLogs.length ? await attachKlaxonLogs(slug, scan.klaxonLogs, setStatus) : [];
      const kxGames = kx.reduce((n, x) => n + x.games, 0);
      const kxBad = kx.filter((x) => x.error || !x.games);
      clearSetCache(slug);
      refreshIndex();
      setScan(null); setConfirm(false);
      setDone(`Replaced. The tournament now has ${r.editions} edition${r.editions === 1 ? "" : "s"}.`
        + (kx.length ? ` Klaxon buzz points added to ${kxGames} game${kxGames === 1 ? "" : "s"}.` : "")
        + (kxBad.length ? ` Couldn't add ${kxBad.map((x) => x.name).join(", ")}: ${kxBad.map((x) => x.error || "no game matched").join("; ")}.` : ""));
      onDone();
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); setStatus(""); }
  }

  return (
    <div className="create-form" style={{ maxWidth: 820 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn-secondary" disabled={busy || !!scanMsg} onClick={() => dirInput.current?.click()}>Choose folder…</button>
        <button type="button" className="btn-secondary" disabled={busy || !!scanMsg} onClick={() => zipInput.current?.click()}>Choose a .zip…</button>
      </div>
      <input
        ref={dirInput} type="file" hidden multiple
        // @ts-expect-error non-standard directory picker
        webkitdirectory="" directory=""
        onChange={(e) => { onPick(e.target.files); e.target.value = ""; }}
      />
      <input ref={zipInput} type="file" hidden accept=".zip" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(null, f); e.target.value = ""; }} />
      {scanMsg && <small className="muted">{scanMsg}</small>}

      {scan && group && (
        <div className="field">
          {scan.klaxonLogs.length > 0 && <small className="muted">Klaxon logs found: {scan.klaxonLogs.map((l) => l.name).join(", ")}</small>}
          {scan.sets.length > 1 && (
            <label className="field">
              <span>Question set</span>
              <select value={setKey} onChange={(e) => pickSet(scan, e.target.value)}>
                {scan.sets.map((g) => <option key={g.key} value={g.key}>{g.name} ({g.mirrors.length} site{g.mirrors.length === 1 ? "" : "s"})</option>)}
              </select>
            </label>
          )}
          <span>{chosen.length} of {group.mirrors.length} sites included</span>
          <div className="site-table-wrap">
            <table className="site-table">
              <thead><tr><th></th><th>Site in the file</th><th>Replaces</th><th>Shown as</th><th>Games</th><th>Rounds with packets</th></tr></thead>
              <tbody>
                {group.mirrors.map((m) => {
                  const off = skip.has(m.name);
                  const cov = mirrorCoverage(scan, group.key, m);
                  const rep = replaces[m.name] || "";
                  return (
                    <tr key={m.name} className={off ? "muted" : ""}>
                      <td><input type="checkbox" aria-label={`Include ${m.label}`} checked={!off} onChange={() => setSkip((s0) => { const n = new Set(s0); if (n.has(m.name)) n.delete(m.name); else n.add(m.name); return n; })} /></td>
                      <td>{m.label}</td>
                      <td>
                        <select value={rep} disabled={off} aria-label={`Edition ${m.label} replaces`} className={rep && dupIds.has(rep) ? "warn-text" : ""}
                          onChange={(e) => {
                            const id = e.target.value;
                            setReplaces((r) => ({ ...r, [m.name]: id }));
                            setLabels((l) => ({ ...l, [m.name]: id ? oldById.get(id)!.label : m.label }));
                          }}>
                          <option value="">(add as new)</option>
                          {editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                        </select>
                      </td>
                      <td><input value={labels[m.name] ?? m.label} disabled={off} onChange={(e) => setLabels((l) => ({ ...l, [m.name]: e.target.value }))} /></td>
                      <td>{m.games.length}{rep && oldById.get(rep)?.numGames != null && <span className="muted"> (was {oldById.get(rep)!.numGames})</span>}</td>
                      <td className={cov.matched < cov.rounds ? "warn-text" : ""}>{cov.matched} / {cov.rounds}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {dupIds.size > 0 && <small className="warn-text">Two sites replace the same edition. Only the first keeps its settings.</small>}
          {dropped.length > 0 && (
            <small className="warn-text">
              Will be removed with their settings: {dropped.map((e) => e.label).join(", ")}
            </small>
          )}

          {!confirm ? (
            <div><button type="button" className="btn-primary" disabled={busy || !chosen.length} onClick={() => setConfirm(true)}>Replace data…</button></div>
          ) : (
            <div className="error-box" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span>Replace every packet and game in this tournament? This can't be undone.</span>
              <button type="button" className="btn-primary" disabled={busy} onClick={run}>{busy ? "Replacing…" : "Yes, replace"}</button>
              <button type="button" className="btn-link" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {status && <small className="muted">{status}</small>}
      {err && <div className="error-inline">{err}</div>}
      {done && <div className="muted">{done}</div>}
    </div>
  );
}
