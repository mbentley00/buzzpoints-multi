// Rebuild a tournament's uploadable files from its stored source: the packet
// JSONs, the per-game QBJ (stats) files, and a roster QBJ MODAQ can load —
// zipped so an admin can hand a set back in the form it was (or could have
// been) uploaded in. Everything is derived from `_source.json`, which the
// admin backup endpoint already serves; corrections and renames deliberately
// stay out, since MODAQ and the stats tools expect the raw files.
import { zipFiles } from "./zip";
import { roundLabel } from "./util";

interface SourcePacket { round: number; tossups?: any[]; bonuses?: any[] }
interface SourceGame { round?: number; _round?: number; editionId?: string; match_teams?: any[]; [k: string]: any }
interface SourceEdition { id: string; label?: string; packets?: SourcePacket[]; games?: SourceGame[] }
export interface SetSourceLike {
  name?: string;
  editions?: SourceEdition[];
  // legacy single-edition sources kept packets/games at the top level
  packets?: SourcePacket[];
  games?: SourceGame[];
}

const enc = new TextEncoder();
const json = (o: unknown) => enc.encode(JSON.stringify(o, null, 2));
// Filesystem-safe fragment of a team/edition name; never empty.
const safe = (s: string, fallback: string) =>
  (s || "").replace(/[^A-Za-z0-9 _.-]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || fallback;
// "Round_05" / "Round_A" — the same shapes roundFromName() parses on upload,
// so a re-upload of this export lands every file on its original round.
const roundName = (r: number) => {
  const l = roundLabel(r);
  return `Round_${/^\d+$/.test(l) ? l.padStart(2, "0") : l}`;
};

// A MODAQ/QBJ packet: exactly the fields the format defines, nothing Buzzpoints
// bolted on (imported sets carry pre-aggregated `stats` on bonuses, for one).
function packetJson(p: SourcePacket): Uint8Array {
  const pick = (o: any, keys: string[]) => {
    const out: any = {};
    for (const k of keys) if (o?.[k] !== undefined) out[k] = o[k];
    return out;
  };
  return json({
    tossups: (p.tossups || []).filter(Boolean).map((t) => pick(t, ["question", "answer", "metadata"])),
    bonuses: (p.bonuses || []).filter(Boolean).map((b) => pick(b, ["leadin", "parts", "answers", "values", "difficultyModifiers", "metadata"])),
  });
}

// The stored game IS the uploaded QBJ match, plus the round/edition bookkeeping
// Buzzpoints added — strip that and the original file is back.
function gameJson(g: SourceGame): Uint8Array {
  const { round, _round, editionId, ...rest } = g;
  return json(rest);
}

const teamNamesOf = (g: SourceGame): string[] =>
  (g.match_teams || []).map((mt: any) => mt?.team?.name).filter((n: any): n is string => typeof n === "string" && !!n);

// A roster ("tournament") QBJ in the shape MODAQ loads: registrations, each
// carrying its teams and players. Buzzpoints never knew the school behind a
// team, so each team is its own registration. Players are the union of the
// edition's lineups (match_players) and any roster the games carried.
function rosterJson(name: string, games: SourceGame[]): Uint8Array {
  const teams = new Map<string, Set<string>>();
  for (const g of games)
    for (const mt of g.match_teams || []) {
      const tname = mt?.team?.name;
      if (typeof tname !== "string" || !tname) continue;
      let players = teams.get(tname);
      if (!players) { players = new Set(); teams.set(tname, players); }
      for (const p of mt?.team?.players || []) if (p?.name) players.add(String(p.name));
      for (const mp of mt?.match_players || []) if (mp?.player?.name) players.add(String(mp.player.name));
    }
  return json({
    name,
    registrations: [...teams.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([tname, players]) => ({
        name: tname,
        teams: [{ name: tname, players: [...players].sort().map((p) => ({ name: p })) }],
      })),
  });
}

// Build the archive. Multi-edition sets get one folder per mirror; a
// single-edition set keeps everything at the top level.
export async function buildModaqExport(source: SetSourceLike, slug: string): Promise<Blob> {
  const editions: SourceEdition[] =
    source.editions?.length ? source.editions : [{ id: "e0", label: "Original", packets: source.packets, games: source.games }];
  const multi = editions.length > 1;
  const usedDirs = new Set<string>();
  const entries: { name: string; data: Uint8Array }[] = [];

  for (const ed of editions) {
    let dir = "";
    if (multi) {
      let d = safe(ed.label || ed.id, ed.id);
      if (usedDirs.has(d)) d = `${d}_${ed.id}`; // two mirrors, same label
      usedDirs.add(d);
      dir = `${d}/`;
    }
    for (const p of ed.packets || [])
      entries.push({ name: `${dir}packets/${roundName(p.round)}.json`, data: packetJson(p) });

    // One QBJ per game; a round can hold several, so the teams name the file.
    const perRound = new Map<string, number>();
    for (const g of ed.games || []) {
      const r = g.round ?? g._round ?? 0;
      const [a, b] = teamNamesOf(g);
      let base = `${roundName(r)}_${safe(a || "TeamA", "TeamA")}_vs_${safe(b || "TeamB", "TeamB")}`;
      const n = (perRound.get(base) || 0) + 1;
      perRound.set(base, n);
      if (n > 1) base += `_${n}`; // same pairing twice in a round (e.g. replayed)
      entries.push({ name: `${dir}games/${base}.qbj`, data: gameJson(g) });
    }

    const label = multi ? `${source.name || slug} — ${ed.label || ed.id}` : source.name || slug;
    entries.push({ name: `${dir}roster.qbj`, data: rosterJson(label, ed.games || []) });
  }
  return zipFiles(entries);
}
