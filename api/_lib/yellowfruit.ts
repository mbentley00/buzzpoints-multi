// YellowFruit / QBJ tournament parser.
//
// YellowFruit (.yft) and QBJ (.qbj) files describe a tournament as registrations
// (teams + players), phases -> rounds -> matches, and scoring rules. Crucially,
// the match data is BOX-SCORE ONLY: per team we get points + bonus points, and
// per player we get tossups_heard plus aggregate answer_counts (how many of each
// answer value they got). There are NO per-question buzzes and NO word-level buzz
// positions, so this feeds the "results" tournament type, not the buzz pages.
//
// Both formats reference objects by id via { "$ref": "<id>" }. We resolve those
// against the registration + answer_type definitions to get plain names/values.

export interface YfPlayerLine {
  name: string;
  tossupsHeard: number;
  counts: Record<number, number>; // answer value -> count (e.g. {15: 3, 10: 3, -5: 0})
}
export interface YfTeamLine {
  team: string;
  points: number;
  bonusPoints: number;
  correctWithoutBonus: number;
  players: YfPlayerLine[];
}
export interface YfMatch {
  phase: string;
  round: number;
  tossupsRead: number;
  tiebreaker: boolean;
  teams: YfTeamLine[];
}
export interface YfTournament {
  name: string;
  scoringId: string;          // mapped ScoringId
  answerValues: number[];     // distinct answer values, descending
  hasBonuses: boolean;        // any bonus points recorded
  teams: { name: string; players: string[] }[];
  matches: YfMatch[];
}

export class YfParseError extends Error {}

const refOf = (o: any): string | null => (o && typeof o === "object" && typeof o.$ref === "string" ? o.$ref : null);

// Pick the tournament root object. YF/QBJ wrap it as { version, objects: [root] };
// occasionally the root is given directly.
function rootOf(raw: any): any {
  if (!raw || typeof raw !== "object") throw new YfParseError("File is not valid YellowFruit/QBJ JSON.");
  if (Array.isArray(raw.objects)) {
    const r = raw.objects.find((o: any) => o && (o.phases || o.registrations || o.type === "Tournament")) || raw.objects[0];
    if (!r) throw new YfParseError("No tournament object found in the file.");
    return r;
  }
  if (raw.phases || raw.registrations) return raw;
  throw new YfParseError("Unrecognized file shape — expected a YellowFruit (.yft) or QBJ (.qbj) tournament export.");
}

// Map the distinct answer values to one of the app's scoring formats.
export function yfScoringId(values: number[]): string {
  const set = new Set(values);
  const hasNeg = values.some((v) => v < 0);
  const maxPos = Math.max(0, ...values.filter((v) => v > 0));
  if (set.has(20) && set.has(15)) return "SUPERPOWER";
  if (set.has(20) && hasNeg) return "SUPERPOWER";
  if (set.has(20)) return "PACE";
  if (set.has(15) || maxPos === 15) return "mACF";
  if (maxPos === 10) return "ACF";
  return hasNeg ? "mACF" : "PACE";
}

export function parseYellowFruit(raw: any): YfTournament {
  const root = rootOf(raw);

  // answer_type id -> value
  const answerValue = new Map<string, number>();
  for (const a of root.scoring_rules?.answer_types || [])
    if (a?.id != null && typeof a.value === "number") answerValue.set(a.id, a.value);
  const answerValues = [...new Set(answerValue.values())].sort((a, b) => b - a);

  // registrations: resolve team + player ids to names
  const teamName = new Map<string, string>();
  const playerName = new Map<string, string>();
  const teams: { name: string; players: string[] }[] = [];
  for (const reg of root.registrations || []) {
    for (const tm of reg.teams || []) {
      const tname = tm.name || refOf(tm) || "Unknown team";
      if (tm.id) teamName.set(tm.id, tname);
      const players: string[] = [];
      for (const p of tm.players || []) {
        const pname = p.name || "Unknown player";
        if (p.id) playerName.set(p.id, pname);
        players.push(pname);
      }
      teams.push({ name: tname, players });
    }
  }

  const resolveTeam = (o: any): string => {
    const r = refOf(o?.team ?? o);
    if (r) return teamName.get(r) ?? r.replace(/^Team_/, "");
    return o?.team?.name || o?.name || "Unknown team";
  };
  const resolvePlayer = (o: any): string => {
    const r = refOf(o?.player ?? o);
    if (r) return playerName.get(r) ?? r.replace(/^Player_/, "").replace(/_\d+$/, "");
    return o?.player?.name || o?.name || "Unknown player";
  };
  const valueOf = (ac: any): number | null => {
    const r = refOf(ac?.answer_type);
    if (r && answerValue.has(r)) return answerValue.get(r)!;
    if (typeof ac?.answer_type?.value === "number") return ac.answer_type.value;
    return null;
  };

  let hasBonuses = false;
  const matches: YfMatch[] = [];
  for (const ph of root.phases || []) {
    const phaseName = ph.name || ph.YfData?.code || "Phase";
    for (const rnd of ph.rounds || []) {
      const roundNum = rnd.YfData?.number ?? Number(String(rnd.name).match(/\d+/)?.[0] ?? 0);
      for (const m of rnd.matches || []) {
        const teamsLine: YfTeamLine[] = [];
        for (const mt of m.match_teams || []) {
          const bonusPoints = mt.bonus_points || 0;
          if (bonusPoints) hasBonuses = true;
          const players: YfPlayerLine[] = [];
          for (const mp of mt.match_players || []) {
            const counts: Record<number, number> = {};
            for (const ac of mp.answer_counts || []) {
              const v = valueOf(ac);
              if (v !== null) counts[v] = (counts[v] || 0) + (ac.number || 0);
            }
            players.push({ name: resolvePlayer(mp), tossupsHeard: mp.tossups_heard || 0, counts });
          }
          teamsLine.push({
            team: resolveTeam(mt),
            points: mt.points || 0,
            bonusPoints,
            correctWithoutBonus: mt.correct_tossups_without_bonuses || 0,
            players,
          });
        }
        if (teamsLine.length)
          matches.push({ phase: phaseName, round: roundNum, tossupsRead: m.tossups_read || 0, tiebreaker: !!m.tiebreaker, teams: teamsLine });
      }
    }
  }

  if (!teams.length) throw new YfParseError("No teams found in the file.");
  if (!matches.length) throw new YfParseError("No played matches found — this file has no game results to import.");

  return {
    name: root.name || root.tournament_site?.name || "Tournament",
    scoringId: yfScoringId(answerValues),
    answerValues,
    hasBonuses,
    teams,
    matches,
  };
}
