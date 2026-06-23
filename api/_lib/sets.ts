// Shared set storage: raw source, corrections, requests, the set index, and the
// re-aggregation helper used by ingest and the edit endpoints.
import { put, del } from "@vercel/blob";
import { readBlobJson } from "./blob.js";
import { aggregate, PacketFile, GameFile, Correction } from "./aggregate.js";
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

export interface SetEntry {
  slug: string;
  name: string;
  scoring: string;
  hasBonuses: boolean;
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
export function sanitizeEntry(e: SetEntry, user: string | null) {
  const isOwner = !!user && user === e.owner;
  const { invites, ...rest } = e;
  return { ...rest, visibility: effectiveVisibility(e), inviteCount: (invites || []).length, ...(isOwner ? { invites } : {}) };
}
export interface CorrectionRequest {
  id: string;
  correction: Correction;
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

export const readRequests = (slug: string) => readBlobJson<CorrectionRequest[]>(`sets/${slug}/_requests.json`, false).then((r) => r || []);
export const writeRequests = (slug: string, r: CorrectionRequest[]) => writeJson(`sets/${slug}/_requests.json`, r);

// Access requests: a logged-in user asks the owner to be invited to a set.
export interface AccessRequest { email: string; name: string; at: string; status: "pending" | "approved" | "denied"; }
export const readAccess = (slug: string) => readBlobJson<AccessRequest[]>(`sets/${slug}/_access.json`, false).then((r) => r || []);
export const writeAccess = (slug: string, r: AccessRequest[]) => writeJson(`sets/${slug}/_access.json`, r);

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
  return [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, r]) => ({
    round,
    tossups: [...r.tossups.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t),
    bonuses: [...r.bonuses.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
  }));
}

const stripTxt = (s: string) => (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

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
  const cfg = { name: source.name, slug, scoring: getScoring(source.scoring), hasBonuses: source.hasBonuses };
  const editions = editionsOf(source);
  const multi = editions.length > 1;

  const editionSummaries: EditionSummary[] = [];
  for (const ed of editions) {
    const out = aggregate(ed.packets, ed.games, cfg, corrections);
    const m = out["meta.json"] as any;
    editionSummaries.push({ id: ed.id, label: ed.label, numGames: m.numGames, numTeams: m.numTeams, numPlayers: m.numPlayers, numTossups: m.numTossups, rounds: m.rounds.length });
    if (multi) await writeFiles(`sets/${slug}/editions/${ed.id}/`, out);
  }

  // combined (single-edition: identical to the one edition)
  const combinedGames = editions.flatMap((e) => e.games || []);
  const out = aggregate(combinedPackets(editions), combinedGames, cfg, corrections);
  (out["meta.json"] as any).editions = editionSummaries;
  if (multi) attachVersions(out, editions);
  await writeFiles(`sets/${slug}/`, out);
  return { meta: out["meta.json"] as any, editions: editionSummaries };
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
