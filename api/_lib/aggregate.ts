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
  // Which edition (mirror) played this game. Set only when the combined
  // aggregation flattens 2+ editions, so single-edition output stays lean.
  editionId?: string;
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
  // How to read each question's metadata line, once the owner has confirmed it.
  metaMap?: MetaMap | null;
  // Per-question tag edits the owner made by hand, keyed "<round>-<num>".
  tagEdits?: TagEdits | null;
}

// Hand edits layered over the tags derived from metadata.
export interface TagEdit { add?: string[]; remove?: string[] }
export interface TagEdits { tossups?: Record<string, TagEdit>; bonuses?: Record<string, TagEdit> }
const applyTagEdits = (tags: string[], e?: TagEdit): string[] => {
  if (!e) return tags;
  const out = tags.filter((t) => !(e.remove || []).includes(t));
  for (const t of e.add || []) if (!out.includes(t)) out.push(t);
  return out;
};

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

// A correction to what ONE team scored on ONE bonus. Sources routinely record
// the right number of parts against the wrong ones — "they got the easy and the
// medium", when it was the medium and the hard — which leaves per-part
// conversion, and every difficulty breakdown built on it, describing a bonus
// nobody heard that way. Total points are often right while the parts are not,
// so this is about WHICH parts, not how many.
//
// Keyed on the hearing's ORIGINAL recorded points, like a buzz correction is
// keyed on its original player and word: that addresses one specific hearing,
// survives a later team rename, and makes re-applying the same edit a no-op.
export interface BonusCorrection {
  round: number;
  num: number;
  team: string;
  fromPartPts: number[];
  fromBbPts: number[];
  toPartPts: number[];
  toBbPts?: number[];
  by?: string;
  at?: string;
}
export const bnCorrKeyOf = (round: number, num: number, team: string | null, partPts: number[], bbPts: number[]) =>
  `${round}|${num}|${team}|${partPts.join(",")}|${bbPts.join(",")}`;

// A set-wide rename of one player or one team. Sources spell the same person or
// the same school differently between games ("Mike Bentley" / "Michael Bentley",
// "Chicago A" / "UChicago A"), or simply get a name wrong; a rename folds every
// appearance onto one spelling so the stats stop being split in two.
//
// `kind` says which is being renamed; absent means "player", the only kind that
// existed when the first renames were stored. `team` scopes a PLAYER rename to
// one roster — necessary because two different people on different teams can
// legitimately share a name; null renames the player wherever they appear. A
// team rename is always set-wide, so it leaves `team` null.
//
// Unlike a Correction (which targets one buzz) this applies across the whole
// tournament, but it travels the same route: the owner applies it directly, a
// viewer submits it for approval.
export interface Rename {
  kind?: "player" | "team";
  from: string;
  to: string;
  team: string | null;
  by?: string;
  at?: string;
}
export const renameKind = (r: { kind?: string } | null | undefined): "player" | "team" =>
  r?.kind === "team" ? "team" : "player";

// An owner-defined "virtual" (merged) category: a named group that aggregates the
// stats of one or more existing (sub)categories. `members` are subcategory path
// strings (e.g. "Fine Arts - Auditory - Opera"); a subcategory may belong to
// several virtual categories. They appear as extra top-level nodes in the tossup
// and bonus category trees without altering the underlying questions.
export interface VirtualCategory {
  name: string;
  members: string[];
}
// A full subcategory path `fs` belongs to member `m` when it is `m` itself, a
// descendant of it ("Fine Arts" matches "Fine Arts - Auditory - Opera"), or ends
// with it as its leaf.
//
// That last case is what makes a merged category work across a set's two
// category vocabularies. Tossup and bonus metadata routinely spell the same
// subject differently — a set can file tossups under a flat "Biology" while its
// bonuses use "Science - Biology" — and the picker can only offer one of them.
// Without leaf matching, picking "Biology" silently did nothing on the bonus
// side, so a merged category came out holding whichever members happened to be
// spelled the same in both.
const vmatchSub = (fs: string, m: string) =>
  fs === m || fs.startsWith(m + " - ") || fs.endsWith(" - " + m);

// What a merged category actually claims: the members the owner picked, plus its
// own name. A merged "Science" sitting beside a real "Science" branch under the
// same heading is not a merge — it's the same name twice, which is exactly how
// this looked when the picked members only matched half of a set's categories.
export const virtualMembers = (v: VirtualCategory) => [...new Set([...v.members, v.name])];

// The subcategories some merged category has taken over. They are removed from
// the top level of the tree, because a merge that leaves its members standing
// alongside the thing they merged into hasn't merged anything.
function absorbedSubs(virtualCats: VirtualCategory[], keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const fs of keys)
    for (const v of virtualCats)
      if (virtualMembers(v).some((m) => vmatchSub(fs, m))) { out.add(fs); break; }
  return out;
}
// The stats map with those subcategories taken out, for building the real tree.
const withoutAbsorbed = <A>(subStats: Map<string, A>, absorbed: Set<string>) =>
  absorbed.size ? new Map([...subStats].filter(([fs]) => !absorbed.has(fs))) : subStats;

const SEP = "||"; // delimiter for composite (player, team[, sub]) keys
const RACE_WINDOW = 5;
const RACE_CONTEXT = 6;

/* ----------------------------- text helpers ----------------------------- */
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number, d: number) => (d ? round1((100 * n) / d) : 0);

