// Shared set storage: raw source, corrections, requests, the set index, and the
// re-aggregation helper used by ingest and the edit endpoints.
import { put, del } from "@vercel/blob";
import { readBlobJson } from "./blob.js";
import { aggregate, bonusFilesFromImported, ImportedBonus, PacketFile, GameFile, Correction, VirtualCategory, PlayerRename, MetaMap, TagEdits, AggregateConfig } from "./aggregate.js";
import { getScoring } from "./scoring.js";

export interface Edition {
  id: string;
  label: string;
  packets: PacketFile[];
  games: GameFile[];
}
export interface SetSource {
  name: string;
  scoring: string;
  hasBonuses: boolean;
  editions?: Edition[];     // multi-edition model
  packets?: PacketFile[];   // legacy single-edition fallback
  games?: GameFile[];       // legacy
}
// Normalize a source to its editions (legacy single-edition sources become one
// "Original" edition).
export function editionsOf(s: SetSource): Edition[] {
  if (s.editions && s.editions.length) return s.editions;
  return [{ id: "e0", label: "Original", packets: s.packets || [], games: s.games || [] }];
}
export interface EditionSummary { id: string; label: string; numGames: number; numTeams: number; numPlayers: number; numTossups: number; rounds: number; }
export type Visibility = "public" | "listed" | "private";

// Tournament level/type ids (labels live on the client).
export const TOURNAMENT_LEVELS = ["hs", "college", "open", "popculture", "side"] as const;

export interface SetEntry {
  slug: string;
  name: string;
  scoring: string;
  hasBonuses: boolean;
  // "results" = imported from a YellowFruit/QBJ box score (no buzz/question data);
  // absent/"buzz" = the default packet + QBJ buzz-level tournament.
  kind?: "buzz" | "results";
  owner: string;
  // A tournament may have multiple editions (mirrors). Top-level counts are the
  // COMBINED totals; per-edition summaries live here. Absent => single edition.
  editions?: EditionSummary[];
  // "public": on the list, anyone may view. "listed": on the list, but viewing
  // requires login + invite. "private": invite-only and not shown on the list.
  visibility: Visibility;
  invites: string[]; // normalized emails allowed to view (besides the owner)
  // ISO date when a non-public set auto-publishes, or null if the owner opted out.
  autoPublicAt: string | null;
  // Phase/tag summaries (present when the owner has tagged rounds) used to build
  // the phase filter; each tag also has a scoped set of stat files.
  tags?: TagSummary[];
  // True when the owner uploaded a companion YellowFruit (.yft) file, enabling the
  // corrected-export download.
  hasYf?: boolean;
  // Tournament level/type (one of TOURNAMENT_LEVELS) and an optional link to its
  // hsquizbowl Tournament Database entry. Set at creation; absent on legacy sets.
  level?: string;
  tdLink?: string;
  numGames: number;
  numTeams: number;
  numPlayers: number;
  numTossups: number;
  rounds: number;
  createdAt: string;
}

// Effective visibility, applying the auto-publish date: a non-public set whose
// autoPublicAt has passed is treated as public.
export function effectiveVisibility(e: SetEntry): Visibility {
  if (e.visibility === "public") return "public";
  if (e.autoPublicAt && Date.now() >= Date.parse(e.autoPublicAt)) return "public";
  return e.visibility ?? "listed";
}
// Does this user have *legitimate* (un-redacted) access to the set's content?
export function canViewContent(e: SetEntry, user: string | null): boolean {
  if (effectiveVisibility(e) === "public") return true;
  if (!user) return false;
  if (user === e.owner) return true;
  return (e.invites || []).includes(user);
}
// Admins may reach a set (for management), but their content is redacted unless
// they legitimately have access or explicitly reveal it.
export function canView(e: SetEntry, user: string | null, isAdmin = false): boolean {
  return canViewContent(e, user) || isAdmin;
}
export function canList(e: SetEntry, user: string | null, isAdmin = false): boolean {
  if (isAdmin) return true;
  const v = effectiveVisibility(e);
  if (v === "public" || v === "listed") return true;
  return !!user && (user === e.owner || (e.invites || []).includes(user));
}

