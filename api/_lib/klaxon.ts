// Klaxon full buzz logs: one room's (`klaxon-fullbuzz-1`, from its buzz panel)
// or a whole tournament's (`klaxon-tournament-buzzpoints-1`, every room, each
// press tagged with its room). A QBJ records only the buzz that got the floor; Klaxon also logs
// every press behind it — the player who knew it too and lost the race by 40 ms,
// or pressed while the winner was answering. These stats are kept apart from
// everything the QBJs produce and live in their own file (klaxon.json).
//
// How a log lines up with the QBJs:
//   - A room runs many games, one after another. The log is cut into games where
//     the round label changes or the tossup number jumps back to the start.
//   - Within a game, `question` is MODAQ's tossup number (the QBJ's
//     match_question.question_number), and each buzzer reset starts a new
//     `cycleNo`. A tossup with a neg and a rebound has two cycles, and cycle i's
//     winner is the QBJ's buzz i on that tossup. Cycles the moderator cleared
//     without ruling (accidental buzzes) never reach the QBJ and are dropped.
//   - Each game is matched to the QBJ game whose buzzes agree with it most:
//     the same teams, and the same winner on the most cycles.

import type { GameFile } from "./aggregate.js";

export interface KlaxonRawBuzz {
  room?: string; at?: number; t?: number; cycleNo?: number; playerId?: string; name?: string; team?: string | null;
  modaqPlayer?: string | null; round?: string | number | null; question?: number | null;
  accepted?: boolean; reason?: string | null; accidental?: boolean; order?: number | null; msAfterFirst?: number | null;
}
export interface KlaxonLog { format?: string; room?: string; tournament?: string; rooms?: string[]; name?: string; exportedAt?: number; buzzes?: KlaxonRawBuzz[] }
const FORMATS = new Set(["klaxon-fullbuzz-1", "klaxon-tournament-buzzpoints-1"]);

// One press in a cycle. `ms` is how far behind the cycle's first press it was;
// `late` means it came after the room had locked (the winner was answering).
export interface KlaxonPress { name: string; team: string | null; ms: number | null; late: boolean }
// One buzzer cycle as stored on a game: who got the floor, and everyone else.
export interface KlaxonCycle { winner: string; winnerTeam: string | null; others: KlaxonPress[] }
export interface GameKlaxon { room: string; file: string; questions: Record<string, KlaxonCycle[]> }
export type KlaxonGame = GameFile & { klaxon?: GameKlaxon };

// A press within this long of the winner is a buzzer race; anything slower is
// someone who also knew it, but wasn't racing for it.
export const RACE_MS = 1000;

export const normName = (s: string | null | undefined) =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseKlaxonLog(raw: unknown): KlaxonLog {
  const d = raw as KlaxonLog;
  if (!d || typeof d !== "object" || !Array.isArray(d.buzzes))
    throw new Error("Not a Klaxon buzz log (expected a Klaxon full buzz or tournament buzz points file).");
  if (d.format && !FORMATS.has(d.format)) throw new Error(`Unsupported Klaxon format "${d.format}".`);
  return d;
}

export interface KlaxonSegment {
  index: number;
  room: string;
  round: string | null;
  teams: string[];
  questions: Record<string, KlaxonCycle[]>;
  cycles: number;
  firstAt: number | null;
}

// A game never pauses this long between presses; a gap like it is a different
// sitting (a test the day before, a game resumed after a break) under the same
// round label.
const GAP_MS = 30 * 60 * 1000;

