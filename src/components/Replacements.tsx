import { useEffect, useState } from "react";
import { clearSetCache, refreshIndex } from "../data";
import { byLabel, roundLabel } from "../util";

// Owner tool for tiebreakers and replacement questions the packets don't
// contain. A game file records only which number a room read ("round 7, tossup
// 22", or bonus 22), so when the packet stops at 20 those buzzes and bonus
// results have no question to land on. Each such question is listed here with
// what the games recorded on it, and the owner picks the
// question that was actually read — from a tiebreaker packet uploaded on its
// own round, or any other packet — for the whole round, or game by game where
// rooms read different questions under the same number. See
// api/_lib/replacements.ts.

type Kind = "tossups" | "bonuses";
interface Target { editionId: string; round: number; num: number }
interface Rule { kind?: Kind; editionId: string; round: number; num: number; game: string | null; target: Target; by?: string; at?: string }
interface MissingBuzz { player: string | null; team: string | null; word: number | null; value: number | null }
interface MissingGame { key: string; teams: string[]; buzzes: MissingBuzz[]; bonuses: { team: string | null; parts: number[] }[] }
interface Missing { kind: Kind; editionId: string; round: number; num: number; packetCount: number; games: MissingGame[]; suggested: Target | null }
// A packet question: a tossup carries its length, a bonus its part count.
interface Candidate { num: number; answer: string; words?: number; parts?: number }
interface EditionCands { id: string; label: string; packets: { round: number; played: boolean; tossups: Candidate[]; bonuses: Candidate[] }[] }
interface Data { replacements: Rule[]; missing: Missing[]; editions: EditionCands[] }

const groupKey = (m: Missing) => `${m.kind}|${m.editionId}|${m.round}|${m.num}`;
const ruleKey = (r: Rule) => `${r.kind ?? "tossups"}|${r.editionId}|${r.round}|${r.num}|${r.game ?? "*"}`;
const noun = (k: Kind | undefined) => (k === "bonuses" ? "bonus" : "tossup");
const tval = (t: Target) => `${t.editionId}|${t.round}|${t.num}`;
const parseT = (v: string): Target | null => {
  const [editionId, round, num] = v.split("|");
  return v ? { editionId, round: Number(round), num: Number(num) } : null;
};
const maxWord = (games: MissingGame[]) =>
  Math.max(0, ...games.flatMap((g) => g.buzzes.map((b) => b.word ?? 0)));
const maxParts = (games: MissingGame[]) =>
  Math.max(0, ...games.flatMap((g) => g.bonuses.map((b) => b.parts.length)));
const pts = (v: number | null) => (v == null ? "?" : v > 0 ? `+${v}` : String(v));

