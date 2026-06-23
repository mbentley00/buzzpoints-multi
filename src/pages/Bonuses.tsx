import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { BonusRow } from "../types";
import { CategoryTag, Html, pct, num, plain } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, RoundFilter, SearchInput } from "../components/Common";

export function Bonuses() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<BonusRow[]>("bonuses.json");
  const [round, setRound] = useState<number | "all">("all");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    let r = data ?? [];
    if (round !== "all") r = r.filter((b) => b.round === round);
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((b) => b.subcategory.toLowerCase().includes(n) || [b.easyAnswer, b.medAnswer, b.hardAnswer].some((a) => a && plain(a).toLowerCase().includes(n)));
    }
    return r;
  }, [data, round, q]);

  const partCell = (answer: string | null, p: number | null) =>
    answer === null ? (
      "—"
    ) : (
      <div className="part-cell">
        <Html html={answer} className="part-answer" />
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
          {b.round}-{b.num}
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
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={rows} columns={columns} initialSort="rn" initialDir="asc" rowKey={(b) => b.id} />}
    </div>
  );
}
