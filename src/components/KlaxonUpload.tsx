import { useRef, useState } from "react";
import { clearSetCache, refreshIndex } from "../data";
import { roundLabel } from "../util";
import { filesFromZip, isKlaxonLog } from "../migratorFolder";

// Settings → Klaxon buzz logs. Each log (klaxon_<ROOM>_full_buzz.json, from a
// Klaxon room's buzz panel) is matched game by game to the QBJs already here;
// attaching stores the extra presses on those games and rebuilds.

interface Match {
  segment: number; round: string | null; teams: string[]; cycles: number;
  match: { editionId: string; editionLabel: string; index: number; round: number; teams: string[]; agree: number } | null;
  reason?: string;
}
interface Picked { file: string; log: unknown; room: string; matches: Match[] | null; error?: string; done?: boolean }

async function post(body: unknown) {
  const r = await fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
  return d;
}

export function KlaxonUpload({ slug, hasKlaxon, multiEdition }: { slug: string; hasKlaxon: boolean; multiEdition: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function onPick(list: FileList | null) {
    setErr(""); setMsg("");
    const picked: Picked[] = [];
    for (const f of Array.from(list || [])) {
      // Klaxon's quizbowlbuzzpoints zip carries the tournament's buzz points
      // beside its data/ folder; take every Klaxon log out of it.
      if (/\.zip$/i.test(f.name)) {
        try {
          let found = 0;
          for (const e of await filesFromZip(f)) {
            if (!/\.json$/i.test(e.path) || /(^|\/)(question_sets|tournaments)\//.test(e.path)) continue;
            try {
              const d = JSON.parse(await e.file.text());
              if (isKlaxonLog(d)) { picked.push({ file: `${f.name} › ${e.file.name}`, log: d, room: "", matches: null }); found++; }
            } catch { /* not JSON */ }
          }
          if (!found) picked.push({ file: f.name, log: null, room: "", matches: null, error: "No Klaxon buzz points in this zip." });
        } catch { picked.push({ file: f.name, log: null, room: "", matches: null, error: "Couldn't read this zip." }); }
        continue;
      }
      try { picked.push({ file: f.name, log: JSON.parse(await f.text()), room: "", matches: null }); }
      catch { picked.push({ file: f.name, log: null, room: "", matches: null, error: "Not a JSON file." }); }
    }
    setFiles(picked);
    setBusy(true);
    const out: Picked[] = [];
    for (const p of picked) {
      if (p.error) { out.push(p); continue; }
      try {
        const d = await post({ slug, op: "klaxon-match", log: p.log, file: p.file });
        out.push({ ...p, room: d.room, matches: d.matches });
      } catch (e) { out.push({ ...p, error: String((e as Error).message || e) }); }
      setFiles([...out, ...picked.slice(out.length)]);
    }
    setBusy(false);
  }

  async function attach() {
    setBusy(true); setErr(""); setMsg("");
    let games = 0;
    try {
      const next = [...files];
      for (let i = 0; i < next.length; i++) {
        const p = next[i];
        if (p.error || !p.matches?.some((m) => m.match)) continue;
        const d = await post({ slug, op: "klaxon-attach", log: p.log, file: p.file });
        games += d.attached || 0;
        next[i] = { ...p, done: true };
        setFiles([...next]);
      }
      clearSetCache(slug); refreshIndex();
      setMsg(`Attached to ${games} game${games === 1 ? "" : "s"}. Reload to see the Klaxon page.`);
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  async function clearAll() {
    if (!window.confirm("Remove every Klaxon buzz log from this tournament? The QBJ stats aren't affected.")) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const d = await post({ slug, op: "klaxon-clear" });
      clearSetCache(slug); refreshIndex();
      setMsg(`Removed from ${d.cleared} game${d.cleared === 1 ? "" : "s"}.`);
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  const matched = files.reduce((n, p) => n + (p.matches?.filter((m) => m.match).length ?? 0), 0);
  return (
    <div className="srcfiles">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => input.current?.click()}>Choose Klaxon file or zip…</button>
        <input ref={input} type="file" hidden multiple accept=".json,.zip" onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
        {hasKlaxon && <button type="button" className="btn-link danger" disabled={busy} onClick={clearAll}>Remove all Klaxon data</button>}
      </div>
      {files.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data-table">
            <thead><tr><th>Log</th><th>Round</th><th>Teams</th><th className="right">Buzzes</th><th>Game here</th></tr></thead>
            <tbody>
              {files.flatMap((p) => p.error || !p.matches
                ? [<tr key={p.file}><td>{p.file}</td><td colSpan={4} className={p.error ? "warn-text" : "muted"}>{p.error || "Checking…"}</td></tr>]
                : p.matches.map((m, i) => (
                  <tr key={`${p.file}-${i}`} className={m.match ? "" : "muted"}>
                    <td>{i === 0 ? <>{p.file}{p.room && <span className="muted"> · room {p.room}</span>}{p.done && <span className="ok-msg"> ✓</span>}</> : ""}</td>
                    <td>{m.round ?? "—"}</td>
                    <td>{m.teams.join(" vs ") || "—"}</td>
                    <td className="right mono">{m.cycles}</td>
                    <td>
                      {m.match
                        ? <>{multiEdition && `${m.match.editionLabel} · `}round {roundLabel(m.match.round)}, {m.match.teams.join(" vs ")} <span className="muted">({m.match.agree}/{m.cycles} agree)</span></>
                        : <span className="warn-text">{m.reason}</span>}
                    </td>
                  </tr>
                )))}
            </tbody>
          </table>
        </div>
      )}
      {files.length > 0 && (
        <div className="srcfiles-actions">
          <button className="btn-primary btn-sm" disabled={busy || !matched} onClick={attach}>
            {busy ? "Working…" : `Attach ${matched} game${matched === 1 ? "" : "s"} & rebuild`}
          </button>
        </div>
      )}
      {msg && <p className="ok-msg">{msg}</p>}
      {err && <div className="error-box">{err}</div>}
    </div>
  );
}
