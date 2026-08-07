// Owner applies an edit directly (re-aggregates the set).
// POST /api/correct { slug, correction }  -> reassign / move one buzz
// POST /api/correct { slug, rename }      -> rename a player across the set
// POST /api/correct { slug, undoRename }  -> drop a stored rename
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser } from "./_lib/auth.js";
import {
  getSetEntry, readSource, readCorrections, writeCorrections, aggregateAndWrite, mergeCorrection, validCorrection,
  readRenames, writeRenames, mergeRename, validRename,
} from "./_lib/sets.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Log in to edit." });

  const { slug, correction, rename, undoRename } = (req.body || {}) as any;
  if (typeof slug !== "string") return res.status(400).json({ error: "Invalid request." });

  const isRename = rename !== undefined;
  const isUndo = undoRename !== undefined;
  if (!isRename && !isUndo && !validCorrection(correction))
    return res.status(400).json({ error: "Invalid correction." });
  if (isRename && !validRename(rename))
    return res.status(400).json({ error: "Enter a different, non-empty name (200 characters max)." });

  try {
    const entry = await getSetEntry(slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (entry.owner !== user)
      return res.status(403).json({ error: "Only the owner can edit directly. Submit a request instead." });

    const source = await readSource(slug);
    if (!source) return res.status(500).json({ error: "Source data not found." });

    if (isRename || isUndo) {
      const renames = await readRenames(slug);
      const next = isRename
        ? mergeRename(renames, { ...rename, by: user, at: new Date().toISOString() })
        : renames.filter((r) => !(r.from === undoRename?.from && (r.team ?? null) === (undoRename?.team ?? null)));
      await writeRenames(slug, next);
      await aggregateAndWrite(slug, source, await readCorrections(slug));
      return res.status(200).json({ ok: true, renames: next });
    }

    const corrections = await readCorrections(slug);
    const next = mergeCorrection(corrections, { ...correction, by: user, at: new Date().toISOString() });
    await writeCorrections(slug, next);
    await aggregateAndWrite(slug, source, next);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