// Strip question content (questions + answers + leadins) from a computed file,
// keeping stats/structure intact. Used when an admin views a non-public set they
// don't own and hasn't revealed.
const HIDDEN = "■ content hidden";
const MASK = "▆▆";
const maskArr = (a: unknown) => (Array.isArray(a) ? a.map(() => MASK) : a);
const maskText = (s: unknown) => (typeof s === "string" && s ? s.split(/\s+/).map(() => MASK).join(" ") : s);
export const CONTENT_FILES = new Set([
  "tossups.json", "tossups_detail.json", "bonuses.json", "bonuses_detail.json",
  "first_sentence.json", "buzzer_races.json", "players_detail.json",
]);
export function redactContent(file: string, data: any): any {
  const o = (m: any) => { const r: any = {}; for (const k in data) r[k] = m(data[k]); return r; };
  switch (file) {
    case "tossups.json":
      return (data as any[]).map((r) => ({ ...r, answer: HIDDEN }));
    case "tossups_detail.json":
      return o((v: any) => ({ ...v, answer: HIDDEN, questionHtml: "", words: maskArr(v.words) }));
    case "bonuses.json":
      return (data as any[]).map((r) => ({ ...r, easyAnswer: r.easyAnswer == null ? null : HIDDEN, medAnswer: r.medAnswer == null ? null : HIDDEN, hardAnswer: r.hardAnswer == null ? null : HIDDEN }));
    case "bonuses_detail.json":
      return o((v: any) => ({ ...v, leadin: "", parts: maskArr(v.parts), answers: (v.answers || []).map(() => HIDDEN), partConv: (v.partConv || []).map((p: any) => ({ ...p, answer: HIDDEN, part: MASK })) }));
    case "first_sentence.json":
      return (data as any[]).map((r) => ({ ...r, answer: HIDDEN, sentenceWords: maskArr(r.sentenceWords) }));
    case "buzzer_races.json":
      return (data as any[]).map((r) => ({ ...r, answer: HIDDEN, before: maskText(r.before), hot: maskText(r.hot), after: maskText(r.after) }));
    case "players_detail.json":
      return o((v: any) => ({ ...v, buzzes: (v.buzzes || []).map((b: any) => ({ ...b, answer: HIDDEN })) }));
    default:
      return data;
  }
}
// Client-safe view of an entry (never leak the invite list to non-owners).
// `hasAccess` lets the list group sets the viewer can already open (owned, invited,
// or public) without exposing who else is invited.
export function sanitizeEntry(e: SetEntry, user: string | null) {
  const isOwner = !!user && user === e.owner;
  const { invites, ...rest } = e;
  return { ...rest, visibility: effectiveVisibility(e), inviteCount: (invites || []).length, hasAccess: canViewContent(e, user), ...(isOwner ? { invites } : {}) };
}
// A proposed edit awaiting the owner. Exactly one of `correction` (one buzz) or
// `rename` (a player across the whole tournament) is set; `correction` stays
// non-optional in shape for the many older records that predate renames.
export interface CorrectionRequest {
  id: string;
  correction?: Correction;
  rename?: PlayerRename;
  by: string;
  at: string;
  status: "pending" | "approved" | "rejected";
  desc?: string;
}

async function writeJson(path: string, obj: unknown) {
  await put(path, JSON.stringify(obj), {
    access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
  });
}

export const readIndex = () => readBlobJson<{ sets: SetEntry[] }>("sets/index.json", false).then((d) => d || { sets: [] });
export const writeIndex = (idx: { sets: SetEntry[] }) => writeJson("sets/index.json", idx);
export const getSetEntry = (slug: string) => readIndex().then((idx) => idx.sets.find((s) => s.slug === slug) || null);

export const readSource = (slug: string) => readBlobJson<SetSource>(`sets/${slug}/_source.json`);
export const writeSource = (slug: string, s: SetSource) => writeJson(`sets/${slug}/_source.json`, s);

export const readCorrections = (slug: string) => readBlobJson<Correction[]>(`sets/${slug}/_corrections.json`, false).then((c) => c || []);
export const writeCorrections = (slug: string, c: Correction[]) => writeJson(`sets/${slug}/_corrections.json`, c);

// Set-wide player renames applied on (re-)aggregation. Same lifecycle as
// corrections: the owner writes them directly, viewers propose them.
export const readRenames = (slug: string) =>
  readBlobJson<PlayerRename[]>(`sets/${slug}/_renames.json`, false).then((r) => r || []);
export const writeRenames = (slug: string, r: PlayerRename[]) => writeJson(`sets/${slug}/_renames.json`, r);

const renameKey = (r: PlayerRename) => `${r.team ?? ""}|${r.from}`;

