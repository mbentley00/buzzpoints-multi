// Corrections for "results" (YellowFruit) tournaments. Owner reassigns/changes/
// removes an individual scoring event; we store it and re-aggregate.
//   POST { slug, op: "correct", correction }   (owner / moderator)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser, canModerate } from "./_lib/auth.js";
import {
  readIndex, writeIndex, readYf, readResultsCorrections, writeResultsCorrections, aggregateResultsAndWrite,
} from "./_lib/sets.js";
import { ResultsCorrection } from "./_lib/resultsAggregate.js";

function validCorrection(c: any): c is ResultsCorrection {
  return (
    c && typeof c.matchKey === "string" && typeof c.fromPlayer === "string" &&
    typeof c.fromTeam === "string" && typeof c.fromValue === "number" &&
    (c.toPlayer === undefined || typeof c.toPlayer === "string") &&
    (c.toTeam === undefined || typeof c.toTeam === "string") &&
    (c.toValue === undefined || typeof c.toValue === "number") &&
    (c.remove === undefined || typeof c.remove === "boolean")
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Log in." });

  const body = (req.body || {}) as any;
  const slug = String(body.slug || "");
  const index = await readIndex();
  const entry = index.sets.find((s) => s.slug === slug);
  if (!entry) return res.status(404).json({ error: "Tournament not found." });
  if (entry.kind !== "results") return res.status(400).json({ error: "Not a results tournament." });
  if (entry.owner !== user && !(await canModerate(user))) return res.status(403).json({ error: "Owner only." });

  try {
    if (body.op === "correct") {
      const c = body.correction;
      if (!validCorrection(c)) return res.status(400).json({ error: "Invalid correction." });
      c.by = user; c.at = new Date().toISOString();
      const corrections = await readResultsCorrections(slug);
      corrections.push(c);
      await writeResultsCorrections(slug, corrections);
      const raw = await readYf(slug);
      if (!raw) return res.status(500).json({ error: "Source YellowFruit file not found." });
      const { meta } = await aggregateResultsAndWrite(slug, raw, corrections);
      Object.assign(entry, { numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers, rounds: (meta.rounds || []).length });
      await writeIndex(index);
      return res.status(200).json({ ok: true, corrections: corrections.length });
    }
    if (body.op === "reset") {
      await writeResultsCorrections(slug, []);
      const raw = await readYf(slug);
      if (!raw) return res.status(500).json({ error: "Source YellowFruit file not found." });
      await aggregateResultsAndWrite(slug, raw, []);
      return res.status(200).json({ ok: true, corrections: 0 });
    }
    return res.status(400).json({ error: "Unknown op." });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
