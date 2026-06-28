// Owner manages "merged" (virtual) categories for a buzz tournament. The full
// desired list is sent each time and replaces what's stored, then the set is
// re-aggregated so the synthetic category nodes are rebuilt.
// POST /api/categories { slug, virtualCategories: [{ name, members }] }
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser } from "./_lib/auth.js";
import {
  getSetEntry, readSource, readCorrections, writeVirtualCats, aggregateAndWrite,
} from "./_lib/sets.js";
import { VirtualCategory } from "./_lib/aggregate.js";

const MAX_CATS = 50, MAX_MEMBERS = 300, MAX_NAME = 80, MAX_MEMBER_LEN = 200;

// Validate + normalize the incoming list. Returns null on any malformed input
// (unknown shape, empty/duplicate name, no members, or over the size limits).
function sanitize(input: unknown): VirtualCategory[] | null {
  if (!Array.isArray(input) || input.length > MAX_CATS) return null;
  const out: VirtualCategory[] = [];
  const seenNames = new Set<string>();
  for (const v of input as any[]) {
    if (!v || typeof v.name !== "string" || !Array.isArray(v.members)) return null;
    const name = v.name.trim().slice(0, MAX_NAME);
    if (!name) return null;
    const key = name.toLowerCase();
    if (seenNames.has(key)) return null; // names must be unique
    seenNames.add(key);
    const members = [
      ...new Set(
        (v.members as unknown[])
          .filter((m): m is string => typeof m === "string")
          .map((m) => m.trim().slice(0, MAX_MEMBER_LEN))
          .filter(Boolean)
      ),
    ];
    if (!members.length || members.length > MAX_MEMBERS) return null;
    out.push({ name, members });
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Log in to edit categories." });

  const { slug, virtualCategories } = (req.body || {}) as any;
  if (typeof slug !== "string") return res.status(400).json({ error: "Missing slug." });
  const clean = sanitize(virtualCategories);
  if (!clean) return res.status(400).json({ error: "Invalid category groups." });

  try {
    const entry = await getSetEntry(slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (entry.owner !== user) return res.status(403).json({ error: "Only the owner can edit categories." });
    if (entry.kind === "results") return res.status(400).json({ error: "Category groups apply to buzz tournaments only." });

    const source = await readSource(slug);
    if (!source) return res.status(500).json({ error: "Source data not found." });
    await writeVirtualCats(slug, clean);
    await aggregateAndWrite(slug, source, await readCorrections(slug));
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
