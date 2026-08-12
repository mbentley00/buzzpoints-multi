import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { BonusRow } from "../types";
import { CategoryTag, Html, pct, num, plain, catMatches, roundLabel, primaryAnswer } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, RoundFilter, SearchInput } from "../components/Common";
import { useCategoryFilter, CategoryFilterChip } from "../components/CategoryFilter";

export function Bonuses() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<BonusRow[]>("bonuses.json");
  const [round, setRound] = useState<number | "all">("all");
  const [q, setQ] = useState("");
  const [params, setParams] = useSearchParams();
  const tag = params.get("tag");
  const cat = useCategoryFilter();

  const rows = useMemo(() => {
    let r = data ?? [];
    if (round !== "all") r = r.filter((b) => b.round === round);
    if (cat.values.length) r = r.filter((b) => cat.values.some((v) => catMatches(b.subcategory, v)));
    if (tag) r = r.filter((b) => (b.tags || []).includes(tag));
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((b) => b.subcategory.toLowerCase().includes(n) || [b.easyAnswer, b.medAnswer, b.hardAnswer].some((a) => a && plain(a).toLowerCase().includes(n)));
    }
    return r;
  }, [data, round, q, cat.values, tag]);

  const partCell = (answer: string | null, p: number | null) =>
    answer === null ? (
      "—"
    ) : (
      <div className="part-cell">
        <Html html={primaryAnswer(answer)} className="part-answer" />
        <span className="part-pct">{pct(p)}</span>
      </div>
    );

  const columns: Column<BonusRow>[] = [
    {
      key: "rn",
      label: "Rd/#",
      sortVal: (b) => b.round * 100 + b.num,
      render: (b) => (
        <Link className="mono link" to={`/set/${slug}/bonus/${b.id}`}>
          {roundLabel(b.round)}-{b.num}
        </Link>
      ),
    },
    { key: "category", label: "Category", sortVal: (b) => b.category, render: (b) => <CategoryTag cat={b.category} /> },
    { key: "heard", label: "Heard", align: "right", sortVal: (b) => b.heard, render: (b) => b.heard },
    { key: "ppb", label: "PPB", align: "right", sortVal: (b) => b.ppb, render: (b) => num(b.ppb, 2) },
    { key: "easy", label: "Easy", sortVal: (b) => b.easyPct ?? -1, render: (b) => partCell(b.easyAnswer, b.easyPct) },
    { key: "med", label: "Medium", sortVal: (b) => b.medPct ?? -1, render: (b) => partCell(b.medAnswer, b.medPct) },
    { key: "hard", label: "Hard", sortVal: (b) => b.hardPct ?? -1, render: (b) => partCell(b.hardAnswer, b.hardPct) },
  ];

  return (
    <div>
      <PageHeader title="Bonuses" subtitle={`${rows.length} bonuses`}>
        <RoundFilter rounds={meta.rounds} value={round} onChange={setRound} />
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
      {data && <DataTable rows={rows} columns={columns} initialSort="rn" initialDir="asc" rowKey={(b) => b.id} />}
    </div>
  );
}
