import { useParams, Link } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { CategoryPlayers, CategoryPlayerRow } from "../types";
import { num } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox } from "../components/Common";

export function CategoryPlayersPage() {
  const { meta } = useSetCtx();
  const { slug = "", cid = "" } = useParams();
  const { data: all, error, loading } = useScopedJson<Record<string, CategoryPlayers>>("categories_players.json");
  const data = all?.[cid];

  const columns: Column<CategoryPlayerRow>[] = [
    { key: "name", label: "Player", sortVal: (p) => p.name.toLowerCase(), render: (p) => (p.playerId ? <Link className="link" to={`/set/${slug}/player/${p.playerId}`}>{p.name}</Link> : p.name) },
    { key: "team", label: "Team", sortVal: (p) => p.team.toLowerCase(), render: (p) => (p.teamId ? <Link className="link" to={`/set/${slug}/team/${p.teamId}`}>{p.team}</Link> : p.team) },
    ...(meta.hasPower ? [{ key: "pwr", label: "Pwr", align: "right" as const, sortVal: (p: CategoryPlayerRow) => p.powers, render: (p: CategoryPlayerRow) => p.powers, title: "Powers" }] : []),
    { key: "gets", label: "Get", align: "right", sortVal: (p) => p.gets, render: (p) => p.gets },
    { key: "inc", label: "Inc", align: "right", sortVal: (p) => p.incorrect, render: (p) => p.incorrect, title: "Incorrect buzzes" },
    { key: "pts", label: "Points", align: "right", sortVal: (p) => p.points, render: (p) => p.points },
    { key: "early", label: "Earliest Buzz", align: "right", sortVal: (p) => p.earliest ?? 1e9, render: (p) => (p.earliest === null ? "—" : p.earliest), title: "Earliest word position of a correct buzz" },
    { key: "avg", label: "Avg Buzz", align: "right", sortVal: (p) => p.avgBuzz ?? 1e9, render: (p) => (p.avgBuzz === null ? "—" : num(p.avgBuzz)) },
    { key: "first", label: "First Buzzes", align: "right", sortVal: (p) => p.firstBuzzes, render: (p) => p.firstBuzzes, title: "Times the earliest buzzer on a tossup in this category" },
    { key: "top3", label: "Top 3 Buzzes", align: "right", sortVal: (p) => p.top3Buzzes, render: (p) => p.top3Buzzes },
  ];

  return (
    <div>
      <div className="breadcrumb">
        <Link to={`/set/${slug}/category/tossup`} className="link">← Categories (Tossup)</Link>
      </div>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {all && !data && <ErrorBox error="Category not found." />}
      {data && (
        <>
          <PageHeader title={data.category} subtitle={`${data.players.length} players · tossup performance in this category`} />
          <DataTable rows={data.players} columns={columns} initialSort="pts" initialDir="desc" rowKey={(p) => `${p.name}|${p.team}`} />
        </>
      )}
    </div>
  );
}