// Cut a log into games — per room, since cycle numbers and tossup numbers are
// each room's own — and turn each game into cycles per tossup.
export function segmentLog(log: KlaxonLog): KlaxonSegment[] {
  const byRoom = new Map<string, KlaxonRawBuzz[]>();
  for (const b of log.buzzes || []) {
    if (!b || b.question == null || Number(b.question) < 1 || b.cycleNo == null) continue;
    const room = String(b.room ?? log.room ?? "");
    let arr = byRoom.get(room); if (!arr) { arr = []; byRoom.set(room, arr); }
    arr.push(b);
  }
  const groups: { room: string; list: KlaxonRawBuzz[] }[] = [];
  for (const [room, list] of [...byRoom.entries()].sort()) {
    list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    let cur: KlaxonRawBuzz[] = [];
    let curRound: string | null = null, lastQ = 0, lastAt = 0;
    for (const b of list) {
      const round = b.round == null ? null : String(b.round);
      const q = Number(b.question);
      const at = b.at ?? 0;
      const newGame = cur.length > 0 && (round !== curRound || q < lastQ - 2 || (q <= 2 && lastQ >= 6) || at - lastAt > GAP_MS);
      if (newGame) { groups.push({ room, list: cur }); cur = []; lastQ = 0; }
      cur.push(b); curRound = round; lastQ = Math.max(q, lastQ); lastAt = at;
    }
    if (cur.length) groups.push({ room, list: cur });
  }

  return groups.map(({ room, list }, index) => {
    const byQ = new Map<number, Map<number, KlaxonRawBuzz[]>>();
    for (const b of list) {
      const q = Number(b.question);
      let cyc = byQ.get(q); if (!cyc) { cyc = new Map(); byQ.set(q, cyc); }
      const c = Number(b.cycleNo);
      let arr = cyc.get(c); if (!arr) { arr = []; cyc.set(c, arr); }
      arr.push(b);
    }
    const questions: Record<string, KlaxonCycle[]> = {};
    let cycles = 0;
    for (const [q, cyc] of [...byQ.entries()].sort((a, b) => a[0] - b[0])) {
      const out: KlaxonCycle[] = [];
      for (const [, presses] of [...cyc.entries()].sort((a, b) => a[0] - b[0])) {
        const accepted = presses.filter((p) => p.accepted).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || (a.t ?? 0) - (b.t ?? 0));
        const win = accepted[0];
        // No floor (nobody accepted), or the moderator cleared it as accidental:
        // the QBJ has no buzz for it.
        if (!win || win.accidental) continue;
        const who = (p: KlaxonRawBuzz) => p.modaqPlayer || p.name || "";
        const seen = new Set([p0key(win)]);
        const others: KlaxonPress[] = [];
        // Accepted presses first (they were in the window), then the late ones,
        // each player once. "queued"/"duplicate" are repeat presses by someone
        // already counted.
        for (const p of [...accepted.slice(1), ...presses.filter((x) => !x.accepted && x.reason === "locked").sort((a, b) => (a.t ?? 0) - (b.t ?? 0))]) {
          const k = p0key(p);
          if (seen.has(k) || p.accidental) continue;
          seen.add(k);
          const ms = p.msAfterFirst ?? (win.t != null && p.t != null ? Math.max(0, Math.round(p.t - win.t)) : null);
          others.push({ name: who(p), team: p.team ?? null, ms, late: !p.accepted });
        }
        out.push({ winner: who(win), winnerTeam: win.team ?? null, others });
      }
      if (out.length) { questions[String(q)] = out; cycles += out.length; }
    }
    const teams = [...new Set(list.map((b) => b.team).filter(Boolean) as string[])].sort();
    return { index, room, round: list[0]?.round == null ? null : String(list[0].round), teams, questions, cycles, firstAt: list[0]?.at ?? null };
  });
}
const p0key = (p: KlaxonRawBuzz) => p.playerId || `${p.team ?? ""}|${p.modaqPlayer || p.name || ""}`;

export interface GameRef { editionId: string; editionLabel: string; index: number; game: GameFile }
export interface SegmentMatch {
  segment: number; room: string; round: string | null; teams: string[]; cycles: number;
  match: { editionId: string; editionLabel: string; index: number; round: number; teams: string[]; agree: number } | null;
  reason?: string;
}

const gameTeams = (g: GameFile) => (g.match_teams || []).map((t) => t.team?.name).filter(Boolean) as string[];

// How many of a segment's cycles name the same winner as this game's QBJ.
function agreement(seg: KlaxonSegment, g: GameFile): number {
  let n = 0;
  const byNum = new Map<number, NonNullable<GameFile["match_questions"]>[number]>();
  (g.match_questions || []).forEach((mq, i) => byNum.set(Number((mq as { question_number?: number }).question_number ?? i + 1), mq));
  for (const [q, cycles] of Object.entries(seg.questions)) {
    const mq = byNum.get(Number(q));
    if (!mq) continue;
    cycles.forEach((c, i) => {
      const bz = (mq.buzzes || [])[i];
      if (bz && normName(bz.player?.name) && normName(bz.player?.name) === normName(c.winner)) n++;
    });
  }
  return n;
}

export function matchSegments(segments: KlaxonSegment[], games: GameRef[]): SegmentMatch[] {
  return segments.map((seg) => {
    const segTeams = new Set(seg.teams.map(normName));
    const roundNum = seg.round && /\d+/.test(seg.round) ? Number(seg.round.match(/\d+/)![0]) : null;
    let best: { ref: GameRef; agree: number; roundHit: boolean } | null = null;
    let tie = false;
    for (const ref of games) {
      const tn = new Set(gameTeams(ref.game).map(normName));
      // Every team that buzzed in the room has to be one of this game's.
      if (segTeams.size && [...segTeams].some((t) => !tn.has(t))) continue;
      const agree = agreement(seg, ref.game);
      if (!agree) continue;
      const roundHit = roundNum !== null && ref.game.round === roundNum;
      if (!best || agree > best.agree || (agree === best.agree && roundHit && !best.roundHit)) { best = { ref, agree, roundHit }; tie = false; }
      else if (agree === best.agree && roundHit === best.roundHit) tie = true;
    }
    const base = { segment: seg.index, room: seg.room, round: seg.round, teams: seg.teams, cycles: seg.cycles };
    if (!seg.cycles) return { ...base, match: null, reason: "No buzzes on a tossup." };
    if (!best) return { ...base, match: null, reason: "No game here has these teams with the same buzzes." };
    // Most cycles should agree; a handful of winners can differ where the
    // moderator corrected a buzz in MODAQ after the fact.
    if (best.agree < Math.max(2, Math.ceil(seg.cycles * 0.5)))
      return { ...base, match: null, reason: `Best game agrees on only ${best.agree} of ${seg.cycles} buzzes.` };
    if (tie) return { ...base, match: null, reason: "Matches more than one game equally well." };
    return {
      ...base,
      match: { editionId: best.ref.editionId, editionLabel: best.ref.editionLabel, index: best.ref.index, round: best.ref.game.round, teams: gameTeams(best.ref.game), agree: best.agree },
    };
  });
}

