// Owner applies a buzz correction directly (re-aggregates the set).
// POST /api/correct { slug, correction }
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser } from "./_lib/auth.js";
import {
  getSetEntry, readSource, readCorrections, writeCorrections, aggregateAndWrite, mergeCorrection, validCorrection,
} from "./_lib/sets.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Log in to edit buzzes." });

  const { slug, correction } = (req.body || {}) as any;
  if (typeof slug !== "string" || !validCorrection(correction))
    return res.status(400).json({ error: "Invalid correction." });

  try {
    const entry = await getSetEntry(slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (entry.owner !== user)
      return res.status(403).json({ error: "Only the owner can edit directly. Submit a request instead." });

    const source = await readSource(slug);
    if (!source) return res.status(500).json({ error: "Source data not found." });
    const corrections = await readCorrections(slug);
    const next = mergeCorrection(corrections, { ...correction, by: user, at: new Date().toISOString() });
    await writeCorrections(slug, next);
    await aggregateAndWrite(slug, source, next);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
