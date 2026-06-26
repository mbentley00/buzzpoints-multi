// Shared "create a new tournament" path, used both by direct ingest (established
// posters) and by approving a queued first-post submission. Keeps slug
// allocation, source storage, aggregation, and index insertion in one place.
import { PacketFile, GameFile } from "./aggregate.js";
import { SCORINGS } from "./scoring.js";
import {
  readIndex, writeIndex, writeSource, writeCorrections, writeRequests,
  aggregateAndWrite, SetSource, SetEntry, Visibility,
  writeYf, writeResultsCorrections, aggregateResultsAndWrite,
} from "./sets.js";
import { parseYellowFruit } from "./yellowfruit.js";

// A file payload: either inline JSON (legacy / small uploads) or a reference to
// a blob the client uploaded directly (resolved to `json` before aggregation).
export interface FileRef { name: string; json?: any; pathname?: string; }
export interface CreateBody {
  name?: string; scoring?: string; hasBonuses?: boolean;
  packets?: FileRef[]; games?: FileRef[];
  visibility?: string; autoPublicAt?: string | null; edition?: string;
}

const VISIBILITIES = new Set<Visibility>(["public", "listed", "private"]);
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export const slugify = (s: string) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "set";
export const roundFromName = (name: string) => {
  const m = (name || "").match(/(?:Round[_ ])?0*(\d+)(?:[_ .]|$)/i);
  return m ? Number(m[1]) : null;
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
export async function createTournament(body: CreateBody, owner: string): Promise<{ slug: string }> {
  const name = (body.name || "").trim();
  if (!name) throw new CreateError(400, "Tournament name is required.");
  if (!body.scoring || !(body.scoring in SCORINGS)) throw new CreateError(400, "Unknown scoring format.");
  if (!body.packets?.length) throw new CreateError(400, "At least one packet is required.");
  if (!body.games?.length) throw new CreateError(400, "At least one game (QBJ) is required.");

  const { packets, games } = parseFiles(body);
  const hasBonuses = !!body.hasBonuses;
  const visibility: Visibility = VISIBILITIES.has(body.visibility as Visibility) ? (body.visibility as Visibility) : "listed";
  const createdAt = new Date().toISOString();
  let autoPublicAt: string | null = null;
  if (visibility !== "public") {
    if (body.autoPublicAt === null) autoPublicAt = null;
    else if (typeof body.autoPublicAt === "string" && !Number.isNaN(Date.parse(body.autoPublicAt))) autoPublicAt = new Date(body.autoPublicAt).toISOString();
    else autoPublicAt = new Date(Date.now() + TWO_YEARS_MS).toISOString();
  }

  const index = await readIndex();
  const taken = new Set(index.sets.map((s) => s.slug));
  let slug = slugify(name);
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  const label = (body.edition || "").trim() || "Original";
  const source: SetSource = { name, scoring: body.scoring!, hasBonuses, editions: [{ id: "e0", label, packets, games }] };
  await writeSource(slug, source);
  await writeCorrections(slug, []);
  await writeRequests(slug, []);
  const { meta, editions } = await aggregateAndWrite(slug, source, []);

  const entry: SetEntry = {
    slug, name, scoring: body.scoring!, hasBonuses, owner, editions,
    visibility, invites: [], autoPublicAt,
    numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
    numTossups: meta.numTossups, rounds: meta.rounds.length, createdAt,
  };
  await writeIndex({ sets: [entry, ...index.sets.filter((s) => s.slug !== slug)] });
  return { slug };
}

export interface CreateResultsBody {
  name?: string; yf?: any; visibility?: string; autoPublicAt?: string | null;
}

// Create a "results" tournament from an uploaded YellowFruit/QBJ file. Scoring,
// bonus presence, and the name default come from the file itself.
export async function createResultsTournament(body: CreateResultsBody, owner: string): Promise<{ slug: string }> {
  if (!body.yf) throw new CreateError(400, "A YellowFruit (.yft) or QBJ file is required.");
  let yf;
  try { yf = parseYellowFruit(body.yf); }
  catch (e) { throw new CreateError(400, (e as Error).message); }

  const name = (body.name || "").trim() || yf.name;
  if (!name) throw new CreateError(400, "Tournament name is required.");

  const visibility: Visibility = VISIBILITIES.has(body.visibility as Visibility) ? (body.visibility as Visibility) : "listed";
  const createdAt = new Date().toISOString();
  let autoPublicAt: string | null = null;
  if (visibility !== "public") {
    if (body.autoPublicAt === null) autoPublicAt = null;
    else if (typeof body.autoPublicAt === "string" && !Number.isNaN(Date.parse(body.autoPublicAt))) autoPublicAt = new Date(body.autoPublicAt).toISOString();
    else autoPublicAt = new Date(Date.now() + TWO_YEARS_MS).toISOString();
  }

  const index = await readIndex();
  const taken = new Set(index.sets.map((s) => s.slug));
  let slug = slugify(name);
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  await writeYf(slug, body.yf);
  await writeResultsCorrections(slug, []);
  const { meta } = await aggregateResultsAndWrite(slug, body.yf, []);

  const entry: SetEntry = {
    slug, name, scoring: yf.scoringId, hasBonuses: meta.hasBonuses, kind: "results", owner,
    visibility, invites: [], autoPublicAt,
    numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
    numTossups: 0, rounds: (meta.rounds || []).length, createdAt,
  };
  await writeIndex({ sets: [entry, ...index.sets.filter((s) => s.slug !== slug)] });
  return { slug };
}
