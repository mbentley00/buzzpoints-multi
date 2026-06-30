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
interface BonusPart { part?: string; answer?: string; leadin?: string; difficulty_modifier?: string; value?: number; metadata?: string; }
interface BonusDirect { team_name: string; opponent_name?: string; part_one?: number; part_two?: number; part_three?: number; total?: number; }

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

const sortedKey = (round: number, a: string, b: string) => `${round}|${[a, b].sort().join("|")}`;

export async function scrapeEdition(base: string, slug: string): Promise<{ packets: PacketFile[]; games: GameFile[]; values: Set<number>; pages: number; hasBonuses: boolean }> {
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
  const gameByKey = new Map<string, GameFile>();
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
    if (teams.length === 2) gameByKey.set(sortedKey(g.round, teams[0], teams[1]), gf);
  }

  // ---- bonuses (optional): parts (packet defn) + directs (per-game results) ----
  // Some shared sites (e.g. quizbowlstats) compute bonus pages with an expensive
  // query (~10s each), so 200+ of them can't be fetched within the time budget.
  // Probe one page's latency: if the source serves bonuses slowly, import
  // tossup-only rather than partially (which would skew PPB).
  let bPairs: [number, number][] = [];
  try {
    // Short timeout: if the bonus index is slow to render, skip bonuses fast.
    const bHtml = await fetchText(`${base}/tournament/${slug}/bonus`, 1, 9000);
    bPairs = [...new Set([...bHtml.matchAll(new RegExp(`/tournament/${slug}/bonus/(\\d+)/(\\d+)`, "g"))].map((m) => `${m[1]}|${m[2]}`))]
      .map((k) => k.split("|").map(Number) as [number, number]);
  } catch { /* no readable bonus index -> import tossup-only */ }
  const bonusDefs = new Map<string, { leadin: string; parts: string[]; answers: string[]; difficultyModifiers: string[]; metadata: string }>();
  let hasBonuses = false;
  let bonusFast = false;
  if (bPairs.length) {
    const t0 = Date.now();
    try { await fetchText(`${base}/tournament/${slug}/bonus/${bPairs[0][0]}/${bPairs[0][1]}`, 1, 5000); bonusFast = Date.now() - t0 < 3500; }
    catch { bonusFast = false; }
  }
  if (bPairs.length && bonusFast) {
    const deadline = Date.now() + 20000; // hard budget for the whole bonus scrape
    const bscraped = await mapLimit(bPairs, CONCURRENCY, async ([round, num]) => {
      if (Date.now() > deadline) return { round, num, parts: [] as BonusPart[], directs: [] as BonusDirect[] };
      try {
        // Fail fast per page (no long retries) so slow bonus pages don't blow the budget.
        const f = parseFlight(await fetchText(`${base}/tournament/${slug}/bonus/${round}/${num}`, 1, 6000));
        return { round, num, parts: jsonArrayField(f, "parts") as BonusPart[], directs: jsonArrayField(f, "directs") as BonusDirect[] };
      } catch { return { round, num, parts: [] as BonusPart[], directs: [] as BonusDirect[] }; }
    });
    // Only keep bonuses if we actually got (nearly) all of them.
    const got = bscraped.filter((b) => b.parts.length).length;
    if (got >= bPairs.length * 0.9) for (const b of bscraped) {
      if (!b.parts.length) continue;
      hasBonuses = true;
      bonusDefs.set(`${b.round}-${b.num}`, {
        leadin: b.parts[0]?.leadin || "",
        parts: b.parts.map((p) => p.part || ""),
        answers: b.parts.map((p) => p.answer || ""),
        difficultyModifiers: b.parts.map((p) => (p.difficulty_modifier || "m").toLowerCase()),
        metadata: b.parts[0]?.metadata || "",
      });
      roundSize.set(b.round, Math.max(roundSize.get(b.round) || 0, b.num));
      // attach per-game results
      for (const d of b.directs) {
        if (!d.opponent_name) continue;
        const gf = gameByKey.get(sortedKey(b.round, d.team_name, d.opponent_name));
        if (!gf) continue;
        const mq = (gf.match_questions || [])[b.num - 1] as any;
        if (!mq) continue;
        const pts = [d.part_one, d.part_two, d.part_three].slice(0, b.parts.length).map((v) => Number(v) || 0);
        mq.bonus = { question: { question_number: b.num }, parts: pts.map((v) => ({ controlled_points: v, bounceback_points: 0 })) };
        const mt = (gf.match_teams || []).find((t: any) => t.team?.name === d.team_name) as any;
        if (mt) mt.bonus_points = (mt.bonus_points || 0) + (Number(d.total) || 0);
      }
    }
  }

  // packets: one per round, tossups + bonuses in order (gaps filled with blanks)
  const packets: PacketFile[] = [...roundSize.keys()].sort((a, b) => a - b).map((round) => {
    const size = roundSize.get(round)!;
    const tossups = [], bonuses = [];
    for (let n = 1; n <= size; n++) {
      const t = byKey.get(`${round}-${n}`);
      tossups.push({ question: t?.question || "", answer: t?.answer || "", metadata: t?.metadata || "" });
      const bd = bonusDefs.get(`${round}-${n}`);
      bonuses.push(bd ? { leadin: bd.leadin, parts: bd.parts, answers: bd.answers, difficultyModifiers: bd.difficultyModifiers, metadata: bd.metadata } : {});
    }
    return { round, tossups, bonuses };
  });

  return { packets, games: gameFiles, values, pages: tPairs.length + bPairs.length, hasBonuses };
}

// Pick the cleanest set name from the edition names (the shortest is usually the
// base name without an "Online"/"at <site>" qualifier).
export function setNameFrom(names: string[]): string {
  return names.filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || "Imported tournament";
}
