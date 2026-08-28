// A set's search document: everything the cross-tournament search needs about
// its questions and players, in one compact file, with the searchable text
// already stripped of markup and lowercased. Built at aggregation time; a set
// last built before this existed gets one made from its detail files the first
// time a search touches it, and written back so the next search doesn't.
//
// Why: a question search used to read tossups_detail.json AND bonuses_detail.json
// (and players_detail.json for players) from every accessible set — hundreds of
// kilobytes each, most of it per-buzz rows and question HTML that then had to be
// stripped on every request. The document is a fraction of that and needs no
// work at query time.
//
// The file is `_search.json`: /api/data refuses any underscore-prefixed file, and
// this one carries question text, so it must never be served raw. Search results
// go through canViewContent in api/index.ts instead.
import { put } from "@vercel/blob";
import { readBlobJson } from "./blob.js";
import { categoryBuckets, CategoryBucket } from "./categories.js";

export const SEARCH_FILE = "_search.json";
const VERSION = 2; // 2: correct / heard counts behind the conversion rates

export interface SearchTossup {
  id: string; round: number; num: number;
  answer: string;            // as shown (HTML)
  a: string;                 // answer, plain + lowercase, for matching
  t: string;                 // question text, plain + lowercase
  category: string; subcategory: string; buckets: CategoryBucket[];
  heard: number; correct: number; convPct: number | null; avgBuzzPct: number | null; wordCount: number | null;
  buzzes: [number, number][]; // [wordIndex, value] of every placed buzz
}
export interface SearchBonus {
  id: string; round: number; num: number;
  answers: string[]; a: string[];
  t: string;                 // lead-in + parts, plain + lowercase
  category: string; subcategory: string; buckets: CategoryBucket[];
  heard: number;
  parts: { difficulty: string; convPct: number | null; convCount: number | null }[];
}
export interface SearchPlayer {
  id: string; name: string; n: string; team: string; tm: string;
  ppg: number; games: number; pts: number;
  topCats: { category: string; points: number }[];
}
export interface SearchDoc { v: number; tossups: SearchTossup[]; bonuses: SearchBonus[]; players: SearchPlayer[] }

export const stripHtml = (s: string) =>
  (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const low = (s: unknown) => stripHtml(String(s ?? "")).toLowerCase();

// From the aggregation's output files (or the same files read back from the store).
export function buildSearchDoc(files: Record<string, any>): SearchDoc {
  const tu = (files["tossups_detail.json"] ?? {}) as Record<string, any>;
  const bn = (files["bonuses_detail.json"] ?? {}) as Record<string, any>;
  const pl = (files["players.json"] ?? []) as any[];
  const pd = (files["players_detail.json"] ?? {}) as Record<string, any>;
  const tossups: SearchTossup[] = Object.values(tu).map((r) => ({
    id: r.id, round: r.round, num: r.num, answer: r.answer ?? "", a: low(r.answer), t: low(r.questionHtml),
    category: r.category ?? "", subcategory: r.subcategory ?? "", buckets: categoryBuckets(r.category, r.subcategory),
    heard: r.heard ?? 0, correct: (r.powers ?? 0) + (r.gets ?? 0), convPct: r.convPct ?? null, avgBuzzPct: r.avgBuzzPct ?? null, wordCount: r.wordCount ?? null,
    buzzes: (Array.isArray(r.buzzes) ? r.buzzes : [])
      .filter((b: any) => b && b.wordIndex !== null && b.wordIndex !== undefined)
      .map((b: any) => [b.wordIndex, b.value] as [number, number]),
  }));
  const bonuses: SearchBonus[] = Object.values(bn).map((r) => {
    const answers: string[] = Array.isArray(r.answers) ? r.answers : [];
    const parts: string[] = Array.isArray(r.parts) ? r.parts : [];
    const mods: string[] = Array.isArray(r.difficultyModifiers) ? r.difficultyModifiers : [];
    const conv: any[] = Array.isArray(r.partConv) ? r.partConv : [];
    return {
      id: r.id, round: r.round, num: r.num, answers, a: answers.map(low), t: low([r.leadin, ...parts].join(" ")),
      category: r.category ?? "", subcategory: r.subcategory ?? "", buckets: categoryBuckets(r.category, r.subcategory),
      heard: r.heard ?? 0,
      parts: answers.map((_, i) => { const c = conv.find((p) => p.idx === i); return { difficulty: String(mods[i] || ""), convPct: c?.convPct ?? null, convCount: c?.convCount ?? null }; }),
    };
  });
  const players: SearchPlayer[] = pl.map((r) => {
    const cats = pd[r.id]?.categories as any[] | undefined;
    return {
      id: r.id, name: r.name, n: String(r.name || "").toLowerCase(), team: r.team ?? "", tm: String(r.team || "").toLowerCase(),
      ppg: r.ppg ?? 0, games: r.games ?? 0, pts: r.pts ?? 0,
      topCats: Array.isArray(cats)
        ? cats.filter((c) => (c.points || 0) > 0).sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 3).map((c) => ({ category: c.category, points: c.points || 0 }))
        : [],
    };
  });
  return { v: VERSION, tossups, bonuses, players };
}

// Per-instance cache. Fluid compute keeps instances warm across requests, so a
// run of searches reads each set's document from the store once. Short-lived,
// because a rebuild in another instance can't reach in here to drop it.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; doc: SearchDoc }>();
export const invalidateSearchDoc = (slug: string) => { cache.delete(slug); };

export async function getSearchDoc(slug: string): Promise<SearchDoc | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.doc;
  let doc = await readBlobJson<SearchDoc>(`sets/${slug}/${SEARCH_FILE}`, false);
  if (!doc || doc.v !== VERSION) {
    // Built before the document existed: make it from the detail files now and
    // keep it, so this only ever happens once per set.
    const [tu, bn, pl, pd] = await Promise.all([
      readBlobJson<any>(`sets/${slug}/tossups_detail.json`, true),
      readBlobJson<any>(`sets/${slug}/bonuses_detail.json`, true),
      readBlobJson<any>(`sets/${slug}/players.json`, true),
      readBlobJson<any>(`sets/${slug}/players_detail.json`, true),
    ]);
    if (!tu && !pl) return null;
    doc = buildSearchDoc({ "tossups_detail.json": tu, "bonuses_detail.json": bn, "players.json": pl, "players_detail.json": pd });
    put(`sets/${slug}/${SEARCH_FILE}`, JSON.stringify(doc), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true })
      .catch((e) => console.warn(`[search-index] couldn't write ${slug}: ${(e as Error).message}`));
  }
  cache.set(slug, { at: Date.now(), doc });
  return doc;
}
