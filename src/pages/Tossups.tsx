import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { TossupRow } from "../types";
import { CategoryTag, Html, pct, num, plain, catMatches, roundLabel } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, RoundFilter, MinHeardFilter, SearchInput } from "../components/Common";
import { useCategoryFilter, CategoryFilterChip } from "../components/CategoryFilter";

export function Tossups() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<TossupRow[]>("tossups.json");
  const [round, setRound] = useState<number | "all">("all");
  const [minHeard, setMinHeard] = useState(0);
  const [q, setQ] = useState("");
  const cat = useCategoryFilter();
  // ?tag=Writer: JL — set by the Tags page and by a tag chip on a question.
  const [params, setParams] = useSearchParams();
  const tag = params.get("tag");

  const rows = useMemo(() => {
    let r = data ?? [];
    if (round !== "all") r = r.filter((t) => t.round === round);
    if (minHeard > 0) r = r.filter((t) => t.heard >= minHeard);
    if (cat.values.length) r = r.filter((t) => cat.values.some((v) => catMatches(t.subcategory, v)));
    if (tag) r = r.filter((t) => (t.tags || []).includes(tag));
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((t) => plain(t.answer).toLowerCase().includes(n) || t.subcategory.toLowerCase().includes(n));
    }
    return r;
  }, [data, round, minHeard, q, cat.values, tag]);

  const columns: Column<TossupRow>[] = [
    {
      key: "rn",
      label: "Rd/#",
      sortVal: (t) => t.round * 100 + t.num,
      render: (t) => (
        <Link className="mono link" to={`/set/${slug}/tossup/${t.id}`}>
          {roundLabel(t.round)}-{t.num}
        </Link>
      ),
    },
    {
      key: "answer",
      label: "Answer",
      sortVal: (t) => plain(t.answer).toLowerCase(),
      render: (t) => (
        <Link className="link answer-cell" to={`/set/${slug}/tossup/${t.id}`}>
          <Html html={t.answer} />
        </Link>
      ),
    },
    { key: "category", label: "Category", sortVal: (t) => t.category, render: (t) => <CategoryTag cat={t.category} /> },
    { key: "heard", label: "Heard", align: "right", sortVal: (t) => t.heard, render: (t) => t.heard },
    { key: "conv", label: "Conv%", align: "right", sortVal: (t) => t.convPct, render: (t) => pct(t.convPct) },
    ...(meta.hasPower
      ? [
          { key: "pwr", label: "Pwr", align: "right" as const, sortVal: (t: TossupRow) => t.powers, render: (t: TossupRow) => t.powers },
          { key: "pwrpct", label: "Pwr%", align: "right" as const, sortVal: (t: TossupRow) => t.powerPct, render: (t: TossupRow) => pct(t.powerPct) },
        ]
      : []),
    { key: "incpct", label: "Inc%", align: "right", sortVal: (t) => t.incorrectPct, render: (t) => pct(t.incorrectPct), title: "Rate of interrupting incorrect buzzes per play" },
    {
      key: "buzz",
      label: "Avg Buzz",
      align: "right",
      sortVal: (t) => t.avgBuzzPct ?? 999,
      render: (t) => (t.avgBuzzPct === null ? "—" : `${num(t.avgBuzzPct)}%`),
    },
    {
      key: "livebuzz",
      label: "Avg Live Buzz",
      align: "right",
      title: "Average position of conversions that came while the question was still live — the first buzz of a reading, before anyone had negged",
      sortVal: (t) => t.avgLiveBuzzPct ?? 999,
      render: (t) => (t.avgLiveBuzzPct == null ? "—" : `${num(t.avgLiveBuzzPct)}%`),
    },
  ];

  return (
    <div>
      <PageHeader title="Tossups" subtitle={`${rows.length} questions`}>
        <RoundFilter rounds={meta.rounds} value={round} onChange={setRound} />
        <MinHeardFilter value={minHeard} onChange={setMinHeard} />
        <SearchInput value={q} onChange={setQ} placeholder="Search answer / category" />
      </PageHeader>
      {cat.active && <CategoryFilterChip label={cat.label} onClear={cat.clear} />}
      {tag && (
        <CategoryFilterChip
          label={tag}
          onClear={() => { const n = new URLSearchParams(params); n.delete("tag"); setParams(n, { replace: true }); }}
        />
      )}
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={rows} columns={columns} initialSort="rn" initialDir="asc" rowKey={(t) => t.id} />}
    </div>
  );
}
