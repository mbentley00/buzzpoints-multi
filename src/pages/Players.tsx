import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { PlayerRow } from "../types";
import { num } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, SearchInput, EditionBadges } from "../components/Common";

export function Players() {
  const { meta, scope, editions } = useSetCtx();
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

  // In the combined view of a multi-edition set, say which edition(s) each
  // player played (rows only carry editionIds once the set has been re-aggregated).
  const edLabel = (id: string) => editions.find((e) => e.id === id)?.label ?? id;
  const showEditions = scope === "all" && editions.length > 1 && (data ?? []).some((p) => p.editionIds?.length);

  const columns: Column<PlayerRow>[] = [
    { key: "name", label: "Player", sortVal: (p) => p.name.toLowerCase(), render: (p) => <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> },
    { key: "team", label: "Team", sortVal: (p) => p.team.toLowerCase(), render: (p) => (p.teamId ? <Link className="link" to={`/set/${slug}/team/${p.teamId}`}>{p.team}</Link> : p.team) },
    ...(showEditions
      ? [{ key: "edition", label: "Edition", sortVal: (p: PlayerRow) => (p.editionIds || []).map(edLabel).join(", ").toLowerCase(), render: (p: PlayerRow) => <EditionBadges ids={p.editionIds} editions={editions} />, title: "Edition(s) this player played" }]
      : []),
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
    { key: "bpa", label: "BPA", align: "right", sortVal: (p) => p.bpa ?? -1, render: (p) => num(p.bpa),
      title: "Buzz point area-under-the-curve: how much of each question went unread thanks to early correct buzzes, per tossup heard. Higher is faster." },
    { key: "first", label: "1st", align: "right", sortVal: (p) => p.firstBuzzes, render: (p) => p.firstBuzzes, title: "Times the fastest correct buzz on a tossup" },
    { key: "top3", label: "Top3", align: "right", sortVal: (p) => p.top3Buzzes, render: (p) => p.top3Buzzes },
    { key: "reb", label: "Reb", align: "right", sortVal: (p) => p.rebounds, render: (p) => p.rebounds, title: "Rebounds: tossups converted after another team buzzed wrong" },
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
