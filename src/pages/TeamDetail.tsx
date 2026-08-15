import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { TeamDetail, RosterPlayer, CatBonusRow, CatBonusSub, CatTeamTossupRow, CatTeamTossupSub } from "../types";
import { num, pct } from "../util";
import { Loading, ErrorBox, EditionBadges } from "../components/Common";
import { CategoryGroups, CatColumn } from "../components/CategoryGroups";
import { DataTable, Column } from "../components/DataTable";
import { Rename } from "../components/Rename";

const buzz = (v: number | null) => (v === null ? "—" : num(v));
const rankCell = (rank?: number | null, rankOf?: number | null) =>
  rank == null ? "—" : rankOf ? `${rank} / ${rankOf}` : String(rank);

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
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

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!d) return <ErrorBox error="Team not found." />;

  const tossupCols: CatColumn<CatTeamTossupRow, CatTeamTossupSub>[] = [
    ...(meta.hasPower ? [{ label: "Pwr", align: "right" as const, main: (g: CatTeamTossupRow) => g.powers, sub: (s: CatTeamTossupSub) => s.powers }] : []),
    { label: "Get", align: "right", main: (g) => g.gets, sub: (s) => s.gets },
    { label: meta.hasNeg ? "Neg" : "Inc", align: "right", main: (g) => g.incorrect, sub: (s) => s.incorrect },
    { label: "Points", align: "right", main: (g) => g.points, sub: (s) => s.points },
    { label: "Rank", align: "right", title: "This team's rank in the category by total points, of the teams that played it", main: (g) => rankCell(g.rank, g.rankOf), sub: (s) => rankCell(s.rank, s.rankOf) },
    { label: "Earliest", align: "right", main: (g) => g.earliest ?? "—", sub: (s) => s.earliest ?? "—" },
    { label: "Avg Buzz", align: "right", main: (g) => buzz(g.avgBuzz), sub: (s) => buzz(s.avgBuzz) },
    { label: "% Pts", align: "right", main: (g) => num(g.pctPoints, 1), sub: (s) => num(s.pctPoints, 1) },
  ];

  const bonusCols: CatColumn<CatBonusRow, CatBonusSub>[] = [
    { label: "Heard", align: "right", main: (g) => g.heard, sub: (s) => s.heard },
    { label: "PPB", align: "right", main: (g) => num(g.ppb, 2), sub: (s) => num(s.ppb, 2) },
    { label: "Easy%", align: "right", main: (g) => pct(g.easyPct), sub: (s) => pct(s.easyPct) },
    { label: "Medium%", align: "right", main: (g) => pct(g.medPct), sub: (s) => pct(s.medPct) },
    { label: "Hard%", align: "right", main: (g) => pct(g.hardPct), sub: (s) => pct(s.hardPct) },
  ];

  const rosterCols: Column<RosterPlayer>[] = [
    { key: "name", label: "Player", sortVal: (p) => p.name.toLowerCase(), render: (p) => <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> },
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

      <div className="stat-row">
        <Stat label="PPG" value={num(d.ppg)} />
        {teamBonus && <Stat label="PPB" value={num(d.ppb, 2)} />}
        <Stat label="PP20TUH" value={num(d.pp20tuh)} />
        {meta.hasPower && <Stat label="Powers" value={String(d.powers)} />}
        <Stat label="Correct" value={String(d.gets)} />
        <Stat label={meta.hasNeg ? "Neg" : "Inc"} value={String(d.incorrect)} />
        <Stat label="1st buzzes" value={String(d.firstBuzzes)} />
        <Stat label="Top 3" value={String(d.top3Buzzes)} />
      </div>

      {view === "main" || !teamBonus ? (
        <>
          <h2>Roster</h2>
          <DataTable rows={d.roster} columns={rosterCols} initialSort="pts" initialDir="desc" rowKey={(p) => p.id} />
          <h2>Tossups by category</h2>
          <CategoryGroups groups={d.categories} columns={tossupCols} linkBase={`/set/${slug}/tossup`} mainParam="category" subParam="subcategory" />
        </>
      ) : (
        <>
          <h2>Bonuses by category</h2>
          <CategoryGroups groups={d.bonusCategories} columns={bonusCols} linkBase={`/set/${slug}/bonus`} mainParam="category" subParam="subcategory" />
        </>
      )}
    </div>
  );
}