export function validRename(r: any): r is PlayerRename {
  if (!r || typeof r.from !== "string" || typeof r.to !== "string") return false;
  const from = r.from.trim(), to = r.to.trim();
  if (!from || !to || from === to) return false;
  if (from.length > 120 || to.length > 120) return false;
  return r.team === null || r.team === undefined || (typeof r.team === "string" && r.team.length <= 200);
}

// Add a rename, keeping the list a single-pass map: an existing rename whose
// TARGET is being renamed again is retargeted rather than left to dangle, so
// "A -> B" followed by "B -> C" ends up as "A -> C" plus "B -> C" instead of a
// chain the aggregator would refuse to follow.
export function mergeRename(list: PlayerRename[], incoming: PlayerRename): PlayerRename[] {
  const inc: PlayerRename = { ...incoming, from: incoming.from.trim(), to: incoming.to.trim(), team: incoming.team ?? null };
  const sameScope = (r: PlayerRename) => (r.team ?? null) === inc.team || r.team === null;
  const out = list
    .filter((r) => renameKey(r) !== renameKey(inc))
    .map((r) => (r.to === inc.from && sameScope(r) ? { ...r, to: inc.to } : r));
  // A rename onto a name that is itself renamed away would strand the player.
  const onward = out.find((r) => r.from === inc.to && sameScope(r));
  return [...out, onward ? { ...inc, to: onward.to } : inc];
}

// Owner-defined merged ("virtual") categories applied to the tossup + bonus
// category trees on (re-)aggregation.
export const readVirtualCats = (slug: string) =>
  readBlobJson<VirtualCategory[]>(`sets/${slug}/_virtualcats.json`, false).then((c) => c || []);
export const writeVirtualCats = (slug: string, c: VirtualCategory[]) => writeJson(`sets/${slug}/_virtualcats.json`, c);

// How the owner said to read this set's question metadata (which comma-separated
// field is the category, which are tag dimensions), and any hand edits to the
// tags that mapping produces. Both are applied on (re-)aggregation.
export const readMetaMap = (slug: string) =>
  readBlobJson<MetaMap>(`sets/${slug}/_metamap.json`, false).then((m) => (m?.fields?.length ? m : null));
export const writeMetaMap = (slug: string, m: MetaMap) => writeJson(`sets/${slug}/_metamap.json`, m);
export const readTagEdits = (slug: string) =>
  readBlobJson<TagEdits>(`sets/${slug}/_tagedits.json`, false).then((t) => t || {});
export const writeTagEdits = (slug: string, t: TagEdits) => writeJson(`sets/${slug}/_tagedits.json`, t);

// Owner-assigned round tags ("phases"): a map of round number -> tag names. Used
// to write per-tag scoped stat files so viewers can filter every page to a phase.
export type RoundTags = Record<string, string[]>;
export const readRoundTags = (slug: string) =>
  readBlobJson<RoundTags>(`sets/${slug}/_roundtags.json`, false).then((r) => r || {});
export const writeRoundTags = (slug: string, r: RoundTags) => writeJson(`sets/${slug}/_roundtags.json`, r);

// Default phase vocabulary offered in the owner UI (custom tags are also allowed).
export const DEFAULT_ROUND_TAGS = ["Prelims", "Playoffs", "Finals", "Superplayoffs", "Tiebreakers"];

export interface TagSummary { name: string; slug: string; rounds: number[]; numGames: number; numTeams: number; numPlayers: number; }
export const tagSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";

export const readRequests = (slug: string) => readBlobJson<CorrectionRequest[]>(`sets/${slug}/_requests.json`, false).then((r) => r || []);
export const writeRequests = (slug: string, r: CorrectionRequest[]) => writeJson(`sets/${slug}/_requests.json`, r);

// Access requests: a logged-in user asks the owner to be invited to a set.
// They must declare their affiliation: a role and the team they were part of.
export type AccessRole = "player" | "staff" | "coach";
export interface AccessRequest {
  email: string; name: string; at: string;
  status: "pending" | "approved" | "denied";
  role?: AccessRole; team?: string;
  // How the request stopped being pending, and when. "link" means they redeemed
  // an invite link themselves — which is why an owner can open a request email
  // and find the person already has access.
  via?: "owner" | "link";
  resolvedAt?: string;
}
export const readAccess = (slug: string) => readBlobJson<AccessRequest[]>(`sets/${slug}/_access.json`, false).then((r) => r || []);
export const writeAccess = (slug: string, r: AccessRequest[]) => writeJson(`sets/${slug}/_access.json`, r);

