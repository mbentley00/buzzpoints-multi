// Import a tournament from a STATIC-JSON Buzzpoints site — the newer build (a
// Vite SPA), e.g. https://pace-nsc-2026-beta.vercel.app. Nothing in
// importBuzzpoints.ts applies to it: that reads React Flight payloads out of
// server-rendered Next.js pages, while here EVERY route serves the same tiny
// index.html shell (no links, no payload) and all the data sits in prebuilt
// JSON under /data. Pointing the old scraper at one of these finds no
// /tournament links and no tossups, so it reports no games — hence this
// separate adapter.
//
//   /data/meta.json            -> set name/slug + rounds (also the flavor probe)
//   /data/tossups.json         -> every tossup's id ("<round>-<num>")
//   /data/details/tu_<id>.json -> question HTML, word list, and every buzz
//   /data/bonuses.json         -> every bonus's id
//   /data/details/bn_<id>.json -> leadin/parts/answers + per-team results
//
// One site is one tournament, so an import here is always a single edition.
import type { PacketFile, GameFile } from "./aggregate.js";
import { tokenize } from "./aggregate.js";

// Static assets off a CDN: no Cloudflare throttling and no expensive per-page
// queries, so this can run wider than the 8 the Next.js scraper is held to.
const CONCURRENCY = 16;
const HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  accept: "application/json",
  "accept-encoding": "gzip, deflate, br",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T>(url: string, tries = 3, timeoutMs = 20000): Promise<T> {
  let lastErr: Error = new Error(`Couldn't read ${url}.`);
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (r.ok) return (await r.json()) as T;
      lastErr = new Error(`Couldn't read ${url} (HTTP ${r.status}).`);
      if (![429, 500, 502, 503, 504].includes(r.status)) throw lastErr;
    } catch (e) {
      lastErr = e as Error;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries - 1) await sleep(250 * (i + 1));
  }
  throw lastErr;
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

export interface StaticMeta { setName: string; setSlug: string; rounds: number[]; numGames?: number }

// Is `base` one of these static-JSON sites? The probe doubles as the data we
// need (name + slug), and the shape is checked so a stray /data/meta.json on
// some other kind of site can't be mistaken for one.
export async function detectStaticSite(base: string): Promise<StaticMeta | null> {
  try {
    const m = await fetchJson<any>(`${base}/data/meta.json`, 2, 10000);
    if (!m || typeof m.setSlug !== "string" || !m.setSlug || !Array.isArray(m.rounds)) return null;
    return {
      setName: String(m.setName || "").trim() || m.setSlug,
      setSlug: m.setSlug,
      rounds: m.rounds.map(Number),
      numGames: Number(m.numGames) || undefined,
    };
  } catch { return null; }
}

interface IdxRow { id: string; round: number; num: number }
interface StaticBuzz { player: string; team: string; opponent: string; value: number; wordIndex: number }
interface TuDetail { round: number; num: number; answer: string; questionHtml: string; category?: string; subcategory?: string; words: string[]; buzzes: StaticBuzz[] }
interface BnResult { team: string; partPts: number[]; bbPts?: number[]; total: number }
interface BnDetail { round: number; num: number; category?: string; subcategory?: string; leadin?: string; parts?: string[]; answers?: string[]; difficultyModifiers?: (string | null)[]; results?: BnResult[] }

