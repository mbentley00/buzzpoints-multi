import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { FirstSentenceTossup, Buzz } from "../types";
import { CategoryTag, Html, roundLabel } from "../util";
import { PageHeader, Loading, ErrorBox, RoundFilter, SearchInput } from "../components/Common";

function valueClass(v: number): string {
  if (v > 10) return "buzz-power";
  if (v > 0) return "buzz-get";
  return "buzz-neg";
}
function valueLabel(v: number): string {
  if (v > 10) return "Power";
  if (v > 0) return "Correct";
  return v < 0 ? "Neg" : "0";
}

function Sentence({ words, buzzers }: { words: string[]; buzzers: Buzz[] }) {
  const byIndex = new Map<number, Buzz[]>();
  for (const b of buzzers) {
    if (b.wordIndex === null) continue;
    const arr = byIndex.get(b.wordIndex) ?? [];
    arr.push(b);
    byIndex.set(b.wordIndex, arr);
  }
  return (
    <p className="fs-sentence">
      {words.map((w, i) => {
        const bz = byIndex.get(i);
        return (
          <span key={i}>
            {w}{" "}
            {bz && bz.map((b, j) => (
              <span key={j} className={`buzz-dot ${valueClass(b.value)}`} title={`${b.player} (${b.team}) — ${valueLabel(b.value)}`} />
            ))}
          </span>
        );
      })}
      <span className="fs-ellipsis"> …</span>
    </p>
  );
}

export function FirstSentence() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<FirstSentenceTossup[]>("first_sentence.json");
  const [round, setRound] = useState<number | "all">("all");
  const [q, setQ] = useState("");
  const [minBuzz, setMinBuzz] = useState(0);
  const [correctOnly, setCorrectOnly] = useState(false);

  const rows = useMemo(() => {
    let r = data ?? [];
    // "Correct only": drop the incorrect (neg) buzzes, recount, and hide any
    // tossup whose only first-sentence buzzes were negs.
    if (correctOnly) {
      r = r
        .map((x) => {
          const buzzers = x.buzzers.filter((b) => b.value > 0);
          return { ...x, buzzers, buzzCount: buzzers.length, incorrect: 0 };
        })
        .filter((x) => x.buzzCount > 0);
    }
    if (round !== "all") r = r.filter((x) => x.round === round);
    if (minBuzz > 0) r = r.filter((x) => x.buzzCount >= minBuzz);
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((x) => x.sentenceWords.join(" ").toLowerCase().includes(n) || x.category.toLowerCase().includes(n) || x.buzzers.some((b) => b.player.toLowerCase().includes(n) || b.team.toLowerCase().includes(n)));
    }
    return r;
  }, [data, round, q, minBuzz, correctOnly]);

  const totalBuzzes = rows.reduce((a, x) => a + x.buzzCount, 0);

  return (
    <div>
      <PageHeader title="First-Sentence Buzzes" subtitle={`${rows.length} tossups · ${totalBuzzes} buzzes landed on the opening sentence`}>
        <RoundFilter rounds={meta.rounds} value={round} onChange={setRound} />
        <label className="filter">
          Min buzzes:{" "}
          <input className="num-input" type="number" min={0} value={minBuzz === 0 ? "" : minBuzz} placeholder="0" onChange={(e) => setMinBuzz(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label className="filter">
          <input type="checkbox" checked={correctOnly} onChange={(e) => setCorrectOnly(e.target.checked)} /> Correct only
        </label>
        <SearchInput value={q} onChange={setQ} placeholder="Search clue / player / team" />
      </PageHeader>
      <p className="explainer">
        Every tossup where at least one team buzzed during the <strong>first sentence</strong> — the deepest,
        fastest knowledge in the set. Sorted by how many teams got there.
      </p>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      <div className="fs-list">
        {rows.map((x) => (
          <div className="fs-card" key={x.id}>
            <div className="fs-card-head">
              <Link to={`/set/${slug}/tossup/${x.id}`} className="link answer-cell"><Html html={x.answer} /></Link>
              <div className="fs-head-right">
                <CategoryTag cat={x.category} />
                <Link to={`/set/${slug}/tossup/${x.id}`} className="mono link">{roundLabel(x.round)}-{x.num}</Link>
                <span className="fs-count" title="First-sentence buzzes">
                  {x.buzzCount}{" "}
                  <span className="mono breakdown">
                    ({meta.hasPower && <><span className="b-pwr">{x.powers}</span>/</>}
                    <span className="b-get">{x.gets}</span>/<span className="b-neg">{x.incorrect}</span>)
                  </span>
                </span>
              </div>
            </div>
            <Sentence words={x.sentenceWords} buzzers={x.buzzers} />
            <div className="fs-buzzers">
              {x.buzzers.map((b, i) => (
                <span key={i} className={`fs-buzzer ${valueClass(b.value)}`} title={valueLabel(b.value)}>
                  <span className="fs-dot" />
                  {b.player} <span className="muted">· {b.team}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
        {rows.length === 0 && !loading && <p className="empty">No matching tossups.</p>}
      </div>
    </div>
  );
}
