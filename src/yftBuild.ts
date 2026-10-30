// Build a YellowFruit 4 tournament file (.yft) from a set's box scores
// (games.json), for tournaments that never had one uploaded. The shape copies
// what YellowFruit 4.0 itself saves: a QBJ Tournament with YfData extensions,
// teams and players referenced by id, one answer_count per answer type.
import { loadSetJson } from "./data";
import { scopedPath } from "./components/Layout";
import type { GameRow, GameTeamLine, TagSummary } from "./types";

// Answer values per scoring format, highest first (as YellowFruit lists them).
export const ANSWER_VALUES: Record<string, number[]> = {
  ACF: [10, -5],
  mACF: [15, 10, -5],
  PACE: [20, 10],
  SUPERPOWER: [20, 15, 10, -5],
};

export interface YftOptions {
  slug: string;
  scope: string;           // "all", an edition id, or "tag:<slug>"
  name: string;            // tournament name
  scoring: string;         // ScoringId
  hasBonuses: boolean;
  tags?: TagSummary[];     // phases, if the owner has tagged rounds
  editionId?: string;      // which mirror's rounds the phases apply to
  date?: string;           // YYYY-MM-DD
}

// Split a player's game line into per-value counts. Super-power lumps 20s and
// 15s together as powers, so the split is solved back out of the points.
export function counts(values: number[], line: { powers: number; gets: number; incorrect: number; pts: number }): Map<number, number> {
  const m = new Map<number, number>(values.map((v) => [v, 0]));
  const neg = values.find((v) => v < 0);
  const posPowers = values.filter((v) => v > 10);
  if (neg !== undefined) m.set(neg, line.incorrect);
  m.set(10, line.gets);
  if (posPowers.length === 1) m.set(posPowers[0], line.powers);
  else if (posPowers.length === 2) {
    const [hi, lo] = posPowers;
    const rest = line.pts - 10 * line.gets - (neg ?? 0) * line.incorrect - lo * line.powers;
    const nHi = Math.min(line.powers, Math.max(0, Math.round(rest / (hi - lo))));
    m.set(hi, nHi);
    m.set(lo, line.powers - nHi);
  }
  return m;
}

export const mode = (xs: number[]) => {
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 20;
};

// Phases: the owner's round tags (for this mirror), in the order their first
// round was played; untagged rounds go to a leading "Prelims".
export function phasesOf(games: GameRow[], tagList?: TagSummary[], editionId?: string) {
  const roundsOf = (t: TagSummary) => (editionId && t.editionRounds ? t.editionRounds[editionId] ?? [] : t.rounds);
  const tags = (tagList ?? []).filter((t) => roundsOf(t).length).sort((a, b) => Math.min(...roundsOf(a)) - Math.min(...roundsOf(b)));
  const phaseOfRound = new Map<number, string>();
  for (const t of tags) for (const r of roundsOf(t)) if (!phaseOfRound.has(r)) phaseOfRound.set(r, t.name);
  const phaseNames: string[] = [];
  const byPhase = new Map<string, GameRow[]>();
  for (const g of [...games].sort((a, b) => a.round - b.round)) {
    const ph = phaseOfRound.get(g.round) ?? "Prelims";
    if (!byPhase.has(ph)) { byPhase.set(ph, []); phaseNames.push(ph); }
    byPhase.get(ph)!.push(g);
  }
  return { phaseNames, byPhase };
}

