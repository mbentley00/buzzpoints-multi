import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, setNav, useScopedJson, scopedPath } from "../components/Layout";
import { useSetJson } from "../data";
import { levelLabel, difficultyLabel, PlayerRow, TeamRow } from "../types";
import { num, searchable, byLabel } from "../util";

const record = (t: TeamRow) => `${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ""}`;
const TOP = 8;
const winPct = (t: TeamRow) => (t.games ? (t.wins + t.ties / 2) / t.games : 0);

export function SetHome() {
  const { meta, level, tdLink, difficulty, combinedFrom, editions, isOwner, forum, forumUnread, pendingAccess, scope } = useSetCtx();
  const { slug = "" } = useParams();
  const base = `/set/${slug}`;
  const groups = setNav(meta, base, { hasEditions: editions.length > 1, isOwner, forum, forumUnread, pendingAccess });
  const { data: teams } = useScopedJson<TeamRow[]>(meta.individual ? "" : "teams.json");
  const { data: players } = useScopedJson<PlayerRow[]>("players.json");
  const [q, setQ] = useState("");

  // Editions are separate sites or divisions, so records from different ones
  // don't rank against each other: Top Teams shows one edition at a time.
  const sortedEds = useMemo(() => byLabel(editions), [editions]);
  const perEdition = !meta.individual && editions.length > 1 && scope === "all";
  const [edPick, setEdPick] = useState("");
  const edId = perEdition ? (sortedEds.find((e) => e.id === edPick) ?? sortedEds[0]).id : "";
  const { data: edTeams } = useSetJson<TeamRow[]>(slug, perEdition ? scopedPath(edId, "teams.json") : "");
  const rankTeams = perEdition ? edTeams : teams;
  // Team ids are per scope, and team pages open in the combined scope, so an
  // edition's team is linked through its combined row (matched by name).
  const teamLink = useMemo(() => {
    const all = teams ?? [];
    return (t: TeamRow) => {
      if (!perEdition) return t.id;
      const same = all.filter((c) => c.name === t.name);
      return (same.find((c) => c.editionIds?.includes(edId)) ?? (same.length === 1 ? same[0] : undefined))?.id;
    };
  }, [teams, perEdition, edId]);

  const bestTeams = useMemo(
    () => [...(rankTeams ?? [])].filter((t) => t.games > 0).sort((a, b) => winPct(b) - winPct(a) || b.ppg - a.ppg).slice(0, TOP),
    [rankTeams]
  );
  // A player who sat in for one game shouldn't top the list.
  const topPlayers = useMemo(() => {
    const ps = (players ?? []).filter((p) => p.games > 0);
    const most = Math.max(0, ...ps.map((p) => p.games));
    return ps.filter((p) => p.games >= most / 2).sort((a, b) => b.ppg - a.ppg).slice(0, TOP);
  }, [players]);

  const hits = useMemo(() => {
    const n = searchable(q.trim());
    if (!n) return [];
    const ts = (teams ?? []).filter((t) => searchable(t.name).includes(n)).map((t) => ({ key: "t" + t.id, to: `${base}/team/${t.id}`, name: t.name, sub: "Team" }));
    const ps = (players ?? []).filter((p) => searchable(p.name).includes(n)).map((p) => ({ key: "p" + p.id, to: `${base}/player/${p.id}`, name: p.name, sub: p.team }));
    return [...ts, ...ps].slice(0, 10);
  }, [q, teams, players, base]);

  const numTeams = teams?.length ?? meta.numTeams;
  const numPlayers = players?.filter((p) => p.games > 0).length ?? meta.numPlayers;

  return (
    <div className="home">
      <div className="home-head">
        <div>
          <h1>{meta.setName}</h1>
          <p className="subtitle">
            {level && <>{levelLabel(level)} · </>}
            {difficultyLabel(level, difficulty) && <>{difficultyLabel(level, difficulty)} · </>}
            {meta.individual
              ? <>{meta.numPlayers} players · {meta.numGames} rooms · </>
              : <>{meta.numTeams} teams · {meta.numGames} games · </>}
            {meta.scoringLabel}
          </p>
          {combinedFrom && combinedFrom.length > 0 && (
            <p className="subtitle">
              Combined from{" "}
              {combinedFrom.map((c, i) => (
                <span key={c.slug}>
                  {i > 0 && " · "}
                  <Link className="link" to={`/set/${c.slug}`}>{c.name}</Link>{" "}
                  <span className="muted">(packets {c.from}–{c.to})</span>
                </span>
              ))}
            </p>
          )}
          {tdLink && (
            <p className="subtitle">
              <a className="link" href={tdLink} target="_blank" rel="noreferrer">Tournament Database →</a>
            </p>
          )}
        </div>
        <div className="home-search">
          <input
            type="search" className="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search" aria-label={meta.individual ? "Search players" : "Search players and teams"}
          />
          {hits.length > 0 && (
            <ul className="home-search-hits">
              {hits.map((h) => (
                <li key={h.key}><Link to={h.to}><span className="strong">{h.name}</span> <span className="muted">· {h.sub}</span></Link></li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="home-grid">
        {!meta.individual && (teams?.length ?? 0) > 0 && (
          <section className="home-card">
            <div className="home-card-head">
              <h2>Top Teams</h2>
              <Link to={`${base}/team`}>All {numTeams} teams →</Link>
            </div>
            {perEdition && (
              <select className="home-edition" aria-label="Edition" value={edId} onChange={(e) => setEdPick(e.target.value)}>
                {sortedEds.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            )}
            <table className="home-table">
              <thead>
                <tr><th>Team</th><th className="right">W–L</th><th className="right" title="Points per game">PPG</th>{meta.hasBonuses && <th className="right" title="Points per bonus">PPB</th>}</tr>
              </thead>
              <tbody>
                {bestTeams.map((t) => (
                  <tr key={t.id}>
                    <td>{teamLink(t) ? <Link className="strong" to={`${base}/team/${teamLink(t)}`}>{t.name}</Link> : <span className="strong">{t.name}</span>}</td>
                    <td className="right">{record(t)}</td>
                    <td className="right">{num(t.ppg)}</td>
                    {meta.hasBonuses && <td className="right">{t.bonusesHeard ? num(t.ppb, 2) : "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {topPlayers.length > 0 && (
          <section className="home-card">
            <div className="home-card-head">
              <h2>Top Individuals</h2>
              <Link to={`${base}/player`}>All {numPlayers} players →</Link>
            </div>
            <ol className="home-players">
              {topPlayers.map((p, i) => (
                <li key={p.id}>
                  <span className="muted">{i + 1}</span>
                  <span>
                    <Link className="strong" to={`${base}/player/${p.id}`}>{p.name}</Link>
                    {!meta.individual && <span className="muted"> · {p.team}</span>}
                  </span>
                  <span><b>{num(p.ppg)}</b> <span className="muted">PPG</span></span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <h2>Explore</h2>
      <div className="explore-grid">
        {groups.map((g) => (
          <section key={g.label} className="home-card">
            <h3>{g.label}</h3>
            <ul>
              {g.items.map((i) => (
                <li key={i.to}>
                  <Link to={i.to}>{i.label}{!!i.badge && <span className="badge-new" title={i.badgeTitle}>{i.badge}</span>}</Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