// Optional companion YellowFruit (.yft) file a buzz tournament's owner uploaded.
// Kept verbatim so a corrections-applied copy can be re-exported (see
// /api/yf-export). Buzz reassignments are the corrections; no separate YF state.
export const readYf = (slug: string) => readBlobJson<any>(`sets/${slug}/_yf.json`, false);
export const writeYf = (slug: string, raw: unknown) => writeJson(`sets/${slug}/_yf.json`, raw);

// Invite links: a shareable token any logged-in account can redeem to join a set.
export interface InviteLink { id: string; label: string; by: string; at: string; revoked?: boolean; uses: number; }
export const readLinks = (slug: string) => readBlobJson<InviteLink[]>(`sets/${slug}/_links.json`, false).then((r) => r || []);
export const writeLinks = (slug: string, r: InviteLink[]) => writeJson(`sets/${slug}/_links.json`, r);

async function writeFiles(prefix: string, files: Record<string, unknown>) {
  await Promise.all(
    Object.entries(files).map(([rel, obj]) =>
      put(`${prefix}${rel}`, JSON.stringify(obj), {
        access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
      })
    )
  );
}

// Merge editions' packets by (round, position); the LATEST edition that defines a
// slot wins, so the combined view shows the most recent version of each question.
function combinedPackets(editions: Edition[]): PacketFile[] {
  const rounds = new Map<number, { tossups: Map<number, any>; bonuses: Map<number, any> }>();
  for (const e of editions)
    for (const p of e.packets || []) {
      let r = rounds.get(p.round);
      if (!r) { r = { tossups: new Map(), bonuses: new Map() }; rounds.set(p.round, r); }
      (p.tossups || []).forEach((t, i) => r!.tossups.set(i, t)); // later editions overwrite
      (p.bonuses || []).forEach((b, i) => r!.bonuses.set(i, b));
    }
  // Place each question at its own index (not compacted): canonicalizeTossups may
  // leave gaps/appended slots, and buzzes are keyed by slot number, so positions
  // must be preserved. Holes (slots no edition filled) are skipped downstream.
  const atIndex = <T>(m: Map<number, T>): T[] => { const a: T[] = []; for (const [i, v] of m) a[i] = v; return a; };
  return [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, r]) => ({
    round,
    tossups: atIndex(r.tossups),
    bonuses: atIndex(r.bonuses),
  }));
}

// Gather pre-aggregated (index-derived) bonus stats from editions' packets, for
// the given scope (all rounds, or a filtered subset for a phase tag). Returns []
// for tournaments whose bonuses came from per-game QBJ data (those keep the
// game-derived bonus files from aggregate()).
function collectImportedBonuses(editions: Edition[], roundFilter?: Set<number>): ImportedBonus[] {
  const out: ImportedBonus[] = [];
  for (const e of editions)
    for (const p of e.packets || []) {
      if (roundFilter && !roundFilter.has(p.round)) continue;
      (p.bonuses || []).forEach((b: any, i) => {
        if (!b || !b.stats) return;
        out.push({
          round: p.round, num: i + 1, category: b.metadata || "",
          parts: b.parts || [], answers: b.answers || [], difficultyModifiers: b.difficultyModifiers || [],
          heard: b.stats.heard || 0, got: b.stats.got || [], points: b.stats.points || 0,
        });
      });
    }
  return out;
}

