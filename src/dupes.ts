// Likely duplicate teams and players. Hand-entered scoresheets (MODAQ games
// typed in by a moderator, say) spell the same team or person a little
// differently from room to room, and each spelling becomes its own row. This
// finds the pairs worth a look; the owner decides, and a merge is an ordinary
// rename.
//
// Two rules keep it from suggesting the impossible: two teams that played each
// other, or both played in the same round of the same edition, are different
// teams; two players who both appeared in one game are different people.

import { fold } from "./util";

export interface DupeGameTeam { name: string; players?: { name: string }[] }
export interface DupeGame { round: number; editionId?: string; teams: DupeGameTeam[] }
export interface DupeTeam { name: string; games: number }
export interface DupePlayer { name: string; team: string; games: number }

export interface TeamPair { a: DupeTeam; b: DupeTeam; why: string }
export interface PlayerPair { a: DupePlayer; b: DupePlayer; team: string; why: string }

const norm = (s: string) => fold((s || "").toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();

// The words that carry a team's identity, without the filler that varies from
// sheet to sheet ("Team 5 / Ryan et. al" and "Ryan et al." are both {ryan}).
const FILLER = new Set(["team", "the", "and", "of", "for", "et", "al", "a", "an"]);
const coreWords = (s: string) => norm(s).split(" ").filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w));

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Why two team names look like the same team, or null.
function teamNameMatch(x: string, y: string): string | null {
  const a = coreWords(x), b = coreWords(y);
  if (!a.length || !b.length) return null;
  const ja = a.join(" "), jb = b.join(" ");
  if (ja === jb) return "same name once filler is ignored";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // One name is the start of the other: "Pouring monstrous" / "Pouring monstrous moonshine…".
  if (short.every((w, i) => long[i] === w)) return "one name is the start of the other";
  // Every word of the shorter name appears in the longer: "Jaiden" / "Dan and Geoff and Jaiden".
  if (short.every((w) => long.includes(w))) return "one name is contained in the other";
  if (Math.min(ja.length, jb.length) >= 6 && editDistance(ja, jb) <= 2) return "near-identical spelling";
  return null;
}

// Why two player names look like the same person, or null.
function playerNameMatch(x: string, y: string): string | null {
  const a = norm(x), b = norm(y);
  if (!a || !b) return null;
  if (a === b) return "same name apart from case or punctuation";
  const pa = a.split(" "), pb = b.split(" ");
  // A first name alone next to a full name: "Stan" / "Stan Melkumian".
  if ((pa.length === 1 && pb.length > 1 && pb[0] === pa[0]) || (pb.length === 1 && pa.length > 1 && pa[0] === pb[0])) return "first name only on one sheet";
  // Same surname, and one first name is the start of the other: "Dan Ni" / "Daniel Ni".
  if (pa.length > 1 && pb.length > 1 && pa[pa.length - 1] === pb[pb.length - 1] && (pa[0].startsWith(pb[0]) || pb[0].startsWith(pa[0]))) return "short form of the first name";
  // A typo: "Rosenburg" / "Rosenberg".
  if (Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= 2) return "near-identical spelling";
  return null;
}

export function findDuplicates(teams: DupeTeam[], players: DupePlayer[], games: DupeGame[]): { teams: TeamPair[]; players: PlayerPair[] } {
  // Where each team played, and whom it played.
  const slots = new Map<string, Set<string>>();
  const met = new Set<string>();
  const shared = new Map<string, Set<string>>(); // players seen together in one game, per team
  const key2 = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const g of games) {
    const names = g.teams.map((t) => t.name);
    for (const t of g.teams) {
      // Round 0 means the file never said, so it can't show two teams overlapped.
      if (g.round > 0) {
        let s = slots.get(t.name); if (!s) { s = new Set(); slots.set(t.name, s); }
        s.add(`${g.editionId ?? ""}|${g.round}`);
      }
      const ps = (t.players || []).map((p) => p.name);
      let sh = shared.get(t.name); if (!sh) { sh = new Set(); shared.set(t.name, sh); }
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) sh.add(key2(ps[i], ps[j]));
    }
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) met.add(key2(names[i], names[j]));
  }
  const clash = (x: string, y: string) => {
    if (met.has(key2(x, y))) return true;
    const sx = slots.get(x), sy = slots.get(y);
    if (!sx || !sy) return false;
    for (const s of sx) if (sy.has(s)) return true;
    return false;
  };

  const rosterOf = new Map<string, DupePlayer[]>();
  for (const p of players) { const r = rosterOf.get(p.team) || []; r.push(p); rosterOf.set(p.team, r); }

  const teamPairs: TeamPair[] = [];
  for (let i = 0; i < teams.length; i++)
    for (let j = i + 1; j < teams.length; j++) {
      const a = teams[i], b = teams[j];
      if (clash(a.name, b.name)) continue;
      let why = teamNameMatch(a.name, b.name);
      if (!why) {
        // Different names, but the same person turns up on both.
        const ra = rosterOf.get(a.name) || [], rb = rosterOf.get(b.name) || [];
        const same = ra.find((p) => rb.some((q) => playerNameMatch(p.name, q.name)));
        if (same) why = `${same.name} played for both`;
      }
      if (why) teamPairs.push(a.games >= b.games ? { a, b, why } : { a: b, b: a, why });
    }

  const playerPairs: PlayerPair[] = [];
  for (const [team, roster] of rosterOf) {
    const together = shared.get(team) || new Set<string>();
    for (let i = 0; i < roster.length; i++)
      for (let j = i + 1; j < roster.length; j++) {
        const a = roster[i], b = roster[j];
        if (together.has(key2(a.name, b.name))) continue;
        const why = playerNameMatch(a.name, b.name);
        if (!why) continue;
        // Keep the fuller name by default, then the one with more games.
        const aFirst = a.name.length !== b.name.length ? a.name.length > b.name.length : a.games >= b.games;
        playerPairs.push(aFirst ? { a, b, team, why } : { a: b, b: a, team, why });
      }
  }
  return { teams: teamPairs, players: playerPairs };
}
