import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { PlayerRow } from "../types";
import { num } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, SearchInput } from "../components/Common";

export function Players() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<PlayerRow[]>("players.json");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((p) => p.name.toLowerCase().includes(n) || p.team.toLowerCase().includes(n));
    }
    return r;
  }, [data, q]);

  const columns: Column<PlayerRow>[] = [
    { key: "name", label: "Player", sortVal: (p) => p.name.toLowerCase(), render: (p) => <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> },
    { key: "team", label: "Team", sortVal: (p) => p.team.toLowerCase(), render: (p) => (p.teamId ? <Link className="link" to={`/set/${slug}/team/${p.teamId}`}>{p.team}</Link> : p.team) },
    { key: "games", label: "GP", align: "right", sortVal: (p) => p.games, render: (p) => p.games },
    { key: "tuh", label: "TUH", align: "right", sortVal: (p) => p.tuh, render: (p) => p.tuh },
    ...(meta.hasPower
      ? [{ key: "pwr", label: "Pwr", align: "right" as const, sortVal: (p: PlayerRow) => p.powers, render: (p: PlayerRow) => p.powers }]
      : []),
    { key: "gets", label: "Correct", align: "right", sortVal: (p) => p.gets, render: (p) => p.gets },
    { key: "inc", label: meta.hasNeg ? "Neg" : "Inc", align: "right", sortVal: (p) => p.incorrect, render: (p) => p.incorrect, title: "Incorrect buzzes" },
    { key: "pts", label: "Pts", align: "right", sortVal: (p) => p.pts, render: (p) => p.pts },
    { key: "ppg", label: "PPG", align: "right", sortVal: (p) => p.ppg, render: (p) => num(p.ppg) },
    { key: "ptuh", label: "Pts/TUH", align: "right", sortVal: (p) => p.pPerTuh, render: (p) => num(p.pPerTuh, 2) },
    { key: "first", label: "1st", align: "right", sortVal: (p) => p.firstBuzzes, render: (p) => p.firstBuzzes, title: "Times the earliest buzzer on a tossup" },
    { key: "top3", label: "Top3", align: "right", sortVal: (p) => p.top3Buzzes, render: (p) => p.top3Buzzes },
  ];

  return (
    <div>
      <PageHeader title="Players" subtitle={`${rows.length} players`}>
        <SearchInput value={q} onChange={setQ} placeholder="Search player / team" />
      </PageHeader>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={rows} columns={columns} initialSort="ppg" initialDir="desc" rowKey={(p) => p.id} />}
    </div>
  );
}
