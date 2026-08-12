import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { TossupRow, BonusRow } from "../types";
import { CategoryTag, Html, pct, num, roundLabel, primaryAnswer } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading } from "../components/Common";

export function Packets() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data: tus } = useScopedJson<TossupRow[]>("tossups.json");
  const { data: bns } = useScopedJson<BonusRow[]>(meta.hasBonuses ? "bonuses.json" : "tossups.json");
  const [round, setRound] = useState<number>(meta.rounds[0] ?? 1);

  const tossups = useMemo(
    () => (tus ?? []).filter((t) => t.round === round).sort((a, b) => a.num - b.num),
    [tus, round]
  );
  const bonuses = useMemo(
    () => (meta.hasBonuses ? (bns ?? []) : []).filter((b) => b.round === round).sort((a, b) => a.num - b.num),
    [bns, round, meta.hasBonuses]
  );

  const tuCols: Column<TossupRow>[] = [
    { key: "num", label: "#", align: "right", sortVal: (t) => t.num, render: (t) => <Link className="mono link" to={`/set/${slug}/tossup/${t.id}`}>{t.num}</Link> },
    { key: "answer", label: "Answer", sortVal: (t) => t.num, render: (t) => <Link className="link answer-cell" to={`/set/${slug}/tossup/${t.id}`}><Html html={primaryAnswer(t.answer)} /></Link> },
    { key: "cat", label: "Category", sortVal: (t) => t.category, render: (t) => <CategoryTag cat={t.category} /> },
    { key: "heard", label: "Heard", align: "right", sortVal: (t) => t.heard, render: (t) => t.heard },
    { key: "conv", label: "Conv%", align: "right", sortVal: (t) => t.convPct, render: (t) => pct(t.convPct) },
    ...(meta.hasPower ? [{ key: "pwr", label: "Pwr%", align: "right" as const, sortVal: (t: TossupRow) => t.powerPct, render: (t: TossupRow) => pct(t.powerPct) }] : []),
    { key: "inc", label: "Inc%", align: "right", sortVal: (t) => t.incorrectPct, render: (t) => pct(t.incorrectPct), title: "Rate of interrupting incorrect buzzes per play" },
    { key: "buzz", label: "Avg Buzz", align: "right", sortVal: (t) => t.avgBuzzPct ?? 999, render: (t) => (t.avgBuzzPct === null ? "—" : `${num(t.avgBuzzPct)}%`) },
  ];

  const partCell = (answer: string | null, p: number | null) =>
    answer === null ? "—" : (
      <div className="part-cell">
        <Html html={primaryAnswer(answer)} className="part-answer" />
        <span className="part-pct">{pct(p)}</span>
      </div>
    );

  const bnCols: Column<BonusRow>[] = [
    { key: "num", label: "#", align: "right", sortVal: (b) => b.num, render: (b) => <Link className="mono link" to={`/set/${slug}/bonus/${b.id}`}>{b.num}</Link> },
    { key: "cat", label: "Category", sortVal: (b) => b.category, render: (b) => <CategoryTag cat={b.category} /> },
    { key: "ppb", label: "PPB", align: "right", sortVal: (b) => b.ppb, render: (b) => num(b.ppb, 2) },
    { key: "easy", label: "Easy", sortVal: (b) => b.easyPct ?? -1, render: (b) => partCell(b.easyAnswer, b.easyPct) },
    { key: "med", label: "Medium", sortVal: (b) => b.medPct ?? -1, render: (b) => partCell(b.medAnswer, b.medPct) },
    { key: "hard", label: "Hard", sortVal: (b) => b.hardPct ?? -1, render: (b) => partCell(b.hardAnswer, b.hardPct) },
  ];

  return (
    <div>
      <PageHeader title="Packets" subtitle={`Round ${roundLabel(round)} — questions in packet order`}>
        <label className="filter">
          Round:{" "}
          <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
            {meta.rounds.map((r) => <option key={r} value={r}>{roundLabel(r)}</option>)}
          </select>
        </label>
      </PageHeader>
      {!tus ? (
        <Loading />
      ) : (
        <>
          <h2>Tossups</h2>
          <DataTable rows={tossups} columns={tuCols} initialSort="num" initialDir="asc" rowKey={(t) => t.id} />
          {meta.hasBonuses && (
            <>
              <h2>Bonuses</h2>
              <DataTable rows={bonuses} columns={bnCols} initialSort="num" initialDir="asc" rowKey={(b) => b.id} />
            </>
          )}
        </>
      )}
    </div>
  );
}
