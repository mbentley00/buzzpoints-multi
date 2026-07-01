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

const CONCURRENCY = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Some sources sit behind Cloudflare and throttle non-browser user-agents heavily,
// so present as a browser and accept gzip.
const HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-encoding": "gzip, deflate, br",
};

interface BuzzRec { player_name: string; team_name: string; opponent_name?: string; game_id: string; buzz_position: number; value: number; }
interface ScrapedTossup { round: number; num: number; question: string; answer: string; metadata: string; buzzes: BuzzRec[]; }

// Fetch with retries on transient errors (timeouts / rate limits), since large
// imports hit hundreds of pages on shared sites that occasionally 5xx.
async function fetchText(url: string, tries = 4, timeoutMs = 25000): Promise<string> {
  let lastErr: Error = new Error(`Couldn't read ${url}.`);
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs); // bound any single hung request
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (r.ok) return r.text();
      lastErr = new Error(`Couldn't read ${url} (HTTP ${r.status}).`);
      if (![429, 500, 502, 503, 504].includes(r.status)) throw lastErr; // don't retry 404 etc.
    } catch (e) {
      lastErr = e as Error;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries - 1) await sleep(300 * (i + 1));
  }
  throw lastErr;
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

// Extract the JSON array that follows `"key":[` (at or after `from`), scanning
// with string/bracket awareness so values containing brackets don't end it early.
function jsonArrayField(s: string, key: string, from = 0): any[] {
  const at = s.indexOf(`"${key}":[`, from);
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

// Parse an import URL into the Buzzpoints app's base (origin + any subpath like
// "/buzzpoints") and what to import:
//   .../tournament/<slug>  -> that one tournament (a shared site hosts many, so we
//                             must NOT import everything)
//   .../set/<slug>         -> all editions/mirrors of that set
//   root / .../tournament  -> every tournament listed there (per-deployment sites,
//                             whose "tournaments" are editions of one)
export interface ImportTarget { base: string; kind: "tournament" | "set" | "list"; slug?: string }
export function parseTarget(input: string): ImportTarget {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error("Enter the full URL of a Buzzpoints page (e.g. https://example.vercel.app or https://quizbowlstats.com/buzzpoints/tournament/<slug>)."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("The import URL must be http(s).");
  const path = u.pathname.replace(/\/+$/, "");
  let m = path.match(/^(.*)\/tournament\/([^/]+)$/) || path.match(/^(.*)\/tournament\/([^/]+)\//);
  if (m) return { base: u.origin + m[1], kind: "tournament", slug: m[2] };
  m = path.match(/^(.*)\/set\/([^/]+)/);
  if (m) return { base: u.origin + m[1], kind: "set", slug: m[2] };
  m = path.match(/^(.*)\/tournament\/?$/);
  if (m) return { base: u.origin + m[1], kind: "list" };
  return { base: u.origin + path, kind: "list" };
}

// Title-case a tournament slug for a display name, upper-casing common quizbowl
// acronyms. Used when importing a single tournament by URL (the user can override
// the name on the import form).
const ACRONYMS = new Set(["acf", "pace", "nsc", "scop", "hsapq", "ncsa", "eft", "rmp", "ll", "act", "sat"]);
export function slugToName(slug: string): string {
  return slug.split("-").map((w) =>
    /^\d+$/.test(w) ? w : ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(" ");
}

// Map the distinct buzz values to one of this app's scoring formats.
export function scoringFor(values: Set<number>): string {
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

// The tournament slugs + display names listed at `listPath` under `base`
// (a /tournament index for per-deployment sites, or a /set/<slug> page for a set).
// Handles hrefs with a base-path prefix (e.g. /buzzpoints/tournament/<slug>).
export async function listEditions(base: string, listPath: string): Promise<{ slug: string; name: string }[]> {
  const html = await fetchText(`${base}${listPath}`);
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/href="[^"]*?\/tournament\/([a-z0-9-]+)"[^>]*>([^<]+)</g))
    if (!seen.has(m[1])) seen.set(m[1], m[2].trim());
  for (const m of html.matchAll(/href="[^"]*?\/tournament\/([a-z0-9-]+)"/g)) if (!seen.has(m[1])) seen.set(m[1], m[1]);
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

// Every question SET listed at <base>/set (used by the admin bulk import). Each
// set groups the mirror tournaments that are its editions.
export async function listSets(base: string): Promise<{ slug: string; name: string }[]> {
  const html = await fetchText(`${base}/set`);
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/href="[^"]*?\/set\/([a-z0-9-]+)"[^>]*>([^<]+)</g))
    if (!seen.has(m[1])) seen.set(m[1], m[2].trim().replace(/&amp;/g, "&"));
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

// The editions (mirror tournaments) of a set. The set page is set-level stats and
// doesn't list its tournaments, so we take the full tournament index and keep the
// ones whose slug is the set slug or a "<set>-<site>" descendant of it.
export async function setEditions(base: string, setSlug: string): Promise<{ slug: string; name: string }[]> {
  const all = await listEditions(base, "/tournament");
  const matched = all.filter((t) => t.slug === setSlug || t.slug.startsWith(setSlug + "-"));
  if (matched.length) return matched;
  // Single-edition sets aren't always in the /tournament index, and use a doubled
  // slug (<set>-<set>); scrapeEdition fails gracefully if this guess is wrong.
  return [{ slug: `${setSlug}-${setSlug}`, name: slugToName(setSlug) }];
}

export async function scrapeEdition(base: string, slug: string): Promise<{ packets: PacketFile[]; games: GameFile[]; values: Set<number>; pages: number; hasBonuses: boolean; bonusPairs: [number, number][] }> {
  // ---- tossups ----
  const tHtml = await fetchText(`${base}/tournament/${slug}/tossup`);
  const tPairs = [...new Set([...tHtml.matchAll(new RegExp(`/tournament/${slug}/tossup/(\\d+)/(\\d+)`, "g"))].map((m) => `${m[1]}|${m[2]}`))]
    .map((k) => k.split("|").map(Number) as [number, number]);

  const scraped = await mapLimit(tPairs, CONCURRENCY, async ([round, num]): Promise<ScrapedTossup> => {
    try {
      const f = parseFlight(await fetchText(`${base}/tournament/${slug}/tossup/${round}/${num}`));
      const buzzAt = f.indexOf('"buzzes":[');
      return {
        round, num,
        question: strField(f, "question", buzzAt >= 0 ? buzzAt : undefined) ?? "",
        answer: strField(f, "answer", buzzAt >= 0 ? buzzAt : undefined) ?? strField(f, "answer_primary") ?? "",
        metadata: strField(f, "metadata", buzzAt >= 0 ? buzzAt : undefined) ?? "",
        // game_id / value come through as numbers on some sites and strings on
        // others (quizbowlstats), so normalize them.
        buzzes: (jsonArrayField(f, "buzzes") as any[])
          .filter((b) => b && b.game_id != null && b.game_id !== "")
          .map((b): BuzzRec => ({ player_name: b.player_name, team_name: b.team_name, opponent_name: b.opponent_name, game_id: String(b.game_id), buzz_position: Number(b.buzz_position), value: Number(b.value) })),
      };
    } catch { return { round, num, question: "", answer: "", metadata: "", buzzes: [] }; } // skip an unreadable tossup, don't fail the import
  });

  const values = new Set<number>();
  const byKey = new Map<string, ScrapedTossup>();
  const roundSize = new Map<number, number>();
  for (const t of scraped) {
    byKey.set(`${t.round}-${t.num}`, t);
    roundSize.set(t.round, Math.max(roundSize.get(t.round) || 0, t.num));
    for (const b of t.buzzes) values.add(b.value);
  }

  // games: group buzzes by game_id (each game is one round between two teams)
  type G = { round: number; teams: Set<string>; q: Map<number, any[]>; players: Map<string, Set<string>> };
  const games = new Map<string, G>();
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
    for (let n = 1; n <= size; n++) match_questions.push({ tossup_question: { question_number: n }, buzzes: g.q.get(n) || [] } as any);
    const gf: GameFile = { round: g.round, match_teams, match_questions };
    gameFiles.push(gf);
  }

  // ---- bonuses (optional) ----
  // The bonus INDEX page carries, in ONE cheap request, every bonus's
  // pre-aggregated per-part conversion, ppb, heard count, category, and answer
  // parts. We always import those aggregate stats. The question TEXT (leadin +
  // prompts) and per-team results live only on the (slow, often 504) per-bonus
  // detail pages, scraped separately + optionally by scrapeBonusResults — so the
  // aggregate stats still work even when the detail pages fail.
  const bonusDefs = new Map<string, { metadata: string; parts: string[]; answers: string[]; difficultyModifiers: string[]; stats: { heard: number; got: number[]; points: number } }>();
  let hasBonuses = false;
  try {
    const f = parseFlight(await fetchText(`${base}/tournament/${slug}/bonus`, 3, 15000));
    for (const b of jsonArrayField(f, "bonuses") as any[]) {
      const round = Number(b.round), num = Number(b.question_number);
      if (!Number.isInteger(round) || !Number.isInteger(num)) continue;
      const heard = Number(b.heard) || 0;
      // Order the three parts by their position in the packet (the index labels
      // parts by difficulty, not by reading order).
      const slots = [
        { pos: Number(b.easy_part_number), diff: "e", ans: b.easy_part || "", conv: Number(b.easy_conversion) || 0 },
        { pos: Number(b.medium_part_number), diff: "m", ans: b.medium_part || "", conv: Number(b.medium_conversion) || 0 },
        { pos: Number(b.hard_part_number), diff: "h", ans: b.hard_part || "", conv: Number(b.hard_conversion) || 0 },
      ].sort((x, y) => (x.pos || 0) - (y.pos || 0));
      bonusDefs.set(`${round}-${num}`, {
        metadata: b.category || "",
        parts: slots.map(() => ""), // part prompts aren't exposed by the index
        answers: slots.map((s) => s.ans),
        difficultyModifiers: slots.map((s) => s.diff),
        stats: { heard, got: slots.map((s) => Math.round(s.conv * heard)), points: Math.round((Number(b.ppb) || 0) * heard) },
      });
      roundSize.set(round, Math.max(roundSize.get(round) || 0, num));
      hasBonuses = true;
    }
  } catch { /* no readable bonus index -> import tossup-only */ }

  // packets: one per round, tossups + bonuses in order (gaps filled with blanks)
  const packets: PacketFile[] = [...roundSize.keys()].sort((a, b) => a - b).map((round) => {
    const size = roundSize.get(round)!;
    const tossups = [], bonuses = [];
    for (let n = 1; n <= size; n++) {
      const t = byKey.get(`${round}-${n}`);
      tossups.push({ question: t?.question || "", answer: t?.answer || "", metadata: t?.metadata || "" });
      const bd = bonusDefs.get(`${round}-${n}`);
      bonuses.push(bd ? { leadin: "", parts: bd.parts, answers: bd.answers, difficultyModifiers: bd.difficultyModifiers, metadata: bd.metadata, stats: bd.stats } : {});
    }
    return { round, tossups, bonuses };
  });

  const bonusPairs = [...bonusDefs.keys()].map((k) => k.split("-").map(Number) as [number, number]);
  return { packets, games: gameFiles, values, pages: tPairs.length + (hasBonuses ? 1 : 0), hasBonuses, bonusPairs };
}

// Pick the cleanest set name from the edition names (the shortest is usually the
// base name without an "Online"/"at <site>" qualifier).
export function setNameFrom(names: string[]): string {
  return names.filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || "Imported tournament";
}

/* ----------------------------- bonus detail (text + per-team results) ----------------------------- */
// The per-bonus detail pages hold the question text (leadin + prompts + answers)
// AND the per-team results table — but are slow (cold ~5-15s) and 504 on the
// largest fields. They're scraped OPTIONALLY, in chunks driven by the browser so
// each request stays within the function limit.
const BONUS_CONCURRENCY = 3; // higher tends to 504 the source
export interface BonusResultRow { team: string; opp: string; pts: number[]; total: number }
export interface BonusText { leadin: string; parts: string[]; answers: string[] }
export interface BonusPageResult { round: number; num: number; rows: BonusResultRow[]; text: BonusText | null }

// Parse the per-team results table (`data` array following the part_one column)
// out of a bonus detail page's flight payload.
function parseBonusRows(f: string): BonusResultRow[] {
  const p = f.indexOf('"part_one"');
  if (p < 0) return [];
  return (jsonArrayField(f, "data", p) as any[])
    .map((r) => ({ team: r.team_name, opp: r.opponent_name, pts: [Number(r.part_one) || 0, Number(r.part_two) || 0, Number(r.part_three) || 0], total: Number(r.total) || 0 }))
    .filter((r) => r.team && r.opp);
}

// The bonus question text is rendered as ordered `__html` chunks (via
// dangerouslySetInnerHTML): the leadin first, then a (prompt, answer) pair per
// part in reading order. Extract them into leadin + parts[] + answers[].
function parseBonusText(f: string): BonusText | null {
  const htmls: string[] = [];
  const re = /"__html":"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(f))) { try { htmls.push(JSON.parse('"' + m[1] + '"')); } catch { /* skip */ } }
  // Expect 1 leadin + an even number of prompt/answer chunks (>=1 part).
  if (htmls.length < 3 || htmls.length % 2 === 0) return null;
  const parts: string[] = [], answers: string[] = [];
  for (let i = 1; i + 1 < htmls.length; i += 2) { parts.push(htmls[i]); answers.push(htmls[i + 1]); }
  return { leadin: htmls[0], parts, answers };
}

// Scrape per-team results for a slice of bonus pairs, stopping at `deadline` (so
// the caller stays within the function time limit). Pages that 504/timeout are
// skipped (that bonus keeps its index-derived aggregate). Returns the results
// gathered and how many pairs were attempted (the caller advances its cursor by
// that many, whether each succeeded or not).
export async function scrapeBonusResults(
  base: string, slug: string, pairs: [number, number][], deadline: number
): Promise<{ results: BonusPageResult[]; attempted: number }> {
  const results: BonusPageResult[] = [];
  let attempted = 0, next = 0;
  async function worker() {
    while (Date.now() < deadline) {
      const i = next++;
      if (i >= pairs.length) return;
      attempted++;
      const [round, num] = pairs[i];
      try {
        const f = parseFlight(await fetchText(`${base}/tournament/${slug}/bonus/${round}/${num}`, 1, 20000));
        const rows = parseBonusRows(f);
        const text = parseBonusText(f);
        if (rows.length || text) results.push({ round, num, rows, text });
      } catch { /* 504/timeout -> no per-team data for this bonus */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BONUS_CONCURRENCY, pairs.length) }, worker));
  return { results, attempted };
}

// Fill in the bonus question text (leadin + part prompts + answers) scraped from
// the detail pages onto the packet bonus definitions. The text is identical
// across mirrors, so any edition that reads a page contributes it.
export function applyBonusText(packets: PacketFile[], results: BonusPageResult[]): void {
  const byRound = new Map<number, PacketFile>();
  for (const p of packets) byRound.set(p.round, p);
  for (const r of results) {
    if (!r.text) continue;
    const b = byRound.get(r.round)?.bonuses?.[r.num - 1] as any;
    if (!b) continue;
    b.leadin = r.text.leadin || b.leadin || "";
    if (r.text.parts.length) b.parts = r.text.parts;
    if (r.text.answers.length) b.answers = r.text.answers;
  }
}

// Attach scraped per-team bonus results onto reconstructed games (QBJ shape), so
// the normal aggregation produces full per-team bonus stats. Matches each result
// row to its game by (round, {team, opponent}).
export function applyBonusResults(games: GameFile[], results: BonusPageResult[]): void {
  const idx = new Map<string, GameFile>();
  for (const g of games) {
    const names = (g.match_teams || []).map((t) => t.team?.name).filter(Boolean) as string[];
    if (names.length === 2) idx.set(`${g.round}|${[names[0], names[1]].sort().join("|")}`, g);
  }
  for (const bp of results)
    for (const row of bp.rows) {
      const gf = idx.get(`${bp.round}|${[row.team, row.opp].sort().join("|")}`);
      if (!gf) continue;
      const mq = (gf.match_questions || [])[bp.num - 1] as any;
      if (!mq) continue;
      mq.bonus = { question: { question_number: bp.num }, parts: row.pts.map((v) => ({ controlled_points: v, bounceback_points: 0 })) };
      const mt = (gf.match_teams || []).find((t: any) => t.team?.name === row.team) as any;
      if (mt) mt.bonus_points = (mt.bonus_points || 0) + row.total;
    }
}
