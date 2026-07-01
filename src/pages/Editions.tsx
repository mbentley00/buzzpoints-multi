import { useState } from "react";
import { Link } from "react-router-dom";
import { refreshIndex } from "../data";
import { useSetCtx } from "../components/Layout";
import { PageHeader, Loading, ErrorBox } from "../components/Common";
import { uploadFiles } from "../upload";
import { FileDrop } from "../components/FileDrop";

type Seg = { op: "eq" | "del" | "add"; text: string };
// Word-level LCS diff producing a unified inline change (A → B).
function wordDiff(a: string, b: string): Seg[] {
  const A = a ? a.split(" ") : [], B = b ? b.split(" ") : [];
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw: Seg[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { raw.push({ op: "eq", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ op: "del", text: A[i] }); i++; }
    else { raw.push({ op: "add", text: B[j] }); j++; }
  }
  while (i < n) raw.push({ op: "del", text: A[i++] });
  while (j < m) raw.push({ op: "add", text: B[j++] });
  const out: Seg[] = [];
  for (const s of raw) { const last = out[out.length - 1]; if (last && last.op === s.op) last.text += " " + s.text; else out.push({ ...s }); }
  return out;
}
const Diff = ({ a, b }: { a: string; b: string }) => (
  <span className="wd">{wordDiff(a, b).map((s, i) => <span key={i} className={`wd-${s.op}`}>{s.text} </span>)}</span>
);

interface DiffResult {
  a: { id: string; label: string }; b: { id: string; label: string };
  summary: { tossupTotal: number; tuChanged: number; tuOnlyA: number; tuOnlyB: number; bonusTotal: number; bnChanged: number; bnOnlyA: number; bnOnlyB: number };
  tossups: any[]; bonuses: any[];
}

function ChangedTossup({ c, ae, be }: { c: any; ae: string; be: string }) {
  return (
    <div className="diff-item">
      <div className="diff-head"><span className="mono">Tossup {c.round}-{c.num}</span>{" "}
        {c.status === "changed"
          ? <>{c.questionChanged && <span className="diff-tag">question</span>} {c.answerChanged && <span className="diff-tag">answer</span>}</>
          : <span className="diff-tag diff-tag-only">{c.status === "only-a" ? `only in ${ae}` : `only in ${be}`}</span>}
      </div>
      {c.status === "changed" ? (
        <>
          {c.questionChanged && <p className="diff-line"><span className="diff-field">Q</span> <Diff a={c.a.question} b={c.b.question} /></p>}
          {c.answerChanged && <p className="diff-line"><span className="diff-field">A</span> <Diff a={c.a.answer} b={c.b.answer} /></p>}
        </>
      ) : <p className="diff-line muted">{(c.a || c.b).answer}</p>}
    </div>
  );
}
function ChangedBonus({ c, ae, be }: { c: any; ae: string; be: string }) {
  const join = (x: any) => (x ? [x.leadin, ...(x.parts || []), ...(x.answers || [])].join("  ·  ") : "");
  return (
    <div className="diff-item">
      <div className="diff-head"><span className="mono">Bonus {c.round}-{c.num}</span>{" "}
        {c.status === "changed"
          ? <>{c.leadinChanged && <span className="diff-tag">leadin</span>} {c.partsChanged && <span className="diff-tag">parts</span>} {c.answersChanged && <span className="diff-tag">answers</span>}</>
          : <span className="diff-tag diff-tag-only">{c.status === "only-a" ? `only in ${ae}` : `only in ${be}`}</span>}
      </div>
      {c.status === "changed" ? <p className="diff-line"><Diff a={join(c.a)} b={join(c.b)} /></p> : <p className="diff-line muted">{join(c.a || c.b)}</p>}
    </div>
  );
}

