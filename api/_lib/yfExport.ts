// Round-trip buzz corrections back into a raw YellowFruit (.yft) file. A buzz
// tournament's owner can upload the .yft they scored from; when they later
// reassign buzzes (the "stat corrections"), this shifts each moved tossup's point
// value between players' answer_counts in the matching YF match and recomputes
// team points, so they can re-import a corrected file into YellowFruit.
//
// Buzz values aren't stored on the correction itself, so they're looked up from
// the QBJ games. Word-index-only corrections don't change the box score and are
// ignored here.
import { GameFile, Correction } from "./aggregate.js";

const refOf = (o: any): string | null => (o && typeof o === "object" && typeof o.$ref === "string" ? o.$ref : null);

// Index every original buzz by the same key corrections use
// (round|num|team|player|wordIndex) -> its recorded value + the match's team set.
function buzzIndex(games: GameFile[]) {
  const m = new Map<string, { value: number; teams: string[] }>();
  for (const g of games) {
    const teams = [...((g.match_teams || []).map((t) => t.team?.name).filter(Boolean) as string[])].sort();
    for (const mq of g.match_questions || []) {
      const num = mq.tossup_question?.question_number;
      if (num == null) continue;
      for (const bz of mq.buzzes || []) {
        const player = bz.player?.name ?? null;
        const team = bz.team?.name ?? null;
        const widx = bz.buzz_position?.word_index ?? null;
        m.set(`${g.round}|${num}|${team}|${player}|${widx}`, { value: bz.result?.value ?? 0, teams });
      }
    }
  }
  return m;
}

export function applyBuzzCorrectionsToYf(raw: any, games: GameFile[], corrections: Correction[]): any {
  const clone = JSON.parse(JSON.stringify(raw));
  // Only reassignments / removals affect the box score (toPlayer set; null = removed).
  const moves = corrections.filter((c) => c.toPlayer !== undefined && c.toPlayer !== c.fromPlayer);
  if (!moves.length) return clone;
  const idx = buzzIndex(games);

  const croot = Array.isArray(clone?.objects) ? clone.objects[0] : clone;
  const valueById = new Map<string, number>();
  const idByValue = new Map<number, string>();
  for (const a of croot.scoring_rules?.answer_types || [])
    if (a?.id != null && typeof a.value === "number") { valueById.set(a.id, a.value); idByValue.set(a.value, a.id); }
  const teamName = new Map<string, string>();
  const playerName = new Map<string, string>();
  for (const reg of croot.registrations || [])
    for (const tm of reg.teams || []) {
      if (tm.id) teamName.set(tm.id, tm.name);
      for (const p of tm.players || []) if (p.id) playerName.set(p.id, p.name);
    }
  const resolveTeam = (mt: any) => { const r = refOf(mt.team); return r ? teamName.get(r) ?? r.replace(/^Team_/, "") : mt.team?.name; };
  const resolvePlayer = (mp: any) => { const r = refOf(mp.player); return r ? playerName.get(r) ?? r.replace(/^Player_/, "").replace(/_\d+$/, "") : mp.player?.name; };

  // Group the box-score adjustments by round|sortedTeamNames.
  type Adj = { fromTeam: string; fromPlayer: string; toPlayer: string | null; value: number };
  const byMatch = new Map<string, Adj[]>();
  for (const c of moves) {
    const info = idx.get(`${c.round}|${c.num}|${c.team}|${c.fromPlayer}|${c.fromWordIndex}`);
    if (!info) continue; // can't resolve the original buzz's value; skip
    const key = `${c.round}|${info.teams.join("|")}`;
    const list = byMatch.get(key) || [];
    list.push({ fromTeam: c.team, fromPlayer: c.fromPlayer || "", toPlayer: c.toPlayer ?? null, value: info.value });
    byMatch.set(key, list);
  }
  if (!byMatch.size) return clone;

  const bump = (mp: any, value: number, delta: number) => {
    const id = idByValue.get(value);
    if (id == null) return;
    let ac = (mp.answer_counts || []).find((x: any) => refOf(x.answer_type) === id || valueById.get(refOf(x.answer_type) || "") === value);
    if (!ac) { ac = { number: 0, answer_type: { $ref: id } }; (mp.answer_counts = mp.answer_counts || []).push(ac); }
    ac.number = Math.max(0, (ac.number || 0) + delta);
  };
  const findOrAddPlayer = (mt: any, name: string) => {
    let mp = (mt.match_players || []).find((x: any) => resolvePlayer(x) === name);
    if (!mp) { mp = { player: { name }, tossups_heard: 0, answer_counts: [] }; (mt.match_players = mt.match_players || []).push(mp); }
    return mp;
  };
  const recomputePoints = (mt: any) => {
    let tu = 0;
    for (const mp of mt.match_players || [])
      for (const ac of mp.answer_counts || []) {
        const v = valueById.get(refOf(ac.answer_type) || "");
        if (typeof v === "number") tu += v * (ac.number || 0);
      }
    mt.points = tu + (mt.bonus_points || 0);
  };

  for (const ph of croot.phases || [])
    for (const rnd of ph.rounds || [])
      for (const m of rnd.matches || []) {
        const roundNum = rnd.YfData?.number ?? Number(String(rnd.name).match(/\d+/)?.[0] ?? 0);
        const names = (m.match_teams || []).map(resolveTeam).filter(Boolean) as string[];
        const adjs = byMatch.get(`${roundNum}|${[...names].sort().join("|")}`);
        if (!adjs) continue;
        const touched = new Set<any>();
        for (const a of adjs) {
          const fromMt = (m.match_teams || []).find((mt: any) => resolveTeam(mt) === a.fromTeam);
          if (!fromMt) continue;
          bump(findOrAddPlayer(fromMt, a.fromPlayer), a.value, -1);
          touched.add(fromMt);
          if (a.toPlayer == null) continue; // removed, not reassigned
          // A buzz is reassigned within its own team (fixing which teammate buzzed).
          bump(findOrAddPlayer(fromMt, a.toPlayer), a.value, +1);
        }
        for (const mt of touched) recomputePoints(mt);
      }
  return clone;
}