// The category line this app parses out of a question's metadata. The source
// splits category from subcategory, and the fullest one is what we want (the
// app derives "Fine Arts" and "Fine Arts - Music" from "Fine Arts - Music -
// Classical").
//
// Two wrinkles. The subcategory doesn't always sit under the category — a
// couple of questions are Fine Arts but subcategorised "Other Fine Arts —
// Visual - Film" — and since this app takes the top level from the front of the
// line, those would open a category of their own; prefixing the source's own
// top-level keeps them where the source puts them. And commas are stripped
// because metaFields() splits a metadata line on them: one source category
// ("History - Cross, Historiography, and Miscellaneous") contains commas and
// would otherwise be read as three fields, landing the whole category under
// "Historiography".
function metaLine(category?: string, subcategory?: string): string {
  const cat = (category || "").trim(), sub = (subcategory || "").trim();
  const full = !sub ? cat : !cat || sub === cat || sub.startsWith(`${cat} - `) ? sub : `${cat} - ${sub}`;
  return full.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

// Translate a buzz's word index from the source's numbering into this app's.
//
// The source's `words` array is a DISPLAY list: it includes the "(*)" power
// marker, and (inconsistently — it strips the curly-quote ones) some
// pronunciation guides. Its buzz indices, though, are numbered over the SPOKEN
// words only, which is also what this app's tokenize() produces: verified
// against the source, every power buzz falls before the marker and the highest
// index used is exactly one past the last spoken word — the END slot, holding
// 2413 of its 14626 buzzes, a question read out with nobody buzzing.
//
// So the source's index space is `words` minus "(*)", and this app's is
// tokenize(questionHtml). Those agree outright for all but a handful of
// questions (the 6 straight-quote pronunciation guides the source keeps and we
// don't), so rather than assume, align the two and map through: index i becomes
// the number of our words that precede it — the identity wherever the lists
// agree, shifted by exactly the extra tokens where they don't. A token only the
// source has maps to the next spoken word, since nothing unspoken can be
// buzzed on.
function spokenIndexMap(sourceWords: string[], ourWords: string[]): number[] {
  const spoken = (sourceWords || []).filter((w) => w !== "(*)");
  const map = new Array<number>(spoken.length + 1);
  let j = 0;
  for (let i = 0; i < spoken.length; i++) {
    map[i] = j;
    if (j < ourWords.length && spoken[i] === ourWords[j]) j++;
  }
  map[spoken.length] = ourWords.length;
  // The lists should differ only by tokens the source has and we don't. If they
  // diverge some other way the alignment is meaningless, so pass indices through
  // unchanged rather than shifting every buzz by a wrong amount.
  if (j !== ourWords.length) for (let i = 0; i <= spoken.length; i++) map[i] = Math.min(i, ourWords.length);
  return map;
}

interface BuiltGame {
  round: number;
  teams: string[];
  players: Map<string, Set<string>>;
  buzzes: Map<number, { player: { name: string }; team: { name: string }; result: { value: number }; buzz_position: { word_index: number } }[]>;
  // Keyed by the TOSSUP number the hearing hangs off, which is not the bonus's
  // own number — see the pairing step below.
  bonuses: Map<number, { team: string; num: number; parts: { controlled_points: number; bounceback_points: number }[]; total: number }>;
}

export async function scrapeStaticEdition(base: string): Promise<{
  packets: PacketFile[]; games: GameFile[]; values: Set<number>; pages: number; hasBonuses: boolean; bonusPairs: [number, number][];
}> {
  const data = `${base}/data`;
  const tIdx = await fetchJson<IdxRow[]>(`${data}/tossups.json`);
  // A site with no tossups has nothing to import; say so rather than quietly
  // building an empty tournament.
  if (!Array.isArray(tIdx) || !tIdx.length) throw new Error("That site's tossup index is empty, so there's nothing to import.");
  const bIdx = await fetchJson<IdxRow[]>(`${data}/bonuses.json`).catch(() => [] as IdxRow[]);

  const tus = await mapLimit(tIdx, CONCURRENCY, (t) => fetchJson<TuDetail>(`${data}/details/tu_${t.id}.json`).catch(() => null));
  const bns = await mapLimit(bIdx, CONCURRENCY, (b) => fetchJson<BnDetail>(`${data}/details/bn_${b.id}.json`).catch(() => null));

  const values = new Set<number>();
  const roundSize = new Map<number, number>();
  const bump = (round: number, num: number) => roundSize.set(round, Math.max(roundSize.get(round) || 0, num));
  // How many rooms the source says heard each tossup. A packet here ends with a
  // replacement tossup that most rooms never reach, so this is what separates
  // "in the packet" from "actually read" — see standardLength below.
  const heardOf = new Map<string, number>();
  for (const t of tIdx) if (t && (t as any).heard != null) heardOf.set(`${t.round}-${t.num}`, Number((t as any).heard) || 0);

  // ---- tossups + games ----
  const tossupAt = new Map<string, { question: string; answer: string; metadata: string }>();
  const games = new Map<string, BuiltGame>();
  const gameOf = new Map<string, string>(); // "<round>|<team>" -> game key

  tIdx.forEach((row, i) => {
    const d = tus[i];
    if (!d) return;
    const round = Number(d.round) || row.round, num = Number(d.num) || row.num;
    if (!Number.isInteger(round) || !Number.isInteger(num)) return;
    bump(round, num);
    tossupAt.set(`${round}-${num}`, {
      question: d.questionHtml || "",
      answer: d.answer || "",
      metadata: metaLine(d.category, d.subcategory),
    });

    const map = spokenIndexMap(d.words || [], tokenize(d.questionHtml || "").words);
    const last = map.length - 1;
    for (const b of d.buzzes || []) {
      if (!b || !b.team || !b.opponent || !b.player) continue;
      const value = Number(b.value) || 0;
      values.add(value);
      // No game_id anywhere in this format, so a game IS its (round, pair).
      const key = `${round}|${[b.team, b.opponent].sort().join("|")}`;
      let g = games.get(key);
      if (!g) { g = { round, teams: [b.team, b.opponent].sort(), players: new Map(), buzzes: new Map(), bonuses: new Map() }; games.set(key, g); }
      gameOf.set(`${round}|${b.team}`, key);
      gameOf.set(`${round}|${b.opponent}`, key);
      let ps = g.players.get(b.team);
      if (!ps) { ps = new Set(); g.players.set(b.team, ps); }
      ps.add(b.player);
      const wi = map[Math.max(0, Math.min(Number(b.wordIndex) || 0, last))];
      const arr = g.buzzes.get(num) || [];
      arr.push({ player: { name: b.player }, team: { name: b.team }, result: { value }, buzz_position: { word_index: wi } });
      g.buzzes.set(num, arr);
    }
  });

  // ---- bonuses ----
  // Every bonus carries its full text AND its per-team results here, so unlike
  // the Next.js sites there's no slow opt-in second pass: the games get real
  // per-team bonus data straight away.
  const bonusAt = new Map<string, { leadin: string; parts: string[]; answers: string[]; difficultyModifiers: string[]; metadata: string }>();
  let hasBonuses = false;
  // Which bonuses each team heard, per game, and the row behind each one. The
  // source records a hearing against a TEAM rather than against the tossup that
  // earned it, and its bonus numbering drifts from the tossup numbering — 707
  // of its 10890 hearings sit on a tossup nobody converted — so the pairing has
  // to be rebuilt below rather than assumed.
  const heardBy = new Map<string, Map<string, number[]>>();
  const rowAt = new Map<string, BnResult>();
  bIdx.forEach((row, i) => {
    const d = bns[i];
    if (!d) return;
    const round = Number(d.round) || row.round, num = Number(d.num) || row.num;
    if (!Number.isInteger(round) || !Number.isInteger(num)) return;
    bump(round, num);
    hasBonuses = true;
    bonusAt.set(`${round}-${num}`, {
      leadin: d.leadin || "",
      parts: (d.parts || []).map((p) => p || ""),
      answers: (d.answers || []).map((a) => a || ""),
      // Already in reading order here, each labelled with its own difficulty, so
      // no reordering is needed (the Next.js bonus index lists parts BY
      // difficulty and has to be sorted back). One source bonus has a null in
      // this list, so coerce.
      difficultyModifiers: (d.difficultyModifiers || []).map((m) => String(m || "")),
      metadata: metaLine(d.category, d.subcategory),
    });

    // File each team's result under the game it played this round. Verified
    // against the source: no team faces two opponents in a round, so (round,
    // team) names exactly one game, and no game ever has both of its teams
    // recorded on the same bonus.
    for (const r of d.results || []) {
      if (!r || !r.team) continue;
      const key = gameOf.get(`${round}|${r.team}`);
      if (!key) continue;
      let m = heardBy.get(key);
      if (!m) { m = new Map(); heardBy.set(key, m); }
      const arr = m.get(r.team) || [];
      arr.push(num);
      m.set(r.team, arr);
      rowAt.set(`${key}|${num}`, r);
    }
  });

  // Hang each hearing off the tossup that earned it. This app credits a bonus to
  // whoever converted the tossup it sits on, so leaving a hearing on a tossup
  // that went dead drops it from that team's PPB entirely. Within one game a
  // team's bonuses and its converted tossups come in the same order, so pairing
  // them in sequence restores the link — the bonus keeps its OWN number (so the
  // per-bonus stats stay right) while sitting in the slot of the tossup that won
  // it. The source's counts line up for 1172 of its 1187 team-rounds; the other
  // 15 convert one extra tossup, always the last-numbered replacement tossup,
  // which has no bonus after it and so pairs with nothing.
  for (const [key, g] of games) {
    for (const [team, nums] of heardBy.get(key) || []) {
      const converted = [...g.buzzes.entries()]
        .filter(([, bs]) => bs.some((b) => b.team.name === team && b.result.value > 0))
        .map(([n]) => n)
        .sort((a, b) => a - b);
      nums.sort((a, b) => a - b).forEach((bnum, k) => {
        const slot = converted[k];
        const r = slot == null ? null : rowAt.get(`${key}|${bnum}`);
        // More hearings than conversions would mean the two can't be lined up;
        // drop the surplus rather than credit it to a team that didn't earn it,
        // which would put the points and the hearing count out of step.
        if (slot == null || !r || g.bonuses.has(slot)) return;
        const pts = (r.partPts || []).map((p) => Number(p) || 0);
        const bb = (r.bbPts || []).map((p) => Number(p) || 0);
        g.bonuses.set(slot, {
          team,
          num: bnum,
          parts: pts.map((p, i2) => ({ controlled_points: p, bounceback_points: bb[i2] || 0 })),
          total: Number(r.total) || pts.reduce((a, x) => a + x, 0) + bb.reduce((a, x) => a + x, 0),
        });
      });
    }
  }

  // ---- assemble ----
  // How many tossups a room normally read in each round. Every question listed
  // on a game counts as heard, so sizing games to the whole packet would report
  // the replacement tossup at the end as heard by everyone and converted almost
  // never. The source doesn't say how far each room got, but it does say how
  // many rooms heard each tossup: the ones that are part of the normal reading
  // were heard by nearly every room, and a replacement by a handful. Half the
  // round's rooms separates the two cleanly (in this source it is ~35 of 36
  // against 0-3).
  const gamesInRound = new Map<number, number>();
  for (const g of games.values()) gamesInRound.set(g.round, (gamesInRound.get(g.round) || 0) + 1);
  const standardLength = new Map<number, number>();
  for (const [round, size] of roundSize) {
    const quorum = (gamesInRound.get(round) || 0) / 2;
    let n = 0;
    for (let i = 1; i <= size; i++) if ((heardOf.get(`${round}-${i}`) ?? 0) >= quorum) n = i;
    standardLength.set(round, n);
  }

  const gameFiles: GameFile[] = [];
  for (const g of games.values()) {
    // The normal reading, plus anything this particular room went on to reach.
    const size = Math.max(standardLength.get(g.round) || 0, 0, ...g.buzzes.keys(), ...g.bonuses.keys());
    const bonusPoints = new Map<string, number>();
    for (const b of g.bonuses.values()) bonusPoints.set(b.team, (bonusPoints.get(b.team) || 0) + b.total);
    const match_teams = g.teams.map((tn) => {
      const players = [...(g.players.get(tn) || [])];
      return {
        bonus_points: bonusPoints.get(tn) || 0,
        team: { name: tn, players: players.map((name) => ({ name })) },
        match_players: players.map((name) => ({ player: { name }, tossups_heard: size })),
      };
    });
    const match_questions = [];
    for (let n = 1; n <= size; n++) {
      const bonus = g.bonuses.get(n);
      match_questions.push({
        tossup_question: { question_number: n },
        buzzes: g.buzzes.get(n) || [],
        ...(bonus ? { bonus: { question: { question_number: bonus.num }, parts: bonus.parts } } : {}),
      } as any);
    }
    gameFiles.push({ round: g.round, match_teams, match_questions });
  }

  const packets: PacketFile[] = [...roundSize.keys()].sort((a, b) => a - b).map((round) => {
    const size = roundSize.get(round)!;
    const tossups = [], bonuses = [];
    for (let n = 1; n <= size; n++) {
      tossups.push(tossupAt.get(`${round}-${n}`) || { question: "", answer: "", metadata: "" });
      bonuses.push(bonusAt.get(`${round}-${n}`) || {});
    }
    return { round, tossups, bonuses };
  });

  // No bonus pairs to chase: the text and the per-team results both came down
  // with the bonuses above, so the browser's follow-up chunk loop has no work.
  return { packets, games: gameFiles, values, pages: tIdx.length + bIdx.length + 2, hasBonuses, bonusPairs: [] };
}
