// Generic Buzzpoints aggregation. No tournament-specific logic: scoring is
// configurable (powers/negs optional via the Scoring), bonuses are optional, and
// there is no finals mapping, team-name fixup, or hard-coded scoring. Mirrors the
// richer NSC builder (opponent/ids per buzz, per-player & per-team category
// breakdowns, buzzer races, first-sentence buzzes, first/top-3 buzzes) generically.
import { Scoring, classify } from "./scoring.js";

/* ----------------------------- input shapes ----------------------------- */
export interface PacketFile {
  round: number;
  tossups: { question: string; answer: string; metadata?: string }[];
  bonuses: {
    leadin?: string;
    parts?: string[];
    answers?: string[];
    values?: number[];
    difficultyModifiers?: string[];
    metadata?: string;
    // Pre-aggregated per-part results (imports whose source only exposes bonus
    // conversion in aggregate, not per game). `got[i]` = hearings that earned
    // part i; `points` = total bonus points; `heard` = times the bonus was heard.
    stats?: { heard: number; got: number[]; points: number };
  }[];
}

export interface GameFile {
  round: number;
  match_teams?: {
    bonus_points?: number;
    team?: { name?: string; players?: { name?: string }[] };
    match_players?: { player?: { name?: string }; tossups_heard?: number }[];
  }[];
  match_questions?: {
    tossup_question?: { question_number?: number };
    buzzes?: {
      buzz_position?: { word_index?: number };
      player?: { name?: string };
      team?: { name?: string };
      result?: { value?: number };
    }[];
    bonus?: {
      question?: { question_number?: number };
      parts?: { controlled_points?: number; bounceback_points?: number }[];
    };
  }[];
}

export interface AggregateConfig {
  name: string;
  slug: string;
  scoring: Scoring;
  hasBonuses: boolean;
}

// A buzz reassignment / move keyed on the buzz's original attributes.
export interface Correction {
  round: number;
  num: number;
  team: string;
  fromPlayer: string | null;
  fromWordIndex: number | null;
  toPlayer?: string | null;
  toWordIndex?: number | null;
  by?: string;
  at?: string;
}
const corrKeyOf = (r: number, num: number, team: string | null, player: string | null, widx: number | null) =>
  `${r}|${num}|${team}|${player}|${widx}`;

// An owner-defined "virtual" (merged) category: a named group that aggregates the
// stats of one or more existing (sub)categories. `members` are subcategory path
// strings (e.g. "Fine Arts - Auditory - Opera"); a subcategory may belong to
// several virtual categories. They appear as extra top-level nodes in the tossup
// and bonus category trees without altering the underlying questions.
export interface VirtualCategory {
  name: string;
  members: string[];
}
// A full subcategory path `fs` belongs to member `m` when it is `m` itself or a
// descendant of it ("Fine Arts" matches "Fine Arts - Auditory - Opera").
const vmatchSub = (fs: string, m: string) => fs === m || fs.startsWith(m + " - ");

const SEP = "||"; // delimiter for composite (player, team[, sub]) keys
const RACE_WINDOW = 5;
const RACE_CONTEXT = 6;

/* ----------------------------- text helpers ----------------------------- */
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number, d: number) => (d ? round1((100 * n) / d) : 0);

function stripHtml(s: string): string {
  return (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}
// Pronunciation guides — parentheticals beginning with a curly quote, e.g.
// (“eye-no…”) — are not counted as words by the scorekeeper, so strip them
// before tokenizing or buzz word indices drift.
const PRON_GUIDE = /\(“[^)]*\)/g;
function wordsOf(html: string): string[] {
  return stripHtml(html).replace(PRON_GUIDE, " ").split(/\s+/).filter(Boolean);
}
function powerIndexOf(words: string[]): number | null {
  const i = words.findIndex((w) => w.includes("(*)"));
  return i >= 0 ? i : null;
}

/* sentence-end detection (best effort) */
const ABBR_NODOT = new Set([
  "mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "etc", "no", "mt", "ft",
  "gen", "col", "sgt", "rev", "prof", "capt", "lt", "gov", "sen", "rep",
  "fig", "ca", "approx", "ave", "blvd", "inc", "ltd", "co",
]);
const INITIALISM = /(?:[A-Za-z]\.){2,}$/;
const ROMAN = new Set("IVXLCDM".split(""));
function rstrip(s: string, chars: string): string {
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return s.slice(0, e);
}
function sentenceEndIndices(words: string[]): number[] {
  const ends: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = rstrip(words[i], ')"”’—');
    if (!/[.?!]$/.test(t)) continue;
    if (INITIALISM.test(t)) continue;
    const core = rstrip(t, ".?!");
    if (core.length === 1 && /[A-Za-z]/.test(core) && !ROMAN.has(core.toUpperCase())) continue;
    if (ABBR_NODOT.has(core.toLowerCase())) continue;
    ends.push(i);
  }
  return ends;
}
const firstSentenceEnd = (words: string[]) => {
  const e = sentenceEndIndices(words);
  return e.length ? e[0] : words.length - 1;
};
const nthSentenceEnd = (words: string[], n: number) => {
  const e = sentenceEndIndices(words);
  return e.length >= n ? e[n - 1] : words.length - 1;
};

/* category parsing -> (main, full subcategory) */
function parseCategory(meta?: string): [string, string] {
  if (!meta) return ["Other", "Other"];
  let s = meta.split(/<Editor/i)[0];
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  s = s.split("~")[0].split(">")[0];
  if (s.includes(",")) s = s.slice(s.indexOf(",") + 1);
  s = s.replace(/�/g, "-").replace(/\s*[–—]\s*/g, " - ");
  s = s.trim().replace(/>+$/, "").trim();
  if (!s) return ["Other", "Other"];
  const main = s.split(" - ")[0].trim();
  return [main, s];
}
function categoryMid(full: string, main: string): string {
  const parts = full.split(" - ").map((p) => p.trim());
  return parts.length >= 2 ? `${parts[0]} - ${parts[1]}` : main;
}
function levels(full: string): [string | null, string | null] {
  const parts = full.split(" - ").map((p) => p.trim());
  if (parts.length <= 1) return [null, null];
  const mid = `${parts[0]} - ${parts[1]}`;
  return [mid, parts.length >= 3 ? full : null];
}

/* ----------------------------- bad-category heuristic ----------------------------- */
// Canonical top-level quizbowl categories (and common multi-word ones), normalized
// to lowercase words. Used only to AVOID flagging legitimate categories that would
// otherwise trip the "looks like a name / too short" checks; unknown categories are
// never flagged on their own — a category must also LOOK wrong (initials, a personal
// name, or an unusually short code) to be surfaced.
const KNOWN_CATEGORIES = new Set(
  [
    "literature", "history", "science", "arts", "fine arts", "religion", "mythology",
    "philosophy", "social science", "geography", "current events", "popular culture",
    "pop culture", "trash", "general knowledge", "other", "other academic", "academic",
    "mathematics", "math", "music", "painting", "sculpture", "architecture", "film",
    "visual arts", "auditory arts", "world literature", "american literature",
    "british literature", "european literature", "long fiction", "short fiction", "poetry",
    "drama", "physics", "biology", "chemistry", "astronomy", "earth science", "geology",
    "computer science", "economics", "psychology", "sociology", "anthropology",
    "political science", "law", "linguistics", "thought", "world history", "american history",
    "european history", "ancient history", "world", "american", "european", "religion mythology philosophy",
    "rmp", "rmpss", "myth", "social studies", "sports", "entertainment", "science math",
  ].map((s) => s.replace(/[^a-z]+/g, " ").trim())
);
const normCat = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();

