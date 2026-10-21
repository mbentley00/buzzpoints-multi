import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { BuzzerRace } from "../types";
import { CategoryTag, Html, num, roundLabel, primaryAnswer, searchable } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, RoundFilter, SearchInput } from "../components/Common";

function ClueSnippet({ r }: { r: BuzzerRace }) {
  return (
    <div className="clue-snippet">
      <span className="muted">{r.leadingPct ? "… " : ""}{r.before}{" "}</span>
      <mark className="hot-clue">{r.hot}</mark>
      <span className="muted">{" "}{r.after}{r.trailingMore ? " …" : ""}</span>
    </div>
  );
}

export function BuzzerRaces() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<BuzzerRace[]>("buzzer_races.json");
  const [round, setRound] = useState<number | "all">("all");
  const [q, setQ] = useState("");
  const [minBuzz, setMinBuzz] = useState(0);
  const [minPct, setMinPct] = useState<number | "">("");
  const [maxPct, setMaxPct] = useState<number | "">("");

  const rows = useMemo(() => {
    let r = data ?? [];
    if (round !== "all") r = r.filter((x) => x.round === round);
    if (minBuzz > 0) r = r.filter((x) => x.buzzCount >= minBuzz);
    if (minPct !== "") r = r.filter((x) => x.pctThrough >= minPct);
    if (maxPct !== "") r = r.filter((x) => x.pctThrough <= maxPct);
    if (q.trim()) {
      const n = searchable(q);
      r = r.filter((x) => searchable(x.hot).includes(n) || searchable(x.before).includes(n) || searchable(x.after).includes(n) || searchable(x.category).includes(n));
    }
    return r;
  }, [data, round, q, minBuzz, minPct, maxPct]);

  const columns: Column<BuzzerRace>[] = [
    { key: "buzzes", label: "Buzzes", align: "right", sortVal: (r) => r.buzzCount, render: (r) => <span className="race-count">{r.buzzCount}</span>, title: "Within 5 words" },
    {
      key: "breakdown", label: "P / C / N", align: "center", sortVal: (r) => r.powers,
      render: (r) => (
        <span className="mono breakdown">
          {meta.hasPower && <><span className="b-pwr">{r.powers}</span>/</>}
          <span className="b-get">{r.gets}</span>/<span className="b-neg">{r.incorrect}</span>
        </span>
      ),
      title: "Powers / Correct / Incorrect",
    },
    { key: "clue", label: "Contested clue", sortVal: (r) => r.hot.toLowerCase(), render: (r) => <ClueSnippet r={r} /> },
    { key: "answer", label: "Answer", sortVal: (r) => r.id, render: (r) => <Link className="link answer-cell" to={`/set/${slug}/tossup/${r.id}`}><Html html={primaryAnswer(r.answer)} /></Link> },
    { key: "category", label: "Category", sortVal: (r) => r.category, render: (r) => <CategoryTag cat={r.category} /> },
    { key: "rn", label: "Rd/#", sortVal: (r) => r.round * 100 + r.num, render: (r) => <Link className="mono link" to={`/set/${slug}/tossup/${r.id}`}>{roundLabel(r.round)}-{r.num}</Link> },
    { key: "through", label: "% Through", align: "right", sortVal: (r) => r.pctThrough, render: (r) => `${num(r.pctThrough)}%` },
  ];

  return (
    <div>
      <PageHeader title="Buzzer Races">
        <RoundFilter rounds={meta.rounds} value={round} onChange={setRound} />
        <label className="filter">
          Min buzzes:{" "}
          <input className="num-input" type="number" min={0} value={minBuzz === 0 ? "" : minBuzz} placeholder="0" onChange={(e) => setMinBuzz(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label className="filter">
          % through:{" "}
          <input className="num-input narrow" type="number" min={0} max={100} value={minPct} placeholder="min" onChange={(e) => setMinPct(e.target.value === "" ? "" : Number(e.target.value))} />
          {" – "}
          <input className="num-input narrow" type="number" min={0} max={100} value={maxPct} placeholder="max" onChange={(e) => setMaxPct(e.target.value === "" ? "" : Number(e.target.value))} />
        </label>
        <SearchInput value={q} onChange={setQ} placeholder="Search clue / category" />
      </PageHeader>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={rows} columns={columns} initialSort="buzzes" initialDir="desc" rowKey={(r) => r.id} />}
    </div>
  );
}
