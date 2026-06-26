// Pages for "results" (YellowFruit/QBJ box-score) tournaments: standings,
// individual leaderboard, and per-game box scores with owner buzz-style
// corrections. These read the results_*.json files produced by resultsAggregate.
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { useSetJson, clearSetCache } from "../data";
import { ResultsTeam, ResultsPlayer, ResultsGame, ResultsGameTeam } from "../types";
import { num } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { Loading, ErrorBox } from "../components/Common";

const ANSWER_VALUES = [15, 10, -5]; // correction value choices (covers common formats)

export function ResultsStandings() {
  const { meta, slug } = useSetCtx();
  const { data, error, loading } = useSetJson<ResultsTeam[]>(slug, "results_teams.json");
  const hasPower = meta.hasPower, hasNeg = meta.hasNeg, hasBonuses = meta.hasBonuses;

  const columns: Column<ResultsTeam>[] = [
    { key: "rank", label: "#", sortVal: (t) => t.rank, render: (t) => t.rank },
    { key: "team", label: "Team", sortVal: (t) => t.name.toLowerCase(), render: (t) => <Link className="link" to={`/set/${slug}/games?team=${encodeURIComponent(t.name)}`}>{t.name}</Link> },
    { key: "w", label: "W", align: "right", sortVal: (t) => t.wins, render: (t) => t.wins },
    { key: "l", label: "L", align: "right", sortVal: (t) => t.losses, render: (t) => t.losses },
    { key: "pct", label: "Pct", align: "right", sortVal: (t) => t.pct, render: (t) => t.pct.toFixed(3).replace(/^0/, ""), title: "Win percentage" },
    { key: "pp20", label: "PP20TUH", align: "right", sortVal: (t) => t.pp20tuh, render: (t) => num(t.pp20tuh), title: "Tossup points per 20 tossups heard" },
    ...(hasPower ? [{ key: "pwr", label: "Pwr", align: "right" as const, sortVal: (t: ResultsTeam) => t.powers, render: (t: ResultsTeam) => t.powers }] : []),
    { key: "get", label: "Correct", align: "right", sortVal: (t) => t.gets, render: (t) => t.gets },
    ...(hasNeg ? [{ key: "neg", label: "Neg", align: "right" as const, sortVal: (t: ResultsTeam) => t.negs, render: (t: ResultsTeam) => t.negs }] : []),
    { key: "tuh", label: "TUH", align: "right", sortVal: (t) => t.tuh, render: (t) => t.tuh, title: "Tossups heard" },
    ...(hasBonuses ? [{ key: "ppb", label: "PPB", align: "right" as const, sortVal: (t: ResultsTeam) => t.ppb ?? -1, render: (t: ResultsTeam) => (t.ppb == null ? "—" : t.ppb.toFixed(2)), title: "Points per bonus" }] : []),
    { key: "ppg", label: "PPG", align: "right", sortVal: (t) => t.ppg, render: (t) => num(t.ppg) },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{meta.setName}</h1>
          <p className="subtitle">
            Standings · {meta.numGames} games · {meta.numTeams} teams · {meta.numPlayers} players · {meta.rounds.length} rounds · {meta.scoringLabel}
          </p>
        </div>
        <a className="btn-secondary" href={`/api/results-export?slug=${encodeURIComponent(slug)}`} title="Download the updated YellowFruit file and HTML stat reports">
          Export (.yft + stats)
        </a>
      </div>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={data} columns={columns} initialSort="rank" initialDir="asc" rowKey={(t) => t.id} />}
    </div>
  );
}