export async function buildYft(o: YftOptions): Promise<string> {
  const games = await loadSetJson<GameRow[]>(o.slug, scopedPath(o.scope, "games.json"));
  if (!games?.length) throw new Error("No games to export. Try Settings → Rebuild stats first.");
  if (!games.some((g) => g.teams.length === 2)) throw new Error("YellowFruit only records two-team games, and this tournament has none.");
  const values = ANSWER_VALUES[o.scoring] ?? ANSWER_VALUES.PACE;
  const atId = (v: number) => `AnswerType_${v}`;
  const answerTypes = values.map((v) => ({ value: v, id: atId(v) }));
  const answerCounts = (m: Map<number, number>) => values.map((v) => ({ number: m.get(v) || 0, answer_type: { $ref: atId(v) } }));

  // Registrations: every team seen, with every player who appeared for it.
  const rosters = new Map<string, Set<string>>();
  for (const g of games)
    for (const t of g.teams) {
      let s = rosters.get(t.name);
      if (!s) rosters.set(t.name, (s = new Set()));
      for (const p of t.players) s.add(p.name);
    }
  const teamNames = [...rosters.keys()].sort((a, b) => a.localeCompare(b));
  const teamRef = (t: string) => `Team_${t}`;
  const playerRef = new Map<string, string>();
  let pn = 1000;
  const registrations = teamNames.map((t) => ({
    YfData: { isSmallSchool: false },
    name: t,
    teams: [{
      YfData: { letter: "", isJV: false, isUG: false, isD2: false },
      name: t,
      players: [...rosters.get(t)!].sort((a, b) => a.localeCompare(b)).map((p) => {
        const id = `Player_${p}_${pn++}`;
        playerRef.set(`${t}\u0000${p}`, id);
        return { YfData: { yearString: "", isUG: false, isD2: false }, name: p, id };
      }),
      ranks: [{ ranking: { $ref: "Ranking_Overall" } }],
      id: teamRef(t),
    }],
  }));

  const { phaseNames, byPhase } = phasesOf(games, o.tags, o.editionId);

  const regTuh = mode(games.map((g) => g.tuh).filter((n) => n > 0));
  const maxTuh = Math.max(regTuh, ...games.map((g) => g.tuh));
  const timed = maxTuh > regTuh;
  let mn = 1000;
  const matchTeam = (g: GameRow, t: GameTeamLine) => {
    const correct = t.powers + t.gets;
    return {
      YfData: { overTimeBuzzes: answerCounts(new Map()), validation: [] },
      team: { $ref: teamRef(t.name) },
      points: t.score,
      ...(o.hasBonuses ? { bonus_points: t.bonusPts } : {}),
      forfeit_loss: false,
      correct_tossups_without_bonuses: o.hasBonuses ? Math.max(0, correct - t.bonusesHeard) : 0,
      match_players: t.players.map((p) => ({
        player: { $ref: playerRef.get(`${t.name}\u0000${p.name}`)! },
        // 0 means the source didn't say; credit the whole game rather than none.
        tossups_heard: p.tuh || g.tuh,
        answer_counts: answerCounts(counts(values, p)),
      })),
    };
  };

  const phases = phaseNames.map((ph, i) => {
    const pg = byPhase.get(ph)!;
    const inPhase = [...new Set(pg.flatMap((g) => g.teams.map((t) => t.name)))].sort((a, b) => a.localeCompare(b));
    const rounds = [...new Set(pg.map((g) => g.round))].map((r) => ({
      YfData: { number: r },
      name: String(r),
      matches: pg.filter((g) => g.round === r && g.teams.length === 2).map((g) => ({
        YfData: { otherValidation: [] },
        tiebreaker: false,
        id: `Match_${mn++}`,
        tossups_read: g.tuh,
        match_teams: g.teams.map((t) => matchTeam(g, t)),
        carryover_phases: [],
      })),
    }));
    return {
      YfData: { phaseType: i === 0 ? "Prelim" : "Playoff", code: String(i + 1), wildCardAdvancementRules: [], wildCardRankingMethod: "RankThenPPB" },
      name: ph,
      pools: [{
        YfData: { size: inPhase.length, roundRobins: i === 0 ? 1 : 0, seeds: [], hasCarryover: false, autoAdvanceRules: [] },
        name: ph,
        position: 1,
        pool_teams: inPhase.map((t) => ({ YfData: { didNotAdvance: false }, team: { $ref: teamRef(t) } })),
      }],
      rounds,
      id: `Phase_${ph}`,
    };
  });

  const maxPlayers = Math.max(4, ...games.flatMap((g) => g.teams.map((t) => t.players.length)));
  const root = {
    YfData: {
      YfVersion: "4.0.18",
      seeds: teamNames.map((t) => ({ $ref: teamRef(t) })),
      trackPlayerYear: false, trackSmallSchool: false, trackJV: false, trackUG: false, trackDiv2: false,
      finalRankingsReady: false, usingScheduleTemplate: false,
    },
    name: o.name,
    registrations,
    phases,
    rankings: [{ name: "Overall", id: "Ranking_Overall" }],
    type: "Tournament",
    tournament_site: { name: "" },
    scoring_rules: {
      YfData: { timed },
      name: "",
      maximum_players_per_team: maxPlayers,
      maximum_regulation_tossup_count: maxTuh,
      minimum_overtime_question_count: 1,
      overtime_includes_bonuses: false,
      total_divisor: 5,
      lightning_count_per_team: 0,
      // YellowFruit reads "has bonuses" from whether this field is present at all.
      ...(o.hasBonuses ? { maximum_bonus_score: 30, minimum_parts_per_bonus: 3, maximum_parts_per_bonus: 3, bonus_divisor: 10 } : {}),
      answer_types: answerTypes,
    },
    ...(o.date ? { start_date: `${o.date}T12:00:00.000Z` } : {}),
    question_set: o.name,
  };
  return JSON.stringify({ version: "2.1.1", objects: [root] });
}
