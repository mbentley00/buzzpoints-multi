import { useMemo } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { GameRow, GameTeamLine, Meta, TeamRow } from "../types";
import { num, roundLabel } from "../util";
import { PageHeader, Loading, ErrorBox } from "../components/Common";

// The standard stats report — the same six views, columns and column order a
// YellowFruit export puts on the Quizbowl Resource Center, so a tournament here
// can be read by anyone who already reads those.
//
// It is deliberately a separate view from Teams/Players rather than more columns
// on them. Those pages are this app's own take (buzz points, BPA, first buzzes);
// this one is the standard report, and its job is to be unsurprising: the same
// numbers computed the same way, so it can be checked against a YellowFruit
// export line by line.
//
// Everything here is derived from games.json — the per-game box scores — so
// every figure has a game-by-game breakdown standing behind it.

type View = "standings" | "individuals" | "scoreboard" | "team-detail" | "individual-detail" | "round-report";
// In an individual shootout every "team" is one player, so Standings already IS
// the individual table and Team Detail would repeat Individual Detail.
const TEAM_ONLY_VIEWS: View[] = ["individuals", "team-detail"];
const VIEWS: { id: View; path: string; label: string }[] = [
  { id: "standings", path: "", label: "Standings" },
  { id: "individuals", path: "individuals", label: "Individuals" },
  { id: "scoreboard", path: "scoreboard", label: "Scoreboard" },
  { id: "team-detail", path: "team-detail", label: "Team Detail" },
  { id: "individual-detail", path: "individual-detail", label: "Individual Detail" },
  { id: "round-report", path: "round-report", label: "Round Report" },
];

// YellowFruit heads the power column with what a power is worth. The tiers here
// are generic (anything above the base value is a power), so the value is only
// known for the formats that have exactly one power tier.
const POWER_HEAD: Record<string, string> = { mACF: "15", PACE: "20", SUPERPOWER: "Pwr" };
const powerHead = (m: Meta) => POWER_HEAD[m.scoring] ?? "Pwr";
const negHead = (m: Meta) => (m.hasNeg ? "-5" : "Inc");

/* ----------------------------- season totals from the box scores ----------------------------- */

interface TeamAgg {
  name: string; id: string | null;
  games: number; wins: number; losses: number; ties: number;
  pts: number; tuPts: number; bonusPts: number; bonusesHeard: number;
  powers: number; gets: number; incorrect: number; tuh: number;
  lines: { round: number; opponent: string | null; opponentId: string | null; own: GameTeamLine; oppScore: number | null; tuh: number; room: number }[];
}
interface PlayerAgg {
  name: string; id: string | null; team: string; teamId: string | null;
  games: number; powers: number; gets: number; incorrect: number; pts: number; tuh: number;
  lines: { round: number; opponent: string | null; powers: number; gets: number; incorrect: number; pts: number; tuh: number }[];
}

function buildTeams(games: GameRow[]): TeamAgg[] {
  const by = new Map<string, TeamAgg>();
  const of = (t: GameTeamLine): TeamAgg => {
    let v = by.get(t.name);
    if (!v) {
      v = { name: t.name, id: t.id, games: 0, wins: 0, losses: 0, ties: 0, pts: 0, tuPts: 0, bonusPts: 0, bonusesHeard: 0, powers: 0, gets: 0, incorrect: 0, tuh: 0, lines: [] };
      by.set(t.name, v);
    }
    return v;
  };
  for (const g of games)
    for (const t of g.teams) {
      const v = of(t);
      const opp = g.teams.find((o) => o.name !== t.name) ?? null;
      v.games++; v.pts += t.score; v.tuPts += t.tuPts; v.bonusPts += t.bonusPts; v.bonusesHeard += t.bonusesHeard;
      v.powers += t.powers; v.gets += t.gets; v.incorrect += t.incorrect; v.tuh += g.tuh;
      if (t.result === "W") v.wins++; else if (t.result === "L") v.losses++; else if (t.result === "T") v.ties++;
      v.lines.push({ round: g.round, opponent: opp?.name ?? null, opponentId: opp?.id ?? null, own: t, oppScore: opp?.score ?? null, tuh: g.tuh, room: g.teams.length });
    }
  for (const v of by.values()) v.lines.sort((a, b) => a.round - b.round);
  return [...by.values()];
}

