// Compare two editions (mirrors) of one tournament by question position.
// GET /api/diff?slug=<slug>&a=<editionId>&b=<editionId>
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser } from "./_lib/auth.js";
import { getSetEntry, readSource, canViewContent, editionsOf } from "./_lib/sets.js";

const strip = (s: string | undefined) =>
  (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

interface TU { question: string; answer: string }
interface BN { leadin: string; parts: string[]; answers: string[] }
const tossupMap = (packets: any[]) => { const m = new Map<string, TU>(); for (const p of packets || []) (p.tossups || []).forEach((t: any, i: number) => m.set(`${p.round}-${i + 1}`, { question: strip(t.question), answer: strip(t.answer) })); return m; };
const bonusMap = (packets: any[]) => { const m = new Map<string, BN>(); for (const p of packets || []) (p.bonuses || []).forEach((b: any, i: number) => m.set(`${p.round}-${i + 1}`, { leadin: strip(b.leadin), parts: (b.parts || []).map(strip), answers: (b.answers || []).map(strip) })); return m; };
const byRoundNum = (a: { round: number; num: number }, b: { round: number; num: number }) => a.round - b.round || a.num - b.num;
const parseKey = (k: string) => { const [r, n] = k.split("-").map(Number); return { round: r, num: n }; };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const slug = String(req.query.slug || ""), aId = String(req.query.a || ""), bId = String(req.query.b || "");
  if (!slug || !aId || !bId) return res.status(400).json({ error: "Provide slug and two edition ids (a, b)." });
  if (aId === bId) return res.status(400).json({ error: "Pick two different editions." });
  try {
    const entry = await getSetEntry(slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (!canViewContent(entry, currentUser(req))) return res.status(403).json({ error: "You don't have access to this tournament." });
    const source = await readSource(slug);
    if (!source) return res.status(500).json({ error: "Source data not found." });
    const eds = editionsOf(source);
    const ea = eds.find((e) => e.id === aId), eb = eds.find((e) => e.id === bId);
    if (!ea || !eb) return res.status(404).json({ error: "Edition not found." });

    const tuA = tossupMap(ea.packets), tuB = tossupMap(eb.packets);
    const bnA = bonusMap(ea.packets), bnB = bonusMap(eb.packets);

    const tossups: any[] = [];
    let tuChanged = 0, tuOnlyA = 0, tuOnlyB = 0;
    for (const k of new Set([...tuA.keys(), ...tuB.keys()])) {
      const a = tuA.get(k) || null, b = tuB.get(k) || null;
      const { round, num } = parseKey(k);
      if (a && b) { const questionChanged = a.question !== b.question, answerChanged = a.answer !== b.answer; if (questionChanged || answerChanged) { tuChanged++; tossups.push({ round, num, status: "changed", questionChanged, answerChanged, a, b }); } }
      else if (a) { tuOnlyA++; tossups.push({ round, num, status: "only-a", a, b: null }); }
      else { tuOnlyB++; tossups.push({ round, num, status: "only-b", a: null, b }); }
    }
    tossups.sort(byRoundNum);

    const bonuses: any[] = [];
    let bnChanged = 0, bnOnlyA = 0, bnOnlyB = 0;
    for (const k of new Set([...bnA.keys(), ...bnB.keys()])) {
      const a = bnA.get(k) || null, b = bnB.get(k) || null;
      const { round, num } = parseKey(k);
      if (a && b) { const leadinChanged = a.leadin !== b.leadin, partsChanged = !arrEq(a.parts, b.parts), answersChanged = !arrEq(a.answers, b.answers); if (leadinChanged || partsChanged || answersChanged) { bnChanged++; bonuses.push({ round, num, status: "changed", leadinChanged, partsChanged, answersChanged, a, b }); } }
      else if (a) { bnOnlyA++; bonuses.push({ round, num, status: "only-a", a, b: null }); }
      else { bnOnlyB++; bonuses.push({ round, num, status: "only-b", a: null, b }); }
    }
    bonuses.sort(byRoundNum);

    res.setHeader("cache-control", "private, no-store");
    return res.status(200).json({
      a: { id: ea.id, label: ea.label }, b: { id: eb.id, label: eb.label },
      summary: {
        tossupTotal: new Set([...tuA.keys(), ...tuB.keys()]).size, tuChanged, tuOnlyA, tuOnlyB,
        bonusTotal: new Set([...bnA.keys(), ...bnB.keys()]).size, bnChanged, bnOnlyA, bnOnlyB,
      },
      tossups, bonuses,
    });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
