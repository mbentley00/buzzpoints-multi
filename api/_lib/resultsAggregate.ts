// Aggregate a parsed YellowFruit/QBJ tournament (box-score data) into the stat
// files the "results" tournament pages render. No buzz/question data exists here,
// so this produces standings, per-team and per-player totals, and per-game box
// scores — the standard quiz-bowl report set.
import { Scoring, classify } from "./scoring.js";
import { YfTournament, YfMatch } from "./yellowfruit.js";

// A buzz-style correction. YellowFruit has no per-question buzzes, so the finest
// correctable unit is "one scoring event": in match `matchKey`, player `fromPlayer`
// (on `fromTeam`) recorded an answer worth `fromValue`. The correction reassigns
// it to another player and/or changes its value, or removes it entirely. Team
// points are recomputed from the resulting answer counts (+ bonus points), so the
// fix flows through every stat and the re-exported .yft.
export interface ResultsCorrection {
  matchKey: string;
  fromPlayer: string;
  fromTeam: string;
  fromValue: number;
  toPlayer?: string;
  toTeam?: string;
  toValue?: number;
  remove?: boolean;
  by?: string;
  at?: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const matchKeyOf = (m: YfMatch) =>
  `${m.phase}|${m.round}|${m.teams.map((t) => t.team).slice().sort().join("|")}`;

// Return a corrections-applied deep copy of the tournament's matches. Each
// correction decrements the original (player, value) event and, unless removed,
// increments the target (player, value) — adding a player line if the reassigned
// player didn't otherwise appear in that game.
export function applyCorrections(yf: YfTournament, corrections: ResultsCorrection[]): YfMatch[] {
  if (!corrections.length) return yf.matches;
  const byKey = new Map<string, ResultsCorrection[]>();
  for (const c of corrections) {
    const arr = byKey.get(c.matchKey) || [];
    arr.push(c);
    byKey.set(c.matchKey, arr);
  }
  return yf.matches.map((m) => {
    const cs = byKey.get(matchKeyOf(m));
    if (!cs) return m;
    // deep clone the teams/players/counts we may mutate
    const teams = m.teams.map((t) => ({ ...t, players: t.players.map((p) => ({ ...p, counts: { ...p.counts } })) }));
    const findTeam = (name: string) => teams.find((t) => t.team === name);
    const findOrAddPlayer = (teamName: string, playerName: string) => {
      const t = findTeam(teamName);
      if (!t) return null;
      let p = t.players.find((p) => p.name === playerName);
      if (!p) { p = { name: playerName, tossupsHeard: 0, counts: {} }; t.players.push(p); }
      return p;
    };
    for (const c of cs) {
      const from = findOrAddPlayer(c.fromTeam, c.fromPlayer);
      if (!from) continue;
      from.counts[c.fromValue] = (from.counts[c.fromValue] || 0) - 1;
      if (from.counts[c.fromValue] <= 0) delete from.counts[c.fromValue];
      if (c.remove) continue;
      const toTeam = c.toTeam || c.fromTeam;
      const toPlayer = c.toPlayer || c.fromPlayer;
      const toValue = c.toValue ?? c.fromValue;
      const to = findOrAddPlayer(toTeam, toPlayer);
      if (to) to.counts[toValue] = (to.counts[toValue] || 0) + 1;
    }
    return { ...m, teams };
  });
}

export function aggregateResults(
  yf: YfTournament,
  scoring: Scoring,
  corrections: ResultsCorrection[] = []
): Record<string, unknown> {
  const matches = applyCorrections(yf, corrections);
  const tierOf = (v: number) => classify(v, scoring);

  type TM = {
    games: number; wins: number; losses: number; ties: number;
    pts: number; bonusPts: number; powers: number; gets: number; negs: number;
    tuh: number; correctWithoutBonus: number;
  };
  type PL = { name: string; team: string; games: number; tuh: number; powers: number; gets: number; negs: number; pts: number };
  const tm = new Map<string, TM>();
  const pl = new Map<string, PL>();
  const tmOf = (n: string): TM => {
    let v = tm.get(n);
    if (!v) { v = { games: 0, wins: 0, losses: 0, ties: 0, pts: 0, bonusPts: 0, powers: 0, gets: 0, negs: 0, tuh: 0, correctWithoutBonus: 0 }; tm.set(n, v); }
    return v;
  };
  const plKey = (name: string, team: string) => `${name}|||${team}`;
  const plOf = (name: string, team: string): PL => {
    const k = plKey(name, team);
    let v = pl.get(k);
    if (!v) { v = { name, team, games: 0, tuh: 0, powers: 0, gets: 0, negs: 0, pts: 0 }; pl.set(k, v); }
    return v;
  };

  // ensure every registered team/player appears even with no games
  for (const t of yf.teams) { tmOf(t.name); for (const p of t.players) plOf(p, t.name); }

  const games: Record<string, unknown>[] = [];

  for (const m of matches) {
    if (m.teams.length !== 2) continue;
    const teamPts: { name: string; points: number }[] = [];
    const gameTeams: Record<string, unknown>[] = [];

    for (const tl of m.teams) {
      const t = tmOf(tl.team);
      t.games += 1;
      t.bonusPts += tl.bonusPoints;
      t.correctWithoutBonus += tl.correctWithoutBonus;
      let teamTuPts = 0;
      const playerLines: Record<string, unknown>[] = [];
      for (const pl0 of tl.players) {
        const p = plOf(pl0.name, tl.team);
        if (pl0.tossupsHeard > 0) p.games += 1;
        p.tuh += pl0.tossupsHeard;
        t.tuh += pl0.tossupsHeard;
        let pPts = 0, pPow = 0, pGet = 0, pNeg = 0;
        for (const [vStr, n] of Object.entries(pl0.counts)) {
          const v = Number(vStr);
          const tier = tierOf(v);
          if (tier === "power") { pPow += n; } else if (tier === "get") { pGet += n; } else if (tier === "neg") { pNeg += n; }
          pPts += v * n;
        }
        p.powers += pPow; p.gets += pGet; p.negs += pNeg; p.pts += pPts;
        t.powers += pPow; t.gets += pGet; t.negs += pNeg;
        teamTuPts += pPts;
        playerLines.push({ name: pl0.name, tuh: pl0.tossupsHeard, powers: pPow, gets: pGet, negs: pNeg, pts: pPts });
      }
      const totalPts = teamTuPts + tl.bonusPoints;
      t.pts += totalPts;
      teamPts.push({ name: tl.team, points: totalPts });
      gameTeams.push({ team: tl.team, points: totalPts, bonusPoints: tl.bonusPoints, tuPts: teamTuPts, players: playerLines });
    }

    // win / loss / tie (tiebreaker games still affect points but not the record)
    if (!m.tiebreaker) {
      const [a, b] = teamPts;
      if (a.points > b.points) { tmOf(a.name).wins++; tmOf(b.name).losses++; }
      else if (b.points > a.points) { tmOf(b.name).wins++; tmOf(a.name).losses++; }
      else { tmOf(a.name).ties++; tmOf(b.name).ties++; }
    }

    games.push({ phase: m.phase, round: m.round, tiebreaker: m.tiebreaker, tossupsRead: m.tossupsRead, teams: gameTeams });
  }

  // ids
  const teamId = new Map<string, string>();
  [...tm.keys()].sort().forEach((n, i) => teamId.set(n, `t${i}`));

  const hasBonuses = yf.hasBonuses;
  const teams = [...tm.entries()].map(([name, s]) => {
    const decided = s.wins + s.losses + s.ties;
    const tuPts = s.pts - s.bonusPts;
    const bonusesHeard = Math.max(0, s.powers + s.gets - s.correctWithoutBonus);
    return {
      id: teamId.get(name)!, name, games: s.games,
      wins: s.wins, losses: s.losses, ties: s.ties,
      pct: decided ? round1((100 * (s.wins + 0.5 * s.ties)) / decided) / 100 : 0,
      pts: s.pts, tuPts, bonusPts: s.bonusPts, powers: s.powers, gets: s.gets, negs: s.negs, tuh: s.tuh,
      ppg: s.games ? round1(s.pts / s.games) : 0,
      pp20tuh: s.tuh ? round1((20 * tuPts) / s.tuh) : 0,
      bonusesHeard, ppb: hasBonuses && bonusesHeard ? round2(s.bonusPts / bonusesHeard) : null,
    };
  });
  teams.sort((a, b) => b.pct - a.pct || b.pp20tuh - a.pp20tuh || b.ppg - a.ppg);
  // dense ranks with ties marked
  teams.forEach((t, i) => {
    const prev = teams[i - 1] as any;
    (t as any).rank = i > 0 && prev.pct === t.pct && prev.pp20tuh === t.pp20tuh ? prev.rank : i + 1;
  });

  let pidx = 0;
  const players = [...pl.values()].map((s) => {
    const tuPts = s.pts; // player points are tossup points
    return {
      id: `p${pidx++}`, name: s.name, team: s.team, teamId: teamId.get(s.team) ?? null,
      games: s.games, tuh: s.tuh, powers: s.powers, gets: s.gets, negs: s.negs, pts: s.pts,
      ppg: s.games ? round1(s.pts / s.games) : 0,
      pp20tuh: s.tuh ? round1((20 * tuPts) / s.tuh) : 0,
      ptsPerTuh: s.tuh ? round2(s.pts / s.tuh) : 0,
    };
  });
  players.sort((a, b) => b.ppg - a.ppg || b.pts - a.pts);

  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const phases = [...new Set(matches.map((m) => m.phase))];

  return {
    "meta.json": {
      kind: "results",
      setName: yf.name, scoring: scoring.id, scoringLabel: scoring.label,
      hasPower: scoring.hasPower, hasNeg: scoring.hasNeg, hasBonuses,
      numGames: games.length, numTeams: tm.size, numPlayers: pl.size,
      rounds, phases, generatedAt: new Date().toISOString(),
    },
    "results_teams.json": teams,
    "results_players.json": players,
    "results_games.json": games,
  };
}