function buildPlayers(games: GameRow[]): PlayerAgg[] {
  const by = new Map<string, PlayerAgg>();
  for (const g of games)
    for (const t of g.teams) {
      const opp = g.teams.find((o) => o.name !== t.name)?.name ?? null;
      for (const p of t.players) {
        const k = `${p.name}\u0000${t.name}`;
        let v = by.get(k);
        if (!v) {
          v = { name: p.name, id: p.id, team: t.name, teamId: t.id, games: 0, powers: 0, gets: 0, incorrect: 0, pts: 0, tuh: 0, lines: [] };
          by.set(k, v);
        }
        v.games++; v.powers += p.powers; v.gets += p.gets; v.incorrect += p.incorrect; v.pts += p.pts;
        // Fall back to the room's tossup count when the source didn't record what
        // this player heard, so a player's rate stats aren't divided by zero.
        v.tuh += p.tuh || g.tuh;
        v.lines.push({ round: g.round, opponent: opp, powers: p.powers, gets: p.gets, incorrect: p.incorrect, pts: p.pts, tuh: p.tuh || g.tuh });
      }
    }
  for (const v of by.values()) v.lines.sort((a, b) => a.round - b.round);
  return [...by.values()];
}

const winPct = (t: { wins: number; losses: number; ties: number }) => {
  const d = t.wins + t.losses + t.ties;
  return d ? (t.wins + t.ties / 2) / d : 0;
};
const pctText = (v: number) => v.toFixed(3).replace(/^0/, "");
const per = (n: number, d: number, digits = 2) => (d ? num(n / d, digits) : "—");

/* ----------------------------- the page ----------------------------- */

export function StandardStats() {
  const { slug = "", view: viewParam } = useParams();
  const { meta, isOwner } = useSetCtx();
  const { data: games, error, loading } = useScopedJson<GameRow[]>("games.json");
  const { data: teamRows } = useScopedJson<TeamRow[]>("teams.json");

  // A missing file, not a broken one.
  const stale = !!error && /\b404\b/.test(error);

  const view: View = (VIEWS.find((v) => v.path === (viewParam || ""))?.id ?? "standings") as View;
  const teams = useMemo(() => buildTeams(games ?? []), [games]);
  const players = useMemo(() => buildPlayers(games ?? []), [games]);
  // Team ids come off the box scores, but fall back to the standings file so a
  // link still works if a team somehow never appears in one.
  const teamIdOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of teamRows ?? []) m.set(t.name, t.id);
    for (const t of teams) if (t.id) m.set(t.name, t.id);
    return m;
  }, [teamRows, teams]);

  const base = `/set/${slug}/standard`;
  const individual = !!meta.individual;
  const views = individual ? VIEWS.filter((v) => !TEAM_ONLY_VIEWS.includes(v.id)) : VIEWS;

  return (
    <div>
      <PageHeader title="YF stats" subtitle={individual ? "Room-by-room results for every player" : "The same reports a YellowFruit export publishes"} />
      <nav className="std-nav">
        {views.map((v) => (
          <NavLink key={v.id} end to={v.path ? `${base}/${v.path}` : base} className={({ isActive }) => (isActive ? "std-nav-link active" : "std-nav-link")}>
            {v.label}
          </NavLink>
        ))}
      </nav>

      {loading && <Loading />}
      {/* A set last aggregated before these reports existed has no games.json at
          all, which arrives as a 404. That isn't a failure worth an error box —
          it just needs rebuilding, so say so. */}
      {error && !stale && <ErrorBox error={error} />}
      {!loading && (stale || (!error && !(games ?? []).length)) && (
        <p className="empty">
          No game-by-game data for this tournament yet — it was last built before these reports existed.{" "}
          {isOwner
            ? <>Rebuilding its stats from <Link className="link" to={`/set/${slug}/settings`}>Settings</Link> will produce them.</>
            : <>Its owner can produce them by rebuilding the tournament's stats.</>}
        </p>
      )}
      {!!(games ?? []).length && (
        <>
          {view === "standings" && <Standings teams={teams} meta={meta} slug={slug} teamIdOf={teamIdOf} />}
          {view === "individuals" && !individual && <Individuals players={players} meta={meta} slug={slug} teamIdOf={teamIdOf} />}
          {view === "scoreboard" && <Scoreboard games={games!} meta={meta} slug={slug} teamIdOf={teamIdOf} />}
          {view === "team-detail" && !individual && <TeamDetail teams={teams} meta={meta} slug={slug} teamIdOf={teamIdOf} />}
          {view === "individual-detail" && (individual
            ? <ShootoutDetail teams={teams} meta={meta} slug={slug} teamIdOf={teamIdOf} />
            : <IndividualDetail players={players} meta={meta} slug={slug} teamIdOf={teamIdOf} />)}
          {view === "round-report" && <RoundReport games={games!} meta={meta} />}
        </>
      )}
    </div>
  );
}

