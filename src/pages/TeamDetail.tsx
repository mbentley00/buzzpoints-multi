import { useEffect, useMemo, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useSetCtx, useScopedJson, scopedPath } from "../components/Layout";
import { loadSetJson } from "../data";
import { TeamDetail, RosterPlayer, CatBonusRow, CatBonusSub, CatTeamTossupRow, CatTeamTossupSub, GameRow, GamePlayerLine } from "../types";
import { num, pct, roundLabel } from "../util";
import { Loading, ErrorBox, EditionBadges } from "../components/Common";
import { CategoryGroups, CatColumn } from "../components/CategoryGroups";
import { DataTable, Column } from "../components/DataTable";
import { Rename } from "../components/Rename";
import { TeamRounds, teamRoundView } from "../teamRounds";

const buzz = (v: number | null) => (v === null ? "—" : num(v));
const rankCell = (rank?: number | null, rankOf?: number | null) =>
  rank == null ? "—" : rankOf ? `${rank} / ${rankOf}` : String(rank);

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

type MyGame = { g: GameRow; us: GameRow["teams"][number]; them: GameRow["teams"] };

// Which rounds the page is totalled over: chips to pick any mix of rounds, and a
// from–to pair for the common case of a contiguous stretch (say, everything
// after a lineup change). No rounds picked means all of them.
function RoundPicker({ rounds, picked, setPicked }: { rounds: number[]; picked: Set<number>; setPicked: (s: Set<number>) => void }) {
  const toggle = (r: number) => { const n = new Set(picked); if (n.has(r)) n.delete(r); else n.add(r); setPicked(n); };
  const on = rounds.filter((r) => picked.has(r));
  const from = on.length ? on[0] : rounds[0], to = on.length ? on[on.length - 1] : rounds[rounds.length - 1];
  const range = (a: number, z: number) => {
    const [lo, hi] = a <= z ? [a, z] : [z, a];
    const n = new Set(rounds.filter((r) => r >= lo && r <= hi));
    setPicked(n.size === rounds.length ? new Set() : n);
  };
  return (
    <div className="round-pick">
      <span className="muted">Rounds:</span>
      <button type="button" className={"tag-chip" + (picked.size ? "" : " on")} onClick={() => setPicked(new Set())}>All</button>
      {rounds.map((r) => (
        <button key={r} type="button" className={"tag-chip" + (picked.has(r) ? " on" : "")} onClick={() => toggle(r)}>{roundLabel(r)}</button>
      ))}
      {rounds.length > 2 && (
        <span className="round-range">
          <select aria-label="From round" value={from} onChange={(e) => range(Number(e.target.value), to)}>
            {rounds.map((r) => <option key={r} value={r}>{roundLabel(r)}</option>)}
          </select>
          {" – "}
          <select aria-label="To round" value={to} onChange={(e) => range(from, Number(e.target.value))}>
            {rounds.map((r) => <option key={r} value={r}>{roundLabel(r)}</option>)}
          </select>
        </span>
      )}
    </div>
  );
}

// "rounds 4–9", "round 3", or "5 rounds" for a scattered pick.
function roundsPhrase(picked: Set<number>, rounds: number[]) {
  const on = rounds.filter((r) => picked.has(r));
  if (on.length === 1) return `round ${roundLabel(on[0])}`;
  const i = rounds.indexOf(on[0]);
  const contiguous = on.every((r, k) => rounds[i + k] === r);
  return contiguous ? `rounds ${roundLabel(on[0])}–${roundLabel(on[on.length - 1])}` : `${on.length} rounds`;
}

