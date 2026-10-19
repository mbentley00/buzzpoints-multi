import { Link } from "react-router-dom";
import { useSetJson } from "../data";
import { KlaxonFile, KlaxonRace, fmtMs, isRace, setKlaxonOn, useKlaxonOn } from "../klaxon";
import { Html, primaryAnswer, roundLabel } from "../util";

// Klaxon sections on the player and tossup pages. Each is marked as Klaxon data,
// sits below the regular stats, and has a Hide link that turns Klaxon off
// everywhere for this viewer.

function KlaxonHead({ title, slug }: { title: string; slug: string }) {
  return (
    <div className="kx-head">
      <h2>{title} <span className="kx-tag">Klaxon</span></h2>
      <span className="muted kx-head-links">
        <Link className="link" to={`/set/${slug}/klaxon`}>All races</Link> ·{" "}
        <button type="button" className="btn-link" onClick={() => setKlaxonOn(false)}>Hide Klaxon stats</button>
      </span>
    </div>
  );
}

export function Others({ r, raceMs, slug }: { r: KlaxonRace; raceMs: number; slug: string }) {
  return (
    <span className="kx-others">
      {r.others.map((o, i) => (
        <span key={i} className={isRace(o, raceMs) ? "kx-race" : "muted"} title={o.sameTeam ? "Teammate" : o.late ? "Pressed after the buzzer locked" : "Pressed inside the reconcile window"}>
          {o.id ? <Link className="link" to={`/set/${slug}/player/${o.id}`}>{o.player}</Link> : o.player}
          {" "}+{fmtMs(o.ms)}{o.sameTeam ? " (teammate)" : ""}{i < r.others.length - 1 ? ", " : ""}
        </span>
      ))}
    </span>
  );
}

const fileFor = (scope: string) => (!scope || scope === "all" ? "klaxon.json" : scope.startsWith("tag:") ? `tags/${scope.slice(4)}/klaxon.json` : `editions/${scope}/klaxon.json`);

export function KlaxonPlayerPanel({ slug, scope, playerId, show }: { slug: string; scope: string; playerId: string; show: boolean }) {
  const on = useKlaxonOn();
  const { data } = useSetJson<KlaxonFile>(slug, show && on ? fileFor(scope) : "", 0);
  if (!show || !on || !data) return null;
  const p = data.players.find((x) => x.id === playerId);
  const mine = data.races.filter((r) => r.winnerId === playerId || r.others.some((o) => o.id === playerId));
  if (!p && !mine.length) return null;
  const lostRows = mine.filter((r) => r.others.some((o) => o.id === playerId && isRace(o, data.raceMs)));
  return (
    <section className="kx-panel">
      <KlaxonHead title="Buzzer races" slug={slug} />
      {p && (
        <p className="kx-record">
          <strong>{p.won}–{p.lost}</strong> in races decided by under {fmtMs(data.raceMs)}
          {p.winPct !== null && <> ({p.winPct}% won)</>}
          {p.medianLostBy !== null && <> · lost by a median {fmtMs(p.medianLostBy)}</>}
          {p.avgWordLost !== null && <> · at word {p.avgWordLost} on average</>}
          {p.alsoKnew > 0 && <> · pressed late {p.alsoKnew} more time{p.alsoKnew === 1 ? "" : "s"}</>}
          {p.lostTo.length > 0 && <> · most often beaten by {p.lostTo.slice(0, 3).map((x) => `${x.name} (${x.n})`).join(", ")}</>}
        </p>
      )}
      {lostRows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Rd/#</th><th>Answer</th><th>Beaten by</th><th className="right">Word</th><th className="right">By</th></tr></thead>
            <tbody>
              {lostRows.map((r, i) => {
                const me = r.others.find((o) => o.id === playerId)!;
                return (
                  <tr key={i}>
                    <td className="mono"><Link className="link" to={`/set/${slug}/tossup/${r.id}`}>{roundLabel(r.round)}-{r.num}</Link></td>
                    <td><Link className="link answer-cell" to={`/set/${slug}/tossup/${r.id}`}><Html html={primaryAnswer(r.answer)} /></Link></td>
                    <td>{r.winnerId ? <Link className="link" to={`/set/${slug}/player/${r.winnerId}`}>{r.winner}</Link> : r.winner}{r.value < 0 && <span className="muted"> (negged)</span>}</td>
                    <td className="right mono">{r.word !== null ? r.word + 1 : "—"}</td>
                    <td className="right mono">{fmtMs(me.ms)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function KlaxonTossupPanel({ slug, version, tossupId, show }: { slug: string; version: string; tossupId: string; show: boolean }) {
  const on = useKlaxonOn();
  const { data } = useSetJson<KlaxonFile>(slug, show && on ? fileFor(version) : "", 0);
  if (!show || !on || !data) return null;
  const rows = data.races.filter((r) => r.id === tossupId);
  if (!rows.length) return null;
  return (
    <section className="kx-panel">
      <KlaxonHead title="Presses behind each buzz" slug={slug} />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Buzz</th><th className="right">Word</th><th>Also pressed</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.winnerId ? <Link className="link" to={`/set/${slug}/player/${r.winnerId}`}>{r.winner}</Link> : r.winner} <span className="muted">({r.value}{r.rebound ? ", rebound" : ""})</span></td>
                <td className="right mono">{r.word !== null ? r.word + 1 : "—"}</td>
                <td><Others r={r} raceMs={data.raceMs} slug={slug} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