type Common = { meta: Meta; slug: string; teamIdOf: Map<string, string> };
const TeamLink = ({ name, slug, ids }: { name: string; slug: string; ids: Map<string, string> }) => {
  const id = ids.get(name);
  return id ? <Link className="link" to={`/set/${slug}/team/${id}`}>{name}</Link> : <>{name}</>;
};
// In a shootout the "team" is a player, and the team page is hidden — so a
// team-of-one links to the player's page instead. games.json carries the
// player id on the one roster line.
const CompetitorLink = ({ t, meta, slug, ids }: { t: { name: string; players?: { id: string | null }[] }; meta: Meta; slug: string; ids: Map<string, string> }) => {
  const pid = meta.individual ? t.players?.[0]?.id : null;
  return pid ? <Link className="link" to={`/set/${slug}/player/${pid}`}>{t.name}</Link> : <TeamLink name={t.name} slug={slug} ids={ids} />;
};
const playerIdOf = (t: TeamAgg) => t.lines[0]?.own.players?.[0]?.id ?? null;

/* ----------------------------- 1. Standings ----------------------------- */

function Standings({ teams, meta, slug, teamIdOf }: Common & { teams: TeamAgg[] }) {
  // A shootout ranks players on points: rooms differ in size, so a record of
  // rooms won means less than it does head-to-head, and is shown second.
  const byPpg = (a: TeamAgg, b: TeamAgg) => b.pts / (b.games || 1) - a.pts / (a.games || 1);
  const rows = [...teams].sort((a, b) => (meta.individual ? byPpg(a, b) || b.pts - a.pts : winPct(b) - winPct(a) || byPpg(a, b)) || a.name.localeCompare(b.name));
  const bonuses = meta.hasBonuses && meta.hasTeamBonuses !== false;
  return (
    <div className="table-wrap">
      <table className="data-table std-table">
        <thead>
          <tr>
            <th className="right">Rank</th>
            <th>{meta.individual ? "Player" : "Team"}</th>
            <th className="right" title={meta.individual ? "Rooms won outright" : undefined}>W</th>
            <th className="right">L</th>
            {rows.some((t) => t.ties) && <th className="right">T</th>}
            <th className="right">Pct</th>
            <th className="right">PPG</th>
            {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
            <th className="right">10</th>
            <th className="right">{negHead(meta)}</th>
            <th className="right">TUH</th>
            <th className="right">PPTUH</th>
            {bonuses && <th className="right">BHrd</th>}
            {bonuses && <th className="right">BPts</th>}
            {bonuses && <th className="right">PPB</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={t.name}>
              <td className="right mono">{i + 1}</td>
              <td><CompetitorLink t={{ name: t.name, players: [{ id: playerIdOf(t) }] }} meta={meta} slug={slug} ids={teamIdOf} /></td>
              <td className="right mono">{t.wins}</td>
              <td className="right mono">{t.losses}</td>
              {rows.some((x) => x.ties) && <td className="right mono">{t.ties}</td>}
              <td className="right mono">{pctText(winPct(t))}</td>
              <td className="right mono">{per(t.pts, t.games, 1)}</td>
              {meta.hasPower && <td className="right mono">{t.powers}</td>}
              <td className="right mono">{t.gets}</td>
              <td className="right mono">{t.incorrect}</td>
              <td className="right mono">{t.tuh}</td>
              <td className="right mono">{per(t.pts, t.tuh)}</td>
              {bonuses && <td className="right mono">{t.bonusesHeard}</td>}
              {bonuses && <td className="right mono">{t.bonusPts}</td>}
              {bonuses && <td className="right mono">{per(t.bonusPts, t.bonusesHeard)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------- 2. Individuals ----------------------------- */

function Individuals({ players, meta, slug, teamIdOf }: Common & { players: PlayerAgg[] }) {
  const rows = [...players].sort((a, b) => b.pts / (b.games || 1) - a.pts / (a.games || 1) || b.pts - a.pts || a.name.localeCompare(b.name));
  return (
    <div className="table-wrap">
      <table className="data-table std-table">
        <thead>
          <tr>
            <th className="right">Rank</th>
            <th>Player</th>
            <th>Team</th>
            <th className="right">GP</th>
            {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
            <th className="right">10</th>
            <th className="right">{negHead(meta)}</th>
            <th className="right">TUH</th>
            <th className="right">Pts</th>
            <th className="right">PPG</th>
            <th className="right">PP20TUH</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={`${p.name}|${p.team}`}>
              <td className="right mono">{i + 1}</td>
              <td>{p.id ? <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> : p.name}</td>
              <td><TeamLink name={p.team} slug={slug} ids={teamIdOf} /></td>
              <td className="right mono">{p.games}</td>
              {meta.hasPower && <td className="right mono">{p.powers}</td>}
              <td className="right mono">{p.gets}</td>
              <td className="right mono">{p.incorrect}</td>
              <td className="right mono">{p.tuh}</td>
              <td className="right mono">{p.pts}</td>
              <td className="right mono">{per(p.pts, p.games, 1)}</td>
              <td className="right mono">{p.tuh ? num((20 * p.pts) / p.tuh) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------- 3. Scoreboard ----------------------------- */

function Scoreboard({ games, meta, slug, teamIdOf }: Common & { games: GameRow[] }) {
  const byRound = useMemo(() => {
    const m = new Map<number, GameRow[]>();
    for (const g of games) m.set(g.round, [...(m.get(g.round) || []), g]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [games]);
  const bonuses = meta.hasBonuses && meta.hasTeamBonuses !== false;
  if (meta.individual) return <ShootoutScoreboard byRound={byRound} meta={meta} slug={slug} teamIdOf={teamIdOf} />;
  return (
    <div className="std-scoreboard">
      {byRound.map(([round, list]) => (
        <section key={round} className="std-round">
          <h2 className="std-round-head">Round {roundLabel(round)}</h2>
          {list.map((g, gi) => (
            <div className="std-game" key={gi}>
              <h3 className="std-game-head">
                {g.teams.map((t, i) => (
                  <span key={t.name}>
                    {i > 0 && <span className="std-vs">vs.</span>}
                    <TeamLink name={t.name} slug={slug} ids={teamIdOf} />{" "}
                    <strong className="mono">{t.score}</strong>
                  </span>
                ))}
              </h3>
              <div className="table-wrap">
                <table className="data-table std-table std-box">
                  <thead>
                    <tr>
                      <th>Player</th>
                      {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
                      <th className="right">10</th>
                      <th className="right">{negHead(meta)}</th>
                      <th className="right">TUH</th>
                      <th className="right">Pts</th>
                    </tr>
                  </thead>
                  {g.teams.map((t) => (
                    <tbody key={t.name}>
                      <tr className="std-box-team">
                        <td>
                          <TeamLink name={t.name} slug={slug} ids={teamIdOf} />
                        </td>
                        {meta.hasPower && <td className="right mono">{t.powers}</td>}
                        <td className="right mono">{t.gets}</td>
                        <td className="right mono">{t.incorrect}</td>
                        <td className="right mono">{g.tuh}</td>
                        <td className="right mono">{t.tuPts}</td>
                      </tr>
                      {t.players.map((p) => (
                        <tr key={p.name}>
                          <td className="std-box-player">
                            {p.id ? <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> : p.name}
                          </td>
                          {meta.hasPower && <td className="right mono">{p.powers}</td>}
                          <td className="right mono">{p.gets}</td>
                          <td className="right mono">{p.incorrect}</td>
                          <td className="right mono">{p.tuh || g.tuh}</td>
                          <td className="right mono">{p.pts}</td>
                        </tr>
                      ))}
                      {bonuses && (
                        <tr className="std-box-bonus">
                          <td colSpan={meta.hasPower ? 4 : 3}>
                            Bonuses: {t.bonusesHeard} heard, {t.bonusPts} pts, {per(t.bonusPts, t.bonusesHeard)} PPB
                          </td>
                          <td className="right">Total</td>
                          <td className="right mono"><strong>{t.score}</strong></td>
                        </tr>
                      )}
                    </tbody>
                  ))}
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// A shootout room: everyone in it on one table, in finishing order. The
// nested team/player layout above would put each player twice — once as a
// "team" and once as its only member.
function ShootoutScoreboard({ byRound, meta, slug, teamIdOf }: Common & { byRound: [number, GameRow[]][] }) {
  const bonuses = meta.hasBonuses && meta.hasTeamBonuses !== false;
  return (
    <div className="std-scoreboard">
      {byRound.map(([round, list]) => (
        <section key={round} className="std-round">
          <h2 className="std-round-head">Round {roundLabel(round)}</h2>
          {list.map((g, gi) => {
            const order = [...g.teams].sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || b.score - a.score || a.name.localeCompare(b.name));
            return (
              <div className="std-game" key={gi}>
                <h3 className="std-game-head">Room {gi + 1} <span className="std-vs">·</span> {g.teams.length} players <span className="std-vs">·</span> {g.tuh} tossups</h3>
                <div className="table-wrap">
                  <table className="data-table std-table std-box">
                    <thead>
                      <tr>
                        <th className="right">Place</th>
                        <th>Player</th>
                        {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
                        <th className="right">10</th>
                        <th className="right">{negHead(meta)}</th>
                        <th className="right">TUH</th>
                        {bonuses && <th className="right">BPts</th>}
                        <th className="right">Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.map((t) => (
                        <tr key={t.name}>
                          <td className="right mono">{t.place ?? "—"}</td>
                          <td><CompetitorLink t={t} meta={meta} slug={slug} ids={teamIdOf} /></td>
                          {meta.hasPower && <td className="right mono">{t.powers}</td>}
                          <td className="right mono">{t.gets}</td>
                          <td className="right mono">{t.incorrect}</td>
                          <td className="right mono">{t.players[0]?.tuh || g.tuh}</td>
                          {bonuses && <td className="right mono">{t.bonusPts}</td>}
                          <td className="right mono"><strong>{t.score}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/* ----------------------------- 4. Team Detail ----------------------------- */

function TeamDetail({ teams, meta, slug, teamIdOf }: Common & { teams: TeamAgg[] }) {
  const rows = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  const bonuses = meta.hasBonuses && meta.hasTeamBonuses !== false;
  return (
    <div className="std-detail">
      {rows.map((t) => (
        <section key={t.name} className="std-detail-block">
          <h2 className="std-detail-head"><TeamLink name={t.name} slug={slug} ids={teamIdOf} /></h2>
          <div className="table-wrap">
            <table className="data-table std-table">
              <thead>
                <tr>
                  <th className="right">Rd</th>
                  <th>Opponent</th>
                  <th>Result</th>
                  <th className="right">Score</th>
                  <th className="right">Opp</th>
                  {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
                  <th className="right">10</th>
                  <th className="right">{negHead(meta)}</th>
                  <th className="right">TUH</th>
                  <th className="right">TUPts</th>
                  {bonuses && <th className="right">BHrd</th>}
                  {bonuses && <th className="right">BPts</th>}
                  {bonuses && <th className="right">PPB</th>}
                </tr>
              </thead>
              <tbody>
                {t.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="right mono">{roundLabel(l.round)}</td>
                    <td>{l.opponent ? <TeamLink name={l.opponent} slug={slug} ids={teamIdOf} /> : <span className="muted">—</span>}</td>
                    <td>{l.own.result ?? <span className="muted">—</span>}</td>
                    <td className="right mono">{l.own.score}</td>
                    <td className="right mono">{l.oppScore ?? "—"}</td>
                    {meta.hasPower && <td className="right mono">{l.own.powers}</td>}
                    <td className="right mono">{l.own.gets}</td>
                    <td className="right mono">{l.own.incorrect}</td>
                    <td className="right mono">{l.tuh}</td>
                    <td className="right mono">{l.own.tuPts}</td>
                    {bonuses && <td className="right mono">{l.own.bonusesHeard}</td>}
                    {bonuses && <td className="right mono">{l.own.bonusPts}</td>}
                    {bonuses && <td className="right mono">{per(l.own.bonusPts, l.own.bonusesHeard)}</td>}
                  </tr>
                ))}
                <tr className="std-total">
                  <td className="right">—</td>
                  <td><strong>Total</strong></td>
                  <td>{`${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`}</td>
                  <td className="right mono">{t.pts}</td>
                  <td className="right mono">—</td>
                  {meta.hasPower && <td className="right mono">{t.powers}</td>}
                  <td className="right mono">{t.gets}</td>
                  <td className="right mono">{t.incorrect}</td>
                  <td className="right mono">{t.tuh}</td>
                  <td className="right mono">{t.tuPts}</td>
                  {bonuses && <td className="right mono">{t.bonusesHeard}</td>}
                  {bonuses && <td className="right mono">{t.bonusPts}</td>}
                  {bonuses && <td className="right mono">{per(t.bonusPts, t.bonusesHeard)}</td>}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

/* ----------------------------- 5. Individual Detail ----------------------------- */

function IndividualDetail({ players, meta, slug, teamIdOf }: Common & { players: PlayerAgg[] }) {
  const rows = [...players].sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name));
  return (
    <div className="std-detail">
      {rows.map((p) => (
        <section key={`${p.name}|${p.team}`} className="std-detail-block">
          <h2 className="std-detail-head">
            {p.id ? <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> : p.name}
            <span className="std-detail-sub">
              <TeamLink name={p.team} slug={slug} ids={teamIdOf} />
            </span>
          </h2>
          <div className="table-wrap">
            <table className="data-table std-table">
              <thead>
                <tr>
                  <th className="right">Rd</th>
                  <th>Opponent</th>
                  {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
                  <th className="right">10</th>
                  <th className="right">{negHead(meta)}</th>
                  <th className="right">TUH</th>
                  <th className="right">Pts</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="right mono">{roundLabel(l.round)}</td>
                    <td>{l.opponent ? <TeamLink name={l.opponent} slug={slug} ids={teamIdOf} /> : <span className="muted">—</span>}</td>
                    {meta.hasPower && <td className="right mono">{l.powers}</td>}
                    <td className="right mono">{l.gets}</td>
                    <td className="right mono">{l.incorrect}</td>
                    <td className="right mono">{l.tuh}</td>
                    <td className="right mono">{l.pts}</td>
                  </tr>
                ))}
                <tr className="std-total">
                  <td className="right">—</td>
                  <td><strong>Total</strong></td>
                  {meta.hasPower && <td className="right mono">{p.powers}</td>}
                  <td className="right mono">{p.gets}</td>
                  <td className="right mono">{p.incorrect}</td>
                  <td className="right mono">{p.tuh}</td>
                  <td className="right mono">{p.pts}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

// A shootout player's rounds: their place in each room, against the room's
// size, rather than one opponent and a result.
function ShootoutDetail({ teams, meta, slug, teamIdOf }: Common & { teams: TeamAgg[] }) {
  const rows = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  const bonuses = meta.hasBonuses && meta.hasTeamBonuses !== false;
  return (
    <div className="std-detail">
      {rows.map((t) => (
        <section key={t.name} className="std-detail-block">
          <h2 className="std-detail-head"><CompetitorLink t={{ name: t.name, players: [{ id: playerIdOf(t) }] }} meta={meta} slug={slug} ids={teamIdOf} /></h2>
          <div className="table-wrap">
            <table className="data-table std-table">
              <thead>
                <tr>
                  <th className="right">Rd</th>
                  <th className="right">Place</th>
                  <th className="right" title="Players in the room">Of</th>
                  {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
                  <th className="right">10</th>
                  <th className="right">{negHead(meta)}</th>
                  <th className="right">TUH</th>
                  {bonuses && <th className="right">BPts</th>}
                  <th className="right">Pts</th>
                </tr>
              </thead>
              <tbody>
                {t.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="right mono">{roundLabel(l.round)}</td>
                    <td className="right mono">{l.own.place ?? "—"}</td>
                    <td className="right mono">{l.room}</td>
                    {meta.hasPower && <td className="right mono">{l.own.powers}</td>}
                    <td className="right mono">{l.own.gets}</td>
                    <td className="right mono">{l.own.incorrect}</td>
                    <td className="right mono">{l.own.players[0]?.tuh || l.tuh}</td>
                    {bonuses && <td className="right mono">{l.own.bonusPts}</td>}
                    <td className="right mono">{l.own.score}</td>
                  </tr>
                ))}
                <tr className="std-total">
                  <td className="right">—</td>
                  <td colSpan={2}><strong>Total</strong> <span className="muted">{`${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""} in rooms`}</span></td>
                  {meta.hasPower && <td className="right mono">{t.powers}</td>}
                  <td className="right mono">{t.gets}</td>
                  <td className="right mono">{t.incorrect}</td>
                  <td className="right mono">{t.tuh}</td>
                  {bonuses && <td className="right mono">{t.bonusPts}</td>}
                  <td className="right mono">{t.pts}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

/* ----------------------------- 6. Round Report ----------------------------- */

function RoundReport({ games, meta }: { games: GameRow[]; meta: Meta }) {
  const rows = useMemo(() => {
    const m = new Map<number, GameRow[]>();
    for (const g of games) m.set(g.round, [...(m.get(g.round) || []), g]);
    return [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, list]) => {
        const lines = list.flatMap((g) => g.teams);
        const sides = lines.length;
        const pts = lines.reduce((a, t) => a + t.score, 0);
        const tuPts = lines.reduce((a, t) => a + t.tuPts, 0);
        const powers = lines.reduce((a, t) => a + t.powers, 0);
        const gets = lines.reduce((a, t) => a + t.gets, 0);
        const incorrect = lines.reduce((a, t) => a + t.incorrect, 0);
        const bHeard = lines.reduce((a, t) => a + t.bonusesHeard, 0);
        const bPts = lines.reduce((a, t) => a + t.bonusPts, 0);
        // Tossups read in the round, counted once per room rather than per team.
        const tuRead = list.reduce((a, g) => a + g.tuh, 0);
        const margins = list
          .filter((g) => g.teams.length === 2)
          .map((g) => Math.abs(g.teams[0].score - g.teams[1].score));
        return {
          round, games: list.length, sides, pts, tuPts, powers, gets, incorrect, bHeard, bPts, tuRead,
          margin: margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null,
        };
      });
  }, [games]);
  const bonuses = meta.hasBonuses && meta.hasTeamBonuses !== false;
  return (
    <div className="table-wrap">
      <table className="data-table std-table">
        <thead>
          <tr>
            <th className="right">Round</th>
            <th className="right">{meta.individual ? "Rooms" : "Games"}</th>
            <th className="right">TU read</th>
            <th className="right">{meta.individual ? "Pts/player" : "Pts/team"}</th>
            {!meta.individual && <th className="right">Margin</th>}
            {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
            <th className="right">10</th>
            <th className="right">{negHead(meta)}</th>
            <th className="right" title="Share of tossups read that were answered correctly">Conv%</th>
            {bonuses && <th className="right">BHrd</th>}
            {bonuses && <th className="right">PPB</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.round}>
              <td className="right mono">{roundLabel(r.round)}</td>
              <td className="right mono">{r.games}</td>
              <td className="right mono">{r.tuRead}</td>
              <td className="right mono">{per(r.pts, r.sides, 1)}</td>
              {!meta.individual && <td className="right mono">{r.margin === null ? "—" : num(r.margin, 1)}</td>}
              {meta.hasPower && <td className="right mono">{r.powers}</td>}
              <td className="right mono">{r.gets}</td>
              <td className="right mono">{r.incorrect}</td>
              <td className="right mono">{r.tuRead ? `${num((100 * (r.powers + r.gets)) / r.tuRead, 1)}%` : "—"}</td>
              {bonuses && <td className="right mono">{r.bHeard}</td>}
              {bonuses && <td className="right mono">{per(r.bPts, r.bHeard)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