const stripTxt = (s: string | undefined) => (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// A compact comparison token for a tossup answer line: the primary answer only
// (cut before the first bracketed alternate/prompt or parenthetical), lowercased
// and reduced to its first few alphanumeric words. Robust to formatting/HTML
// differences between mirrors of the same question.
function answerKey(ans: string): string {
  let s = stripTxt(ans).toLowerCase().split(/\[|\(/)[0];
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  return s.split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
}

// Align editions' round numbering to a common packet identity. Different mirrors
// of a tournament (ACF Fall/Winter/Regionals especially) read the same packets in
// a DIFFERENT round order, so keying questions by administration round pools
// buzzes from different questions under one `round-num`. We match each edition's
// packets to a reference edition's packets by their set of answer lines and
// renumber rounds so the same physical packet shares a round number everywhere.
// A no-op (returns the input) for a single edition or when orders already agree.
export function canonicalizeEditions(editions: Edition[]): Edition[] {
  return canonicalizeTossups(canonicalizeRounds(editions));
}

function canonicalizeRounds(editions: Edition[]): Edition[] {
  if (editions.length <= 1) return editions;
  const sig = (p: PacketFile) => new Set((p.tossups || []).map((t) => answerKey(t.answer)).filter(Boolean));
  const perEd = editions.map((e) => (e.packets || []).map((p) => ({ round: p.round, set: sig(p) })));

  // Reference = the most complete edition (most packets), earliest on a tie.
  let refIdx = 0;
  for (let i = 1; i < perEd.length; i++) if (perEd[i].length > perEd[refIdx].length) refIdx = i;

  // Canonical rounds are seeded from the reference edition (identity), and grow as
  // other editions contribute packets the reference lacks.
  const canon: { round: number; set: Set<string> }[] = perEd[refIdx].map((p) => ({ round: p.round, set: p.set }));
  let nextRound = Math.max(0, ...canon.map((c) => c.round)) + 1;
  const remap = editions.map(() => new Map<number, number>());
  for (const p of perEd[refIdx]) remap[refIdx].set(p.round, p.round);

  const interCount = (a: Set<string>, b: Set<string>) => {
    let n = 0;
    for (const k of a) if (b.has(k)) n++;
    return n;
  };

  for (let e = 0; e < editions.length; e++) {
    if (e === refIdx) continue;
    const packets = perEd[e];
    // Greedily pair this edition's packets to canonical rounds by best overlap.
    // Require a majority of answers to line up AND at least a few in absolute
    // terms, so a sparsely-scraped packet can't false-match on one shared answer.
    const pairs: { pi: number; ci: number; s: number }[] = [];
    packets.forEach((p, pi) => canon.forEach((c, ci) => {
      const inter = interCount(p.set, c.set);
      const s = p.set.size && c.set.size ? inter / Math.min(p.set.size, c.set.size) : 0;
      if (s >= 0.5 && inter >= 3) pairs.push({ pi, ci, s });
    }));
    pairs.sort((a, b) => b.s - a.s);
    const usedP = new Set<number>(), usedC = new Set<number>();
    for (const { pi, ci } of pairs) {
      if (usedP.has(pi) || usedC.has(ci)) continue;
      usedP.add(pi); usedC.add(ci);
      remap[e].set(packets[pi].round, canon[ci].round);
    }
    // Packets with no match are new canonical rounds (so later editions can match
    // them too), appended after the existing canonical rounds.
    packets.forEach((p, pi) => {
      if (usedP.has(pi)) return;
      const round = nextRound++;
      canon.push({ round, set: p.set });
      remap[e].set(p.round, round);
    });
  }

  // Nothing moved (orders already agree) -> return the input unchanged.
  const changed = remap.some((m) => [...m.entries()].some(([o, c]) => o !== c));
  if (!changed) return editions;

  return editions.map((e, i) => {
    const map = (r: number) => remap[i].get(r) ?? r;
    return {
      ...e,
      packets: (e.packets || []).map((p) => ({ ...p, round: map(p.round) })),
      games: (e.games || []).map((g) => ({ ...g, round: map(g.round) })),
    };
  });
}

// After rounds are aligned, fix packets whose tossups a mirror READ IN A DIFFERENT
// ORDER — or where a mirror PLAYED A DIFFERENT QUESTION at a slot. Buzzes are
// keyed by (round, tossup number), so if one mirror read a packet's tossups in a
// different order, or swapped/replaced a tossup, buzzes on the same question land
// on different numbers and get pooled with (and rendered against) whatever
// question sits in that slot in the combined view — e.g. giveaway buzzes on a
// 136-word question shown past the end of the unrelated 128-word question that
// happens to occupy that slot.
//
// We align each round's tossups by ANSWER IDENTITY to a reference edition (the
// one with the most tossups that round): a tossup that shares its primary answer
// with a reference tossup is renumbered to the reference's position (so a reorder
// collapses onto one slot and its buzzes follow the question); a tossup with no
// reference match is a genuine replacement and is appended to its OWN new slot
// (shared across editions that played the same replacement) so its buzzes are
// never mixed into an unrelated question. Same primary answer, different wording
// stays merged (the `versions` list surfaces the wording diff); only genuinely
// different questions are split apart. A no-op for a single edition, and for
// mirrors that already agree on order.
export function canonicalizeTossups(editions: Edition[]): Edition[] {
  if (editions.length <= 1) return editions;
  const rounds = new Set<number>();
  for (const e of editions) for (const p of e.packets || []) rounds.add(p.round);
  const pktAt = editions.map((e) => { const m = new Map<number, PacketFile>(); for (const p of e.packets || []) m.set(p.round, p); return m; });

  const remap = editions.map(() => new Map<string, number>()); // `${round}-${oldNum}` -> newNum
  let changed = false;
  for (const round of rounds) {
    const present = editions.map((_, e) => ({ e, p: pktAt[e].get(round) })).filter((x): x is { e: number; p: PacketFile } => !!x.p);
    if (present.length < 2) continue;
    // Reference = the edition with the most tossups this round (stable seed order).
    let ref = present[0];
    for (const x of present) if ((x.p.tossups || []).length > (ref.p.tossups || []).length) ref = x;
    const refKeys = (ref.p.tossups || []).map((t) => answerKey(t.answer));
    // answerKey -> reference position (1-based), only for keys unique within ref.
    const refPos = new Map<string, number>();
    { const cnt = new Map<string, number>(); for (const k of refKeys) if (k) cnt.set(k, (cnt.get(k) || 0) + 1);
      refKeys.forEach((k, i) => { if (k && cnt.get(k) === 1 && !refPos.has(k)) refPos.set(k, i + 1); }); }
    // Replacements (a question not in the reference) are appended beyond the
    // largest packet; identical replacements across editions share a slot.
    let nextAppend = Math.max(0, ...present.map((x) => (x.p.tossups || []).length));
    const appendPos = new Map<string, number>();

    for (const { e, p } of present) {
      const ts = p.tossups || [];
      const target = new Array<number>(ts.length).fill(0);
      // 1) same question as the reference at the same slot -> stay put.
      ts.forEach((t, i) => { const k = answerKey(t.answer); if (k && refKeys[i] === k) target[i] = i + 1; });
      // 2) else a question matching a unique reference position -> move there (reorder).
      ts.forEach((t, i) => { if (target[i]) return; const k = answerKey(t.answer); if (k && refPos.has(k)) target[i] = refPos.get(k)!; });
      // 3) else a replacement (no reference match) -> append; a blank answer (e.g. a
      //    tossup that failed to scrape) can't be identified, so it stays in place.
      ts.forEach((t, i) => {
        if (target[i]) return;
        const k = answerKey(t.answer);
        if (!k) { target[i] = i + 1; return; }
        let slot = appendPos.get(k); if (slot === undefined) { slot = ++nextAppend; appendPos.set(k, slot); }
        target[i] = slot;
      });
      // 4) enforce injectivity: on any collision, push the later one to a fresh slot.
      const used = new Set<number>();
      ts.forEach((_, i) => { if (used.has(target[i])) target[i] = ++nextAppend; used.add(target[i]); });
      ts.forEach((_, i) => { if (target[i] !== i + 1) { remap[e].set(`${round}-${i + 1}`, target[i]); changed = true; } });
    }
  }
  if (!changed) return editions;

  const touched = (m: Map<string, number>, round: number) => { for (const k of m.keys()) if (k.startsWith(`${round}-`)) return true; return false; };
  return editions.map((e, ei) => {
    const m = remap[ei];
    if (m.size === 0) return e;
    const rm = (round: number, oldN: number) => m.get(`${round}-${oldN}`) ?? oldN;
    const packets = (e.packets || []).map((p) => {
      if (!touched(m, p.round)) return p;
      // Sparse: holes at canonical slots this edition never played (no buzzes
      // reference them; combined merge and versions both skip holes).
      const tossups: PacketFile["tossups"] = [];
      (p.tossups || []).forEach((t, i) => { tossups[rm(p.round, i + 1) - 1] = t; });
      return { ...p, tossups };
    });
    const games = (e.games || []).map((g) => {
      if (!touched(m, g.round)) return g;
      return { ...g, match_questions: (g.match_questions || []).map((mq) => {
        const tn = mq.tossup_question?.question_number;
        if (tn == null) return mq;
        const nn = rm(g.round, tn);
        return nn === tn ? mq : { ...mq, tossup_question: { ...mq.tossup_question, question_number: nn } };
      }) };
    });
    return { ...e, packets, games };
  });
}

// Attach a per-question `versions` list to each combined detail entry: each
// edition's question AT THAT POSITION (buzzes follow position), with a flag for
// whether it differs from the canonical (latest) version. Lets the UI switch
// between editions' wordings and surfaces replaced/revised questions.
function attachVersions(out: Record<string, unknown>, editions: Edition[]) {
  const tuPos = editions.map((e) => { const m = new Map<string, { q: string; a: string }>(); for (const p of e.packets || []) (p.tossups || []).forEach((t, i) => m.set(`${p.round}-${i + 1}`, { q: stripTxt(t.question), a: stripTxt(t.answer) })); return m; });
  const bnPos = editions.map((e) => { const m = new Map<string, string>(); for (const p of e.packets || []) (p.bonuses || []).forEach((b, i) => m.set(`${p.round}-${i + 1}`, stripTxt(b.leadin) + " || " + (b.parts || []).map(stripTxt).join(" | ") + " || " + (b.answers || []).map(stripTxt).join(" | "))); return m; });

  const tu = out["tossups_detail.json"] as Record<string, any>;
  for (const id in tu) {
    const d = tu[id]; const cq = stripTxt(d.questionHtml), ca = stripTxt(d.answer);
    const versions = editions.map((e, k) => { const v = tuPos[k].get(id); return v ? { editionId: e.id, label: e.label, id, differs: v.q !== cq || v.a !== ca } : null; }).filter(Boolean);
    if (versions.length > 1) d.versions = versions;
  }
  const bn = out["bonuses_detail.json"] as Record<string, any> | undefined;
  if (bn) for (const id in bn) {
    const d = bn[id]; const sig = stripTxt(d.leadin) + " || " + (d.parts || []).map(stripTxt).join(" | ") + " || " + (d.answers || []).map(stripTxt).join(" | ");
    const versions = editions.map((e, k) => { const v = bnPos[k].get(id); return v !== undefined ? { editionId: e.id, label: e.label, id, differs: v !== sig } : null; }).filter(Boolean);
    if (versions.length > 1) d.versions = versions;
  }
}

// Re-aggregate a tournament from its source + corrections. Writes COMBINED stats
// at the top level and, when there are 2+ editions, each edition under
// editions/<id>/. Returns the combined meta and the per-edition summaries.
export async function aggregateAndWrite(slug: string, source: SetSource, corrections: Correction[]) {
  const cfg: AggregateConfig = { name: source.name, slug, scoring: getScoring(source.scoring), hasBonuses: source.hasBonuses };
  // Align mirrors that read the packets in different round orders onto a common
  // packet numbering, so combined stats key each question consistently.
  const editions = canonicalizeEditions(editionsOf(source));
  const multi = editions.length > 1;
  const virtualCats = await readVirtualCats(slug);
  const renames = await readRenames(slug);
  const metaMap = await readMetaMap(slug);
  const tagEdits = await readTagEdits(slug);
  cfg.metaMap = metaMap;
  cfg.tagEdits = tagEdits;

  // Bonuses imported as aggregate-only stats: rebuild the bonus files from those
  // stats when there's no per-game bonus data. If per-team results WERE scraped
  // (games carry bonus results), aggregate() already produced full per-team
  // bonus files, so we keep those. A no-op for uploaded tournaments.
  const hasImportedBonuses = collectImportedBonuses(editions).length > 0;
  const overrideBonuses = (out: Record<string, unknown>, eds: Edition[], roundFilter?: Set<number>) => {
    if (!hasImportedBonuses) return;
    const b = out["bonuses.json"] as { heard?: number }[] | undefined;
    if (b && b.some((r) => (r.heard || 0) > 0)) return; // real per-game bonus data present; keep it
    Object.assign(out, bonusFilesFromImported(collectImportedBonuses(eds, roundFilter), virtualCats, metaMap));
  };

  const editionSummaries: EditionSummary[] = [];
  // Which edition(s) each team/player appeared in, keyed by the same raw names
  // the combined aggregation merges on, for annotating the combined rows.
  const teamEds = new Map<string, string[]>();
  const playerEds = new Map<string, string[]>();
  const playerKey = (r: any) => `${r.name}\u0000${r.team}`;
  for (const ed of editions) {
    const out = aggregate(ed.packets, ed.games, cfg, corrections, virtualCats, renames);
    overrideBonuses(out, [ed]);
    const m = out["meta.json"] as any;
    editionSummaries.push({ id: ed.id, label: ed.label, numGames: m.numGames, numTeams: m.numTeams, numPlayers: m.numPlayers, numTossups: m.numTossups, rounds: m.rounds.length });
    if (multi) {
      for (const t of out["teams.json"] as any[]) teamEds.set(t.name, [...(teamEds.get(t.name) || []), ed.id]);
      for (const p of out["players.json"] as any[]) { const k = playerKey(p); playerEds.set(k, [...(playerEds.get(k) || []), ed.id]); }
      await writeFiles(`sets/${slug}/editions/${ed.id}/`, out);
    }
  }

  // combined (single-edition: identical to the one edition)
  const combinedGames = editions.flatMap((e) => e.games || []);
  const combined = combinedPackets(editions);
  const out = aggregate(combined, combinedGames, cfg, corrections, virtualCats, renames);
  overrideBonuses(out, editions);
  (out["meta.json"] as any).editions = editionSummaries;
  if (multi) {
    attachVersions(out, editions);
    // Tag combined team/player rows (list + detail) with the editions they
    // appeared in, so the combined view can say which mirror was played.
    for (const t of out["teams.json"] as any[]) t.editionIds = teamEds.get(t.name) || [];
    const td = out["teams_detail.json"] as Record<string, any>;
    for (const id in td) td[id].editionIds = teamEds.get(td[id].name) || [];
    for (const p of out["players.json"] as any[]) p.editionIds = playerEds.get(playerKey(p)) || [];
    const pd = out["players_detail.json"] as Record<string, any>;
    for (const id in pd) pd[id].editionIds = playerEds.get(playerKey(pd[id])) || [];
  }
  await writeFiles(`sets/${slug}/`, out);

  // Per-phase (round-tag) scopes: re-aggregate the subset of rounds carrying each
  // tag and write its stat files under tags/<slug>/, so the UI can filter every
  // page to a phase the same way it scopes to an edition.
  const roundTags = await readRoundTags(slug);
  const tagToRounds = new Map<string, Set<number>>();
  for (const [rnd, names] of Object.entries(roundTags))
    for (const name of names) {
      const key = name.trim();
      if (!key) continue;
      let s = tagToRounds.get(key);
      if (!s) { s = new Set(); tagToRounds.set(key, s); }
      s.add(Number(rnd));
    }
  const tags: TagSummary[] = [];
  for (const [name, roundsSet] of tagToRounds) {
    const gm = combinedGames.filter((g) => roundsSet.has(g.round));
    if (!gm.length) continue;
    const pk = combined.filter((p) => roundsSet.has(p.round));
    const tout = aggregate(pk, gm, cfg, corrections, virtualCats, renames);
    overrideBonuses(tout, editions, roundsSet);
    const slugT = tagSlug(name);
    await writeFiles(`sets/${slug}/tags/${slugT}/`, tout);
    const tm = tout["meta.json"] as any;
    tags.push({ name, slug: slugT, rounds: [...roundsSet].sort((a, b) => a - b), numGames: tm.numGames, numTeams: tm.numTeams, numPlayers: tm.numPlayers });
  }
  tags.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  return { meta: out["meta.json"] as any, editions: editionSummaries, tags };
}

export async function deleteSet(slug: string, blobUrls: string[]) {
  if (blobUrls.length) await del(blobUrls);
}

export const corrKey = (c: Correction) =>
  `${c.round}|${c.num}|${c.team}|${c.fromPlayer}|${c.fromWordIndex}`;

// Apply an incoming correction over the existing list for the same raw buzz.
// Each edit overrides only the fields it specifies (toPlayer / toWordIndex), so a
// later word-move doesn't wipe out an earlier reassignment, and vice versa.
export function mergeCorrection(list: Correction[], incoming: Correction): Correction[] {
  const k = corrKey(incoming);
  const existing = list.find((c) => corrKey(c) === k);
  const merged: Correction = existing
    ? { ...existing }
    : { round: incoming.round, num: incoming.num, team: incoming.team, fromPlayer: incoming.fromPlayer, fromWordIndex: incoming.fromWordIndex };
  if (incoming.toPlayer !== undefined) merged.toPlayer = incoming.toPlayer;
  if (incoming.toWordIndex !== undefined) merged.toWordIndex = incoming.toWordIndex;
  merged.by = incoming.by;
  merged.at = incoming.at;
  return [...list.filter((c) => corrKey(c) !== k), merged];
}

export function validCorrection(c: any): c is Correction {
  return (
    c && typeof c.round === "number" && typeof c.num === "number" && typeof c.team === "string" &&
    (typeof c.fromPlayer === "string" || c.fromPlayer === null) &&
    (c.fromWordIndex === null || typeof c.fromWordIndex === "number") &&
    (c.toPlayer === undefined || c.toPlayer === null || typeof c.toPlayer === "string") &&
    (c.toWordIndex === undefined || c.toWordIndex === null || typeof c.toWordIndex === "number") &&
    (c.toPlayer !== undefined || c.toWordIndex !== undefined)
  );
}