export function ReplacementEditor({ slug }: { slug: string }) {
  const [data, setData] = useState<Data | null>(null);
  // Picked question per missing tossup (groupKey) or per game (groupKey|gameKey).
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [perGame, setPerGame] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/manage?slug=${encodeURIComponent(slug)}&op=replacements`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `Failed (${r.status})`); return d as Data; })
      .then(setData)
      .catch((e) => setErr(String(e.message || e)));
  }, [slug]);

  if (err && !data) return <div className="error-box">{err}</div>;
  if (!data) return <p className="muted">Checking the games against the packets…</p>;

  const edLabel = (id: string) => data.editions.find((e) => e.id === id)?.label || id;
  const multi = data.editions.length > 1;
  const answerOf = (kind: Kind, t: Target) =>
    data.editions.find((e) => e.id === t.editionId)?.packets.find((p) => p.round === t.round)?.[kind].find((c) => c.num === t.num);
  const describe = (kind: Kind, t: Target) => {
    const c = answerOf(kind, t);
    return `${multi ? `${edLabel(t.editionId)} ` : ""}round ${roundLabel(t.round)} ${noun(kind)} #${t.num}${c ? `: ${c.answer}` : ""}`;
  };
  const picked = (k: string, m: Missing) => choice[k] ?? (m.suggested ? tval(m.suggested) : "");

  // Everything the owner has chosen, as rules for the server.
  const rules = (): Omit<Rule, "by" | "at">[] => {
    const out: Omit<Rule, "by" | "at">[] = [];
    for (const m of data.missing) {
      const gk = groupKey(m);
      if (perGame[gk]) {
        for (const g of m.games) {
          const t = parseT(picked(`${gk}|${g.key}`, m));
          if (t) out.push({ kind: m.kind, editionId: m.editionId, round: m.round, num: m.num, game: g.key, target: t });
        }
      } else {
        const t = parseT(picked(gk, m));
        if (t) out.push({ kind: m.kind, editionId: m.editionId, round: m.round, num: m.num, game: null, target: t });
      }
    }
    return out;
  };

  async function send(body: { set?: unknown[]; remove?: string[] }) {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, op: "replacements", ...body }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
      clearSetCache(slug);
      refreshIndex();
      window.location.reload();
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  }

  // The question list for one missing question: its own edition first, and
  // within it the packets nobody played from (the likely tiebreakers) first.
  // `games` are the games this choice covers, to rule out questions that can't
  // be the one read — too short for a buzz on it, or too few parts.
  function picker(m: Missing, k: string, games: MissingGame[]) {
    const v = picked(k, m);
    const t = parseT(v);
    const words = maxWord(games), parts = maxParts(games);
    const misfit = (c: Candidate | undefined) =>
      !c ? "" : m.kind === "tossups" ? ((c.words ?? Infinity) < words ? "shorter than a buzz on it" : "")
        : (c.parts ?? Infinity) < parts ? `only ${c.parts} part${c.parts === 1 ? "" : "s"}` : "";
    const bad = t ? misfit(answerOf(m.kind, t)) : "";
    const eds = [...data!.editions].sort((a, b) => Number(b.id === m.editionId) - Number(a.id === m.editionId));
    return (
      <span className="repl-pick">
        <select value={v} disabled={busy} onChange={(e) => setChoice((c) => ({ ...c, [k]: e.target.value }))}>
          <option value="">— not mapped —</option>
          {eds.flatMap((e) =>
            [...e.packets].sort((a, b) => Number(a.played) - Number(b.played) || a.round - b.round).map((p) => (
              <optgroup key={`${e.id}|${p.round}`}
                label={`${multi ? `${e.label} · ` : ""}Round ${roundLabel(p.round)}${p.played ? "" : " — no games (tiebreakers?)"}`}>
                {p[m.kind].map((c) => {
                  const mf = misfit(c);
                  return (
                    <option key={c.num} value={tval({ editionId: e.id, round: p.round, num: c.num })}>
                      #{c.num} — {c.answer} ({m.kind === "tossups" ? `${c.words} words` : `${c.parts} parts`}{mf ? `, ${mf}` : ""})
                    </option>
                  );
                })}
              </optgroup>
            ))
          )}
        </select>
        {m.suggested && v === tval(m.suggested) && choice[k] === undefined && <span className="muted"> suggested</span>}
        {bad && (
          <span className="danger">
            {m.kind === "tossups"
              ? ` — a buzz came at word ${words}, past the end of this question`
              : ` — the games recorded ${parts} parts, but this bonus has ${bad.replace(/^only /, "")}`}
          </span>
        )}
      </span>
    );
  }

  const resultLine = (kind: Kind, g: MissingGame) =>
    kind === "bonuses"
      ? g.bonuses.map((b) => `${b.team ?? "?"}: ${b.parts.join("/")} (${b.parts.reduce((a, x) => a + x, 0)})`).join("; ") || "no result"
      : g.buzzes.length
        ? g.buzzes.map((b) => `${b.player ?? "?"}${b.team ? ` (${b.team})` : ""} ${pts(b.value)}${b.word != null ? ` @ word ${b.word}` : ""}`).join("; ")
        : "no buzzes";

  const pending = rules();
  // Tossups first, then bonuses, as the server sends them; mirrors grouped by name.
  const missing = [...data.missing].sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "tossups" ? -1 : 1)
    || (multi ? edLabel(a.editionId).localeCompare(edLabel(b.editionId)) || a.round - b.round || a.num - b.num : 0));

  return (
    <div className="srcfiles">
      {err && <div className="error-box">{err}</div>}
      {!missing.length && (
        <p className="muted">Every question the games read is in the packets — nothing to map.</p>
      )}
      {missing.length > 0 && (
        <>
          <table className="data-table srcfiles-table repl-table">
            <thead>
              <tr><th>Read as</th><th>Games and results</th><th>Question that was read</th></tr>
            </thead>
            <tbody>
              {missing.map((m) => {
                const gk = groupKey(m);
                const split = !!perGame[gk];
                return (
                  <tr key={gk}>
                    <td>
                      {multi && <div className="muted">{edLabel(m.editionId)}</div>}
                      Round {roundLabel(m.round)}, {noun(m.kind)} #{m.num}
                      <div className="muted">packet has {m.packetCount}</div>
                    </td>
                    <td>
                      {m.games.map((g) => (
                        <div key={g.key} className="repl-game">
                          <strong>{g.teams.join(" vs ") || "(unnamed game)"}</strong>
                          <div className="muted">{resultLine(m.kind, g)}</div>
                          {split && picker(m, `${gk}|${g.key}`, [g])}
                        </div>
                      ))}
                    </td>
                    <td>
                      {!split && picker(m, gk, m.games)}
                      {m.games.length > 1 && (
                        <label className="muted repl-split">
                          <input type="checkbox" checked={split} disabled={busy}
                            onChange={(e) => setPerGame((p) => ({ ...p, [gk]: e.target.checked }))} />{" "}
                          rooms read different questions as #{m.num}
                        </label>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            <button className="btn-primary btn-sm" disabled={busy || !pending.length} onClick={() => send({ set: pending })}>
              {busy ? "Saving…" : `Save ${pending.length} mapping${pending.length === 1 ? "" : "s"}`}
            </button>
          </p>
        </>
      )}

      {data.replacements.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>Mapped questions</h3>
          <ul className="repl-done">
            {byLabel(data.replacements.map((r) => ({ ...r, label: `${r.kind === "bonuses" ? 1 : 0}|${edLabel(r.editionId)}|${String(r.round).padStart(4, "0")}|${String(r.num).padStart(3, "0")}` }))).map((r) => (
              <li key={ruleKey(r)}>
                {multi && `${edLabel(r.editionId)} · `}Round {roundLabel(r.round)} {noun(r.kind)} #{r.num}
                {r.game ? ` in ${r.game.slice(r.game.indexOf(":") + 1).split(" | ").join(" vs ")}` : " (every game)"} → {describe(r.kind ?? "tossups", r.target)}{" "}
                <button className="btn-link danger" disabled={busy} onClick={() => send({ remove: [ruleKey(r)] })}>Undo</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
