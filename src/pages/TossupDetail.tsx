import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { clearSetCache, useSetJson } from "../data";
import { useSetCtx } from "../components/Layout";
import { TossupDetail, Buzz, Rosters } from "../types";
import { Html, pct, num } from "../util";
import { Loading, ErrorBox } from "../components/Common";

function tier(v: number): "power" | "get" | "neg" | "zero" {
  if (v > 10) return "power";
  if (v > 0) return "get";
  if (v < 0) return "neg";
  return "zero";
}
const rowCls: Record<string, string> = { power: "buzz-row-power", get: "buzz-row-get", neg: "buzz-row-neg", zero: "buzz-row-neg" };
function annotClass(v: number): string {
  if (v > 10) return "an-power";
  if (v > 0) return "an-pos";
  if (v < 0) return "an-neg";
  return "an-zero";
}

// Effective buzz position: imprecise buzzes collapse to the power mark.
const effIdx = (d: TossupDetail, b: Buzz) =>
  b.imprecise && d.powerIndex !== null ? d.powerIndex : b.wordIndex;

/** Question text: each buzzed word becomes a blue chip with value[count]
 *  annotations above it; an orange dashed line marks the average buzz. Hovering
 *  any word reveals its 1-based index (handy for corrections) and, via
 *  onHoverWord, highlights the buzzers at that word in the buzz list. */
