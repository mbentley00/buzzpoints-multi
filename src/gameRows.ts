import type { GameRow } from "./types";

// Older games.json files leave a player's tossups heard at 0 when the file
// didn't say. A player who buzzed must have played (credit the whole game);
// one who never buzzed and heard nothing sat out, so drop them.
export function resolveHeard(games: GameRow[]): GameRow[] {
  return games.map((g) => ({
    ...g,
    teams: g.teams.map((t) => ({
      ...t,
      players: t.players
        .map((p) => (p.tuh ? p : p.powers + p.gets + p.incorrect > 0 ? { ...p, tuh: g.tuh } : p))
        .filter((p) => p.tuh > 0),
    })),
  }));
}
