// Downloads for a tournament. Folded into one function (the Hobby plan caps the
// deployment at 12) and dispatched on `op`:
//   GET /api/yf-export?slug=...          the uploaded YellowFruit (.yft) with the
//                                        owner's buzz reassignments applied to its
//                                        box scores (anyone who can view the set)
//   GET /api/yf-export?slug=...&op=all   everything stored for the set, for the
//                                        owner's "Export all data" zip (owners and
//                                        moderators only). The browser builds the
//                                        zip — packets, game QBJs, Klaxon presses,
//                                        rosters, the .yft — from this.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { gzipSync } from "node:zlib";
import { currentUser, canModerate } from "./_lib/auth.js";
import { readBlobJson } from "./_lib/blob.js";
import { getSetEntry, readSource, readCorrections, readYf, canView, editionsOf, isSetOwner } from "./_lib/sets.js";
import { applyBuzzCorrectionsToYf } from "./_lib/yfExport.js";

// The hand edits layered on the uploaded files. Access lists, invite links and
// pending requests are left out: they're about people, not the tournament.
const EDIT_FILES = [
  "_corrections.json", "_bonuscorrections.json", "_bonusdiffs.json", "_renames.json", "_metamap.json",
  "_tagedits.json", "_replacements.json", "_virtualcats.json", "_roundtags.json",
] as const;

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);
  const slug = String(req.query.slug || "");
  const entry = await getSetEntry(slug);
  if (!entry) return res.status(404).json({ error: "Tournament not found." });
  const mod = await canModerate(user);
  if (!canView(entry, user, mod)) return res.status(403).json({ error: "You don't have access to this tournament." });

  if (req.query.op === "all") {
    if (!isSetOwner(entry, user) && !mod) return res.status(403).json({ error: "Only the tournament's owners can export all of its data." });
    try {
      const [source, raw, corrections] = await Promise.all([readSource(slug), readYf(slug), readCorrections(slug)]);
      const games = source ? editionsOf(source).flatMap((e) => e.games || []) : [];
      const edits: Record<string, unknown> = {};
      await Promise.all(EDIT_FILES.map(async (f) => {
        const v = await readBlobJson<unknown>(`sets/${slug}/${f}`, false);
        if (v !== null) edits[f.replace(/^_/, "")] = v;
      }));
      const klaxonStats = await readBlobJson<unknown>(`sets/${slug}/klaxon.json`, false);
      const body = JSON.stringify({
        kind: "buzzpoints-export", version: 1, at: new Date().toISOString(), slug,
        tournament: {
          name: entry.name, level: entry.level ?? null, difficulty: entry.difficulty ?? null,
          tournamentDate: entry.tournamentDate ?? null, tdLink: entry.tdLink ?? null, individual: !!entry.individual,
          scoring: source?.scoring ?? null,
        },
        source,
        yf: raw ? { original: raw, corrected: applyBuzzCorrectionsToYf(raw, games, corrections) } : null,
        klaxonStats,
        edits,
      });
      // Big sets run past the 4.5 MB response cap as plain JSON; gzipped they're
      // a fraction of that, and the browser unpacks it on its own.
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      if (/\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
        res.setHeader("content-encoding", "gzip");
        return res.status(200).send(gzipSync(body));
      }
      return res.status(200).send(body);
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  }

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
