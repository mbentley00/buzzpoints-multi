// Moderator/admin listing of every tournament. Management actions reuse the
// existing /api/delete and /api/manage endpoints (which honor the role bypass).
// GET /api/admin -> { role, isAdmin, sets }
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser, getRole } from "./_lib/auth.js";
import { readIndex, effectiveVisibility } from "./_lib/sets.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const user = currentUser(req);
  res.setHeader("cache-control", "no-store");
  const role = await getRole(user);
  if (role === "user") return res.status(200).json({ role: "user", isAdmin: false, sets: [] });

  const idx = await readIndex();
  const sets = idx.sets.map((s) => ({
    slug: s.slug, name: s.name, owner: s.owner ?? null, scoring: s.scoring, hasBonuses: s.hasBonuses,
    visibility: s.visibility ?? "listed", effectiveVisibility: effectiveVisibility(s), autoPublicAt: s.autoPublicAt ?? null,
    inviteCount: (s.invites || []).length, numGames: s.numGames, numTeams: s.numTeams, numPlayers: s.numPlayers,
    numTossups: s.numTossups, rounds: s.rounds, createdAt: s.createdAt,
  }));
  return res.status(200).json({ role, isAdmin: role === "admin", sets });
}