export function ResultsPlayers() {
  const { meta, slug } = useSetCtx();
  const { data, error, loading } = useSetJson<ResultsPlayer[]>(slug, "results_players.json");
  const hasPower = meta.hasPower, hasNeg = meta.hasNeg;

  const columns: Column<ResultsPlayer>[] = [
    { key: "name", label: "Player", sortVal: (p) => p.name.toLowerCase(), render: (p) => p.name },
    { key: "team", label: "Team", sortVal: (p) => p.team.toLowerCase(), render: (p) => <Link className="link" to={`/set/${slug}/games?team=${encodeURIComponent(p.team)}`}>{p.team}</Link> },
    { key: "g", label: "G", align: "right", sortVal: (p) => p.games, render: (p) => p.games },
    { key: "tuh", label: "TUH", align: "right", sortVal: (p) => p.tuh, render: (p) => p.tuh },
    ...(hasPower ? [{ key: "pwr", label: "Pwr", align: "right" as const, sortVal: (p: ResultsPlayer) => p.powers, render: (p: ResultsPlayer) => p.powers }] : []),
    { key: "get", label: "Correct", align: "right", sortVal: (p) => p.gets, render: (p) => p.gets },
    ...(hasNeg ? [{ key: "neg", label: "Neg", align: "right" as const, sortVal: (p: ResultsPlayer) => p.negs, render: (p: ResultsPlayer) => p.negs }] : []),
    { key: "pts", label: "Pts", align: "right", sortVal: (p) => p.pts, render: (p) => p.pts },
    { key: "ppg", label: "PPG", align: "right", sortVal: (p) => p.ppg, render: (p) => num(p.ppg) },
    { key: "pptuh", label: "P/TUH", align: "right", sortVal: (p) => p.ptsPerTuh, render: (p) => p.ptsPerTuh.toFixed(2), title: "Points per tossup heard" },
  ];

  return (
    <div>
      <div className="page-header"><div><h1>Players</h1><p className="subtitle">Individual statistics</p></div></div>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={data} columns={columns} initialSort="ppg" initialDir="desc" rowKey={(p) => p.id} />}
    </div>
  );
}

const gameKey = (g: ResultsGame) => `${g.phase}|${g.round}|${g.teams.map((t) => t.team).slice().sort().join("|")}`;

