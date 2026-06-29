// Returns the list of tournaments visible to the caller, and (with `?q=`) a
// cross-tournament player/question search scoped to sets the caller can view.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readBlobJson } from "./_lib/blob.js";
import { currentUser, canModerate } from "./_lib/auth.js";
import { SetEntry, canList, canViewContent, sanitizeEntry } from "./_lib/sets.js";

const stripHtml = (s: string) =>
  (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").trim();

const MAX_SETS = 80;   // cap how many accessible sets a single query scans
const MAX_RESULTS = 200;

// Cross-tournament search over the sets the caller has *content* access to
// (public, owned, or invited). Reads each set's already-computed players.json /
// tossups.json, so it covers every existing tournament without re-aggregation.
async function search(user: string | null, q: string, type: "players" | "questions", res: VercelResponse) {
  const needle = q.toLowerCase();
  const idx = await readBlobJson<{ sets: SetEntry[] }>("sets/index.json", false);
  const accessible = (idx?.sets ?? []).filter((s) => canViewContent(s, user)).slice(0, MAX_SETS);
  const file = type === "players" ? "players.json" : "tossups.json";

  const results: any[] = [];
  await Promise.all(
    accessible.map(async (s) => {
      const rows = await readBlobJson<any[]>(`sets/${s.slug}/${file}`, true);
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        if (type === "players") {
          if (String(r.name || "").toLowerCase().includes(needle) || String(r.team || "").toLowerCase().includes(needle))
            results.push({ slug: s.slug, setName: s.name, playerId: r.id, name: r.name, team: r.team, ppg: r.ppg ?? 0, games: r.games ?? 0 });
        } else {
          const answer = stripHtml(String(r.answer || "")).toLowerCase();
          if (answer.includes(needle) || String(r.category || "").toLowerCase().includes(needle) || String(r.subcategory || "").toLowerCase().includes(needle))
            results.push({ slug: s.slug, setName: s.name, id: r.id, round: r.round, num: r.num, answer: r.answer, category: r.category });
        }
      }
    })
  );

  if (type === "players")
    results.sort((a, b) => (b.ppg || 0) - (a.ppg || 0) || String(a.name).localeCompare(String(b.name)));
  else
    results.sort((a, b) => String(a.setName).localeCompare(String(b.setName)) || a.round - b.round || a.num - b.num);

  res.setHeader("cache-control", "no-store");
  return res.status(200).json({ results: results.slice(0, MAX_RESULTS), total: results.length, type });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const user = currentUser(req);

    const q = String(req.query.q || "").trim();
    if (q) {
      if (q.length < 2) return res.status(200).json({ results: [], total: 0, type: req.query.type === "questions" ? "questions" : "players" });
      const type = req.query.type === "questions" ? "questions" : "players";
      return await search(user, q, type, res);
    }

    const admin = await canModerate(user); // moderators/admins see every listable set
    const idx = await readBlobJson<{ sets: SetEntry[] }>("sets/index.json", false);
    const sets = (idx?.sets ?? [])
      .filter((s) => canList(s, user, admin))
      .map((s) => sanitizeEntry(s, user));
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ sets });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