function stripHtml(s: string): string {
  return (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}
// A question is numbered by the words that were actually READ OUT. What's printed
// but not read — the power mark, and pronunciation guides (parentheticals opening
// with a quote, e.g. (“eye-no…”) or ("ballet ROOSE")) — is skipped, so nothing can
// be buzzed on it. This matches how the scorekeeper numbers words: a buzz on the
// first word of a tossup is written as 0, and one index past the last word is the
// ■END■ slot, meaning the question was read out before anyone buzzed.
const PRON_GUIDE = /\([“"][^)]*\)/g;
const POWER_MARK = /\(\*\)/;

interface Tokens {
  words: string[];           // spoken words, in reading order
  powerIndex: number | null; // index of the last word inside power
}
export function tokenize(html: string): Tokens {
  const text = stripHtml(html);
  // By span, not by token: a guide can run across several — ("ballet ROOSE").
  const marks: [number, number][] = [];
  for (const re of [PRON_GUIDE, /\(\*\)/g])
    for (const m of text.matchAll(re)) marks.push([m.index!, m.index! + m[0].length]);
  const marked = (i: number) => marks.some(([a, b]) => a <= i && i < b);

  const words: string[] = [];
  let powerIndex: number | null = null;
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index!, end = start + m[0].length;
    if (powerIndex === null && POWER_MARK.test(m[0])) powerIndex = words.length - 1;
    let spoken = "";
    for (let i = start; i < end; i++) if (!marked(i)) spoken += text[i];
    if (spoken.trim()) words.push(spoken.trim());
  }
  return { words, powerIndex: powerIndex !== null && powerIndex >= 0 ? powerIndex : null };
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
/* --------------------------- question metadata ---------------------------- */
// A packet's metadata line is comma-separated, but sets disagree about what the
// parts MEAN: "<Mike Bentley, Painting - 1800-1900>" leads with the writer,
// "<Poetry, JL>" leads with the category. Guessing gets it wrong half the time —
// that's how a set ended up with "JL" for a category — so the owner tells us,
// once, via a MetaMap, and everything re-derives from the raw line.

// Strip the wrapper punctuation and split into the comma-separated fields the
// owner assigns roles to. Exported: the settings scan shows these to the owner.
export function metaFields(meta?: string): string[] {
  if (!meta) return [];
  let s = meta.split(/<Editor/i)[0];
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  s = s.split("~")[0].split(">")[0].replace(/^\s*</, "");
  s = s.replace(/�/g, "-").replace(/\s*[–—]\s*/g, " - ");
  return s.split(",").map((p) => p.trim().replace(/>+$/, "").trim());
}

export type MetaRole = "category" | "tag" | "ignore";
export interface MetaField { role: MetaRole; tag?: string }
export interface MetaMap { fields: MetaField[] }

// Until an owner maps a set, its categories keep coming out exactly as they
// always have: everything after the first comma is the category. That's the
// "<writer, category>" convention, and it's what puts "JL" in the category column
// for sets written the other way round — deliberately left alone here so mapping
// a set is the only thing that ever moves its categories.
const legacyCategory = (fields: string[]) => (fields.length > 1 ? fields.slice(1).join(", ") : fields[0]) || "Other";

export interface ResolvedMeta { main: string; full: string; tags: string[] }
export function resolveMeta(meta: string | undefined, map: MetaMap | null): ResolvedMeta {
  const fields = metaFields(meta);
  if (!fields.length) return { main: "Other", full: "Other", tags: [] };
  let cat = "";
  const tags: string[] = [];
  if (map?.fields?.length) {
    fields.forEach((value, i) => {
      const r = map.fields[i];
      if (!value || !r || r.role === "ignore") return;
      if (r.role === "category") { if (!cat) cat = value; }
      else if (r.role === "tag" && r.tag) tags.push(tagKey(r.tag, value));
    });
  } else {
    cat = legacyCategory(fields);
  }
  if (!cat) cat = "Other";
  return { main: cat.split(" - ")[0].trim(), full: cat, tags };
}

// A tag is a named dimension plus a value ("Writer: JL"). One string keeps it
// easy to filter on and to put in a URL; the dimension is everything before the
// first ": ".
export const TAG_SEP = ": ";
export const tagKey = (dim: string, value: string) => `${dim}${TAG_SEP}${value}`;
export const tagDim = (t: string) => { const i = t.indexOf(TAG_SEP); return i < 0 ? "" : t.slice(0, i); };
export const tagValue = (t: string) => { const i = t.indexOf(TAG_SEP); return i < 0 ? t : t.slice(i + TAG_SEP.length); };
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

/* ----------------------------- round alignment ----------------------------- */
// A packet's round comes from its FILENAME ("Round_3.json" -> 3); a game's comes
// from inside the QBJ (`_round`), falling back to its filename. When the two
// disagree, buzzes never meet questions: every tossup shows 0 heard even though
// player and team stats look perfectly fine. The usual cause is a packet whose
// name carries no number at all ("Taylor_SMTMT.json"), which falls back to round
// 0 while its games sit on round 1. A second, quieter failure is two packet
// files landing on the SAME round — combinedPackets() lets the later one
// overwrite the earlier, so a whole packet's questions silently vanish.
//
// This scan reports both so the owner can renumber packets in Settings ->
// Round alignment. Advisory only: nothing is blocked or altered.
export interface RoundWarning {
  kind: "packet-unplayed" | "games-unmatched" | "packet-duplicate";
  round: number;
  tossups: number;          // questions sitting on this packet round
  games: number;            // games played in this round
  files: number;            // packet files on this round
  suggested: number | null; // the round this packet most likely belongs on
}

type RoundScanPacket = { round: number; tossups?: unknown[]; bonuses?: unknown[] };

export function scanRoundAlignment(packets: RoundScanPacket[], games: { round: number }[]): RoundWarning[] {
  // Count only packets that actually carry questions — an empty packet round
  // says nothing about alignment.
  const pkt = new Map<number, { questions: number; files: number }>();
  for (const p of packets) {
    const n = (p.tossups || []).filter(Boolean).length + (p.bonuses || []).filter(Boolean).length;
    if (!n) continue;
    const e = pkt.get(p.round) || { questions: 0, files: 0 };
    e.questions += n; e.files += 1;
    pkt.set(p.round, e);
  }
  const gm = new Map<number, number>();
  for (const g of games) gm.set(g.round, (gm.get(g.round) || 0) + 1);
  if (!pkt.size || !gm.size) return []; // packets-only or games-only: nothing to align

  const unplayed = [...pkt.keys()].filter((r) => !gm.has(r)).sort((a, b) => a - b);
  const unmatched = [...gm.keys()].filter((r) => !pkt.has(r)).sort((a, b) => a - b);
  const dupes = [...pkt.entries()].filter(([, e]) => e.files > 1).map(([r]) => r).sort((a, b) => a - b);

  // When exactly as many packet rounds are orphaned as game rounds, a straight
  // renumbering in order is almost certainly the fix (the common case is one
  // packet stuck on round 0 while its games sit on the real round).
  const paired = unplayed.length > 0 && unplayed.length === unmatched.length;

  const out: RoundWarning[] = [];
  unplayed.forEach((r, i) => out.push({
    kind: "packet-unplayed", round: r, tossups: pkt.get(r)!.questions, games: 0,
    files: pkt.get(r)!.files, suggested: paired ? unmatched[i] : null,
  }));
  for (const r of unmatched)
    out.push({ kind: "games-unmatched", round: r, tossups: 0, games: gm.get(r)!, files: 0, suggested: null });
  for (const r of dupes)
    out.push({ kind: "packet-duplicate", round: r, tossups: pkt.get(r)!.questions, games: gm.get(r) || 0, files: pkt.get(r)!.files, suggested: null });
  return out;
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
  // First member to match a subcategory claims it. Members overlap constantly —
  // an explicit "Biology" and the category's own name both reach a bonus filed
  // under "Science - Biology" — and without this the same questions appear under
  // two rows of one merged category, which reads as the merge having half worked.
  for (const m of members) {
    const memAcc = newAcc();
    let has = false;
    for (const [fs, s] of subStats) {
      if (seen.has(fs) || !vmatchSub(fs, m)) continue;
      seen.add(fs);
      addAcc(memAcc, s);
      addAcc(mainAcc, s);
      has = true;
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
// The difficulty a source marked a bonus part with, or "" when it marked none.
// Plenty of packets carry no [10e]/[10m]/[10h] at all, and calling those parts
// medium invents a fact: it puts real conversion behind a Medium label and
// reports a hard part as an easy one. Unmarked parts stay unmarked, and simply
// don't contribute to the easy/medium/hard breakdowns.
const diffAt = (mods: string[], i: number) => mods[i] || "";
const diffLabel = (d: string) => DIFF_NAME[d] || (d ? d.toUpperCase() : "Unmarked");
// null, not 0, when nothing of this difficulty was heard — "—" reads as "no
// data", where "0.0%" reads as "nobody converted them".
const diffPct = (parts: Map<string, [number, number]>, d: string) => { const [g, t] = parts.get(d) || [0, 0]; return t ? pct(g, t) : null; };
const bnFin = (a: CatBnAcc) => ({ heard: a.heard, ppb: a.heard ? Math.round((100 * a.pts) / a.heard) / 100 : 0, easyPct: diffPct(a.parts, "e"), medPct: diffPct(a.parts, "m"), hardPct: diffPct(a.parts, "h") });
const bnAdd = (a: CatBnAcc, s: CatBnAcc) => { a.main = a.main || s.main; a.heard += s.heard; a.pts += s.pts; for (const [d, gt] of s.parts) { const slot = a.parts.get(d) || [0, 0]; slot[0] += gt[0]; slot[1] += gt[1]; a.parts.set(d, slot); } };
const bnNew = (): CatBnAcc => ({ main: "", heard: 0, pts: 0, parts: new Map() });

/* ----------------------------- accumulators ----------------------------- */
interface TUStat { round: number; num: number; questionHtml: string; answer: string; category: string; subcategory: string; categoryMid: string; tags: string[]; words: string[]; wordCount: number; powerIndex: number | null; }
interface BNStat { round: number; num: number; leadin: string; parts: string[]; answers: string[]; difficultyModifiers: string[]; category: string; subcategory: string; tags: string[]; }
type Buzz = { player: string | null; team: string | null; value: number; wordIndex: number | null; opponent?: string | null; origPlayer?: string | null; origWordIndex?: number | null; origTeam?: string | null; firstInRoom?: boolean; editionId?: string | null; };
// `unread` is the BPA numerator: the fraction of each question left unread,
// summed over reliably-placed correct buzzes. `tuh` is its denominator, filled
// in per team from what was actually read (players inherit their team's).
type CatAcc = { powers: number; gets: number; incorrect: number; points: number; posSum: number; posN: number; earliest: number | null; unread: number; tuh: number };
const newCatAcc = (): CatAcc => ({ powers: 0, gets: 0, incorrect: 0, points: 0, posSum: 0, posN: 0, earliest: null, unread: 0, tuh: 0 });
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
  virtualCats: VirtualCategory[] = [],
  renames: Rename[] = [],
  bonusCorrections: BonusCorrection[] = []
): Record<string, unknown> {
  const scoring = cfg.scoring;
  const hasPower = scoring.hasPower;
  const tierOf = (v: number) => classify(v, scoring);
  const isPower = (v: number) => tierOf(v) === "power";
  const isGet = (v: number) => tierOf(v) === "get";
  const isCorrect = (v: number) => v > 0; // power or get
  // A get recorded at or before the last power word: the position can't be right
  // (it would have scored a power), so it's treated as "somewhere after power".
  const imprecise = (v: number, widx: number | null, pIdx: number | null) =>
    hasPower && isGet(v) && pIdx !== null && widx !== null && widx <= pIdx;
  // The "neg"/incorrect stat counts penalized wrong buzzes. A 0-point buzz is NOT
  // a neg — it carries no penalty — so in a neg format it must not inflate neg
  // counts (a wrong buzz there is negative). In a no-neg format a wrong buzz
  // scores 0, so those 0s ARE the incorrect buzzes we want to count.
  const countsNeg = (v: number) => (scoring.hasNeg ? v < 0 : v <= 0);

  const corrMap = new Map<string, Correction>();
  for (const c of corrections) corrMap.set(corrKeyOf(c.round, c.num, c.team, c.fromPlayer, c.fromWordIndex), c);
  const bnCorrMap = new Map<string, BonusCorrection>();
  for (const c of bonusCorrections)
    bnCorrMap.set(bnCorrKeyOf(c.round, c.num, c.team, c.fromPartPts || [], c.fromBbPts || []), c);

  // Team renames, applied before anything else reads a team name: rosters,
  // standings and the scope of a player rename all key off the name a team ends
  // up with, so they must all see the same one.
  const teamRenameAt = new Map<string, string>();
  for (const r of renames) {
    if (renameKind(r) !== "team" || !r?.from || !r?.to) continue;
    teamRenameAt.set(r.from, r.to);
  }
  const teamNamed = teamRenameAt.size ? (name: string) => teamRenameAt.get(name) ?? name : (name: string) => name;

  // Player renames. A team-scoped rename wins over a global one, and its scope is
  // stated in the team's CURRENT name (a team rename retargets the scopes along
  // with it). Applied in a single pass (never chained), so a rename whose target
  // is another rename's source can't cascade.
  const renameAt = new Map<string, string>();
  for (const r of renames) {
    if (renameKind(r) !== "player" || !r?.from || !r?.to) continue;
    renameAt.set(`${r.team ?? ""}${SEP}${r.from}`, r.to);
  }
  const renamed = renameAt.size
    ? (name: string, team: string | null) =>
        renameAt.get(`${team ?? ""}${SEP}${name}`) ?? renameAt.get(`${SEP}${name}`) ?? name
    : (name: string) => name;

  const tossups = new Map<string, TUStat>();
  const bonuses = new Map<string, BNStat>();
  let bonusTagCount = 0;
  // A set nobody has mapped yet, whose metadata carries more than one field, is
  // being categorized on a guess about field order — the guess that files a set
  // under its writers' initials. Worth telling the owner about.
  let ambiguousMeta = false;
  const noteAmbiguous = (meta?: string) => { if (!cfg.metaMap && metaFields(meta).length > 1) ambiguousMeta = true; };
  for (const p of packets) {
    const r = p.round;
    (p.tossups || []).forEach((t, i) => {
      const num = i + 1;
      noteAmbiguous(t.metadata);
      const rm = resolveMeta(t.metadata, cfg.metaMap ?? null);
      const tok = tokenize(t.question);
      tossups.set(`${r}-${num}`, {
        round: r, num, questionHtml: t.question, answer: t.answer,
        category: rm.main, subcategory: rm.full, categoryMid: categoryMid(rm.full, rm.main),
        tags: applyTagEdits(rm.tags, cfg.tagEdits?.tossups?.[`${r}-${num}`]),
        words: tok.words, wordCount: tok.words.length, powerIndex: tok.powerIndex,
      });
    });
    if (cfg.hasBonuses)
      (p.bonuses || []).forEach((b, i) => {
        const num = i + 1;
        noteAmbiguous(b.metadata);
        const rmb = resolveMeta(b.metadata, cfg.metaMap ?? null);
        bonuses.set(`${r}-${num}`, {
          round: r, num, leadin: b.leadin || "", parts: b.parts || [], answers: b.answers || [],
          difficultyModifiers: b.difficultyModifiers || [], category: rmb.main, subcategory: rmb.full,
          tags: applyTagEdits(rmb.tags, cfg.tagEdits?.bonuses?.[`${r}-${num}`]),
        });
      });
  }

  const tuBuzzes = new Map<string, Buzz[]>();
  const tuHeard = new Map<string, number>();
  const bnResults = new Map<string, { team: string | null; partPts: number[]; bbPts: number[]; total: number; origPartPts?: number[]; origBbPts?: number[]; origTeam?: string; editionId?: string }[]>();

  type PL = { name: string; team: string; games: Set<string>; tuh: number; powers: number; gets: number; incorrect: number; pts: number; unread: number };
  const pl = new Map<string, PL>();
  type TM = { games: number; wins: number; losses: number; ties: number; tuPts: number; bonusPts: number; bonusesHeard: number; powers: number; gets: number; incorrect: number; tuh: number; fullTuh: number; unread: number };
  const tm = new Map<string, TM>();
  const rosters = new Map<string, Set<string>>();
  const plCat = new Map<string, Map<string, CatAcc>>();      // player -> categoryMid -> acc
  const plFullCat = new Map<string, Map<string, CatAcc>>();  // player -> full sub -> acc
  const plBuzzes = new Map<string, { round: number; num: number; value: number; widx: number | null; rebound: boolean }[]>();
  const tmBonusCat = new Map<string, Map<string, BnCat>>();
  const tmTuCat = new Map<string, Map<string, TuCat>>();
  // Tossups a team HEARD, by category — kept separately from the buzz
  // accumulators above, which only ever see categories the team buzzed in. Mid
  // and full-path keys are held apart because a subcategory can be spelled the
  // same as the mid-level category it sits under.
  const tmCatHeardMid = new Map<string, Map<string, number>>();
  const tmCatHeardSub = new Map<string, Map<string, number>>();
  const bumpHeard = (m: Map<string, Map<string, number>>, team: string, cat: string) => {
    let inner = m.get(team); if (!inner) { inner = new Map(); m.set(team, inner); }
    inner.set(cat, (inner.get(cat) || 0) + 1);
  };

  const plKey = (n: string, t: string | null) => `${n}${SEP}${t}`;
  const plOf = (name: string, team: string): PL => {
    const k = plKey(name, team);
    let v = pl.get(k);
    if (!v) { v = { name, team, games: new Set(), tuh: 0, powers: 0, gets: 0, incorrect: 0, pts: 0, unread: 0 }; pl.set(k, v); }
    return v;
  };
  const tmOf = (k: string): TM => { let v = tm.get(k); if (!v) { v = { games: 0, wins: 0, losses: 0, ties: 0, tuPts: 0, bonusPts: 0, bonusesHeard: 0, powers: 0, gets: 0, incorrect: 0, tuh: 0, fullTuh: 0, unread: 0 }; tm.set(k, v); } return v; };
  const nestCat = <V>(m: Map<string, Map<string, V>>, k: string, sub: string, make: () => V): V => {
    let inner = m.get(k); if (!inner) { inner = new Map(); m.set(k, inner); }
    let v = inner.get(sub); if (!v) { v = make(); inner.set(sub, v); } return v;
  };
  const addCat = (c: CatAcc, value: number, widx: number | null, prec: boolean, unread = 0) => {
    if (isPower(value)) c.powers++; else if (isGet(value)) c.gets++; else if (countsNeg(value)) c.incorrect++;
    c.points += value;
    if (prec && widx !== null) { c.posSum += widx; c.posN++; c.earliest = c.earliest === null ? widx : Math.min(c.earliest, widx); c.unread += unread; }
  };

  // BPA (buzz point area-under-the-curve, Ryan Rosenberg): the share of each
  // question a player left unread by buzzing early, summed over the tossups they
  // converted and spread across every tossup they heard —
  //
  //     BPA = 100 × Σ(1 − buzzPosition / questionLength) / tossupsHeard
  //
  // It separates players whose PPG or power count match but who buzz at
  // different points. Only correct buzzes count (a neg leaves the question
  // unread too, but that isn't an achievement), and only ones whose position can
  // be trusted — the same reliability test the buzz ranks use — because a buzz
  // recorded at the wrong word would be scored as if it were fast.
  // See https://www.qbwiki.com/wiki/BPA.
  const unreadOf = (widx: number | null, wordCount: number) =>
    widx === null || wordCount <= 0 ? 0 : Math.max(0, 1 - widx / wordCount);
  const bpaOf = (unread: number, tuh: number) => (tuh > 0 ? round1((100 * unread) / tuh) : null);

  // Games always carry their edition (phase membership is decided per edition),
  // but only annotate buzzes when this aggregation actually spans more than one
  // mirror — on a single-edition set, or a per-edition run, the tag would be the
  // same on every buzz and would just bloat the output.
  const multiEdition = new Set(games.map((g) => g.editionId).filter(Boolean)).size > 1;

  for (const g of games) {
    const r = g.round;
    // Carried onto each buzz and bonus hearing so the detail views can name the
    // mirror it was played in.
    const edId = multiEdition ? g.editionId : undefined;
    // Deduped, because a rename can fold two spellings of one team together —
    // including, in a badly aimed rename, both sides of this very game. One name
    // then means one team here, and the head-to-head result below is skipped
    // rather than credited to a team that played itself.
    const teamNames = [...new Set(((g.match_teams || []).map((t) => t.team?.name).filter(Boolean) as string[]).map(teamNamed))];
    const gameId = `${r}:` + [...teamNames].sort().join("|");
    // Tossups read in this game (used to credit every teammate with a full game's
    // worth of TUH — see the players section — since sources often list only the
    // players who buzzed, not who actually played).
    const gameTuh = (g.match_questions || []).length;
    const gamePts = new Map<string, number>();
    const addGamePts = (t: string, v: number) => gamePts.set(t, (gamePts.get(t) || 0) + v);

    for (const mt of g.match_teams || []) {
      const tname = mt.team?.name ? teamNamed(mt.team.name) : null;
      if (!tname) continue;
      const t = tmOf(tname);
      t.games += 1;
      t.fullTuh += gameTuh;
      t.bonusPts += mt.bonus_points || 0;
      addGamePts(tname, mt.bonus_points || 0);
      let rs = rosters.get(tname);
      if (!rs) { rs = new Set(); rosters.set(tname, rs); }
      for (const p of mt.team?.players || []) if (p?.name) rs.add(renamed(p.name, tname));
      for (const mp of mt.match_players || []) {
        const pname = mp.player?.name ? renamed(mp.player.name, tname) : undefined;
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
      if (tq) {
        tuHeard.set(key!, (tuHeard.get(key!) || 0) + 1);
        // Everyone in the room heard it, whoever buzzed — this is the "tossups
        // heard" a category BPA is spread over.
        for (const t of teamNames) { bumpHeard(tmCatHeardMid, t, tq.categoryMid); bumpHeard(tmCatHeardSub, t, tq.subcategory); }
      }
      let converted = false;
      let controlling: string | null = null;
      // The controlling team as the SOURCE spelled it. A bonus correction is
      // addressed by that name, so renaming a team never orphans one.
      let controllingOrig: string | null = null;
      const ordered: { value: number; pname: string | null; bteam: string | null; widx: number | null }[] = [];

      for (const bz of mq.buzzes || []) {
        const value = bz.result?.value ?? 0;
        const origPlayer = bz.player?.name ?? null;
        const origWordIndex = bz.buzz_position?.word_index ?? null;
        let pname = origPlayer;
        const origTeam = bz.team?.name ?? null;
        const bteam = origTeam === null ? null : teamNamed(origTeam);
        let widx = origWordIndex;
        if (tnum != null) {
          // Corrections address a buzz by the names the SOURCE gave it, so a
          // later team rename never orphans one (and the YellowFruit export,
          // which matches corrections back against the uploaded file, still
          // finds its team).
          const c = corrMap.get(corrKeyOf(r, tnum, origTeam, origPlayer, origWordIndex));
          if (c) { if (c.toPlayer !== undefined) pname = c.toPlayer; if (c.toWordIndex !== undefined) widx = c.toWordIndex; }
        }
        // After the per-buzz correction, so a reassignment lands on the renamed
        // player too. `origPlayer` and `origTeam` deliberately stay raw — they're
        // the keys the buzz editor uses to address this correction.
        if (pname) pname = renamed(pname, bteam);
        // A buzz's word index is relative to the exact wording the player heard. In
        // the combined view of a multi-edition set the canonical wording may be a
        // different length (a mirror reworded the same question), which would render
        // the buzz past the end of the shown text. Pin those to the last word so
        // positions stay within the question. Per-edition views use that edition's
        // own wording, so this is a no-op there.
        // One past the last word is the ■END■ slot — nobody buzzed before the
        // question ran out — and that's as far as an index can legitimately go.
        if (tq && widx !== null && widx > tq.wordCount) widx = tq.wordCount;
        ordered.push({ value, pname, bteam, widx });
        if (tq) {
          const opp = teamNames.find((t) => t !== bteam) ?? null;
          let arr = tuBuzzes.get(key!); if (!arr) { arr = []; tuBuzzes.set(key!, arr); }
          // `ordered` already has this buzz appended above, so length === 1 means
          // it's the first buzz of this room's reading. Later buzzes only happen
          // after an earlier team negged and the reader resumed, so they aren't a
          // genuine same-clue race — the buzzer-race view excludes them.
          arr.push({ player: pname, team: bteam, value, wordIndex: widx, opponent: opp, origPlayer, origWordIndex, origTeam, firstInRoom: ordered.length === 1, editionId: edId });
        }
        if (pname) {
          const pv = plOf(pname, bteam || "");
          if (isPower(value)) pv.powers++; else if (isGet(value)) pv.gets++; else if (countsNeg(value)) pv.incorrect++;
          pv.pts += value;
          if (tq) {
            const prec = isCorrect(value) && !imprecise(value, widx, tq.powerIndex);
            const unread = prec ? unreadOf(widx, tq.wordCount) : 0;
            pv.unread += unread;
            addCat(nestCat(plCat, plKey(pname, bteam || ""), tq.categoryMid, newCatAcc), value, widx, prec, unread);
            addCat(nestCat(plFullCat, plKey(pname, bteam || ""), tq.subcategory, newCatAcc), value, widx, prec, unread);
          }
        }
        if (bteam) {
          const t = tmOf(bteam);
          if (isPower(value)) t.powers++; else if (isGet(value)) t.gets++; else if (countsNeg(value)) t.incorrect++;
          t.tuPts += value;
          addGamePts(bteam, value);
          if (tq) {
            const prec = isCorrect(value) && !imprecise(value, widx, tq.powerIndex);
            const unread = prec ? unreadOf(widx, tq.wordCount) : 0;
            t.unread += unread;
            const tc = nestCat<TuCat>(tmTuCat, bteam, tq.subcategory, () => ({ ...newCatAcc(), main: tq.category }));
            tc.main = tq.category;
            addCat(tc, value, widx, prec, unread);
          }
        }
        if (isCorrect(value)) { converted = true; controlling = bteam; controllingOrig = origTeam; }
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
          const origPartPts = parts.map((p) => p.controlled_points || 0);
          const origBbPts = parts.map((p) => p.bounceback_points || 0);
          // Which parts this team actually got, if someone has corrected them.
          const bc = bnCorrMap.get(bnCorrKeyOf(r, bnum!, controllingOrig, origPartPts, origBbPts));
          const partPts = bc?.toPartPts ?? origPartPts;
          const bbPts = bc?.toBbPts ?? origBbPts;
          const total = partPts.reduce((a, b) => a + b, 0) + bbPts.reduce((a, b) => a + b, 0);
          // A team's bonus points come from the source's own per-game total, not
          // from these parts, so a correction that changes how MANY parts were
          // got would otherwise leave the headline PPB disagreeing with the
          // bonus it was computed from. Carry the difference across to the team
          // and to the game score that decides the result.
          if (bc && controlling) {
            const origTotal = origPartPts.reduce((a, b) => a + b, 0) + origBbPts.reduce((a, b) => a + b, 0);
            const delta = total - origTotal;
            if (delta) { tmOf(controlling).bonusPts += delta; addGamePts(controlling, delta); }
          }
          let arr = bnResults.get(bkey); if (!arr) { arr = []; bnResults.set(bkey, arr); }
          arr.push({
            team: controlling, partPts, bbPts, total,
            // The source's own numbers, kept so the editor can address this
            // hearing — and only when they differ, so untouched sets don't carry
            // a copy of every row.
            ...(bc ? { origPartPts, origBbPts } : {}),
            ...(controllingOrig && controllingOrig !== controlling ? { origTeam: controllingOrig } : {}),
            ...(edId ? { editionId: edId } : {}),
          });
          if (controlling) {
            tmOf(controlling).bonusesHeard += 1;
            const tbc = nestCat<BnCat>(tmBonusCat, controlling, bdef.subcategory, () => ({ heard: 0, pts: 0, main: bdef.category, parts: new Map() }));
            tbc.main = bdef.category; tbc.heard++; tbc.pts += total;
            for (let i = 0; i < parts.length; i++) {
              const got = (partPts[i] || 0) + (bbPts[i] || 0);
              const diff = diffAt(bdef.difficultyModifiers, i);
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
  // The same numbers again, grouped by tag instead of by category. A question
  // counts once per tag it carries.
  const tagTuAcc = new Map<string, CatTuAcc>();
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
    // Where it got converted while the question was still LIVE: the first buzz of
    // a room's reading, so the answering team was racing the clock rather than
    // sitting on a dead question after the other team had already negged. Those
    // late pickups drag the plain average toward the end of the question.
    const liveFracs = correct.filter((b) => b.firstInRoom && b.wordIndex !== null).map((b) => b.wordIndex! / wc);
    const avgLiveFrac = liveFracs.length ? liveFracs.reduce((a, b) => a + b, 0) / liveFracs.length : null;
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
      // Only where a team rename actually moved the name — otherwise every buzz
      // in every set would carry a copy of the team it already names.
      ...(b.origTeam && b.origTeam !== b.team ? { origTeam: b.origTeam } : {}),
      ...(b.editionId ? { editionId: b.editionId } : {}),
    })).sort((a, b) => (a.wordIndex === null ? 1 : 0) - (b.wordIndex === null ? 1 : 0) || (a.wordIndex ?? 0) - (b.wordIndex ?? 0));
    const convPct = pct(powers + gets, heard);
    tuSumm.push({
      id, round: t.round, num: t.num, answer: t.answer, category: t.category, subcategory: t.subcategory,
      tags: t.tags,
      heard, powers, gets, convPct, powerPct: pct(powers, heard), incorrectPct: pct(incorrectBefore, heard),
      avgBuzzPct: avgFrac == null ? null : round1(100 * avgFrac),
      avgLiveBuzzPct: avgLiveFrac == null ? null : round1(100 * avgLiveFrac),
    });
    tuDetail[id] = {
      id, round: t.round, num: t.num, answer: t.answer, questionHtml: t.questionHtml,
      category: t.category, subcategory: t.subcategory, tags: t.tags,
      words: t.words, powerIndex: t.powerIndex, wordCount: t.wordCount,
      heard, powers, gets, convPct, powerPct: pct(powers, heard), incorrectPct: pct(incorrectBefore, heard),
      avgBuzzPct: avgFrac == null ? null : round1(100 * avgFrac),
      avgLiveBuzzPct: avgLiveFrac == null ? null : round1(100 * avgLiveFrac),
      impreciseCount: impreciseN, buzzes: detailBuzzes,
    };
    let cs = catTuSub.get(t.subcategory);
    if (!cs) { cs = { main: t.category, heard: 0, powers: 0, gets: 0, buzzSum: 0, buzzN: 0, firstConv: 0, secondConv: 0, incorrectBefore: 0 }; catTuSub.set(t.subcategory, cs); }
    cs.main = t.category; cs.heard += heard; cs.powers += powers; cs.gets += gets;
    cs.firstConv += firstConv; cs.secondConv += secondConv; cs.incorrectBefore += incorrectBefore;
    if (avgFrac != null) { cs.buzzSum += fracs.reduce((a, b) => a + b, 0); cs.buzzN += fracs.length; }
    for (const tag of t.tags) {
      let ta = tagTuAcc.get(tag);
      if (!ta) { ta = { main: tagDim(tag), heard: 0, powers: 0, gets: 0, buzzSum: 0, buzzN: 0, firstConv: 0, secondConv: 0, incorrectBefore: 0 }; tagTuAcc.set(tag, ta); }
      ta.heard += heard; ta.powers += powers; ta.gets += gets;
      ta.firstConv += firstConv; ta.secondConv += secondConv; ta.incorrectBefore += incorrectBefore;
      if (avgFrac != null) { ta.buzzSum += fracs.reduce((a, b) => a + b, 0); ta.buzzN += fracs.length; }
    }
  }
  files["tossups.json"] = tuSumm;
  files["tossups_detail.json"] = tuDetail;

  /* ----------------------------- bonuses + detail ----------------------------- */
  if (cfg.hasBonuses) {
    const bnSumm: Record<string, unknown>[] = [];
    const bnDetail: Record<string, unknown> = {};
    const catBnSub = new Map<string, CatBnAcc>();
    // The same bonus numbers grouped by tag rather than by category.
    const tagBnAcc = new Map<string, CatBnAcc>();
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
        const diff = diffAt(b.difficultyModifiers, i);
        const row = { idx: i, difficulty: diff, difficultyName: diffLabel(diff), answer: b.answers[i] || "", part: b.parts[i] || "", convPct: pct(got, heard), convCount: got };
        partConv.push(row);
        if (!byDiff[diff]) byDiff[diff] = { answer: row.answer, convPct: row.convPct };
        const slot = cb.parts.get(diff) || [0, 0]; slot[0] += got; slot[1] += heard; cb.parts.set(diff, slot);
      }
      cb.main = b.category; cb.heard += heard; cb.pts += totalPts;
      for (const tag of b.tags) {
        let ta = tagBnAcc.get(tag);
        if (!ta) { ta = bnNew(); ta.main = tagDim(tag); tagBnAcc.set(tag, ta); }
        ta.heard += heard; ta.pts += totalPts;
        for (let i = 0; i < b.parts.length; i++) {
          const got = results.filter((r) => (r.partPts[i] || 0) > 0 || (r.bbPts[i] || 0) > 0).length;
          const diff = diffAt(b.difficultyModifiers, i);
          const slot = ta.parts.get(diff) || [0, 0]; slot[0] += got; slot[1] += heard; ta.parts.set(diff, slot);
        }
      }
      bnSumm.push({
        id, round: b.round, num: b.num, category: b.category, subcategory: b.subcategory, tags: b.tags, heard, ppb,
        easyPct: byDiff.e?.convPct ?? null, medPct: byDiff.m?.convPct ?? null, hardPct: byDiff.h?.convPct ?? null,
        easyAnswer: byDiff.e?.answer ?? null, medAnswer: byDiff.m?.answer ?? null, hardAnswer: byDiff.h?.answer ?? null,
      });
      bnDetail[id] = {
        id, round: b.round, num: b.num, category: b.category, subcategory: b.subcategory, tags: b.tags, leadin: b.leadin,
        parts: b.parts, answers: b.answers, difficultyModifiers: b.difficultyModifiers, heard, ppb, totalPts, partConv, results,
      };
    }
    files["bonuses.json"] = bnSumm;
    files["bonuses_detail.json"] = bnDetail;
    const bnAbsorbed = absorbedSubs(virtualCats, catBnSub.keys());
    const bnTree = buildCategoryTree<CatBnAcc>(withoutAbsorbed(catBnSub, bnAbsorbed), bnNew, bnAdd, bnFin);
    // Merged categories lead: they are the owner's own organization of the set,
    // and appended last they sat below every category they were meant to replace.
    for (const v of [...virtualCats].reverse()) {
      const node = buildVirtualNode<CatBnAcc>(v.name, virtualMembers(v), catBnSub, bnNew, bnAdd, bnFin);
      if (node) bnTree.unshift(node);
    }
    files["categories_bonus.json"] = bnTree;
    // Same grouping-by-dimension as the tossup tags, with bonus columns.
    const bnTagDims = new Map<string, { tag: string; value: string; stats: ReturnType<typeof bnFin> }[]>();
    for (const [tag, acc] of tagBnAcc) {
      const dim = tagDim(tag) || "Tag";
      const list = bnTagDims.get(dim) || [];
      list.push({ tag, value: tagValue(tag), stats: bnFin(acc) });
      bnTagDims.set(dim, list);
    }
    files["tags_bonus.json"] = [...bnTagDims.entries()]
      .map(([dim, values]) => ({
        dim,
        values: values.map((v) => ({ tag: v.tag, value: v.value, ...v.stats })).sort((a, b) => b.heard - a.heard || a.value.localeCompare(b.value)),
      }))
      .sort((a, b) => a.dim.localeCompare(b.dim));
    bonusTagCount = tagBnAcc.size;
  }

  /* ----------------------------- players (list + detail) ----------------------------- */
  const catStatRows = (catMap: Map<string, CatAcc> | undefined, totalPts: number, heard?: Map<string, number>) => {
    const rows = [...(catMap || new Map<string, CatAcc>()).entries()].map(([cat, c]) => ({
      category: cat, powers: c.powers, gets: c.gets, incorrect: c.incorrect, points: c.points,
      earliest: c.earliest === null ? null : c.earliest + 1,
      avgBuzz: c.posN ? round1(c.posSum / c.posN + 1) : null,
      pctPoints: totalPts ? round1((100 * c.points) / totalPts) : 0,
      bpa: bpaOf(c.unread, heard?.get(cat) || 0),
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
    // Games/TUH: sources frequently list only the players who buzzed in a game, so
    // a player's own game/TUH tallies undercount games they played without buzzing.
    // Credit every player with all the games (and full tossups-heard) that their
    // team played, so games/TUH/PPG reflect the rounds their team was in.
    const tmStats = tm.get(s.team);
    const g = tmStats ? tmStats.games : s.games.size;
    const tuh = tmStats ? tmStats.fullTuh : s.tuh;
    // Rebounds: tossups this player converted after another team had buzzed wrong
    // (already flagged per-buzz in the buzz log).
    const rebounds = (plBuzzes.get(k) || []).filter((b) => b.rebound).length;
    const row = {
      id: pid, name: s.name, team: s.team, teamId: teamId.get(s.team) ?? null,
      games: g, tuh, powers: s.powers, gets: s.gets, incorrect: s.incorrect, pts: s.pts,
      firstBuzzes: firstPl.get(k) || 0, top3Buzzes: top3Pl.get(k) || 0, rebounds,
      ppg: g ? round1(s.pts / g) : 0, pPerTuh: tuh ? Math.round((100 * s.pts) / tuh) / 100 : 0,
      // Over the same tossups-heard the rest of this row uses, so BPA and PPG are
      // talking about the same denominator.
      bpa: bpaOf(s.unread, tuh),
    };
    players.push(row);
    if (!teamRoster.has(s.team)) teamRoster.set(s.team, []);
    teamRoster.get(s.team)!.push(row);
    plDetail[pid] = { ...row, categories: catStatRows(plCat.get(k), s.pts || 0, tmCatHeardMid.get(s.team)), buzzes: buzzRowsFor(s.name, s.team) };
  }
  players.sort((a, b) => (b.ppg as number) - (a.ppg as number));
  files["players.json"] = players;
  files["players_detail.json"] = plDetail;

  /* ----------------------------- teams (list + detail) ----------------------------- */
  const tutNew = (): TuCat => ({ ...newCatAcc(), main: "" });
  const tutAdd = (a: TuCat, s: TuCat) => { a.main = a.main || s.main; a.powers += s.powers; a.gets += s.gets; a.incorrect += s.incorrect; a.points += s.points; a.posSum += s.posSum; a.posN += s.posN; a.unread += s.unread; a.tuh += s.tuh; if (s.earliest !== null) a.earliest = a.earliest === null ? s.earliest : Math.min(a.earliest, s.earliest); };
  const tutFin = (totalPts: number) => (a: TuCat) => ({
    heard: a.powers + a.gets + a.incorrect, powers: a.powers, gets: a.gets, incorrect: a.incorrect, points: a.points,
    earliest: a.earliest === null ? null : a.earliest + 1, avgBuzz: a.posN ? round1(a.posSum / a.posN + 1) : null,
    pctPoints: totalPts ? round1((100 * a.points) / totalPts) : 0,
    bpa: bpaOf(a.unread, a.tuh),
  });

  // A leaf's denominator is what that team heard in that subcategory; parents get
  // theirs by summing, which is right because a tossup sits in exactly one.
  for (const [team, subs] of tmTuCat)
    for (const [sub, acc] of subs) acc.tuh = tmCatHeardSub.get(team)?.get(sub) || 0;

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
      // fullTuh, not tuh: a team heard every tossup read in its games, whether or
      // not the source listed a player against each one.
      bpa: bpaOf(s.unread, s.fullTuh),
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
  const tuAbsorbed = absorbedSubs(virtualCats, catTuSub.keys());
  const ct = buildCategoryTree<CatTuAcc>(withoutAbsorbed(catTuSub, tuAbsorbed), tuCatNew, tuCatAdd, tuCatFin);

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
        agg.posSum += c.posSum; agg.posN += c.posN; agg.unread += c.unread;
        // The BPA denominator for this slice: what the player's team heard in
        // each subcategory the filter matched. Summing is right because a tossup
        // belongs to exactly one subcategory, so nothing is counted twice.
        agg.tuh += tmCatHeardSub.get(p.team)?.get(fs) || 0;
        if (c.earliest !== null) agg.earliest = agg.earliest === null ? c.earliest : Math.min(agg.earliest, c.earliest);
        agg.first += firstPlfc.get(`${k}${SEP}${fs}`) || 0;
        agg.top3 += top3Plfc.get(`${k}${SEP}${fs}`) || 0;
      }
      if (matched && agg.powers + agg.gets + agg.incorrect > 0)
        rows.push({
          playerId: playerId.get(k) ?? null, name: p.name, team: p.team, teamId: teamId.get(p.team) ?? null,
          powers: agg.powers, gets: agg.gets, incorrect: agg.incorrect, points: agg.points,
          earliest: agg.earliest === null ? null : agg.earliest + 1, avgBuzz: agg.posN ? round1(agg.posSum / agg.posN + 1) : null,
          firstBuzzes: agg.first, top3Buzzes: agg.top3, bpa: bpaOf(agg.unread, agg.tuh),
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
  for (const v of [...virtualCats].reverse()) {
    const members = virtualMembers(v);
    const node = buildVirtualNode<CatTuAcc>(v.name, members, catTuSub, tuCatNew, tuCatAdd, tuCatFin);
    if (!node) continue;
    emitNode(node, v.name, (fs) => members.some((m) => vmatchSub(fs, m)));
    for (const s of node.subs) emitNode(s, s.subcategory, (fs) => vmatchSub(fs, s.subcategory));
    ct.unshift(node);
  }
  files["categories_tossup.json"] = ct;

  // Tags, grouped by dimension ("Writer", "Difficulty", …) and ordered by how
  // much of the set each one covers.
  const tagDims = new Map<string, { tag: string; value: string; stats: ReturnType<typeof tuCatFin> }[]>();
  for (const [tag, acc] of tagTuAcc) {
    const dim = tagDim(tag) || "Tag";
    const list = tagDims.get(dim) || [];
    list.push({ tag, value: tagValue(tag), stats: tuCatFin(acc) });
    tagDims.set(dim, list);
  }
  files["tags_tossup.json"] = [...tagDims.entries()]
    .map(([dim, values]) => ({
      dim,
      values: values.map((v) => ({ tag: v.tag, value: v.value, ...v.stats })).sort((a, b) => b.heard - a.heard || a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => a.dim.localeCompare(b.dim));
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
    // Whether any question carries a tag, so the client only offers the Tags tab
    // and filters once the owner has marked a metadata field as one.
    hasTags: tagTuAcc.size > 0 || bonusTagCount > 0,
    // Nobody has confirmed what this set's metadata fields mean, and there's more
    // than one of them — so the categories below are a guess. Owner-facing.
    needsCategoryMapping: ambiguousMeta,
    numGames: games.length, numTeams: tm.size, numPlayers: pl.size,
    numTossups: tossups.size, numBonuses: cfg.hasBonuses ? bonuses.size : 0,
    rounds: [...new Set([...tossups.values()].map((t) => t.round))].sort((a, b) => a - b),
    // Advisory heuristic: categories that look mislabeled (author initials/names,
    // short codes) rather than real subjects. Shown to owners; never blocks upload.
    categoryWarnings: scanCategoryQuality(tossups),
    // Advisory: packet rounds that don't line up with the rounds games were
    // played in (so their questions can never accumulate buzzes). Owners get a
    // banner and a renumbering tool in Settings.
    roundWarnings: scanRoundAlignment(packets, games),
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
export function bonusFilesFromImported(list: ImportedBonus[], virtualCats: VirtualCategory[] = [], metaMap: MetaMap | null = null): Record<string, unknown> {
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
    // Imported bonus stats carry their category as a raw metadata string.
    const { main, full: sub } = resolveMeta(b.category, metaMap ?? null);
    const heard = b.heard;
    const totalPts = b.points;
    const ppb = heard ? Math.round((100 * totalPts) / heard) / 100 : 0;
    const partConv: Record<string, unknown>[] = [];
    const byDiff: Record<string, { answer: string; convPct: number }> = {};
    let cb = catBnSub.get(sub);
    if (!cb) { cb = bnNew(); cb.main = main; catBnSub.set(sub, cb); }
    for (let i = 0; i < b.answers.length; i++) {
      const got = b.got[i] || 0;
      const diff = diffAt(b.difficultyModifiers, i);
      const row = { idx: i, difficulty: diff, difficultyName: diffLabel(diff), answer: b.answers[i] || "", part: b.parts[i] || "", convPct: pct(got, heard), convCount: got };
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
  const bnAbsorbed = absorbedSubs(virtualCats, catBnSub.keys());
  const bnTree = buildCategoryTree<CatBnAcc>(withoutAbsorbed(catBnSub, bnAbsorbed), bnNew, bnAdd, bnFin);
  for (const v of [...virtualCats].reverse()) {
    const node = buildVirtualNode<CatBnAcc>(v.name, virtualMembers(v), catBnSub, bnNew, bnAdd, bnFin);
    if (node) bnTree.unshift(node);
  }
  return { "bonuses.json": bnSumm, "bonuses_detail.json": bnDetail, "categories_bonus.json": bnTree };
}