export function ResultsGames() {
  const { meta, slug, isOwner } = useSetCtx();
  const { data, error, loading } = useSetJson<ResultsGame[]>(slug, "results_games.json", 0);
  const [nonce, setNonce] = useState(0);
  const reload = useSetJson<ResultsGame[]>(slug, "results_games.json", nonce);
  const games = nonce ? reload.data : data;
  const [editing, setEditing] = useState<string | null>(null);

  const byRound = useMemo(() => {
    const m = new Map<number, ResultsGame[]>();
    for (const g of games || []) { const a = m.get(g.round) || []; a.push(g); m.set(g.round, a); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [games]);

  function onApplied() { clearSetCache(slug); setNonce((n) => n + 1); }

  return (
    <div>
      <div className="page-header"><div><h1>Games</h1><p className="subtitle">{meta.numGames} games · box scores</p></div></div>
      {(loading || (nonce > 0 && reload.loading)) && <Loading />}
      {error && <ErrorBox error={error} />}
      {byRound.map(([round, gs]) => (
        <div key={round} className="results-round">
          <h2>Round {round}</h2>
          {gs.map((g) => (
            <GameCard key={gameKey(g)} g={g} slug={slug} meta={meta} isOwner={isOwner}
              editing={editing === gameKey(g)} onEdit={() => setEditing(gameKey(g))} onClose={() => setEditing(null)} onApplied={onApplied} />
          ))}
        </div>
      ))}
    </div>
  );
}

function GameCard({ g, slug, meta, isOwner, editing, onEdit, onClose, onApplied }: {
  g: ResultsGame; slug: string; meta: { hasPower: boolean; hasNeg: boolean }; isOwner: boolean;
  editing: boolean; onEdit: () => void; onClose: () => void; onApplied: () => void;
}) {
  const [a, b] = g.teams;
  const winner = a.points === b.points ? null : a.points > b.points ? a.team : b.team;
  return (
    <div className="game-card">
      <div className="game-head">
        <span className={winner === a.team ? "strong" : ""}>{a.team} {a.points}</span>
        <span className="muted">—</span>
        <span className={winner === b.team ? "strong" : ""}>{b.points} {b.team}</span>
        {g.tiebreaker && <span className="muted"> · tiebreaker</span>}
        {isOwner && !editing && <button className="btn-link" style={{ marginLeft: "auto" }} onClick={onEdit}>Correct a score</button>}
      </div>
      <div className="game-boxes">
        {g.teams.map((t) => <BoxTeam key={t.team} t={t} meta={meta} />)}
      </div>
      {editing && <GameCorrector g={g} slug={slug} onClose={onClose} onApplied={onApplied} />}
    </div>
  );
}

function BoxTeam({ t, meta }: { t: ResultsGameTeam; meta: { hasPower: boolean; hasNeg: boolean } }) {
  return (
    <table className="data-table box-table">
      <thead>
        <tr>
          <th>{t.team}</th>
          <th className="right">TUH</th>
          {meta.hasPower && <th className="right">Pwr</th>}
          <th className="right">Cor</th>
          {meta.hasNeg && <th className="right">Neg</th>}
          <th className="right">Pts</th>
        </tr>
      </thead>
      <tbody>
        {t.players.map((p) => (
          <tr key={p.name}>
            <td>{p.name}</td>
            <td className="right mono">{p.tuh}</td>
            {meta.hasPower && <td className="right mono">{p.powers}</td>}
            <td className="right mono">{p.gets}</td>
            {meta.hasNeg && <td className="right mono">{p.negs}</td>}
            <td className="right mono">{p.pts}</td>
          </tr>
        ))}
        <tr className="box-total">
          <td>Bonus: {t.bonusPoints}</td>
          <td className="right" colSpan={meta.hasPower && meta.hasNeg ? 4 : 3}>Total</td>
          <td className="right mono strong">{t.points}</td>
        </tr>
      </tbody>
    </table>
  );
}

// Buzz-style correction: reassign one scoring event (a player's 15/10/-5 in this
// game) to another player and/or change its value, or remove it.
function GameCorrector({ g, slug, onClose, onApplied }: { g: ResultsGame; slug: string; onClose: () => void; onApplied: () => void }) {
  const everyone = g.teams.flatMap((t) => t.players.map((p) => ({ name: p.name, team: t.team })));
  const [fromIdx, setFromIdx] = useState(0);
  const [fromValue, setFromValue] = useState(ANSWER_VALUES[0]);
  const [toIdx, setToIdx] = useState(0);
  const [toValue, setToValue] = useState<number | "same">("same");
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null); setBusy(true);
    const from = everyone[fromIdx], to = everyone[toIdx];
    const correction = {
      matchKey: gameKey(g),
      fromPlayer: from.name, fromTeam: from.team, fromValue,
      ...(remove ? { remove: true } : {
        toPlayer: to.name, toTeam: to.team,
        ...(toValue !== "same" ? { toValue } : {}),
      }),
    };
    try {
      const r = await fetch("/api/results", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, op: "correct", correction }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      onApplied(); onClose();
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  return (
    <div className="game-correct">
      <div className="buzz-edit">
        <label className="field-inline"><span>Event</span>
          <select value={fromIdx} onChange={(e) => setFromIdx(Number(e.target.value))}>
            {everyone.map((p, i) => <option key={i} value={i}>{p.name} ({p.team})</option>)}
          </select>
          <select value={fromValue} onChange={(e) => setFromValue(Number(e.target.value))}>
            {ANSWER_VALUES.map((v) => <option key={v} value={v}>{v > 0 ? `+${v}` : v}</option>)}
          </select>
        </label>
        <span className="muted">→</span>
        <label className="field-inline"><span>Reassign to</span>
          <select value={toIdx} disabled={remove} onChange={(e) => setToIdx(Number(e.target.value))}>
            {everyone.map((p, i) => <option key={i} value={i}>{p.name} ({p.team})</option>)}
          </select>
          <select value={String(toValue)} disabled={remove} onChange={(e) => setToValue(e.target.value === "same" ? "same" : Number(e.target.value))}>
            <option value="same">same value</option>
            {ANSWER_VALUES.map((v) => <option key={v} value={v}>{v > 0 ? `+${v}` : v}</option>)}
          </select>
        </label>
        <label className="field-inline"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /><span>Remove this event</span></label>
        <div className="buzz-edit-actions">
          <button className="btn-primary btn-sm" disabled={busy} onClick={submit}>{busy ? "Applying…" : "Apply correction"}</button>
          <button className="btn-link" onClick={onClose}>Cancel</button>
        </div>
      </div>
      {err && <span className="error-inline">{err}</span>}
    </div>
  );
}