// This team's games from the box scores in the chosen rounds, and the player
// lines pooled over them.
function TeamGames({ sel, filtered, phrase }: { sel: MyGame[]; filtered: boolean; phrase: string }) {
  const { meta, slug } = useSetCtx();
  const teamBonus = meta.hasBonuses && meta.hasTeamBonuses !== false;

  const byPlayer = new Map<string, GamePlayerLine & { gp: number }>();
  for (const m of sel) for (const p of m.us.players) {
    const k = p.id ?? p.name;
    const cur = byPlayer.get(k) ?? { ...p, tuh: 0, powers: 0, gets: 0, incorrect: 0, pts: 0, gp: 0 };
    cur.tuh += p.tuh; cur.powers += p.powers; cur.gets += p.gets; cur.incorrect += p.incorrect; cur.pts += p.pts; cur.gp++;
    byPlayer.set(k, cur);
  }
  const players = [...byPlayer.values()].sort((a, b) => b.pts - a.pts);
  const who = (x: { id: string | null; name: string }, path: "team" | "player") =>
    x.id ? <Link className="link" to={`/set/${slug}/${path}/${x.id}`}>{x.name}</Link> : x.name;

  return (
    <>
      <h2>Games{filtered ? ` in ${phrase}` : ""}</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Round</th><th>Opponent</th><th>Result</th><th className="right">Score</th>
              {meta.hasPower && <th className="right">Pwr</th>}
              <th className="right">Get</th><th className="right">{meta.hasNeg ? "Neg" : "Inc"}</th>
              {teamBonus && <><th className="right">Bonus pts</th><th className="right">PPB</th></>}
            </tr>
          </thead>
          <tbody>
            {sel.map((m, i) => (
              <tr key={i}>
                <td>{roundLabel(m.g.round)}</td>
                <td>{m.them.length ? m.them.map((x, j) => <span key={j}>{j > 0 && ", "}{who(x, "team")}</span>) : "—"}</td>
                <td>{m.us.result ?? "—"}</td>
                <td className="right mono">{m.us.score}{m.them.length === 1 ? `–${m.them[0].score}` : ""}</td>
                {meta.hasPower && <td className="right mono">{m.us.powers}</td>}
                <td className="right mono">{m.us.gets}</td>
                <td className="right mono">{m.us.incorrect}</td>
                {teamBonus && <><td className="right mono">{m.us.bonusPts}</td><td className="right mono">{m.us.bonusesHeard ? num(m.us.bonusPts / m.us.bonusesHeard, 2) : "—"}</td></>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered && players.length > 0 && (
        <>
          <h3>Players in {phrase}</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Player</th><th className="right">GP</th>
                  {meta.hasPower && <th className="right">Pwr</th>}
                  <th className="right">Get</th><th className="right">{meta.hasNeg ? "Neg" : "Inc"}</th>
                  <th className="right">Points</th><th className="right">PPG</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id ?? p.name}>
                    <td>{who(p, "player")}</td><td className="right mono">{p.gp}</td>
                    {meta.hasPower && <td className="right mono">{p.powers}</td>}
                    <td className="right mono">{p.gets}</td><td className="right mono">{p.incorrect}</td>
                    <td className="right mono">{p.pts}</td><td className="right mono">{num(p.pts / p.gp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export function TeamDetailPage() {
  const { meta, scope, editions, isOwner, user, allowRequests } = useSetCtx();
  const { slug = "", id = "" } = useParams();
  const { data: all, error, loading } = useScopedJson<Record<string, TeamDetail>>("teams_detail.json");
  const [view, setView] = useState<"main" | "bonus">("main");
  const d = all?.[id];
  // Per-team bonus stats are unavailable for imports that only carry aggregate
  // bonus conversion; hide the team-level bonus UI while keeping tossup stats.
  const teamBonus = meta.hasBonuses && meta.hasTeamBonuses !== false;

  // Round picker: the box scores give the games, record and per-game lines;
  // team_rounds.json gives the category tables. Sets built before either
  // existed simply don't get the picker (or the filtered categories).
  const { data: games } = useScopedJson<GameRow[]>("games.json");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const filtered = picked.size > 0;
  // The per-round category tallies are big (teams × rounds × subcategories), so
  // they're only fetched once someone actually narrows the rounds.
  const [tr, setTr] = useState<TeamRounds | null | undefined>(undefined);
  useEffect(() => {
    if (!filtered || tr !== undefined) return;
    let alive = true;
    loadSetJson<TeamRounds>(slug, scopedPath(scope, "team_rounds.json"))
      .then((x) => alive && setTr(x), () => alive && setTr(null));
    return () => { alive = false; };
  }, [filtered, tr, slug, scope]);
  useEffect(() => setTr(undefined), [slug, scope]);
  useEffect(() => setPicked(new Set()), [id, scope]);
  const mine = useMemo<MyGame[]>(() => (games ?? [])
    .map((g) => {
      const us = g.teams.find((t) => t.id === id);
      return us ? { g, us, them: g.teams.filter((t) => t !== us) } : null;
    })
    .filter((x): x is MyGame => !!x)
    .sort((a, b) => a.g.round - b.g.round), [games, id]);
  const rounds = useMemo(() => [...new Set(mine.map((m) => m.g.round))].sort((a, b) => a - b), [mine]);
  const rv = useMemo(() => (filtered && tr?.teams[id] ? teamRoundView(tr, id, picked) : null), [filtered, tr, id, picked]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!d) return <ErrorBox error="Team not found." />;
  // In a shootout a team is one player, and there's no Teams tab: an old link to
  // a team page lands on that player instead.
  if (meta.individual && d.roster[0]) return <Navigate to={`/set/${slug}/player/${d.roster[0].id}`} replace />;

  const sel = filtered ? mine.filter((m) => picked.has(m.g.round)) : mine;
  const phrase = filtered ? roundsPhrase(picked, rounds) : "";
  // Games in scope: from the box scores when there are any, else the round tallies.
  const nGames = filtered ? (mine.length ? sel.length : rv?.games ?? 0) : d.games;
  const sum = (f: (m: MyGame) => number) => sel.reduce((a, m) => a + f(m), 0);
  const canFilterCats = !!tr?.teams[id];
  const cats = rv?.categories ?? d.categories;
  const bonusCats = rv?.bonusCategories ?? d.bonusCategories;
  const catNote = !filtered || canFilterCats ? null
    : tr === undefined ? <p className="muted">Loading these rounds…</p>
    : <p className="muted">Season totals. Rebuild stats to filter by round.</p>;

  const tossupCols: CatColumn<CatTeamTossupRow, CatTeamTossupSub>[] = [
    ...(meta.hasPower ? [{ label: "Pwr", align: "right" as const, main: (g: CatTeamTossupRow) => g.powers, sub: (s: CatTeamTossupSub) => s.powers }] : []),
    { label: "Get", align: "right", main: (g) => g.gets, sub: (s) => s.gets },
    { label: meta.hasNeg ? "Neg" : "Inc", align: "right", main: (g) => g.incorrect, sub: (s) => s.incorrect },
    { label: "Points", align: "right", main: (g) => g.points, sub: (s) => s.points },
    { label: "Pts/G", align: "right", title: "Tossup points per game", main: (g) => num(nGames ? g.points / nGames : null), sub: (s) => num(nGames ? s.points / nGames : null),
      sortMain: (g) => g.points, sortSub: (s) => s.points },
    { label: "Rank", align: "right", title: "By total points", main: (g) => rankCell(g.rank, g.rankOf), sub: (s) => rankCell(s.rank, s.rankOf),
      // Rank 1 is the best, so ascending is the useful default reading.
      sortMain: (g) => g.rank ?? null, sortSub: (s) => s.rank ?? null },
    { label: "Earliest", align: "right", main: (g) => g.earliest ?? "—", sub: (s) => s.earliest ?? "—",
      sortMain: (g) => g.earliest, sortSub: (s) => s.earliest },
    { label: "Avg Buzz", align: "right", main: (g) => buzz(g.avgBuzz), sub: (s) => buzz(s.avgBuzz),
      sortMain: (g) => g.avgBuzz, sortSub: (s) => s.avgBuzz },
    { label: "BPA", align: "right", title: "Buzz point area under the curve", main: (g) => num(g.bpa), sub: (s) => num(s.bpa),
      sortMain: (g) => g.bpa, sortSub: (s) => s.bpa },
    { label: "% Pts", align: "right", main: (g) => num(g.pctPoints, 1), sub: (s) => num(s.pctPoints, 1),
      sortMain: (g) => g.pctPoints, sortSub: (s) => s.pctPoints },
  ];

  const bonusCols: CatColumn<CatBonusRow, CatBonusSub>[] = [
    { label: "Heard", align: "right", main: (g) => g.heard, sub: (s) => s.heard },
    { label: "PPB", align: "right", main: (g) => num(g.ppb, 2), sub: (s) => num(s.ppb, 2), sortMain: (g) => g.ppb, sortSub: (s) => s.ppb },
    { label: "Easy%", align: "right", main: (g) => pct(g.easyPct), sub: (s) => pct(s.easyPct), sortMain: (g) => g.easyPct, sortSub: (s) => s.easyPct },
    { label: "Medium%", align: "right", main: (g) => pct(g.medPct), sub: (s) => pct(s.medPct), sortMain: (g) => g.medPct, sortSub: (s) => s.medPct },
    { label: "Hard%", align: "right", main: (g) => pct(g.hardPct), sub: (s) => pct(s.hardPct), sortMain: (g) => g.hardPct, sortSub: (s) => s.hardPct },
  ];

  const rosterCols: Column<RosterPlayer>[] = [
    { key: "name", label: "Player", personName: (p) => p.name, render: (p) => <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> },
    { key: "games", label: "GP", align: "right", sortVal: (p) => p.games, render: (p) => p.games },
    ...(meta.hasPower ? [{ key: "powers", label: "Pwr", align: "right" as const, sortVal: (p: RosterPlayer) => p.powers, render: (p: RosterPlayer) => p.powers }] : []),
    { key: "gets", label: "Get", align: "right", sortVal: (p) => p.gets, render: (p) => p.gets },
    { key: "inc", label: meta.hasNeg ? "Neg" : "Inc", align: "right", sortVal: (p) => p.incorrect, render: (p) => p.incorrect, title: "Incorrect buzzes" },
    { key: "pts", label: "Points", align: "right", sortVal: (p) => p.pts, render: (p) => p.pts },
    { key: "ppg", label: "PPG", align: "right", sortVal: (p) => p.ppg, render: (p) => num(p.ppg) },
  ];

  return (
    <div className="detail">
      <div className="breadcrumb">
        <Link to={`/set/${slug}/team`} className="link">← Teams</Link>
      </div>
      <div className="page-header">
        <div>
          <h1>{d.name}</h1>
          <p className="subtitle">
            {d.wins}-{d.losses}{d.ties ? `-${d.ties}` : ""} · {d.games} games
            {scope === "all" && !!d.editionIds?.length && <> · <EditionBadges ids={d.editionIds} editions={editions} /></>}
            {user && (isOwner || allowRequests) && <> · <Rename slug={slug} kind="team" name={d.name} isOwner={isOwner} /></>}
          </p>
        </div>
        {teamBonus && (
          <button className="btn-primary" onClick={() => setView(view === "main" ? "bonus" : "main")}>
            {view === "main" ? "View Bonuses" : "View Tossup Stats"}
          </button>
        )}
      </div>

      {rounds.length > 1 && <RoundPicker rounds={rounds} picked={picked} setPicked={setPicked} />}

      {filtered && mine.length ? (() => {
        const n = sel.length, tuh = sum((m) => m.g.tuh), bHeard = sum((m) => m.us.bonusesHeard);
        const w = sel.filter((m) => m.us.result === "W").length, l = sel.filter((m) => m.us.result === "L").length, t = sel.filter((m) => m.us.result === "T").length;
        return (
          <div className="stat-row" title={`Totals over ${phrase}`}>
            <Stat label="Games" value={String(n)} />
            <Stat label="Record" value={`${w}-${l}${t ? `-${t}` : ""}`} />
            <Stat label="PPG" value={num(n ? sum((m) => m.us.score) / n : null)} />
            {teamBonus && <Stat label="PPB" value={num(bHeard ? sum((m) => m.us.bonusPts) / bHeard : null, 2)} />}
            <Stat label="PP20TUH" value={num(tuh ? (20 * sum((m) => m.us.tuPts)) / tuh : null)} />
            {rv && <Stat label="BPA" value={num(rv.bpa)} title="Buzz point area under the curve" />}
            {meta.hasPower && <Stat label="Powers" value={String(sum((m) => m.us.powers))} />}
            <Stat label="Correct" value={String(sum((m) => m.us.gets))} />
            <Stat label={meta.hasNeg ? "Neg" : "Inc"} value={String(sum((m) => m.us.incorrect))} />
          </div>
        );
      })() : (
      <div className="stat-row">
        <Stat label="PPG" value={num(d.ppg)} />
        {teamBonus && <Stat label="PPB" value={num(d.ppb, 2)} />}
        <Stat label="PP20TUH" value={num(d.pp20tuh)} />
        <Stat label="BPA" value={num(d.bpa)} title="Buzz point area under the curve" />
        {meta.hasPower && <Stat label="Powers" value={String(d.powers)} />}
        <Stat label="Correct" value={String(d.gets)} />
        <Stat label={meta.hasNeg ? "Neg" : "Inc"} value={String(d.incorrect)} />
        <Stat label="1st buzzes" value={String(d.firstBuzzes)} />
        <Stat label="Top 3" value={String(d.top3Buzzes)} />
      </div>
      )}

      {view === "main" || !teamBonus ? (
        <>
          <h2>Roster{filtered ? " — all rounds" : ""}</h2>
          <DataTable rows={d.roster} columns={rosterCols} initialSort="pts" initialDir="desc" rowKey={(p) => p.id} />
          {mine.length > 0 && <TeamGames sel={sel} filtered={filtered} phrase={phrase} />}
          <h2>Tossups by category{filtered && canFilterCats ? ` in ${phrase}` : ""}</h2>
          {catNote}
          <CategoryGroups groups={cats} columns={tossupCols} linkBase={`/set/${slug}/tossup`} mainParam="category" subParam="subcategory" />
        </>
      ) : (
        <>
          <h2>Bonuses by category{filtered && canFilterCats ? ` in ${phrase}` : ""}</h2>
          {catNote}
          <CategoryGroups groups={bonusCats} columns={bonusCols} linkBase={`/set/${slug}/bonus`} mainParam="category" subParam="subcategory" />
        </>
      )}
    </div>
  );
}