export function Editions() {
  const { meta, slug, editions, isOwner } = useSetCtx();

  const [a, setA] = useState(editions[0]?.id ?? "");
  const [b, setB] = useState(editions[1]?.id ?? "");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-edition form
  const [label, setLabel] = useState("");
  const [packets, setPackets] = useState<File[]>([]);
  const [games, setGames] = useState<File[]>([]);
  const [addStatus, setAddStatus] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // add-files-to-existing-edition form
  const [intoId, setIntoId] = useState(editions[0]?.id ?? "");
  const [intoPackets, setIntoPackets] = useState<File[]>([]);
  const [intoGames, setIntoGames] = useState<File[]>([]);
  const [intoStatus, setIntoStatus] = useState<string | null>(null);
  const [intoErr, setIntoErr] = useState<string | null>(null);
  const [intoBusy, setIntoBusy] = useState(false);

  async function addFiles(e: React.FormEvent) {
    e.preventDefault();
    setIntoErr(null);
    if (!intoId) { setIntoErr("Pick an edition."); return; }
    if (!intoPackets?.length && !intoGames?.length) { setIntoErr("Choose packet and/or game files to add."); return; }
    setIntoBusy(true);
    try {
      const packetRefs = intoPackets.length ? await uploadFiles(intoPackets, (d, t) => setIntoStatus(`Uploading packets… ${d}/${t}`)) : [];
      const gameRefs = intoGames.length ? await uploadFiles(intoGames, (d, t) => setIntoStatus(`Uploading games… ${d}/${t}`)) : [];
      setIntoStatus("Aggregating…");
      const r = await fetch("/api/ingest", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ editionOf: slug, editionId: intoId, packets: packetRefs, games: gameRefs }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      refreshIndex();
      window.location.reload();
    } catch (e) {
      setIntoErr(String((e as Error).message || e)); setIntoBusy(false); setIntoStatus(null);
    }
  }

  async function compare() {
    if (!a || !b || a === b) { setErr("Pick two different editions."); return; }
    setBusy(true); setErr(null); setDiff(null);
    try {
      const r = await fetch(`/api/diff?slug=${encodeURIComponent(slug)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      setDiff(d);
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  async function addEdition(e: React.FormEvent) {
    e.preventDefault();
    setAddErr(null);
    if (!packets?.length || !games?.length) { setAddErr("Choose packet and game files for the new edition."); return; }
    setAdding(true);
    try {
      const packetRefs = await uploadFiles(packets, (d, t) => setAddStatus(`Uploading packets… ${d}/${t}`));
      const gameRefs = await uploadFiles(games, (d, t) => setAddStatus(`Uploading games… ${d}/${t}`));
      setAddStatus("Aggregating…");
      const r = await fetch("/api/ingest", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ editionOf: slug, edition: label.trim() || undefined, packets: packetRefs, games: gameRefs }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      refreshIndex();
      window.location.reload();
    } catch (e) {
      setAddErr(String((e as Error).message || e)); setAdding(false); setAddStatus(null);
    }
  }

  const labelOf = (id: string) => editions.find((e) => e.id === id)?.label ?? id;

  return (
    <div>
      <PageHeader title="Editions" subtitle="Mirrors of this tournament and how their question sets differ" />

      <h2>Editions ({editions.length})</h2>
      <div className="table-wrap" style={{ maxWidth: 560 }}>
        <table className="data-table">
          <thead><tr><th>Edition</th><th className="right">Games</th><th className="right">Teams</th><th className="right">Players</th><th className="right">Rounds</th></tr></thead>
          <tbody>
            {editions.map((e) => (
              <tr key={e.id}><td>{e.label}</td><td className="right mono">{e.numGames}</td><td className="right mono">{e.numTeams}</td><td className="right mono">{e.numPlayers}</td><td className="right mono">{e.rounds}</td></tr>
            ))}
            {editions.length === 0 && <tr><td colSpan={5} className="muted">Single edition.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted">Use the <strong>Showing</strong> filter at the top to view combined stats or a single edition.</p>

      {editions.length >= 2 && (
        <>
          <h2 style={{ marginTop: 28 }}>Compare question sets</h2>
          <div className="cat-toolbar">
            <select value={a} onChange={(e) => setA(e.target.value)}>{editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
            <span>vs</span>
            <select value={b} onChange={(e) => setB(e.target.value)}>{editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
            <button className="btn-primary btn-sm" disabled={busy} onClick={compare}>{busy ? "Comparing…" : "Compare"}</button>
          </div>
          {err && <ErrorBox error={err} />}
          {busy && <Loading />}
          {diff && (
            <>
              <p className="explainer">
                <strong>{labelOf(diff.a.id)}</strong> (A) → <strong>{labelOf(diff.b.id)}</strong> (B), aligned by question position.{" "}
                <span className="wd-del">red = removed/old</span>, <span className="wd-add">green = added/new</span>.
              </p>
              <div className="diff-summary">
                <span><strong>{diff.summary.tuChanged}</strong> of {diff.summary.tossupTotal} tossups differ</span>
                {(diff.summary.tuOnlyA + diff.summary.tuOnlyB) > 0 && <span className="muted"> · {diff.summary.tuOnlyA} only in A, {diff.summary.tuOnlyB} only in B</span>}
                {meta.hasBonuses && <span> · <strong>{diff.summary.bnChanged}</strong> of {diff.summary.bonusTotal} bonuses differ</span>}
              </div>
              {diff.tossups.length > 0 && <h3>Tossup changes ({diff.tossups.length})</h3>}
              {diff.tossups.map((c, i) => <ChangedTossup key={i} c={c} ae={labelOf(diff.a.id)} be={labelOf(diff.b.id)} />)}
              {meta.hasBonuses && diff.bonuses.length > 0 && <h3>Bonus changes ({diff.bonuses.length})</h3>}
              {meta.hasBonuses && diff.bonuses.map((c, i) => <ChangedBonus key={i} c={c} ae={labelOf(diff.a.id)} be={labelOf(diff.b.id)} />)}
              {diff.tossups.length === 0 && diff.bonuses.length === 0 && <p className="caveat">No question differences — these editions are identical.</p>}
            </>
          )}
        </>
      )}

      {isOwner && editions.length > 0 && (
        <>
          <h2 style={{ marginTop: 28 }}>Add files to an existing edition</h2>
          <p className="muted">Append more packets and/or games (e.g. additional rounds) to an edition that's already here. Its stats are recomputed.</p>
          <form className="create-form" onSubmit={addFiles} style={{ maxWidth: 520 }}>
            <label className="field">
              <span>Edition</span>
              <select value={intoId} onChange={(e) => setIntoId(e.target.value)}>
                {editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </label>
            <div className="field">
              <span>Packet files <span className="muted">(optional)</span></span>
              <FileDrop accept=".json" value={intoPackets} onChange={setIntoPackets} hint="One JSON per round" />
            </div>
            <div className="field">
              <span>Game files (QBJ) <span className="muted">(optional)</span></span>
              <FileDrop accept=".json,.qbj" value={intoGames} onChange={setIntoGames} hint="QBJ match files" />
            </div>
            {intoErr && <div className="error-box">{intoErr}</div>}
            {intoStatus && <div className="caveat">{intoStatus}</div>}
            <button className="btn-primary" type="submit" disabled={intoBusy}>{intoBusy ? "Working…" : "Add files"}</button>
          </form>
        </>
      )}

      {isOwner && (
        <>
          <h2 style={{ marginTop: 28 }}>Add an edition / mirror</h2>
          <p className="muted">Upload another mirror's packets and games. It inherits this tournament's name, scoring, and visibility.</p>
          <form className="create-form" onSubmit={addEdition} style={{ maxWidth: 520 }}>
            <label className="field">
              <span>Edition label <span className="muted">(optional)</span></span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`e.g. Mirror ${editions.length + 1}, Online`} />
            </label>
            <div className="field">
              <span>Packet files</span>
              <FileDrop accept=".json" value={packets} onChange={setPackets} hint="One JSON per round" />
            </div>
            <div className="field">
              <span>Game files (QBJ)</span>
              <FileDrop accept=".json,.qbj" value={games} onChange={setGames} hint="QBJ match files" />
            </div>
            {addErr && <div className="error-box">{addErr}</div>}
            {addStatus && <div className="caveat">{addStatus}</div>}
            <button className="btn-primary" type="submit" disabled={adding}>{adding ? "Working…" : "Add edition"}</button>
          </form>
        </>
      )}
    </div>
  );
}
