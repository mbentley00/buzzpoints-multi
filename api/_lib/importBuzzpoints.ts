// Import a tournament from another (JemCasey-style) Buzzpoints site deployed on
// Vercel. Those sites are server-rendered Next.js with no API, so we read the
// data out of the React Flight payloads embedded in each page:
//   /tournament                       -> the tournament slugs (treated as EDITIONS
//                                        of one tournament — a link never hosts two
//                                        genuinely distinct tournaments)
//   /tournament/<slug>/tossup         -> the (round, number) of every tossup
//   /tournament/<slug>/tossup/<r>/<n> -> the question + every buzz (player, team,
//                                        opponent, game_id, word position, value)
// From the buzzes (which carry game_id + opponent) we rebuild this app's QBJ-style
// games, so the normal aggregation produces full buzz-level stats.
import type { PacketFile, GameFile } from "./aggregate.js";
import type { SetSource, Edition } from "./sets.js";

const MAX_TOSSUPS = 1500;  // safety cap across all editions (keeps us within limits)
const CONCURRENCY = 12;

interface BuzzRec { player_name: string; team_name: string; opponent_name?: string; game_id: number; buzz_position: number; value: number; }
interface ScrapedTossup { round: number; num: number; question: string; answer: string; metadata: string; buzzes: BuzzRec[]; }

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": "buzzpoints.buzz importer" } });
  if (!r.ok) throw new Error(`Couldn't read ${url} (HTTP ${r.status}).`);
  return r.text();
}

// Concatenate the page's React Flight chunks into one decoded string.
function parseFlight(html: string): string {
  const out: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse('"' + m[1] + '"')); } catch { /* skip malformed chunk */ }
  }
  return out.join("");
}

// Read a string field (`"key":"…"`), JSON-unescaped. `before` bounds the search.
function strField(s: string, key: string, before = s.length): string | null {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { if (m.index < before) return JSON.parse('"' + m[1] + '"'); else break; }
  return null;
}

// Extract the JSON array that follows `"key":[`, scanning with string/bracket
// awareness so values containing brackets don't end it early.
function jsonArrayField(s: string, key: string): any[] {
  const at = s.indexOf(`"${key}":[`);
  if (at < 0) return [];
  let i = at + key.length + 3; // position of '['
  const start = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { i++; break; } }
  }
  try { return JSON.parse(s.slice(start, i)); } catch { return []; }
}

