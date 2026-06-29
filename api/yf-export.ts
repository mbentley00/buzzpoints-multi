// Download an updated YellowFruit (.yft) for a buzz tournament: the uploaded file
// with the owner's buzz reassignments applied to its box scores.
//   GET /api/yf-export?slug=...   (anyone who can view the set)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser, canModerate } from "./_lib/auth.js";
import { getSetEntry, readSource, readCorrections, readYf, canView, editionsOf } from "./_lib/sets.js";
import { applyBuzzCorrectionsToYf } from "./_lib/yfExport.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);
  const slug = String(req.query.slug || "");
  const entry = await getSetEntry(slug);
  if (!entry) return res.status(404).json({ error: "Tournament not found." });
  if (!canView(entry, user, await canModerate(user))) return res.status(403).json({ error: "You don't have access to this tournament." });

  const raw = await readYf(slug);
  if (!raw) return res.status(404).json({ error: "No YellowFruit file was uploaded for this tournament." });

  try {
    const source = await readSource(slug);
    const games = source ? editionsOf(source).flatMap((e) => e.games || []) : [];
    const updated = applyBuzzCorrectionsToYf(raw, games, await readCorrections(slug));
    const safe = slug.replace(/[^a-z0-9-]+/gi, "_");
    res.setHeader("content-type", "application/json");
    res.setHeader("content-disposition", `attachment; filename="${safe}.yft"`);
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(JSON.stringify(updated));
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
