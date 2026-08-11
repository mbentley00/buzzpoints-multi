import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { PlayerDetail, PlayerBuzz } from "../types";
import { Html, num } from "../util";
import { Loading, ErrorBox, EditionBadges } from "../components/Common";
import { CategoryStatsTable } from "../components/CategoryStatsTable";
import { DataTable, Column } from "../components/DataTable";
import { RenamePlayer } from "../components/RenamePlayer";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function PlayerDetailPage() {
  const { meta, scope, editions, isOwner, user } = useSetCtx();
  const { slug = "", id = "" } = useParams();
  const { data: all, error, loading } = useScopedJson<Record<string, PlayerDetail>>("players_detail.json");
  const [view, setView] = useState<"cat" | "buzz">("cat");
  const d = all?.[id];

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!d) return <ErrorBox error="Player not found." />;

  function rowClass(b: PlayerBuzz): string {
    if (b.value > 10) return "buzz-row buzz-row-power";
    if (b.value > 0) return "buzz-row buzz-row-get";
    if (b.value < 0) return "buzz-row buzz-row-neg";
    return "buzz-row buzz-row-zero";
  }

  const cols: Column<PlayerBuzz>[] = [
    { key: "round", label: "Round", align: "right", sortVal: (b) => b.round, render: (b) => b.round },
    { key: "num", label: "#", align: "right", sortVal: (b) => b.num, render: (b) => b.num },
    { key: "cat", label: "Category", sortVal: (b) => b.category, render: (b) => <Link className="link" to={`/set/${slug}/tossup?subcategory=${encodeURIComponent(b.category)}`}>{b.category}</Link> },
    { key: "ans", label: "Answer", sortVal: (b) => b.id, render: (b) => <Link className="link answer-cell" to={`/set/${slug}/tossup/${b.id}`}><Html html={b.answer} /></Link> },
    // Links into the question with the buzz word highlighted, so "where did they
    // buzz?" is one click rather than counting words.
    { key: "bp", label: "Buzzpoint", align: "right", sortVal: (b) => b.buzzpoint ?? 1e9,
      render: (b) => (b.buzzpoint == null
        ? "—"
        : <Link className="link" to={`/set/${slug}/tossup/${b.id}?w=${b.buzzpoint}`} title="Show this buzz in the question">{b.buzzpoint}</Link>) },
    { key: "val", label: "Value", align: "right", sortVal: (b) => b.value, render: (b) => b.value },
    { key: "first", label: "First", align: "center", sortVal: (b) => (b.first ? 1 : 0), render: (b) => (b.first ? "✓" : "") },
    { key: "top3", label: "Top 3", align: "center", sortVal: (b) => (b.top3 ? 1 : 0), render: (b) => (b.top3 ? "✓" : "") },
    { key: "rank", label: "Rank", align: "right", sortVal: (b) => b.rank ?? 1e9, render: (b) => b.rank ?? "" },
    { key: "reb", label: "Rebound", align: "center", sortVal: (b) => (b.rebound ? 1 : 0), render: (b) => (b.rebound ? "✓" : "✗") },
  ];

  return (
    <div className="detail">
      <div className="breadcrumb">
        <Link to={`/set/${slug}/player`} className="link">← Players</Link>
      </div>
      <div className="page-header">
        <div>
          <h1>{d.name}</h1>
          <p className="subtitle">
            <Link to={`/set/${slug}/team/${d.teamId}`} className="link">{d.team}</Link>
            {scope === "all" && !!d.editionIds?.length && <> · <EditionBadges ids={d.editionIds} editions={editions} /></>}
            {user && <> · <RenamePlayer slug={slug} name={d.name} team={d.team} isOwner={isOwner} /></>}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setView(view === "cat" ? "buzz" : "cat")}>
          {view === "cat" ? "View Buzzes" : "View Category Stats"}
        </button>
      </div>

      <div className="stat-row">
        <Stat label="Games" value={String(d.games)} />
        <Stat label="TUH" value={String(d.tuh)} />
        {meta.hasPower && <Stat label="Powers" value={String(d.powers)} />}
        <Stat label="Correct" value={String(d.gets)} />
        <Stat label={meta.hasNeg ? "Neg" : "Inc"} value={String(d.incorrect)} />
        <Stat label="Points" value={String(d.pts)} />
        <Stat label="PPG" value={num(d.ppg)} />
        <Stat label="1st buzzes" value={String(d.firstBuzzes)} />
        <Stat label="Top 3" value={String(d.top3Buzzes)} />
      </div>

      {view === "cat" ? (
        <>
          <h2>By category</h2>
          <CategoryStatsTable rows={d.categories} hasPower={meta.hasPower} incLabel={meta.hasNeg ? "Neg" : "Inc"} />
        </>
      ) : (
        <>
          <h2>Buzzes ({d.buzzes.length})</h2>
          <DataTable rows={d.buzzes} columns={cols} initialSort="round" initialDir="asc" rowKey={(b, i) => `${b.id}-${i}`} rowClass={rowClass} />
        </>
      )}
    </div>
  );
}