export interface CategoryWarning { category: string; count: number; reason: string; examples: string[] }

// Heuristic scan for likely-mislabeled tossup categories. The classic failure is a
// packet whose "category" column actually holds author initials ("AK") or names,
// so the aggregated stats show categories like "AK" instead of "History". We flag a
// parsed main category when it looks like initials (1–3 letters, e.g. "AK", "J.B."),
// a personal name ("John Keats"), or an unusually short code — none of which are
// real subjects. Advisory only; nothing is blocked or altered.
export function scanCategoryQuality(tossups: Map<string, TUStat>): CategoryWarning[] {
  const byMain = new Map<string, { count: number; examples: string[] }>();
  for (const t of tossups.values()) {
    const m = (t.category || "").trim();
    let e = byMain.get(m);
    if (!e) { e = { count: 0, examples: [] }; byMain.set(m, e); }
    e.count++;
    if (e.examples.length < 3) { const a = stripHtml(t.answer).trim(); if (a) e.examples.push(a.length > 60 ? a.slice(0, 57) + "…" : a); }
  }
  const isInitials = (s: string) => {
    const c = s.replace(/[. \s]/g, "");
    return c.length >= 1 && c.length <= 3 && /^[A-Za-z]+$/.test(c) && c === c.toUpperCase();
  };
  const looksLikeName = (s: string) => /^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z']+$/.test(s.trim());

  // A personal name ("John Keats") is also a valid-looking two-word subject phrase
  // ("Vocal Music"), so we only trust the name signal when the set already carries
  // several initials-style categories — i.e. the category column clearly holds
  // people, not subjects. Otherwise we'd flag legitimate two-word categories.
  const distinctInitials = [...byMain.keys()].filter((m) => m && isInitials(m)).length;
  const nameFlagOn = distinctInitials >= 2;

  const out: CategoryWarning[] = [];
  for (const [m, e] of byMain) {
    if (!m || normCat(m) === "other") continue; // blank/"Other" is the generic fallback, not a mislabel
    if (KNOWN_CATEGORIES.has(normCat(m))) continue;
    let reason = "";
    if (isInitials(m)) reason = "looks like author initials, not a subject category";
    else if (nameFlagOn && looksLikeName(m)) reason = "looks like a person's name, not a subject category";
    else if (m.length <= 4 && /^[A-Za-z.]+$/.test(m)) reason = "unusually short — may be an abbreviation or code, not a subject";
    if (reason) out.push({ category: m, count: e.count, reason, examples: e.examples });
  }
  out.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  return out.slice(0, 25);
}

/* generic 3-level category tree (main -> subcategory -> sub-subcategory) */
type TreeNode = Record<string, unknown> & { category: string; heard: number; subs: SubNode[] };
type SubNode = Record<string, unknown> & { subcategory: string; subLabel: string; leaves?: SubNode[] };
function buildCategoryTree<A extends { main: string }>(
  subStats: Map<string, A>,
  newAcc: () => A,
  addAcc: (acc: A, s: A) => void,
  fin: (acc: A) => Record<string, unknown>
): TreeNode[] {
  type Mid = { acc: A; gen: A; genHas: boolean; leaves: Map<string, A>; label: string };
  type Node = { acc: A; gen: A; genHas: boolean; mids: Map<string, Mid> };
  const mains = new Map<string, Node>();
  for (const [full, s] of subStats) {
    const m = s.main;
    let node = mains.get(m);
    if (!node) { node = { acc: newAcc(), gen: newAcc(), genHas: false, mids: new Map() }; mains.set(m, node); }
    addAcc(node.acc, s);
    const [mid, leaf] = levels(full);
    if (mid === null) { addAcc(node.gen, s); node.genHas = true; continue; }
    let mnode = node.mids.get(mid);
    if (!mnode) { mnode = { acc: newAcc(), gen: newAcc(), genHas: false, leaves: new Map(), label: mid.split(" - ").slice(1).join(" - ") }; node.mids.set(mid, mnode); }
    addAcc(mnode.acc, s);
    if (leaf === null) { addAcc(mnode.gen, s); mnode.genHas = true; }
    else { let lacc = mnode.leaves.get(leaf); if (!lacc) { lacc = newAcc(); mnode.leaves.set(leaf, lacc); } addAcc(lacc, s); }
  }
  const out: TreeNode[] = [];
  for (const [m, node] of mains) {
    const subs: SubNode[] = [];
    for (const [mid, mnode] of node.mids) {
      const leaves: SubNode[] = [];
      for (const [leaf, lacc] of mnode.leaves)
        leaves.push({ subcategory: leaf, subLabel: leaf.split(" - ").slice(-1)[0], ...fin(lacc) });
      if (mnode.genHas && leaves.length) leaves.push({ subcategory: mid, subLabel: "(general)", ...fin(mnode.gen) });
      leaves.sort((a, b) => a.subLabel.toLowerCase().localeCompare(b.subLabel.toLowerCase()));
      subs.push({ subcategory: mid, subLabel: mnode.label, ...fin(mnode.acc), leaves });
    }
    if (node.genHas) subs.push({ subcategory: m, subLabel: "(general)", ...fin(node.gen), leaves: [] });
    subs.sort((a, b) => a.subLabel.toLowerCase().localeCompare(b.subLabel.toLowerCase()));
    out.push({ category: m, ...fin(node.acc), subs } as TreeNode);
  }
  out.sort((a, b) => b.heard - a.heard);
  return out;
}

// Build a single synthetic top-level node for a virtual (merged) category by
// aggregating every subcategory that matches one of its members. Each member
// becomes a sub-row (its own aggregate); the main row aggregates the union of all
// members (each matched subcategory counted once, even if two members overlap).
// Returns null when no member matches any data in this tree.
function buildVirtualNode<A>(
  name: string,
  members: string[],
  subStats: Map<string, A>,
  newAcc: () => A,
  addAcc: (acc: A, s: A) => void,
  fin: (acc: A) => Record<string, unknown>
): TreeNode | null {
  const mainAcc = newAcc();
  const seen = new Set<string>();
  const subs: SubNode[] = [];
  for (const m of members) {
    const memAcc = newAcc();
    let has = false;
    for (const [fs, s] of subStats) {
      if (!vmatchSub(fs, m)) continue;
      addAcc(memAcc, s);
      has = true;
      if (!seen.has(fs)) { seen.add(fs); addAcc(mainAcc, s); }
    }
    if (has) subs.push({ subcategory: m, subLabel: m.split(" - ").slice(-1)[0].trim(), ...fin(memAcc), leaves: [] });
  }
  if (!subs.length) return null;
  subs.sort((a, b) => a.subLabel.toLowerCase().localeCompare(b.subLabel.toLowerCase()));
  const main = fin(mainAcc);
  return { category: name, ...main, heard: Number(main.heard) || 0, subs, virtual: true } as TreeNode;
}

/* ----------------------------- bonus category helpers ----------------------------- */
const DIFF_NAME: Record<string, string> = { e: "Easy", m: "Medium", h: "Hard" };
const diffPct = (parts: Map<string, [number, number]>, d: string) => { const [g, t] = parts.get(d) || [0, 0]; return pct(g, t); };
const bnFin = (a: CatBnAcc) => ({ heard: a.heard, ppb: a.heard ? Math.round((100 * a.pts) / a.heard) / 100 : 0, easyPct: diffPct(a.parts, "e"), medPct: diffPct(a.parts, "m"), hardPct: diffPct(a.parts, "h") });
const bnAdd = (a: CatBnAcc, s: CatBnAcc) => { a.main = a.main || s.main; a.heard += s.heard; a.pts += s.pts; for (const [d, gt] of s.parts) { const slot = a.parts.get(d) || [0, 0]; slot[0] += gt[0]; slot[1] += gt[1]; a.parts.set(d, slot); } };
const bnNew = (): CatBnAcc => ({ main: "", heard: 0, pts: 0, parts: new Map() });