function originOf(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error("Enter the full URL of a Buzzpoints site (e.g. https://example.vercel.app)."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("The import URL must be http(s).");
  return `${u.protocol}//${u.host}`;
}

// Map the distinct buzz values to one of this app's scoring formats.
function scoringFor(values: Set<number>): string {
  const hasNeg = [...values].some((v) => v < 0);
  const maxPos = Math.max(0, ...[...values].filter((v) => v > 0));
  if (values.has(20) && values.has(15)) return "SUPERPOWER";
  if (values.has(20) && hasNeg) return "SUPERPOWER";
  if (values.has(20)) return "PACE";
  if (values.has(15) || maxPos === 15) return "mACF";
  if (maxPos <= 10) return hasNeg ? "ACF" : "PACE";
  return "mACF";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// The tournament slugs + display names on the site's /tournament page.
async function listEditions(origin: string): Promise<{ slug: string; name: string }[]> {
  const html = await fetchText(`${origin}/tournament`);
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/href="\/tournament\/([a-z0-9-]+)"[^>]*>([^<]+)</g))
    if (!seen.has(m[1])) seen.set(m[1], m[2].trim());
  // fallback: links without adjacent text
  for (const m of html.matchAll(/\/tournament\/([a-z0-9-]+)"/g)) if (!seen.has(m[1])) seen.set(m[1], m[1]);
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

async function scrapeEdition(origin: string, slug: string, budget: { left: number }): Promise<{ packets: PacketFile[]; games: GameFile[]; values: Set<number> }> {
  const listHtml = await fetchText(`${origin}/tournament/${slug}/tossup`);
  const pairKeys = [...new Set([...listHtml.matchAll(new RegExp(`/tournament/${slug}/tossup/(\\d+)/(\\d+)`, "g"))].map((m) => `${m[1]}|${m[2]}`))];
  const pairs = pairKeys.map((k) => k.split("|").map(Number) as [number, number]);
  if (pairs.length > budget.left) throw new Error(`This tournament is too large to import in one pass (${pairs.length} tossups). Try a smaller one.`);
  budget.left -= pairs.length;

  const scraped = await mapLimit(pairs, CONCURRENCY, async ([round, num]): Promise<ScrapedTossup> => {
    const f = parseFlight(await fetchText(`${origin}/tournament/${slug}/tossup/${round}/${num}`));
    const buzzAt = f.indexOf('"buzzes":[');
    return {
      round, num,
      question: strField(f, "question", buzzAt >= 0 ? buzzAt : undefined) ?? "",
      answer: strField(f, "answer", buzzAt >= 0 ? buzzAt : undefined) ?? strField(f, "answer_primary") ?? "",
      metadata: strField(f, "metadata", buzzAt >= 0 ? buzzAt : undefined) ?? "",
      buzzes: (jsonArrayField(f, "buzzes") as BuzzRec[]).filter((b) => b && typeof b.game_id === "number"),
    };
  });

  const values = new Set<number>();
  const byKey = new Map<string, ScrapedTossup>();
  const roundSize = new Map<number, number>();
  for (const t of scraped) {
    byKey.set(`${t.round}-${t.num}`, t);
    roundSize.set(t.round, Math.max(roundSize.get(t.round) || 0, t.num));
    for (const b of t.buzzes) values.add(b.value);
  }

  // packets: one per round, tossups in order (gaps filled with blanks)
  const packets: PacketFile[] = [...roundSize.keys()].sort((a, b) => a - b).map((round) => {
    const size = roundSize.get(round)!;
    const tossups = [];
    for (let n = 1; n <= size; n++) {
      const t = byKey.get(`${round}-${n}`);
      tossups.push({ question: t?.question || "", answer: t?.answer || "", metadata: t?.metadata || "" });
    }
    return { round, tossups, bonuses: [] };
  });

  // games: group buzzes by game_id (each game is one round between two teams)
  type G = { round: number; teams: Set<string>; q: Map<number, any[]>; players: Map<string, Set<string>> };
  const games = new Map<number, G>();
  for (const t of scraped) {
    for (const b of t.buzzes) {
      let g = games.get(b.game_id);
      if (!g) { g = { round: t.round, teams: new Set(), q: new Map(), players: new Map() }; games.set(b.game_id, g); }
      g.teams.add(b.team_name);
      if (b.opponent_name) g.teams.add(b.opponent_name);
      let ps = g.players.get(b.team_name); if (!ps) { ps = new Set(); g.players.set(b.team_name, ps); } ps.add(b.player_name);
      const arr = g.q.get(t.num) || [];
      arr.push({ player: { name: b.player_name }, team: { name: b.team_name }, result: { value: b.value }, buzz_position: { word_index: b.buzz_position } });
      g.q.set(t.num, arr);
    }
  }

  const gameFiles: GameFile[] = [];
  for (const g of games.values()) {
    const size = roundSize.get(g.round) || Math.max(0, ...g.q.keys());
    const teams = [...g.teams];
    const match_teams = teams.map((tn) => {
      const players = [...(g.players.get(tn) || [])];
      return {
        bonus_points: 0,
        team: { name: tn, players: players.map((name) => ({ name })) },
        match_players: players.map((name) => ({ player: { name }, tossups_heard: size })),
      };
    });
    const match_questions = [];
    for (let n = 1; n <= size; n++) match_questions.push({ tossup_question: { question_number: n }, buzzes: g.q.get(n) || [] });
    gameFiles.push({ round: g.round, match_teams, match_questions });
  }

  return { packets, games: gameFiles, values };
}

export interface ImportResult { name: string; scoring: string; hasBonuses: boolean; source: SetSource; editionCount: number; }

export async function importBuzzpoints(input: string): Promise<ImportResult> {
  const origin = originOf(input);
  const eds = await listEditions(origin);
  if (!eds.length) throw new Error("No tournaments found at that URL. Make sure it's a Buzzpoints site and the link is correct.");

  const budget = { left: MAX_TOSSUPS };
  const editions: Edition[] = [];
  const values = new Set<number>();
  for (let i = 0; i < eds.length; i++) {
    const { packets, games, values: v } = await scrapeEdition(origin, eds[i].slug, budget);
    v.forEach((x) => values.add(x));
    editions.push({ id: `e${i}`, label: eds[i].name || eds[i].slug, packets, games });
  }
  if (!editions.some((e) => e.games.length)) throw new Error("Couldn't read any game data from that site.");

  // A link only ever hosts editions of one tournament. Name the set after the
  // shortest edition name (editions are usually the base name plus a qualifier
  // like "Online", so the shortest is the cleanest base name).
  const name = eds.map((e) => e.name || e.slug).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return {
    name,
    scoring: scoringFor(values),
    hasBonuses: false, // bonuses aren't reconstructed from these sites yet
    source: { name, scoring: scoringFor(values), hasBonuses: false, editions },
    editionCount: editions.length,
  };
}
