// Shared "create a new tournament" path, used both by direct ingest (established
// posters) and by approving a queued first-post submission. Keeps slug
// allocation, source storage, aggregation, and index insertion in one place.
import { PacketFile, GameFile } from "./aggregate.js";
import { SCORINGS } from "./scoring.js";
import {
  readIndex, writeIndex, writeSource, writeCorrections, writeRequests, readCorrections,
  aggregateAndWrite, SetSource, SetEntry, Visibility, writeYf, TOURNAMENT_LEVELS, isSetOwner, practiceVisibility, difficultiesFor,
} from "./sets.js";
import { parseYellowFruit } from "./yellowfruit.js";

// A file payload: either inline JSON (legacy / small uploads) or a reference to
// a blob the client uploaded directly (resolved to `json` before aggregation).
export interface FileRef { name: string; json?: any; pathname?: string; }
export interface CreateBody {
  name?: string; scoring?: string; hasBonuses?: boolean; individual?: boolean;
  packets?: FileRef[]; games?: FileRef[];
  visibility?: string; autoPublicAt?: string | null; edition?: string;
  yf?: any; // optional companion YellowFruit (.yft) for corrected re-export
  level?: string; tdLink?: string; // tournament type + optional Tournament Database link
  difficulty?: string; // question difficulty on the level's scale (see difficultiesFor)
}

// Validate the tournament level (required) and normalize an optional TD link.
export function validLevel(level: unknown): string {
  if (typeof level !== "string" || !(TOURNAMENT_LEVELS as readonly string[]).includes(level))
    throw new CreateError(400, "Choose a tournament type (high school, college, open, pop culture, or side event).");
  return level;
}
// The difficulty a set may carry: one of its level's options, or nothing. A
// level without a scale silently drops whatever was sent, so switching a set
// from college to a side event doesn't strand a "3.5" on it.
export function cleanDifficulty(level: string, d: unknown): string | undefined {
  const s = String(d ?? "").trim();
  if (!s) return undefined;
  const opts = difficultiesFor(level);
  if (!opts.length) return undefined;
  if (!opts.includes(s)) throw new CreateError(400, "Choose a difficulty from the list.");
  return s;
}
export function cleanTdLink(link: unknown): string | undefined {
  const s = String(link ?? "").trim();
  if (!s) return undefined;
  if (!/^https?:\/\/\S+$/i.test(s)) throw new CreateError(400, "The Tournament Database link must be a valid URL.");
  return s.slice(0, 500);
}

const VISIBILITIES = new Set<Visibility>(["public", "listed", "private"]);
// The visibility a payload will end up with, defaulting to "listed".
export const normVisibility = (v: unknown): Visibility =>
  VISIBILITIES.has(v as Visibility) ? (v as Visibility) : "listed";
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export const slugify = (s: string) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "set";
// Packets are normally "Round_09.json", but some tournaments letter them instead
// ("Round A"). A lettered round is numbered above LETTER_ROUND_BASE so it can't
// collide with a numbered one — a set can have numbered prelims and a lettered
// finals packet, and before this they all landed on round 0 and overwrote each
// other. roundLabel() in src/util.tsx turns them back into letters for display.
export const LETTER_ROUND_BASE = 1000;
export const roundFromName = (name: string) => {
  const m = (name || "").match(/(?:Round[_ ])?0*(\d+)(?:[_ .]|$)/i);
  if (m) return Number(m[1]);
  // Only after a keyword, so an arbitrary filename can't become round "T".
  const l = (name || "").match(/(?:round|rd|packet)[ _-]*([a-z])(?:[ _.)\-]|$)/i);
  return l ? LETTER_ROUND_BASE + (l[1].toUpperCase().charCodeAt(0) - 64) : null;
};

export function parseFiles(body: { packets?: FileRef[]; games?: FileRef[] }): { packets: PacketFile[]; games: GameFile[] } {
  const packets = (body.packets || []).map((p) => { const d = p.json || {}; return { round: roundFromName(p.name) ?? 0, tossups: d.tossups || [], bonuses: d.bonuses || [] }; });
  const games = (body.games || []).map((g) => { const d = g.json || {}; return { ...d, round: d._round ?? roundFromName(g.name) ?? 0 } as GameFile; });
  return { packets, games };
}

export class CreateError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

