// Download a results tournament as a zip: the corrections-applied YellowFruit
// file (.yft) plus regenerated HTML stat reports.
//   GET /api/results-export?slug=...   (anyone who can view the set)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser, canModerate } from "./_lib/auth.js";
import { readIndex, readYf, readResultsCorrections, canView } from "./_lib/sets.js";
import { parseYellowFruit } from "./_lib/yellowfruit.js";
import { aggregateResults } from "./_lib/resultsAggregate.js";
import { getScoring } from "./_lib/scoring.js";
import { buildZip, applyCorrectionsToRawYf, renderReports } from "./_lib/yfExport.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);
  const slug = String(req.query.slug || "");
  const index = await readIndex();
  const entry = index.sets.find((s) => s.slug === slug);
  if (!entry) return res.status(404).json({ error: "Tournament not found." });
  if (entry.kind !== "results") return res.status(400).json({ error: "Not a results tournament." });
  const admin = await canModerate(user);
  if (!canView(entry, user, admin)) return res.status(403).json({ error: "You don't have access to this tournament." });

  const raw = await readYf(slug);
  if (!raw) return res.status(500).json({ error: "Source YellowFruit file not found." });
  const corrections = await readResultsCorrections(slug);

  try {
    const yf = parseYellowFruit(raw);
    const out = aggregateResults(yf, getScoring(yf.scoringId), corrections);
    const updated = applyCorrectionsToRawYf(raw, corrections);
    const reports = renderReports(out, out["meta.json"]);
    const safe = slug.replace(/[^a-z0-9-]+/gi, "_");
    const zip = buildZip([{ name: `${safe}.yft`, data: JSON.stringify(updated) }, ...reports]);

    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${safe}-export.zip"`);
    res.setHeader("cache-control", "no-store");
    return res.status(200).send(zip);
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