/* ----------------------------- accumulators ----------------------------- */
interface TUStat { round: number; num: number; questionHtml: string; answer: string; category: string; subcategory: string; categoryMid: string; words: string[]; wordCount: number; powerIndex: number | null; }
interface BNStat { round: number; num: number; leadin: string; parts: string[]; answers: string[]; difficultyModifiers: string[]; category: string; subcategory: string; }
type Buzz = { player: string | null; team: string | null; value: number; wordIndex: number | null; opponent?: string | null; origPlayer?: string | null; origWordIndex?: number | null; firstInRoom?: boolean; };
type CatAcc = { powers: number; gets: number; incorrect: number; points: number; posSum: number; posN: number; earliest: number | null };
const newCatAcc = (): CatAcc => ({ powers: 0, gets: 0, incorrect: 0, points: 0, posSum: 0, posN: 0, earliest: null });
type CatTuAcc = { main: string; heard: number; powers: number; gets: number; buzzSum: number; buzzN: number; firstConv: number; secondConv: number; incorrectBefore: number };
type CatBnAcc = { main: string; heard: number; pts: number; parts: Map<string, [number, number]> };
type TuCat = CatAcc & { main: string };
type BnCat = { heard: number; pts: number; main: string; parts: Map<string, [number, number]> };

/* ----------------------------- main ----------------------------- */
export function aggregate(
  packets: PacketFile[],
  games: GameFile[],
  cfg: AggregateConfig,
  corrections: Correction[] = [],
  virtualCats: VirtualCategory[] = []
): Record<string, unknown> {
  const scoring = cfg.scoring;
  const hasPower = scoring.hasPower;
  const tierOf = (v: number) => classify(v, scoring);
  const isPower = (v: number) => tierOf(v) === "power";
  const isGet = (v: number) => tierOf(v) === "get";
  const isCorrect = (v: number) => v > 0; // power or get
  const imprecise = (v: number, widx: number | null, pIdx: number | null) =>
    hasPower && isGet(v) && pIdx !== null && widx !== null && widx < pIdx;
  // The "neg"/incorrect stat counts penalized wrong buzzes. A 0-point buzz is NOT
  // a neg — it carries no penalty — so in a neg format it must not inflate neg
  // counts (a wrong buzz there is negative). In a no-neg format a wrong buzz
  // scores 0, so those 0s ARE the incorrect buzzes we want to count.
  const countsNeg = (v: number) => (scoring.hasNeg ? v < 0 : v <= 0);

  const corrMap = new Map<string, Correction>();
  for (const c of corrections) corrMap.set(corrKeyOf(c.round, c.num, c.team, c.fromPlayer, c.fromWordIndex), c);

  const tossups = new Map<string, TUStat>();
  const bonuses = new Map<string, BNStat>();
  for (const p of packets) {
    const r = p.round;
    (p.tossups || []).forEach((t, i) => {
      const num = i + 1;
      const [main, sub] = parseCategory(t.metadata);
      const words = wordsOf(t.question);
      tossups.set(`${r}-${num}`, {
        round: r, num, questionHtml: t.question, answer: t.answer,
        category: main, subcategory: sub, categoryMid: categoryMid(sub, main),
        words, wordCount: words.length, powerIndex: powerIndexOf(words),
      });
    });
    if (cfg.hasBonuses)
      (p.bonuses || []).forEach((b, i) => {
        const num = i + 1;
        const [main, sub] = parseCategory(b.metadata);
        bonuses.set(`${r}-${num}`, {
          round: r, num, leadin: b.leadin || "", parts: b.parts || [], answers: b.answers || [],
          difficultyModifiers: b.difficultyModifiers || [], category: main, subcategory: sub,
        });
      });
  }

  const tuBuzzes = new Map<string, Buzz[]>();
  const tuHeard = new Map<string, number>();
  const bnResults = new Map<string, { team: string | null; partPts: number[]; bbPts: number[]; total: number }[]>();

  type PL = { name: string; team: string; games: Set<string>; tuh: number; powers: number; gets: number; incorrect: number; pts: number };
  const pl = new Map<string, PL>();
  type TM = { games: number; wins: number; losses: number; ties: number; tuPts: number; bonusPts: number; bonusesHeard: number; powers: number; gets: number; incorrect: number; tuh: number };
  const tm = new Map<string, TM>();
  const rosters = new Map<string, Set<string>>();
  const plCat = new Map<string, Map<string, CatAcc>>();      // player -> categoryMid -> acc
  const plFullCat = new Map<string, Map<string, CatAcc>>();  // player -> full sub -> acc
  const plBuzzes = new Map<string, { round: number; num: number; value: number; widx: number | null; rebound: boolean }[]>();
  const tmBonusCat = new Map<string, Map<string, BnCat>>();
  const tmTuCat = new Map<string, Map<string, TuCat>>();

  const plKey = (n: string, t: string | null) => `${n}${SEP}${t}`;
  const plOf = (name: string, team: string): PL => {
    const k = plKey(name, team);
    let v = pl.get(k);
    if (!v) { v = { name, team, games: new Set(), tuh: 0, powers: 0, gets: 0, incorrect: 0, pts: 0 }; pl.set(k, v); }
    return v;
  };
  const tmOf = (k: string): TM => { let v = tm.get(k); if (!v) { v = { games: 0, wins: 0, losses: 0, ties: 0, tuPts: 0, bonusPts: 0, bonusesHeard: 0, powers: 0, gets: 0, incorrect: 0, tuh: 0 }; tm.set(k, v); } return v; };
  const nestCat = <V>(m: Map<string, Map<string, V>>, k: string, sub: string, make: () => V): V => {
    let inner = m.get(k); if (!inner) { inner = new Map(); m.set(k, inner); }
    let v = inner.get(sub); if (!v) { v = make(); inner.set(sub, v); } return v;
  };
  const addCat = (c: CatAcc, value: number, widx: number | null, prec: boolean) => {
    if (isPower(value)) c.powers++; else if (isGet(value)) c.gets++; else if (countsNeg(value)) c.incorrect++;
    c.points += value;
    if (prec && widx !== null) { c.posSum += widx; c.posN++; c.earliest = c.earliest === null ? widx : Math.min(c.earliest, widx); }
  };

  for (const g of games) {
    const r = g.round;
    const teamNames = (g.match_teams || []).map((t) => t.team?.name).filter(Boolean) as string[];
    const gameId = `${r}:` + [...teamNames].sort().join("|");
    const gamePts = new Map<string, number>();
    const addGamePts = (t: string, v: number) => gamePts.set(t, (gamePts.get(t) || 0) + v);

    for (const mt of g.match_teams || []) {
      const tname = mt.team?.name;
      if (!tname) continue;
      const t = tmOf(tname);
      t.games += 1;
      t.bonusPts += mt.bonus_points || 0;
      addGamePts(tname, mt.bonus_points || 0);
      let rs = rosters.get(tname);
      if (!rs) { rs = new Set(); rosters.set(tname, rs); }
      for (const p of mt.team?.players || []) if (p?.name) rs.add(p.name);
      for (const mp of mt.match_players || []) {
        const pname = mp.player?.name;
        if (!pname) continue;
        rs.add(pname);
        const pv = plOf(pname, tname);
        pv.games.add(gameId);
        pv.tuh += mp.tossups_heard || 0;
        t.tuh += mp.tossups_heard || 0;
      }
    }

    for (const mq of g.match_questions || []) {
      const tnum = mq.tossup_question?.question_number;
      const key = tnum != null ? `${r}-${tnum}` : null;
      const tq = key ? tossups.get(key) : undefined;
      if (tq) tuHeard.set(key!, (tuHeard.get(key!) || 0) + 1);
      let converted = false;
      let controlling: string | null = null;
      const ordered: { value: number; pname: string | null; bteam: string | null; widx: number | null }[] = [];

      for (const bz of mq.buzzes || []) {
        const value = bz.result?.value ?? 0;
        const origPlayer = bz.player?.name ?? null;
        const origWordIndex = bz.buzz_position?.word_index ?? null;
        let pname = origPlayer;
        const bteam = bz.team?.name ?? null;
        let widx = origWordIndex;
        if (tnum != null) {
          const c = corrMap.get(corrKeyOf(r, tnum, bteam, origPlayer, origWordIndex));
          if (c) { if (c.toPlayer !== undefined) pname = c.toPlayer; if (c.toWordIndex !== undefined) widx = c.toWordIndex; }
        }
        // A buzz's word index is relative to the exact wording the player heard. In
        // the combined view of a multi-edition set the canonical wording may be a
        // different length (a mirror reworded the same question), which would render
        // the buzz past the end of the shown text. Pin those to the last word so
        // positions stay within the question. Per-edition views use that edition's
        // own wording, so this is a no-op there.
        if (tq && widx !== null && widx >= tq.wordCount) widx = tq.wordCount - 1;
        ordered.push({ value, pname, bteam, widx });
        if (tq) {
          const opp = teamNames.find((t) => t !== bteam) ?? null;
          let arr = tuBuzzes.get(key!); if (!arr) { arr = []; tuBuzzes.set(key!, arr); }
          // `ordered` already has this buzz appended above, so length === 1 means
          // it's the first buzz of this room's reading. Later buzzes only happen
          // after an earlier team negged and the reader resumed, so they aren't a
          // genuine same-clue race — the buzzer-race view excludes them.
          arr.push({ player: pname, team: bteam, value, wordIndex: widx, opponent: opp, origPlayer, origWordIndex, firstInRoom: ordered.length === 1 });
        }
        if (pname) {
          const pv = plOf(pname, bteam || "");
          if (isPower(value)) pv.powers++; else if (isGet(value)) pv.gets++; else if (countsNeg(value)) pv.incorrect++;
          pv.pts += value;
          if (tq) {
            const prec = isCorrect(value) && !imprecise(value, widx, tq.powerIndex);
            addCat(nestCat(plCat, plKey(pname, bteam || ""), tq.categoryMid, newCatAcc), value, widx, prec);
            addCat(nestCat(plFullCat, plKey(pname, bteam || ""), tq.subcategory, newCatAcc), value, widx, prec);
          }
        }
        if (bteam) {
          const t = tmOf(bteam);
          if (isPower(value)) t.powers++; else if (isGet(value)) t.gets++; else if (countsNeg(value)) t.incorrect++;
          t.tuPts += value;
          addGamePts(bteam, value);
          if (tq) {
            const tc = nestCat<TuCat>(tmTuCat, bteam, tq.subcategory, () => ({ ...newCatAcc(), main: tq.category }));
            tc.main = tq.category;
            addCat(tc, value, widx, isCorrect(value) && !imprecise(value, widx, tq.powerIndex));
          }
        }
        if (isCorrect(value)) { converted = true; controlling = bteam; }
      }

      // per-player buzz log (chronological, with rebound detection)
      if (tq) {
        const sorted = [...ordered].sort((a, b) => (a.widx === null ? 1 : 0) - (b.widx === null ? 1 : 0) || (a.widx ?? 0) - (b.widx ?? 0));
        const negged = new Set<string>();
        for (const o of sorted) {
          if (o.pname) {
            const kk = plKey(o.pname, o.bteam || "");
            let arr = plBuzzes.get(kk); if (!arr) { arr = []; plBuzzes.set(kk, arr); }
            arr.push({ round: r, num: tnum!, value: o.value, widx: o.widx, rebound: isCorrect(o.value) && [...negged].some((tt) => tt !== o.bteam) });
          }
          if (!isCorrect(o.value) && o.bteam) negged.add(o.bteam);
        }
      }

      if (cfg.hasBonuses && mq.bonus && converted) {
        const bnum = mq.bonus.question?.question_number;
        const bkey = bnum != null ? `${r}-${bnum}` : null;
        const bdef = bkey ? bonuses.get(bkey) : undefined;
        if (bdef && bkey) {
          const parts = mq.bonus.parts || [];
          const partPts = parts.map((p) => p.controlled_points || 0);
          const bbPts = parts.map((p) => p.bounceback_points || 0);
          const total = partPts.reduce((a, b) => a + b, 0) + bbPts.reduce((a, b) => a + b, 0);
          let arr = bnResults.get(bkey); if (!arr) { arr = []; bnResults.set(bkey, arr); }
          arr.push({ team: controlling, partPts, bbPts, total });
          if (controlling) {
            tmOf(controlling).bonusesHeard += 1;
            const tbc = nestCat<BnCat>(tmBonusCat, controlling, bdef.subcategory, () => ({ heard: 0, pts: 0, main: bdef.category, parts: new Map() }));
            tbc.main = bdef.category; tbc.heard++; tbc.pts += total;
            for (let i = 0; i < parts.length; i++) {
              const got = (partPts[i] || 0) + (bbPts[i] || 0);
              const diff = bdef.difficultyModifiers[i] || "m";
              const slot = tbc.parts.get(diff) || [0, 0];
              slot[1] += 1; if (got > 0) slot[0] += 1;
              tbc.parts.set(diff, slot);
            }
          }
        }
      }
    }

    if (teamNames.length === 2) {
      const [a, b] = teamNames;
      const pa = gamePts.get(a) || 0, pb = gamePts.get(b) || 0;
      if (pa > pb) { tmOf(a).wins++; tmOf(b).losses++; }
      else if (pb > pa) { tmOf(b).wins++; tmOf(a).losses++; }
      else { tmOf(a).ties++; tmOf(b).ties++; }
    }
  }

  /* ----------------------------- ids ----------------------------- */
  const teamId = new Map<string, string>();
  [...tm.keys()].sort().forEach((name, i) => teamId.set(name, `t${i}`));
  const playerId = new Map<string, string>();
  [...pl.keys()].forEach((k, i) => playerId.set(k, `p${i}`));

  /* ----------------------------- first / top-3 buzzes ----------------------------- */
  const firstPl = new Map<string, number>(), top3Pl = new Map<string, number>();
  const firstTm = new Map<string, number>(), top3Tm = new Map<string, number>();
  const firstPlfc = new Map<string, number>(), top3Plfc = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
  // #elements strictly less than x in a sorted array (each correct buzz's rank).
  const lowerBound = (arr: number[], x: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
  const tuCorrect = new Map<string, number[]>(); // sorted widx of reliably-placed correct buzzes
  for (const [k, blist] of tuBuzzes) {
    const t = tossups.get(k);
    const P = t ? t.powerIndex : null;
    const sub = t ? t.subcategory : null;
    // "1st buzz" / "top-3 buzz" credit the fastest CORRECT answerers in the field.
    // A neg is often the earliest buzz on a tossup, but it must never count as a
    // first/top-3 buzz — otherwise these totals disagree with the per-buzz ranks
    // shown on each player's page (buzzRowsFor ranks among correct buzzes only)
    // and neggers get spurious "first buzz" credit.
    const correct = blist.filter((b) => isCorrect(b.value) && b.wordIndex !== null && !imprecise(b.value, b.wordIndex, P)).sort((a, b) => a.wordIndex! - b.wordIndex!);
    const positions = correct.map((b) => b.wordIndex!);
    tuCorrect.set(k, positions);
    if (!correct.length) continue;
    // Rank each correct buzz among the field by position, ties sharing a rank
    // (rank = #correct buzzes strictly earlier + 1) — identical to the per-buzz
    // rank shown on the player page, so header totals and the buzz list agree.
    for (const b of correct) {
      if (!b.player) continue;
      const rank = lowerBound(positions, b.wordIndex!) + 1;
      const pk = plKey(b.player, b.team || "");
      if (rank === 1) { bump(firstPl, pk); if (b.team) bump(firstTm, b.team); if (sub) bump(firstPlfc, `${pk}${SEP}${sub}`); }
      if (rank <= 3) { bump(top3Pl, pk); if (b.team) bump(top3Tm, b.team); if (sub) bump(top3Plfc, `${pk}${SEP}${sub}`); }
    }
  }

  const files: Record<string, unknown> = {};

  /* ----------------------------- tossups + detail ----------------------------- */
  const tuSumm: Record<string, unknown>[] = [];
  const tuDetail: Record<string, unknown> = {};
  const catTuSub = new Map<string, CatTuAcc>();
  for (const [id, t] of [...tossups.entries()].sort()) {
    const heard = tuHeard.get(id) || 0;
    const buzzes = tuBuzzes.get(id) || [];
    const P = t.powerIndex;
    const powers = buzzes.filter((b) => isPower(b.value)).length;
    const gets = buzzes.filter((b) => isGet(b.value)).length;
    const correct = buzzes.filter((b) => isCorrect(b.value) && !imprecise(b.value, b.wordIndex, P));
    const wc = t.wordCount || 1;
    const fracs = correct.filter((b) => b.wordIndex !== null).map((b) => b.wordIndex! / wc);
    const avgFrac = fracs.length ? fracs.reduce((a, b) => a + b, 0) / fracs.length : null;
    const impreciseN = buzzes.filter((b) => imprecise(b.value, b.wordIndex, P)).length;
    const end1 = firstSentenceEnd(t.words), end2 = nthSentenceEnd(t.words, 2);
    const firstConv = correct.filter((b) => b.wordIndex !== null && b.wordIndex <= end1).length;
    const secondConv = correct.filter((b) => b.wordIndex !== null && b.wordIndex <= end2).length;
    const lastWord = (t.wordCount || 1) - 1;
    const incorrectBefore = buzzes.filter((b) => !isCorrect(b.value) && b.wordIndex !== null && b.wordIndex < lastWord).length;
    const detailBuzzes = buzzes.map((b) => ({
      player: b.player, team: b.team, value: b.value, wordIndex: b.wordIndex, opponent: b.opponent ?? null,
      imprecise: imprecise(b.value, b.wordIndex, P),
      playerId: b.player ? playerId.get(plKey(b.player, b.team || "")) ?? null : null,
      teamId: b.team ? teamId.get(b.team) ?? null : null,
      opponentId: b.opponent ? teamId.get(b.opponent) ?? null : null,
      origPlayer: b.origPlayer ?? null, origWordIndex: b.origWordIndex ?? null,
    })).sort((a, b) => (a.wordIndex === null ? 1 : 0) - (b.wordIndex === null ? 1 : 0) || (a.wordIndex ?? 0) - (b.wordIndex ?? 0));
    const convPct = pct(powers + gets, heard);
    tuSumm.push({
      id, round: t.round, num: t.num, answer: t.answer, category: t.category, subcategory: t.subcategory,
      heard, powers, gets, convPct, powerPct: pct(powers, heard), incorrectPct: pct(incorrectBefore, heard),
      avgBuzzPct: avgFrac == null ? null : round1(100 * avgFrac),
    });
    tuDetail[id] = {
      id, round: t.round, num: t.num, answer: t.answer, questionHtml: t.questionHtml,
      category: t.category, subcategory: t.subcategory, words: t.words, powerIndex: t.powerIndex, wordCount: t.wordCount,
      heard, powers, gets, convPct, powerPct: pct(powers, heard), incorrectPct: pct(incorrectBefore, heard),
      avgBuzzPct: avgFrac == null ? null : round1(100 * avgFrac), impreciseCount: impreciseN, buzzes: detailBuzzes,
    };
    let cs = catTuSub.get(t.subcategory);
    if (!cs) { cs = { main: t.category, heard: 0, powers: 0, gets: 0, buzzSum: 0, buzzN: 0, firstConv: 0, secondConv: 0, incorrectBefore: 0 }; catTuSub.set(t.subcategory, cs); }
    cs.main = t.category; cs.heard += heard; cs.powers += powers; cs.gets += gets;
    cs.firstConv += firstConv; cs.secondConv += secondConv; cs.incorrectBefore += incorrectBefore;
    if (avgFrac != null) { cs.buzzSum += fracs.reduce((a, b) => a + b, 0); cs.buzzN += fracs.length; }
  }
  files["tossups.json"] = tuSumm;
  files["tossups_detail.json"] = tuDetail;

  /* ----------------------------- bonuses + detail ----------------------------- */
  if (cfg.hasBonuses) {
    const bnSumm: Record<string, unknown>[] = [];
    const bnDetail: Record<string, unknown> = {};
    const catBnSub = new Map<string, CatBnAcc>();
    for (const [id, b] of [...bonuses.entries()].sort()) {
      const results = bnResults.get(id) || [];
      const heard = results.length;
      const totalPts = results.reduce((a, r) => a + r.total, 0);
      const ppb = heard ? Math.round((100 * totalPts) / heard) / 100 : 0;
      const partConv: Record<string, unknown>[] = [];
      const byDiff: Record<string, { answer: string; convPct: number }> = {};
      let cb = catBnSub.get(b.subcategory);
      if (!cb) { cb = bnNew(); cb.main = b.category; catBnSub.set(b.subcategory, cb); }
      for (let i = 0; i < b.parts.length; i++) {
        const got = results.filter((r) => (r.partPts[i] || 0) > 0 || (r.bbPts[i] || 0) > 0).length;
        const diff = b.difficultyModifiers[i] || "m";
        const row = { idx: i, difficulty: diff, difficultyName: DIFF_NAME[diff] || "Medium", answer: b.answers[i] || "", part: b.parts[i] || "", convPct: pct(got, heard), convCount: got };
        partConv.push(row);
        if (!byDiff[diff]) byDiff[diff] = { answer: row.answer, convPct: row.convPct };
        const slot = cb.parts.get(diff) || [0, 0]; slot[0] += got; slot[1] += heard; cb.parts.set(diff, slot);
      }
      cb.main = b.category; cb.heard += heard; cb.pts += totalPts;
      bnSumm.push({
        id, round: b.round, num: b.num, category: b.category, subcategory: b.subcategory, heard, ppb,
        easyPct: byDiff.e?.convPct ?? null, medPct: byDiff.m?.convPct ?? null, hardPct: byDiff.h?.convPct ?? null,
        easyAnswer: byDiff.e?.answer ?? null, medAnswer: byDiff.m?.answer ?? null, hardAnswer: byDiff.h?.answer ?? null,
      });
      bnDetail[id] = {
        id, round: b.round, num: b.num, category: b.category, subcategory: b.subcategory, leadin: b.leadin,
        parts: b.parts, answers: b.answers, difficultyModifiers: b.difficultyModifiers, heard, ppb, totalPts, partConv, results,
      };
    }
    files["bonuses.json"] = bnSumm;
    files["bonuses_detail.json"] = bnDetail;
    const bnTree = buildCategoryTree<CatBnAcc>(catBnSub, bnNew, bnAdd, bnFin);
    for (const v of virtualCats) {
      const node = buildVirtualNode<CatBnAcc>(v.name, v.members, catBnSub, bnNew, bnAdd, bnFin);
      if (node) bnTree.push(node);
    }
    files["categories_bonus.json"] = bnTree;
  }

  /* ----------------------------- players (list + detail) ----------------------------- */
  const catStatRows = (catMap: Map<string, CatAcc> | undefined, totalPts: number) => {
    const rows = [...(catMap || new Map<string, CatAcc>()).entries()].map(([cat, c]) => ({
      category: cat, powers: c.powers, gets: c.gets, incorrect: c.incorrect, points: c.points,
      earliest: c.earliest === null ? null : c.earliest + 1,
      avgBuzz: c.posN ? round1(c.posSum / c.posN + 1) : null,
      pctPoints: totalPts ? round1((100 * c.points) / totalPts) : 0,
    }));
    rows.sort((a, b) => a.category.toLowerCase().localeCompare(b.category.toLowerCase()));
    return rows;
  };
  const buzzRowsFor = (name: string, team: string) => {
    const rows = (plBuzzes.get(plKey(name, team)) || []).map((rec) => {
      const t = tossups.get(`${rec.round}-${rec.num}`);
      if (!t) return null;
      const corr = isCorrect(rec.value) && rec.widx !== null && !imprecise(rec.value, rec.widx, t.powerIndex);
      const rank = corr ? lowerBound(tuCorrect.get(`${rec.round}-${rec.num}`) || [], rec.widx!) + 1 : null;
      return {
        id: `${rec.round}-${rec.num}`, round: rec.round, num: rec.num, category: t.categoryMid, answer: t.answer,
        buzzpoint: rec.widx === null ? null : rec.widx + 1, value: rec.value, rank,
        first: rank === 1, top3: rank !== null && rank <= 3, rebound: rec.rebound,
      };
    }).filter(Boolean) as Record<string, unknown>[];
    rows.sort((a, b) => (a.round as number) - (b.round as number) || (a.num as number) - (b.num as number));
    return rows;
  };

  const players: Record<string, unknown>[] = [];
  const plDetail: Record<string, unknown> = {};
  const teamRoster = new Map<string, Record<string, unknown>[]>();
  let pidx = 0;
  for (const [k, s] of pl) {
    const pid = `p${pidx++}`;
    const g = s.games.size;
    // Rebounds: tossups this player converted after another team had buzzed wrong
    // (already flagged per-buzz in the buzz log).
    const rebounds = (plBuzzes.get(k) || []).filter((b) => b.rebound).length;
    const row = {
      id: pid, name: s.name, team: s.team, teamId: teamId.get(s.team) ?? null,
      games: g, tuh: s.tuh, powers: s.powers, gets: s.gets, incorrect: s.incorrect, pts: s.pts,
      firstBuzzes: firstPl.get(k) || 0, top3Buzzes: top3Pl.get(k) || 0, rebounds,
      ppg: g ? round1(s.pts / g) : 0, pPerTuh: s.tuh ? Math.round((100 * s.pts) / s.tuh) / 100 : 0,
    };
    players.push(row);
    if (!teamRoster.has(s.team)) teamRoster.set(s.team, []);
    teamRoster.get(s.team)!.push(row);
    plDetail[pid] = { ...row, categories: catStatRows(plCat.get(k), s.pts || 0), buzzes: buzzRowsFor(s.name, s.team) };
  }
  players.sort((a, b) => (b.ppg as number) - (a.ppg as number));
  files["players.json"] = players;
  files["players_detail.json"] = plDetail;

  /* ----------------------------- teams (list + detail) ----------------------------- */
  const tutNew = (): TuCat => ({ ...newCatAcc(), main: "" });
  const tutAdd = (a: TuCat, s: TuCat) => { a.main = a.main || s.main; a.powers += s.powers; a.gets += s.gets; a.incorrect += s.incorrect; a.points += s.points; a.posSum += s.posSum; a.posN += s.posN; if (s.earliest !== null) a.earliest = a.earliest === null ? s.earliest : Math.min(a.earliest, s.earliest); };
  const tutFin = (totalPts: number) => (a: TuCat) => ({
    heard: a.powers + a.gets + a.incorrect, powers: a.powers, gets: a.gets, incorrect: a.incorrect, points: a.points,
    earliest: a.earliest === null ? null : a.earliest + 1, avgBuzz: a.posN ? round1(a.posSum / a.posN + 1) : null,
    pctPoints: totalPts ? round1((100 * a.points) / totalPts) : 0,
  });

  const teams: Record<string, unknown>[] = [];
  const tmDetail: Record<string, unknown> = {};
  for (const [name, s] of tm) {
    const g = s.games;
    const totpts = s.tuPts + s.bonusPts;
    const tid = teamId.get(name)!;
    const row = {
      id: tid, name, games: g, wins: s.wins, losses: s.losses, ties: s.ties, pts: totpts, tuPts: s.tuPts, bonusPts: s.bonusPts,
      ppg: g ? round1(totpts / g) : 0, powers: s.powers, gets: s.gets, incorrect: s.incorrect,
      firstBuzzes: firstTm.get(name) || 0, top3Buzzes: top3Tm.get(name) || 0,
      bonusesHeard: s.bonusesHeard, ppb: s.bonusesHeard ? Math.round((100 * s.bonusPts) / s.bonusesHeard) / 100 : 0,
      pp20tuh: s.tuh ? round1((20 * s.tuPts) / s.tuh) : 0,
    };
    teams.push(row);
    const roster = (teamRoster.get(name) || []).slice().sort((a, b) => (b.pts as number) - (a.pts as number))
      .map((p) => ({ id: p.id, name: p.name, games: p.games, pts: p.pts, ppg: p.ppg, powers: p.powers, gets: p.gets, incorrect: p.incorrect }));
    const bnCatMap = new Map<string, CatBnAcc>();
    for (const [sub, v] of tmBonusCat.get(name) || new Map<string, BnCat>()) bnCatMap.set(sub, { main: v.main, heard: v.heard, pts: v.pts, parts: v.parts });
    tmDetail[tid] = {
      ...row,
      categories: buildCategoryTree<TuCat>(tmTuCat.get(name) || new Map(), tutNew, tutAdd, tutFin(s.tuPts)),
      bonusCategories: cfg.hasBonuses ? buildCategoryTree<CatBnAcc>(bnCatMap, bnNew, bnAdd, bnFin) : [],
      roster,
    };
  }
  // Rank each team within every category node by total points, so a team's
  // category breakdown can show "rank of N" against the other teams that played
  // the same category. Levels are kept separate (main vs sub vs leaf) so a main
  // and its "(general)" sub — which share a key string — don't get pooled.
  {
    type RankEntry = { tid: string; points: number };
    const groups = new Map<string, RankEntry[]>();
    const push = (key: string, tid: string, points: number) => {
      let a = groups.get(key); if (!a) { a = []; groups.set(key, a); } a.push({ tid, points });
    };
    // collect
    for (const tid in tmDetail) {
      const cats = (tmDetail[tid] as any).categories as Record<string, any>[];
      for (const m of cats) {
        push(`0|${m.category}`, tid, m.points);
        for (const s of m.subs as Record<string, any>[]) {
          push(`1|${s.subcategory}`, tid, s.points);
          for (const lf of (s.leaves || []) as Record<string, any>[]) push(`2|${lf.subcategory}`, tid, lf.points);
        }
      }
    }
    // rank within each group (descending points; ties share a rank)
    const rankByKey = new Map<string, { ranks: Map<string, number>; total: number }>();
    for (const [key, arr] of groups) {
      arr.sort((a, b) => b.points - a.points);
      const ranks = new Map<string, number>();
      let rank = 0, seen = 0, prev = NaN;
      for (const e of arr) { seen++; if (e.points !== prev) { rank = seen; prev = e.points; } ranks.set(e.tid, rank); }
      rankByKey.set(key, { ranks, total: arr.length });
    }
    // annotate
    for (const tid in tmDetail) {
      const cats = (tmDetail[tid] as any).categories as Record<string, any>[];
      const set = (key: string, node: Record<string, any>) => {
        const r = rankByKey.get(key);
        node.rank = r ? r.ranks.get(tid) ?? null : null;
        node.rankOf = r ? r.total : null;
      };
      for (const m of cats) {
        set(`0|${m.category}`, m);
        for (const s of m.subs as Record<string, any>[]) {
          set(`1|${s.subcategory}`, s);
          for (const lf of (s.leaves || []) as Record<string, any>[]) set(`2|${lf.subcategory}`, lf);
        }
      }
    }
  }
  teams.sort((a, b) => (b.ppg as number) - (a.ppg as number));
  files["teams.json"] = teams;
  files["teams_detail.json"] = tmDetail;

  /* ----------------------------- tossup categories + per-category players ----------------------------- */
  const tuCatNew = (): CatTuAcc => ({ main: "", heard: 0, powers: 0, gets: 0, buzzSum: 0, buzzN: 0, firstConv: 0, secondConv: 0, incorrectBefore: 0 });
  const tuCatAdd = (a: CatTuAcc, s: CatTuAcc) => { a.main = a.main || s.main; a.heard += s.heard; a.powers += s.powers; a.gets += s.gets; a.buzzSum += s.buzzSum; a.buzzN += s.buzzN; a.firstConv += s.firstConv; a.secondConv += s.secondConv; a.incorrectBefore += s.incorrectBefore; };
  const tuCatFin = (a: CatTuAcc) => ({
    heard: a.heard, powers: a.powers, gets: a.gets, convPct: pct(a.powers + a.gets, a.heard), powerPct: pct(a.powers, a.heard),
    avgBuzzPct: a.buzzN ? round1((100 * a.buzzSum) / a.buzzN) : null,
    firstSentConvPct: pct(a.firstConv, a.heard), secondSentConvPct: pct(a.secondConv, a.heard), incorrectPct: pct(a.incorrectBefore, a.heard),
  });
  const ct = buildCategoryTree<CatTuAcc>(catTuSub, tuCatNew, tuCatAdd, tuCatFin);

  const categoriesPlayers: Record<string, unknown> = {};
  let cpCounter = 0;
  const catPlayerRows = (matchFn: (fs: string) => boolean) => {
    const rows: Record<string, unknown>[] = [];
    for (const [k, submap] of plFullCat) {
      const p = pl.get(k)!;
      const agg = { ...newCatAcc(), first: 0, top3: 0 };
      let matched = false;
      for (const [fs, c] of submap) {
        if (!matchFn(fs)) continue;
        matched = true;
        agg.powers += c.powers; agg.gets += c.gets; agg.incorrect += c.incorrect; agg.points += c.points;
        agg.posSum += c.posSum; agg.posN += c.posN;
        if (c.earliest !== null) agg.earliest = agg.earliest === null ? c.earliest : Math.min(agg.earliest, c.earliest);
        agg.first += firstPlfc.get(`${k}${SEP}${fs}`) || 0;
        agg.top3 += top3Plfc.get(`${k}${SEP}${fs}`) || 0;
      }
      if (matched && agg.powers + agg.gets + agg.incorrect > 0)
        rows.push({
          playerId: playerId.get(k) ?? null, name: p.name, team: p.team, teamId: teamId.get(p.team) ?? null,
          powers: agg.powers, gets: agg.gets, incorrect: agg.incorrect, points: agg.points,
          earliest: agg.earliest === null ? null : agg.earliest + 1, avgBuzz: agg.posN ? round1(agg.posSum / agg.posN + 1) : null,
          firstBuzzes: agg.first, top3Buzzes: agg.top3,
        });
    }
    rows.sort((a, b) => (b.points as number) - (a.points as number) || (a.name as string).toLowerCase().localeCompare((b.name as string).toLowerCase()));
    return rows;
  };
  const emitNode = (node: Record<string, unknown>, label: string, matchFn: (fs: string) => boolean) => {
    const cid = `c${cpCounter++}`;
    node.playersId = cid;
    categoriesPlayers[cid] = { category: label, players: catPlayerRows(matchFn) };
  };
  for (const g of ct) {
    const cat = g.category;
    emitNode(g, cat, (fs) => fs.split(" - ")[0].trim() === cat);
    for (const s of g.subs) {
      const sc = s.subcategory;
      emitNode(s, sc, (fs) => fs === sc || fs.startsWith(sc + " - "));
      for (const lf of s.leaves || []) {
        const lc = lf.subcategory;
        emitNode(lf, lc, (fs) => fs === lc || fs.startsWith(lc + " - "));
      }
    }
  }
  // Owner-defined merged categories: extra top-level nodes aggregating their
  // member subcategories. Each member also gets a per-category players view.
  for (const v of virtualCats) {
    const node = buildVirtualNode<CatTuAcc>(v.name, v.members, catTuSub, tuCatNew, tuCatAdd, tuCatFin);
    if (!node) continue;
    emitNode(node, v.name, (fs) => v.members.some((m) => vmatchSub(fs, m)));
    for (const s of node.subs) emitNode(s, s.subcategory, (fs) => vmatchSub(fs, s.subcategory));
    ct.push(node);
  }
  files["categories_tossup.json"] = ct;
  files["categories_players.json"] = categoriesPlayers;

  /* ----------------------------- buzzer races ----------------------------- */
  const races: Record<string, unknown>[] = [];
  for (const [id, t] of tossups) {
    const buzzes = (tuBuzzes.get(id) || []).filter((b) => b.firstInRoom && b.wordIndex !== null && !imprecise(b.value, b.wordIndex, t.powerIndex));
    if (buzzes.length < 2) continue;
    const idxs = buzzes.map((b) => b.wordIndex!).sort((a, b) => a - b);
    let bestCount = 0, bestStart = idxs[0];
    for (let s = idxs[0]; s <= idxs[idxs.length - 1]; s++) {
      const c = idxs.filter((x) => s <= x && x < s + RACE_WINDOW).length;
      if (c > bestCount) { bestCount = c; bestStart = s; }
    }
    if (bestCount < 2) continue;
    const win = buzzes.filter((b) => bestStart <= b.wordIndex! && b.wordIndex! < bestStart + RACE_WINDOW).sort((a, b) => a.wordIndex! - b.wordIndex!);
    const hotStart = win[0].wordIndex!, hotEnd = win[win.length - 1].wordIndex! + 1;
    const words = t.words, wc = t.wordCount || 1;
    const ca = Math.max(0, hotStart - RACE_CONTEXT), cbb = Math.min(words.length, hotEnd + RACE_CONTEXT);
    races.push({
      id, round: t.round, num: t.num, answer: t.answer, category: t.category, subcategory: t.subcategory,
      buzzCount: bestCount, totalBuzzes: buzzes.length,
      powers: win.filter((b) => isPower(b.value)).length, gets: win.filter((b) => isGet(b.value)).length, incorrect: win.filter((b) => !isCorrect(b.value)).length,
      wordSpan: hotEnd - hotStart, pctThrough: round1((100 * hotStart) / wc), leadingPct: ca > 0,
      before: words.slice(ca, hotStart).join(" "), hot: words.slice(hotStart, hotEnd).join(" "), after: words.slice(hotEnd, cbb).join(" "),
      trailingMore: cbb < words.length,
      buzzers: win.map((b) => ({ player: b.player, team: b.team, value: b.value, wordIndex: b.wordIndex })),
    });
  }
  races.sort((a, b) => (b.buzzCount as number) - (a.buzzCount as number) || (a.pctThrough as number) - (b.pctThrough as number));
  files["buzzer_races.json"] = races;

  /* ----------------------------- first-sentence buzzes ----------------------------- */
  const firstSent: Record<string, unknown>[] = [];
  for (const [id, t] of tossups) {
    const words = t.words;
    const endI = firstSentenceEnd(words);
    // A correct first-line buzz would be a power; a non-power "get" on the first
    // sentence is a parsing artifact and is excluded (powers + wrong buzzes kept).
    const fs = (tuBuzzes.get(id) || []).filter((b) => b.wordIndex !== null && b.wordIndex <= endI && !(hasPower && isGet(b.value))).sort((a, b) => a.wordIndex! - b.wordIndex!);
    if (!fs.length) continue;
    firstSent.push({
      id, round: t.round, num: t.num, answer: t.answer, category: t.category, subcategory: t.subcategory,
      sentenceEndIndex: endI, wordCount: t.wordCount, sentenceWords: words.slice(0, endI + 1),
      buzzCount: fs.length, powers: fs.filter((b) => isPower(b.value)).length, gets: fs.filter((b) => isGet(b.value)).length, incorrect: fs.filter((b) => !isCorrect(b.value)).length,
      buzzers: fs.map((b) => ({ player: b.player, team: b.team, value: b.value, wordIndex: b.wordIndex, teamId: b.team ? teamId.get(b.team) ?? null : null, playerId: b.player ? playerId.get(plKey(b.player, b.team || "")) ?? null : null })),
    });
  }
  firstSent.sort((a, b) => (b.buzzCount as number) - (a.buzzCount as number) || (b.powers as number) - (a.powers as number) || (a.id as string).localeCompare(b.id as string));
  files["first_sentence.json"] = firstSent;

  /* ----------------------------- rosters + meta ----------------------------- */
  files["rosters.json"] = Object.fromEntries([...rosters.entries()].map(([t, s]) => [t, [...s].sort()]));
  files["meta.json"] = {
    setName: cfg.name, setSlug: cfg.slug, scoring: scoring.id, scoringLabel: scoring.label,
    hasPower: scoring.hasPower, hasNeg: scoring.hasNeg, hasBonuses: cfg.hasBonuses,
    // Whether per-team/per-player bonus breakdowns exist. False for imports that
    // only expose aggregate bonus conversion (no per-game results), so the client
    // hides team-level PPB while still showing tournament/category bonus stats.
    hasTeamBonuses: bnResults.size > 0,
    numGames: games.length, numTeams: tm.size, numPlayers: pl.size,
    numTossups: tossups.size, numBonuses: cfg.hasBonuses ? bonuses.size : 0,
    rounds: [...new Set([...tossups.values()].map((t) => t.round))].sort((a, b) => a - b),
    // Advisory heuristic: categories that look mislabeled (author initials/names,
    // short codes) rather than real subjects. Shown to owners; never blocks upload.
    categoryWarnings: scanCategoryQuality(tossups),
    generatedAt: new Date().toISOString(),
  };

  return files;
}

/* ----------------------------- imported (pre-aggregated) bonuses ----------------------------- */
// A bonus whose per-part results are already aggregated by the source (e.g. the
// quizbowlstats bonus index gives per-difficulty conversion + ppb + heard, but
// its per-game pages are too slow to scrape). `got[i]`/`points`/`heard` are
// summed across every edition/mirror that carries the same bonus.
export interface ImportedBonus {
  round: number;
  num: number;
  category: string;            // e.g. "Science - Physics"
  parts: string[];             // part prompts (usually unknown for imports -> "")
  answers: string[];           // answer line per part (HTML), in packet order
  difficultyModifiers: string[]; // per part: "e" | "m" | "h"
  heard: number;
  got: number[];               // per part: hearings that earned it
  points: number;              // total bonus points across all hearings
}

// Build bonuses.json / bonuses_detail.json / categories_bonus.json from
// pre-aggregated bonus data, matching the shapes aggregate() emits so the UI is
// identical. Entries with the same round-num (across mirrors) are summed. No
// per-team/per-game breakdown is possible from this data.
export function bonusFilesFromImported(list: ImportedBonus[], virtualCats: VirtualCategory[] = []): Record<string, unknown> {
  // merge by position id (round-num), summing counts across editions
  const merged = new Map<string, ImportedBonus>();
  for (const b of list) {
    const id = `${b.round}-${b.num}`;
    const m = merged.get(id);
    if (!m) { merged.set(id, { ...b, got: [...b.got] }); continue; }
    m.heard += b.heard;
    m.points += b.points;
    for (let i = 0; i < b.got.length; i++) m.got[i] = (m.got[i] || 0) + (b.got[i] || 0);
  }

  const bnSumm: Record<string, unknown>[] = [];
  const bnDetail: Record<string, unknown> = {};
  const catBnSub = new Map<string, CatBnAcc>();
  for (const [id, b] of [...merged.entries()].sort()) {
    const [main, sub] = parseCategory(b.category);
    const heard = b.heard;
    const totalPts = b.points;
    const ppb = heard ? Math.round((100 * totalPts) / heard) / 100 : 0;
    const partConv: Record<string, unknown>[] = [];
    const byDiff: Record<string, { answer: string; convPct: number }> = {};
    let cb = catBnSub.get(sub);
    if (!cb) { cb = bnNew(); cb.main = main; catBnSub.set(sub, cb); }
    for (let i = 0; i < b.answers.length; i++) {
      const got = b.got[i] || 0;
      const diff = b.difficultyModifiers[i] || "m";
      const row = { idx: i, difficulty: diff, difficultyName: DIFF_NAME[diff] || "Medium", answer: b.answers[i] || "", part: b.parts[i] || "", convPct: pct(got, heard), convCount: got };
      partConv.push(row);
      if (!byDiff[diff]) byDiff[diff] = { answer: row.answer, convPct: row.convPct };
      const slot = cb.parts.get(diff) || [0, 0]; slot[0] += got; slot[1] += heard; cb.parts.set(diff, slot);
    }
    cb.main = main; cb.heard += heard; cb.pts += totalPts;
    bnSumm.push({
      id, round: b.round, num: b.num, category: main, subcategory: sub, heard, ppb,
      easyPct: byDiff.e?.convPct ?? null, medPct: byDiff.m?.convPct ?? null, hardPct: byDiff.h?.convPct ?? null,
      easyAnswer: byDiff.e?.answer ?? null, medAnswer: byDiff.m?.answer ?? null, hardAnswer: byDiff.h?.answer ?? null,
    });
    bnDetail[id] = {
      id, round: b.round, num: b.num, category: main, subcategory: sub, leadin: "",
      parts: b.parts, answers: b.answers, difficultyModifiers: b.difficultyModifiers, heard, ppb, totalPts, partConv, results: [],
    };
  }
  const bnTree = buildCategoryTree<CatBnAcc>(catBnSub, bnNew, bnAdd, bnFin);
  for (const v of virtualCats) {
    const node = buildVirtualNode<CatBnAcc>(v.name, v.members, catBnSub, bnNew, bnAdd, bnFin);
    if (node) bnTree.push(node);
  }
  return { "bonuses.json": bnSumm, "bonuses_detail.json": bnDetail, "categories_bonus.json": bnTree };
}