// Create and publish a new tournament owned by `owner`. Throws CreateError with
// an HTTP status on validation failure. Reads/writes the index internally.
export async function createTournament(body: CreateBody, owner: string): Promise<{ slug: string; categoryWarnings?: unknown[]; roundWarnings?: unknown[]; bonusDiffWarnings?: unknown[] }> {
  const name = (body.name || "").trim();
  if (!name) throw new CreateError(400, "Tournament name is required.");
  if (!body.scoring || !(body.scoring in SCORINGS)) throw new CreateError(400, "Unknown scoring format.");
  if (!body.packets?.length) throw new CreateError(400, "At least one packet is required.");
  if (!body.games?.length) throw new CreateError(400, "At least one game (QBJ) is required.");
  const level = validLevel(body.level);
  const tdLink = cleanTdLink(body.tdLink);
  const difficulty = cleanDifficulty(level, body.difficulty);

  const { packets, games } = parseFiles(body);
  const hasBonuses = !!body.hasBonuses;
  const individual = !!body.individual;
  const visibility = level === "practice" ? practiceVisibility(normVisibility(body.visibility)) : normVisibility(body.visibility);
  const createdAt = new Date().toISOString();
  let autoPublicAt: string | null = null;
  if (visibility !== "public" && level !== "practice") {
    if (body.autoPublicAt === null) autoPublicAt = null;
    else if (typeof body.autoPublicAt === "string" && !Number.isNaN(Date.parse(body.autoPublicAt))) autoPublicAt = new Date(body.autoPublicAt).toISOString();
    else autoPublicAt = new Date(Date.now() + TWO_YEARS_MS).toISOString();
  }

  const index = await readIndex();
  const taken = new Set(index.sets.map((s) => s.slug));
  let slug = slugify(name);
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  const label = (body.edition || "").trim() || "Original";
  const source: SetSource = { name, scoring: body.scoring!, hasBonuses, ...(individual ? { individual } : {}), editions: [{ id: "e0", label, packets, games }] };
  await writeSource(slug, source);
  await writeCorrections(slug, []);
  await writeRequests(slug, []);

  // Optional companion YellowFruit file: validate it parses, then store it so the
  // owner can later export a corrections-applied copy.
  let hasYf = false;
  if (body.yf) {
    try { parseYellowFruit(body.yf); }
    catch (e) { throw new CreateError(400, `YellowFruit file: ${(e as Error).message}`); }
    await writeYf(slug, body.yf);
    hasYf = true;
  }

  const { meta, editions } = await aggregateAndWrite(slug, source, []);

  const entry: SetEntry = {
    slug, name, scoring: body.scoring!, hasBonuses, ...(individual ? { individual } : {}), owner, editions, origin: "upload",
    visibility, invites: [], autoPublicAt, ...(hasYf ? { hasYf } : {}), level, ...(tdLink ? { tdLink } : {}), ...(difficulty ? { difficulty } : {}),
    numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
    numTossups: meta.numTossups, rounds: meta.rounds.length, createdAt,
  };
  await writeIndex({ sets: [entry, ...index.sets.filter((s) => s.slug !== slug)] });
  return {
    slug,
    categoryWarnings: (meta as any).categoryWarnings || [],
    roundWarnings: (meta as any).roundWarnings || [],
    bonusDiffWarnings: (meta as any).bonusDiffWarnings || [],
  };
}

// Refresh an EXISTING tournament in place from a freshly re-scraped source
// (used by the Buzzpoints re-import). Keeps the slug, owner, visibility, level,
// invites, TD link, and corrections; replaces the editions/packets/games and
// recomputes stats. Only the owner or an admin/moderator may refresh.
export async function updateFromSource(
  source: SetSource,
  slug: string,
  owner: string,
  isPrivileged: boolean
): Promise<{ slug: string; editions: number }> {
  const index = await readIndex();
  const entry = index.sets.find((s) => s.slug === slug);
  if (!entry) throw new CreateError(404, "Tournament to refresh not found.");
  if (!isSetOwner(entry, owner) && !isPrivileged) throw new CreateError(403, "Only the tournament's owner can refresh it.");

  // Keep the existing display name; only the underlying data is refreshed.
  source.name = entry.name || source.name;
  // ...and the format: a re-scrape knows nothing about how the set is read.
  if (entry.individual) source.individual = true;
  await writeSource(slug, source);
  const { meta, editions } = await aggregateAndWrite(slug, source, await readCorrections(slug));

  Object.assign(entry, {
    scoring: source.scoring, hasBonuses: source.hasBonuses, editions,
    numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
    numTossups: meta.numTossups, rounds: meta.rounds.length,
  });
  await writeIndex(index);
  return { slug, editions: editions.length };
}

// Create a tournament from an already-built SetSource (used by the Buzzpoints
// import, which reconstructs editions/packets/games itself). Mirrors the tail of
// createTournament but skips file parsing.
export async function createFromSource(
  source: SetSource,
  owner: string,
  opts: { name?: string; visibility?: string; autoPublicAt?: string | null; level?: string; tdLink?: string; difficulty?: string; individual?: boolean }
): Promise<{ slug: string }> {
  const name = (opts.name || source.name || "").trim();
  if (!name) throw new CreateError(400, "Tournament name is required.");
  const level = validLevel(opts.level);
  const tdLink = cleanTdLink(opts.tdLink);
  const difficulty = cleanDifficulty(level, opts.difficulty);
  source.name = name;
  if (opts.individual) source.individual = true;
  const individual = !!source.individual;

  const visibility = level === "practice" ? practiceVisibility(normVisibility(opts.visibility)) : normVisibility(opts.visibility);
  const createdAt = new Date().toISOString();
  let autoPublicAt: string | null = null;
  if (visibility !== "public" && level !== "practice") {
    if (opts.autoPublicAt === null) autoPublicAt = null;
    else if (typeof opts.autoPublicAt === "string" && !Number.isNaN(Date.parse(opts.autoPublicAt))) autoPublicAt = new Date(opts.autoPublicAt).toISOString();
    else autoPublicAt = new Date(Date.now() + TWO_YEARS_MS).toISOString();
  }

  const index = await readIndex();
  const taken = new Set(index.sets.map((s) => s.slug));
  let slug = slugify(name);
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  await writeSource(slug, source);
  await writeCorrections(slug, []);
  await writeRequests(slug, []);
  const { meta, editions } = await aggregateAndWrite(slug, source, []);

  const entry: SetEntry = {
    slug, name, scoring: source.scoring, hasBonuses: source.hasBonuses, ...(individual ? { individual } : {}), owner, editions, origin: "import",
    visibility, invites: [], autoPublicAt, level, ...(tdLink ? { tdLink } : {}), ...(difficulty ? { difficulty } : {}),
    numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
    numTossups: meta.numTossups, rounds: meta.rounds.length, createdAt,
  };
  await writeIndex({ sets: [entry, ...index.sets.filter((s) => s.slug !== slug)] });
  return { slug };
}
