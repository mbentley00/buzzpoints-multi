import { useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { TeamRow } from "../types";
import { num, searchable } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, SearchInput, EditionBadges } from "../components/Common";

export function Teams() {
  const { meta, scope, editions } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<TeamRow[]>("teams.json");
  const [q, setQ] = useState("");
  // Rank by PPB in one subject: a main category or one of its subcategories.
  // Kept in the URL so a ranking can be linked to.
  const [params, setParams] = useSearchParams();
  const subject = params.get("subject") || "";
  const setSubject = (v: string) =>
    setParams((p) => { const n = new URLSearchParams(p); if (v) n.set("subject", v); else n.delete("subject"); return n; }, { replace: true });

  // Every subject some team heard a bonus in, each main followed by its subs.
  const subjects = useMemo(() => {
    const keys = new Set<string>();
    for (const t of data ?? []) for (const k of Object.keys(t.bonusCats || {})) keys.add(k);
    const mains = [...keys].filter((k) => !k.includes(" - ")).sort((a, b) => a.localeCompare(b));
    return mains.flatMap((m) => [
      { key: m, label: m },
      ...[...keys].filter((k) => k.startsWith(m + " - ")).sort((a, b) => a.localeCompare(b))
        .map((k) => ({ key: k, label: "\u00a0\u00a0" + k.split(" - ").slice(1).join(" › ") })),
    ]);
  }, [data]);
  const subjectLabel = subject.split(" - ").slice(-1)[0];

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q.trim()) r = r.filter((t) => searchable(t.name).includes(searchable(q)));
    return r;
  }, [data, q]);

  // In the combined view of a multi-edition set, say which edition(s) each team
  // played (rows only carry editionIds once the set has been re-aggregated).
  const edLabel = (id: string) => editions.find((e) => e.id === id)?.label ?? id;
  const showEditions = scope === "all" && editions.length > 1 && (data ?? []).some((t) => t.editionIds?.length);

  const columns: Column<TeamRow>[] = [
    { key: "name", label: "Team", sortVal: (t) => t.name.toLowerCase(), render: (t) => <Link className="link" to={`/set/${slug}/team/${t.id}`}>{t.name}</Link> },
    ...(showEditions
      ? [{ key: "edition", label: "Edition", sortVal: (t: TeamRow) => (t.editionIds || []).map(edLabel).join(", ").toLowerCase(), render: (t: TeamRow) => <EditionBadges ids={t.editionIds} editions={editions} />, title: "Edition(s) this team played" }]
      : []),
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
    { key: "gets", label: "Correct", align: "right", sortVal: (t) => t.gets, render: (t) => t.gets },
    { key: "inc", label: meta.hasNeg ? "Neg" : "Inc", align: "right", sortVal: (t) => t.incorrect, render: (t) => t.incorrect, title: "Incorrect buzzes" },
    { key: "pp20", label: "PP20TUH", align: "right", sortVal: (t) => t.pp20tuh, render: (t) => num(t.pp20tuh) },
    { key: "bpa", label: "BPA", align: "right", sortVal: (t) => t.bpa ?? -1, render: (t) => num(t.bpa),
      title: "Buzz point area-under-the-curve: how much of each question went unread thanks to early correct buzzes, per tossup heard. Higher is faster." },
    ...(meta.hasBonuses && meta.hasTeamBonuses !== false
      ? [{ key: "ppb", label: "PPB", align: "right" as const, sortVal: (t: TeamRow) => t.ppb, render: (t: TeamRow) => num(t.ppb, 2) }]
      : []),
    ...(subject
      ? [
          { key: "subjHeard", label: "Heard", align: "right" as const, title: `Bonuses heard in ${subject}`,
            sortVal: (t: TeamRow) => t.bonusCats?.[subject]?.[0] ?? 0, render: (t: TeamRow) => t.bonusCats?.[subject]?.[0] ?? 0 },
          { key: "subjPpb", label: `${subjectLabel} PPB`, align: "right" as const, title: `Points per bonus in ${subject}`,
            // A team that heard none sorts below every team that did, either way.
            sortVal: (t: TeamRow) => (t.bonusCats?.[subject]?.[0] ? t.bonusCats[subject][1] : -1),
            render: (t: TeamRow) => (t.bonusCats?.[subject]?.[0] ? num(t.bonusCats[subject][1], 2) : "—") },
        ]
      : []),
    { key: "first", label: "1st", align: "right", sortVal: (t) => t.firstBuzzes, render: (t) => t.firstBuzzes, title: "Fastest correct buzz on a tossup" },
    { key: "top3", label: "Top3", align: "right", sortVal: (t) => t.top3Buzzes, render: (t) => t.top3Buzzes },
  ];

  // A shootout has no teams worth listing (each is one player) and no Teams tab;
  // an old link lands on the players instead.
  if (meta.individual) return <Navigate to={`/set/${slug}/player`} replace />;

  return (
    <div>
      <PageHeader title="Teams" subtitle={`${rows.length} teams`}>
        {subjects.length > 0 && (
          <select className="subject-select" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Rank by PPB in a subject">
            <option value="">PPB by subject…</option>
            {subjects.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        )}
        <SearchInput value={q} onChange={setQ} placeholder="Search team" />
      </PageHeader>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {/* Remounted per subject so choosing one sorts by it. */}
      {data && <DataTable key={subject} rows={rows} columns={columns} initialSort={subject ? "subjPpb" : "ppg"} initialDir="desc" rowKey={(t) => t.id} />}
    </div>
  );
}
