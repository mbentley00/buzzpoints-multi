import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { TeamRow } from "../types";
import { num } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, SearchInput } from "../components/Common";

export function Teams() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<TeamRow[]>("teams.json");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q.trim()) r = r.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
    return r;
  }, [data, q]);

  const columns: Column<TeamRow>[] = [
    { key: "name", label: "Team", sortVal: (t) => t.name.toLowerCase(), render: (t) => <Link className="link" to={`/set/${slug}/team/${t.id}`}>{t.name}</Link> },
    { key: "games", label: "GP", align: "right", sortVal: (t) => t.games, render: (t) => t.games },
    {
      key: "record",
      label: "Record",
      align: "right",
      sortVal: (t) => (t.games ? t.wins / t.games : 0),
      render: (t) => `${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}`,
    },
    { key: "ppg", label: "PPG", align: "right", sortVal: (t) => t.ppg, render: (t) => num(t.ppg) },
    ...(meta.hasPower
      ? [{ key: "pwr", label: "Pwr", align: "right" as const, sortVal: (t: TeamRow) => t.powers, render: (t: TeamRow) => t.powers }]
      : []),
    { key: "pp20", label: "PP20TUH", align: "right", sortVal: (t) => t.pp20tuh, render: (t) => num(t.pp20tuh) },
    ...(meta.hasBonuses
      ? [{ key: "ppb", label: "PPB", align: "right" as const, sortVal: (t: TeamRow) => t.ppb, render: (t: TeamRow) => num(t.ppb, 2) }]
      : []),
    { key: "first", label: "1st", align: "right", sortVal: (t) => t.firstBuzzes, render: (t) => t.firstBuzzes, title: "First buzzes" },
    { key: "top3", label: "Top3", align: "right", sortVal: (t) => t.top3Buzzes, render: (t) => t.top3Buzzes },
  ];

  return (
    <div>
      <PageHeader title="Teams" subtitle={`${rows.length} teams`}>
        <SearchInput value={q} onChange={setQ} placeholder="Search team" />
      </PageHeader>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={rows} columns={columns} initialSort="ppg" initialDir="desc" rowKey={(t) => t.id} />}
    </div>
  );
}
