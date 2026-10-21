import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { KlaxonFile, KlaxonPlayer, KlaxonRace, fmtMs, isRace, setKlaxonOn, useKlaxonOn } from "../klaxon";
import { Others } from "../components/KlaxonPanels";
import { CategoryTag, Html, num, primaryAnswer, roundLabel, searchable } from "../util";
import { DataTable, Column } from "../components/DataTable";
import { PageHeader, Loading, ErrorBox, SearchInput } from "../components/Common";

// Buzzer races from Klaxon full buzz logs: who else pressed on each buzz, and by
// how much they lost. Separate from the QBJ stats, and switchable off.
export function Klaxon() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const on = useKlaxonOn();
  const { data, error, loading } = useScopedJson<KlaxonFile>("klaxon.json");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"players" | "races">("players");
  const [onlyRaces, setOnlyRaces] = useState(true);

  const players = useMemo(() => {
    let r = (data?.players ?? []).filter((p) => p.races > 0 || p.alsoKnew > 0);
    if (q.trim()) { const n = searchable(q); r = r.filter((p) => searchable(p.name).includes(n) || searchable(p.team).includes(n)); }
    return r;
  }, [data, q]);
  const races = useMemo(() => {
    let r = data?.races ?? [];
    if (onlyRaces && data) r = r.filter((x) => x.others.some((o) => isRace(o, data.raceMs)));
    if (q.trim()) {
      const n = searchable(q);
      r = r.filter((x) => searchable(x.answer).includes(n) || searchable(x.winner ?? "").includes(n) || x.others.some((o) => searchable(o.player).includes(n)));
    }
    return r;
  }, [data, q, onlyRaces]);

  if (!meta.hasKlaxon) return <ErrorBox error="This tournament has no Klaxon buzz logs." />;
  if (!on)
    return (
      <div className="detail">
        <PageHeader title="Klaxon races" />
        <p className="muted">Klaxon stats are off.</p>
        <button className="btn-primary" onClick={() => setKlaxonOn(true)}>Show Klaxon stats</button>
      </div>
    );
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error || "No Klaxon data."} />;

  const raceMs = data.raceMs;
  const pcols: Column<KlaxonPlayer>[] = [
    { key: "name", label: "Player", sortVal: (p) => p.name.toLowerCase(), render: (p) => (p.id ? <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> : p.name) },
    ...(meta.individual ? [] : [{ key: "team", label: "Team", sortVal: (p: KlaxonPlayer) => p.team.toLowerCase(), render: (p: KlaxonPlayer) => (p.teamId ? <Link className="link" to={`/set/${slug}/team/${p.teamId}`}>{p.team}</Link> : p.team) }]),
    { key: "races", label: "Races", align: "right", sortVal: (p) => p.races, render: (p) => p.races, title: `Decided by under ${fmtMs(raceMs)}` },
    { key: "won", label: "Won", align: "right", sortVal: (p) => p.won, render: (p) => p.won },
    { key: "lost", label: "Lost", align: "right", sortVal: (p) => p.lost, render: (p) => p.lost },
    { key: "pct", label: "Win %", align: "right", sortVal: (p) => p.winPct ?? -1, render: (p) => (p.winPct === null ? "—" : `${num(p.winPct)}%`) },
    { key: "lostby", label: "Lost by", align: "right", sortVal: (p) => p.medianLostBy ?? 1e9, render: (p) => fmtMs(p.medianLostBy), title: "Median losing margin" },
    { key: "wonby", label: "Won by", align: "right", sortVal: (p) => p.medianWonBy ?? 1e9, render: (p) => fmtMs(p.medianWonBy), title: "Median winning margin" },
    { key: "word", label: "Word lost", align: "right", sortVal: (p) => p.avgWordLost ?? 1e9, render: (p) => (p.avgWordLost === null ? "—" : num(p.avgWordLost + 1)), title: "Avg word of lost races" },
    { key: "correct", label: "Lost to correct", align: "right", sortVal: (p) => p.lostToCorrect, render: (p) => p.lostToCorrect, title: "Lost to a correct buzz" },
    { key: "late", label: "Late presses", align: "right", sortVal: (p) => p.alsoKnew, render: (p) => p.alsoKnew, title: `Over ${fmtMs(raceMs)} after an opponent` },
  ];
  const rcols: Column<KlaxonRace>[] = [
    { key: "rn", label: "Rd/#", sortVal: (r) => r.round * 100 + r.num, render: (r) => <Link className="mono link" to={`/set/${slug}/tossup/${r.id}`}>{roundLabel(r.round)}-{r.num}</Link> },
    { key: "answer", label: "Answer", sortVal: (r) => r.answer, render: (r) => <Link className="link answer-cell" to={`/set/${slug}/tossup/${r.id}`}><Html html={primaryAnswer(r.answer)} /></Link> },
    { key: "cat", label: "Category", sortVal: (r) => r.category, render: (r) => <CategoryTag cat={r.category} /> },
    { key: "winner", label: "Buzz", sortVal: (r) => r.winner ?? "", render: (r) => <>{r.winnerId ? <Link className="link" to={`/set/${slug}/player/${r.winnerId}`}>{r.winner}</Link> : r.winner} <span className="muted">({r.value})</span></> },
    { key: "word", label: "Word", align: "right", sortVal: (r) => r.word ?? 1e9, render: (r) => (r.word === null ? "—" : `${r.word + 1}${r.pct !== null ? ` · ${r.pct}%` : ""}`) },
    { key: "margin", label: "Closest", align: "right", sortVal: (r) => Math.min(...r.others.filter((o) => !o.sameTeam).map((o) => o.ms ?? 1e9), 1e9), render: (r) => fmtMs(Math.min(...r.others.filter((o) => !o.sameTeam).map((o) => o.ms ?? 1e9), 1e9) >= 1e9 ? null : Math.min(...r.others.filter((o) => !o.sameTeam).map((o) => o.ms ?? 1e9))) },
    { key: "others", label: "Also pressed", sortVal: (r) => r.others.length, render: (r) => <Others r={r} raceMs={raceMs} slug={slug} /> },
  ];

  return (
    <div className="detail">
      <PageHeader title="Klaxon races" subtitle={<span className="kx-tag">Klaxon</span>} />
      <p className="muted kx-intro">
        {data.games} game{data.games === 1 ? "" : "s"}, {data.cycles} buzzes, {data.racedCycles} races under {fmtMs(raceMs)}.{" "}
        <button type="button" className="btn-link" onClick={() => setKlaxonOn(false)}>Hide Klaxon stats</button>
      </p>
      <div className="filter-bar">
        <div className="kx-seg">
          <button className={view === "players" ? "active" : ""} onClick={() => setView("players")}>Players</button>
          <button className={view === "races" ? "active" : ""} onClick={() => setView("races")}>Races</button>
        </div>
        <SearchInput value={q} onChange={setQ} placeholder={view === "players" ? "Search players or teams…" : "Search answers or players…"} />
        {view === "races" && (
          <label className="field-inline">
            <input type="checkbox" checked={onlyRaces} onChange={(e) => setOnlyRaces(e.target.checked)} /> Only races under {fmtMs(raceMs)}
          </label>
        )}
      </div>
      {view === "players"
        ? <DataTable rows={players} columns={pcols} initialSort="races" initialDir="desc" rowKey={(p) => `${p.team}|${p.name}`} />
        : <DataTable rows={races} columns={rcols} initialSort="margin" initialDir="asc" rowKey={(r, i) => `${r.id}-${i}`} />}
    </div>
  );
}
