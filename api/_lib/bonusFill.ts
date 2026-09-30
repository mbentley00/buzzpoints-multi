// Fill bonus lead-ins and part prompts from text parsed out of a set's packets,
// for a set whose bonuses arrived with answers and conversion but no text (a
// scrape whose source no longer serves its per-bonus pages). Only the text
// moves: answers, conversion and corrections are left exactly as they were.
import { editionsOf, SetSource } from "./sets.js";

export interface BonusFill { round: number; num: number; leadin?: string; parts?: string[]; answers?: string[] }

// The same normalization the fill files are built with: tags and entities out,
// the answer line cut at its first bracket or parenthesis, accents folded.
export const answerKey = (a: string) =>
  String(a || "").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split(/[[(]/)[0].normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Packet text is shown as HTML, so keep only the inline formatting a packet uses.
const safe = (h: unknown) => String(h ?? "").replace(/<(?!\/?(?:b|i|u|em|strong|sub|sup)>)[^>]*>/gi, "").trim();

// Find each bonus by its answer lines, in every mirror. A multi-mirror set's
// round numbers on the site are canonical ones (mirrors that read packets in
// different orders are renumbered to line up), so they needn't match any
// mirror's own files; the answers do, and they also reach every mirror that
// read the same bonus. Mutates and returns the source.
export function applyBonusFills(source: SetSource, fills: BonusFill[]) {
  const eds = editionsOf(source);
  const byAnswers = new Map<string, any[]>();
  for (const ed of eds)
    for (const p of ed.packets || [])
      for (const b of (p.bonuses || []) as any[]) {
        if (!b || !(b.answers || []).length) continue;
        const k = (b.answers as string[]).map(answerKey).join("|");
        const list = byAnswers.get(k) || [];
        list.push(b);
        byAnswers.set(k, list);
      }
  const skipped: string[] = [];
  let applied = 0, filledCopies = 0;
  for (const f of fills) {
    const given = (f.answers || []).map(String);
    const parts = (f.parts || []).map(safe);
    const targets = given.length ? byAnswers.get(given.join("|")) || [] : [];
    if (!targets.length || parts.length !== given.length || parts.some((p) => !p)) { skipped.push(`${f.round}-${f.num}`); continue; }
    for (const b of targets) { b.leadin = safe(f.leadin); b.parts = parts; filledCopies++; }
    applied++;
  }
  // Bonuses in the stored mirrors that still have no text, so it's clear
  // whether anything is left over.
  let stillBlank = 0;
  for (const ed of eds) for (const p of ed.packets || []) for (const b of (p.bonuses || []) as any[])
    if (b && !String(b.leadin || "").trim() && !(b.parts || []).some((x: string) => String(x || "").trim())) stillBlank++;
  return { next: { ...source, editions: eds } as SetSource, applied, skipped, filledCopies, stillBlank };
}
