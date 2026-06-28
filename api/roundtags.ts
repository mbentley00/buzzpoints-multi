// Owner assigns tags ("phases") to rounds. Saving re-aggregates the set, writing
// a scoped set of stat files per tag so viewers can filter every page to a phase.
//   GET  /api/roundtags?slug=...  (owner) -> { roundTags, defaults, tags }
//   POST { slug, roundTags: { [round]: string[] } }  (owner)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser } from "./_lib/auth.js";
import {
  readIndex, writeIndex, readSource, readCorrections, readRoundTags, writeRoundTags,
  aggregateAndWrite, DEFAULT_ROUND_TAGS, RoundTags,
} from "./_lib/sets.js";

const MAX_TAGS_PER_ROUND = 12, MAX_NAME = 40;

// Validate + normalize { [round]: string[] }. Drops empty/blank entries; returns
// null only on a structurally invalid payload.
function sanitize(input: unknown): RoundTags | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: RoundTags = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) return null;
    if (!Array.isArray(v)) return null;
    const names = [
      ...new Set(
        v.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, MAX_NAME)).filter(Boolean)
      ),
    ];
    if (names.length > MAX_TAGS_PER_ROUND) return null;
    if (names.length) out[k] = names;
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);
  const body = (req.body || {}) as any;
  const slug = String((req.method === "GET" ? req.query.slug : body.slug) || "");
  if (!slug) return res.status(400).json({ error: "Missing slug." });

  const index = await readIndex();
  const entry = index.sets.find((s) => s.slug === slug);
  if (!entry) return res.status(404).json({ error: "Tournament not found." });
  if (!user || entry.owner !== user) return res.status(403).json({ error: "Owner only." });

  try {
    if (req.method === "GET")
      return res.status(200).json({ roundTags: await readRoundTags(slug), defaults: DEFAULT_ROUND_TAGS, tags: entry.tags ?? [] });
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
    if (entry.kind === "results") return res.status(400).json({ error: "Round tags apply to buzz tournaments only." });

    const clean = sanitize(body.roundTags);
    if (!clean) return res.status(400).json({ error: "Invalid round tags." });

    const source = await readSource(slug);
    if (!source) return res.status(500).json({ error: "Source data not found." });
    await writeRoundTags(slug, clean);
    const { tags } = await aggregateAndWrite(slug, source, await readCorrections(slug));
    entry.tags = tags;
    await writeIndex(index);
    return res.status(200).json({ ok: true, roundTags: clean, tags });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
