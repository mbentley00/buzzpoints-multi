// Fill bonus lead-ins and part prompts from text parsed out of a set's packets,
// for a set whose bonuses arrived with answers and conversion but no text (a
// scrape whose source no longer serves its per-bonus pages). Only the text
// moves: answers, conversion and corrections are left exactly as they were.
import { editionsOf, canonicalizeEditions, SetSource } from "./sets.js";

export interface BonusFill { round: number; num: number; leadin?: string; parts?: string[]; answers?: string[] }

// HTML entities decoded the way the fill files' builder (Python's html.unescape)
// does, at least as far as an answer key can tell: numeric ones exactly, an
// accented letter ("&eacute;") to its letter, anything else ("&nbsp;", "&rsquo;")
// to punctuation the key drops anyway. Leaving "&nbsp;" as text turned it into
// the letters "nbsp" and broke the match for a whole answer line.
const decodeEntities = (s: string) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z])(acute|grave|uml|circ|tilde|cedil|ring|slash|caron);/gi, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&[a-z][a-z0-9]*;/gi, " ");

// The same normalization the fill files are built with: tags and entities out,
// the answer line cut at its first bracket or parenthesis, accents folded.
export const answerKey = (a: string) =>
  decodeEntities(String(a || "").replace(/<[^>]+>/g, ""))
    .split(/[[(]/)[0].normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const hasText = (b: any) => !!String(b?.leadin || "").trim() || (b?.parts || []).some((x: string) => String(x || "").trim());

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
  // Second pass, for mirrors that read an earlier draft: a blank copy takes the
  // text of the bonus at the same canonical slot (rounds aligned across mirrors,
  // same bonus number) when its answer lines still mostly agree — all but one,
  // and at least two. A playtest mirror then shows the final wording of a bonus
  // whose answer line was tweaked afterwards, rather than nothing. The canonical
  // view renumbers rounds but shares the bonus objects, so this fills the source.
  // A mirror may also have read the round's bonuses in another order, so when
  // the same slot doesn't agree, a single donor elsewhere in the round that does
  // is taken instead.
  const canon = canonicalizeEditions(eds);
  const donors = new Map<string, any>();
  const roundDonors = new Map<number, any[]>();
  for (const ed of canon) for (const p of ed.packets || []) ((p.bonuses || []) as any[]).forEach((b, i) => {
    if (!hasText(b)) return;
    const k = `${p.round}-${i + 1}`;
    if (!donors.has(k)) donors.set(k, b);
    const list = roundDonors.get(p.round) || [];
    list.push(b);
    roundDonors.set(p.round, list);
  });
  const agrees = (mine: string[], d: any) => {
    const theirs: string[] = (d?.answers || []).map(answerKey);
    if (!mine.length || mine.length !== theirs.length) return false;
    return mine.filter((k, j) => k && k === theirs[j]).length >= Math.max(2, mine.length - 1);
  };
  let bySlot = 0;
  for (const ed of canon) for (const p of ed.packets || []) ((p.bonuses || []) as any[]).forEach((b, i) => {
    if (!b || hasText(b)) return;
    const mine: string[] = (b.answers || []).map(answerKey);
    let d = donors.get(`${p.round}-${i + 1}`);
    if (!agrees(mine, d)) {
      const elsewhere = [...new Set((roundDonors.get(p.round) || []).filter((x) => agrees(mine, x)))];
      // Distinct copies of one bonus share their text; only a single wording counts.
      const wordings = new Set(elsewhere.map((x) => `${x.leadin}|${(x.parts || []).join("|")}`));
      d = wordings.size === 1 ? elsewhere[0] : undefined;
    }
    if (!d) return;
    b.leadin = d.leadin;
    b.parts = [...d.parts];
    bySlot++;
  });
  // Bonuses in the stored mirrors that still have no text, so it's clear
  // whether anything is left over.
  let stillBlank = 0;
  for (const ed of eds) for (const p of ed.packets || []) for (const b of (p.bonuses || []) as any[])
    if (b && !hasText(b)) stillBlank++;
  return { next: { ...source, editions: eds } as SetSource, applied, skipped, filledCopies: filledCopies + bySlot, bySlot, stillBlank };
}