function Question({ d, onHoverWord }: { d: TossupDetail; onHoverWord: (i: number | null) => void }) {
  const eff = (b: Buzz) => effIdx(d, b);

  const byWord = new Map<number, Buzz[]>();
  for (const b of d.buzzes) {
    const i = eff(b);
    if (i === null) continue;
    const arr = byWord.get(i) ?? [];
    arr.push(b);
    byWord.set(i, arr);
  }
  const correct = d.buzzes.filter((b) => b.value > 0 && b.wordIndex !== null && !b.imprecise);
  const avgIdx = correct.length
    ? Math.round(correct.reduce((a, b) => a + (b.wordIndex as number), 0) / correct.length)
    : null;
  const annotations = (bz: Buzz[]) => {
    const counts = new Map<number, number>();
    for (const b of bz) counts.set(b.value, (counts.get(b.value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[0] - a[0]);
  };

  return (
    <p className="q-text">
      {d.words.map((w, i) => {
        const bz = byWord.get(i);
        return (
          <span
            key={i}
            className="q-tok"
            onMouseEnter={() => onHoverWord(i)}
            onMouseLeave={() => onHoverWord(null)}
          >
            <span className="q-idx" aria-hidden="true">{i + 1}</span>
            {bz ? (
              <span className="q-word">
                <span className="q-annots">
                  {annotations(bz).map(([v, c], j) => (
                    <span key={j} className={`q-annot ${annotClass(v)}`}>{v} [{c}]</span>
                  ))}
                </span>
                <span className="q-chip">{w}</span>
              </span>
            ) : (
              w
            )}
            {avgIdx === i && <span className="q-avg" title="Average buzz position" />}{" "}
          </span>
        );
      })}
      <span className="q-end">■END■</span>
    </p>
  );
}

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}

// Inline editor: reassign a buzz to a teammate and/or move the buzz word.
function BuzzEditor({ d, b, slug, isOwner, teammates, onClose, onApplied }: {
  d: TossupDetail; b: Buzz; slug: string; isOwner: boolean; teammates: string[]; onClose: () => void; onApplied: () => void;
}) {
  const curPlayer = b.player;
  const curWord = b.wordIndex;
  const [toPlayer, setToPlayer] = useState(curPlayer);
  const [toWord, setToWord] = useState(curWord === null ? "" : String(curWord + 1));
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const players = teammates.includes(curPlayer) ? teammates : [curPlayer, ...teammates];
  const newWordIdx = toWord.trim() === "" ? null : Number(toWord) - 1;
  const playerChanged = toPlayer !== curPlayer;
  const wordChanged = newWordIdx !== curWord;
  const wordValid = newWordIdx === null || (Number.isInteger(newWordIdx) && newWordIdx >= 0 && newWordIdx < d.words.length);
  const canSubmit = (playerChanged || wordChanged) && wordValid && !busy;

  async function submit() {
    setErr(null);
    const correction: any = { round: d.round, num: d.num, team: b.team, fromPlayer: b.origPlayer ?? b.player, fromWordIndex: b.origWordIndex ?? b.wordIndex };
    if (playerChanged) correction.toPlayer = toPlayer;
    if (wordChanged) correction.toWordIndex = newWordIdx;
    setBusy(true);
    try {
      if (isOwner) { await postJson("/api/correct", { slug, correction }); clearSetCache(slug); onApplied(); }
      else { await postJson("/api/requests", { slug, action: "submit", correction, desc: desc.trim() || undefined }); setDone("Request submitted — the owner will review it."); }
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  if (done)
    return (
      <td colSpan={4} className="buzz-edit-cell">
        <div className="buzz-edit"><span className="ok-msg">{done}</span><button className="btn-link" onClick={onClose}>Close</button></div>
      </td>
    );

  return (
    <td colSpan={4} className="buzz-edit-cell">
      <div className="buzz-edit">
        <label className="field-inline"><span>Assign to</span>
          <select value={toPlayer} onChange={(e) => setToPlayer(e.target.value)}>
            {players.map((p) => <option key={p} value={p}>{p}{p === curPlayer ? " (current)" : ""}</option>)}
          </select>
        </label>
        <label className="field-inline"><span>Buzz word #</span>
          <input className="num-input" type="number" min={1} max={d.words.length} value={toWord} onChange={(e) => setToWord(e.target.value)} style={{ width: 70 }} />
          {newWordIdx !== null && wordValid && <span className="muted">“{d.words[newWordIdx]}”</span>}
        </label>
        {!isOwner && (
          <label className="field-inline" style={{ flex: "1 1 220px" }}><span>Reason</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="optional note for the owner" style={{ flex: 1 }} />
          </label>
        )}
        <div className="buzz-edit-actions">
          <button className="btn-primary btn-sm" disabled={!canSubmit} onClick={submit}>{busy ? "Working…" : isOwner ? "Save" : "Request change"}</button>
          <button className="btn-link" onClick={onClose}>Cancel</button>
        </div>
        {!wordValid && <span className="error-inline">Word # must be 1–{d.words.length}.</span>}
        {err && <span className="error-inline">{err}</span>}
      </div>
    </td>
  );
}

function BuzzRow({ d, b, slug, i, isOwner, canEdit, editing, highlight, teammates, onEdit, onClose, onApplied }: {
  d: TossupDetail; b: Buzz; slug: string; i: number; isOwner: boolean; canEdit: boolean; editing: boolean;
  highlight: boolean; teammates: string[]; onEdit: () => void; onClose: () => void; onApplied: () => void;
}) {
  const t = tier(b.value);
  return (
    <>
      <tr className={`buzz-row ${rowCls[t]}${highlight ? " buzz-hl" : ""}`}>
        <td className="buzz-who">
          <span className="buzz-player">
            {b.playerId ? <Link className="link" to={`/set/${slug}/player/${b.playerId}`}>{b.player}</Link> : b.player}
            {canEdit && !editing && <button className="btn-link btn-edit" onClick={onEdit} title="Correct this buzz">Edit</button>}
          </span>
          <span className="buzz-team">{b.teamId ? <Link className="link" to={`/set/${slug}/team/${b.teamId}`}>{b.team}</Link> : b.team}</span>
        </td>
        <td className="buzz-opp">{b.opponent && b.opponentId ? <Link className="link" to={`/set/${slug}/team/${b.opponentId}`}>{b.opponent}</Link> : b.opponent || "—"}</td>
        <td className="right mono">{b.wordIndex === null ? "—" : b.imprecise ? `≈${b.wordIndex + 1}` : b.wordIndex + 1}</td>
        <td className="right mono">{b.value}</td>
      </tr>
      {editing && (
        <tr className="buzz-edit-row">
          <BuzzEditor d={d} b={b} slug={slug} isOwner={isOwner} teammates={teammates} onClose={onClose} onApplied={onApplied} />
        </tr>
      )}
    </>
  );
}

export function TossupDetailPage() {
  const { meta, isOwner, user, slug, scope } = useSetCtx();
  const { id = "" } = useParams();
  const [nonce, setNonce] = useState(0);
  const [version, setVersion] = useState(scope); // "all" (combined/latest) or an edition id
  const combinedFile = "tossups_detail.json";
  const dispFile = version !== "all" ? `editions/${version}/tossups_detail.json` : combinedFile;
  const { data: comb } = useSetJson<Record<string, TossupDetail>>(slug, combinedFile, nonce);
  const { data, error, loading } = useSetJson<Record<string, TossupDetail>>(slug, dispFile, nonce);
  const { data: rosters } = useSetJson<Rosters>(slug, version !== "all" ? `editions/${version}/rosters.json` : "rosters.json", nonce);
  const [editing, setEditing] = useState<number | null>(null);
  const [hoverWord, setHoverWord] = useState<number | null>(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data?.[id];
  if (!d) return <ErrorBox error={version === "all" ? "Tossup not found." : "This edition doesn't have this question."} />;

  const versions = comb?.[id]?.versions ?? [];
  const negs = d.buzzes.filter((b) => b.value < 0).length;
  const sorted = [...d.buzzes].sort((a, b) => (a.wordIndex ?? 1e9) - (b.wordIndex ?? 1e9));

  return (
    <div className="detail">
      <div className="breadcrumb">
        <Link to={`/set/${slug}/tossup`} className="link">← Tossups</Link>
      </div>

      {versions.length > 1 && (
        <div className="version-bar">
          <span className="muted">Question version:</span>
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="all">All editions (latest)</option>
            {versions.map((v) => <option key={v.editionId} value={v.editionId}>{v.label}{v.differs ? " — revised" : ""}</option>)}
          </select>
          {version !== "all" && <span className="muted">showing this edition's wording &amp; its buzzes</span>}
        </div>
      )}

      <div className="tu-grid">
        <div className="tu-left">
          <h1>Packet {d.round}: Tossup {d.num}</h1>
          <Question d={d} onHoverWord={setHoverWord} />
          <p className="tu-answer">ANSWER: <Html html={d.answer} /></p>
          <p className="subtitle">{d.category} · <span className="muted">{d.subcategory}</span></p>
        </div>

        <div className="tu-right">
          <h2 style={{ marginTop: 0 }}>Buzzes ({d.buzzes.length})</h2>
          {!user && (
            <p className="muted">
              <Link to={`/login?next=${encodeURIComponent(`/set/${slug}/tossup/${id}`)}`} className="link">Log in</Link> to correct a buzz or request a change.
            </p>
          )}
          {user && !isOwner && <p className="muted">Spot a mistake? Use <strong>Edit</strong> to send the owner a correction request.</p>}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Player / Team</th><th>Opponent</th><th className="right" title="Buzz position (word #)">Buzz</th><th className="right">Val</th></tr>
              </thead>
              <tbody>
                {sorted.map((b, i) => (
                  <BuzzRow
                    key={i} d={d} b={b} slug={slug} i={i} isOwner={isOwner} canEdit={!!user}
                    editing={editing === i} highlight={hoverWord !== null && effIdx(d, b) === hoverWord}
                    teammates={rosters?.[b.team] ?? []}
                    onEdit={() => setEditing(i)} onClose={() => setEditing(null)}
                    onApplied={() => { setEditing(null); setNonce((n) => n + 1); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <h2>Summary</h2>
      <div className="table-wrap" style={{ maxWidth: 620 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Set</th>
              <th className="right">Heard</th>
              <th className="right">Conv%</th>
              {meta.hasPower && <th className="right">Power%</th>}
              {(meta.hasNeg || negs > 0) && <th className="right">Neg%</th>}
              <th className="right">Avg Buzz</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{meta.setName}</td>
              <td className="right mono">{d.heard}</td>
              <td className="right mono">{pct(d.convPct)}</td>
              {meta.hasPower && <td className="right mono">{pct(d.powerPct)}</td>}
              {(meta.hasNeg || negs > 0) && <td className="right mono">{pct((100 * negs) / (d.heard || 1))}</td>}
              <td className="right mono">{d.avgBuzzPct === null ? "—" : `${num(d.avgBuzzPct)}%`}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