/* ----------------------------- stats (klaxon.json) ----------------------------- */

// One cycle, after the stats build has paired it with its QBJ buzz: the word and
// value come from the QBJ, the presses behind it from Klaxon.
export interface KlaxonRaceRec {
  key: string; round: number; num: number; editionId?: string;
  word: number | null; value: number; rebound: boolean;
  winner: string | null; team: string | null;
  others: { player: string; team: string | null; ms: number | null; late: boolean }[];
}

interface PlayerAcc {
  name: string; team: string;
  won: number; lost: number; marginsLost: number[]; marginsWon: number[]; wordsLost: number[];
  lostToCorrect: number; alsoKnew: number; lostTo: Map<string, number>;
}

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);

export function klaxonFile(
  races: KlaxonRaceRec[],
  ctx: { games: number; tossups: Map<string, { answer: string; category: string; wordCount: number }>; playerId: (name: string, team: string) => string | undefined; teamId: (team: string) => string | undefined }
): Record<string, unknown> {
  const pl = new Map<string, PlayerAcc>();
  const of = (name: string, team: string | null) => {
    const k = `${team ?? ""}\u0001${name}`;
    let v = pl.get(k);
    if (!v) { v = { name, team: team ?? "", won: 0, lost: 0, marginsLost: [], marginsWon: [], wordsLost: [], lostToCorrect: 0, alsoKnew: 0, lostTo: new Map() }; pl.set(k, v); }
    return v;
  };
  const raceRows: Record<string, unknown>[] = [];
  let cyclesWithRace = 0;
  for (const r of races) {
    if (!r.winner) continue;
    const rivals = r.others.filter((o) => o.team !== r.team);
    const racing = rivals.filter((o) => o.ms !== null && o.ms <= RACE_MS);
    if (racing.length) {
      cyclesWithRace++;
      const w = of(r.winner, r.team);
      w.won++;
      w.marginsWon.push(Math.min(...racing.map((o) => o.ms!)));
    }
    for (const o of rivals) {
      const p = of(o.player, o.team);
      if (o.ms !== null && o.ms <= RACE_MS) {
        p.lost++;
        p.marginsLost.push(o.ms);
        if (r.word !== null) p.wordsLost.push(r.word);
        if (r.value > 0) p.lostToCorrect++;
        const wk = `${r.winner}${r.team ? ` (${r.team})` : ""}`;
        p.lostTo.set(wk, (p.lostTo.get(wk) || 0) + 1);
      } else p.alsoKnew++;
    }
    const t = ctx.tossups.get(r.key);
    raceRows.push({
      id: r.key, round: r.round, num: r.num, ...(r.editionId ? { editionId: r.editionId } : {}),
      word: r.word, pct: r.word !== null && t?.wordCount ? Math.round((100 * r.word) / t.wordCount) : null,
      value: r.value, rebound: r.rebound,
      winner: r.winner, team: r.team, winnerId: ctx.playerId(r.winner, r.team ?? ""),
      others: r.others.map((o) => ({ ...o, id: ctx.playerId(o.player, o.team ?? ""), sameTeam: o.team === r.team })),
      answer: t?.answer ?? "", category: t?.category ?? "",
    });
  }
  const players = [...pl.values()].map((p) => ({
    id: ctx.playerId(p.name, p.team), name: p.name, team: p.team, teamId: ctx.teamId(p.team),
    races: p.won + p.lost, won: p.won, lost: p.lost,
    winPct: p.won + p.lost ? Math.round((1000 * p.won) / (p.won + p.lost)) / 10 : null,
    medianLostBy: median(p.marginsLost), medianWonBy: median(p.marginsWon),
    avgWordLost: avg(p.wordsLost), lostToCorrect: p.lostToCorrect, alsoKnew: p.alsoKnew,
    lostTo: [...p.lostTo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n })),
  })).sort((a, b) => b.races - a.races || a.name.localeCompare(b.name));
  return {
    raceMs: RACE_MS,
    games: ctx.games,
    cycles: races.length,
    racedCycles: cyclesWithRace,
    races: raceRows.filter((r) => (r.others as unknown[]).length > 0),
    players,
  };
}
