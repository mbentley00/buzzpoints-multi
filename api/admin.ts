// Moderator/admin listing of every tournament. Management actions reuse the
// existing /api/delete and /api/manage endpoints (which honor the role bypass).
//   GET  /api/admin                     -> { role, isAdmin, sets }
//   GET  /api/admin?op=backup&scope=core-> the account/index state, as a file
//   GET  /api/admin?op=backup&slug=...  -> one tournament's irreplaceable state
//   POST /api/admin { op: "restore", backup } -> write one of those files back
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import { currentUser, getRole } from "./_lib/auth.js";
import { readBlobJson } from "./_lib/blob.js";
import { readIndex, writeIndex, readSource, aggregateAndWrite, readCorrections, effectiveVisibility, SetEntry } from "./_lib/sets.js";

// Scraping a set again is often impossible and re-uploading is manual, so a backup
// carries the things that CAN'T be recomputed: the uploaded packets and games, and
// every hand correction layered on them. The stat files are left out on purpose —
// they're derived, they're the bulk of the bytes, and a restore rebuilds them.
const SET_FILES = [
  "_source.json", "_corrections.json", "_renames.json", "_metamap.json", "_tagedits.json",
  "_virtualcats.json", "_roundtags.json", "_access.json", "_links.json", "_requests.json", "_yf.json",
] as const;
const CORE_FILES = ["users.json", "moderation.json"] as const;

// A restore re-aggregates the set it just wrote, which is the slow part.
export const config = { maxDuration: 60 };

interface Backup {
  kind: "buzzpoints-backup";
  scope: "core" | "set";
  version: 1;
  at: string;
  slug?: string;
  entry?: SetEntry;      // the set's row in sets/index.json
  files: Record<string, unknown>;
}

const writeJson = (path: string, obj: unknown) =>
  put(path, JSON.stringify(obj), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });

async function collect(paths: readonly string[], prefix = ""): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const f of paths) {
    const v = await readBlobJson<unknown>(`${prefix}${f}`, false);
    if (v !== null) out[f] = v; // a file that was never written stays absent
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);
  res.setHeader("cache-control", "no-store");
  const role = await getRole(user);
  if (role === "user") return res.status(200).json({ role: "user", isAdmin: false, sets: [] });

  // ---- backup / restore (admin only) ----
  if (req.method === "GET" && req.query.op === "backup") {
    if (role !== "admin") return res.status(403).json({ error: "Admin access required." });
    const slug = String(req.query.slug || "");
    const at = new Date().toISOString();
    if (!slug) {
      const idx = await readIndex();
      const backup: Backup = { kind: "buzzpoints-backup", scope: "core", version: 1, at, files: { ...(await collect(CORE_FILES)), "sets/index.json": idx } };
      res.setHeader("content-disposition", `attachment; filename="buzzpoints-core-${at.slice(0, 10)}.json"`);
      return res.status(200).json(backup);
    }
    const idx = await readIndex();
    const entry = idx.sets.find((s) => s.slug === slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    const backup: Backup = {
      kind: "buzzpoints-backup", scope: "set", version: 1, at, slug, entry,
      files: await collect(SET_FILES, `sets/${slug}/`),
    };
    res.setHeader("content-disposition", `attachment; filename="buzzpoints-${slug}-${at.slice(0, 10)}.json"`);
    return res.status(200).json(backup);
  }

  if (req.method === "POST" && (req.body || {}).op === "restore") {
    if (role !== "admin") return res.status(403).json({ error: "Admin access required." });
    const b = (req.body || {}).backup as Backup | undefined;
    if (!b || b.kind !== "buzzpoints-backup" || !b.files) return res.status(400).json({ error: "That doesn't look like a Buzzpoints backup file." });

    if (b.scope === "core") {
      for (const f of CORE_FILES) if (b.files[f] !== undefined) await writeJson(f, b.files[f]);
      // The index is restored wholesale only when asked for: it decides which sets
      // exist, so writing it back can un-publish anything created since the backup.
      if ((req.body || {}).includeIndex && b.files["sets/index.json"] !== undefined)
        await writeIndex(b.files["sets/index.json"] as { sets: SetEntry[] });
      return res.status(200).json({ ok: true, restored: Object.keys(b.files).length });
    }

    const slug = String(b.slug || "");
    if (!slug || !b.files["_source.json"]) return res.status(400).json({ error: "This backup has no tournament source in it." });
    for (const f of SET_FILES) if (b.files[f] !== undefined) await writeJson(`sets/${slug}/${f}`, b.files[f]);
    // Put the set back in the index if it's gone (a restore after a deletion).
    const idx = await readIndex();
    if (b.entry && !idx.sets.some((s) => s.slug === slug)) {
      idx.sets.push(b.entry);
      await writeIndex(idx);
    }
    // Stats are derived, so rebuild rather than carrying them in the file.
    const source = await readSource(slug);
    if (!source) return res.status(500).json({ error: "Restored source could not be read back." });
    await aggregateAndWrite(slug, source, await readCorrections(slug));
    return res.status(200).json({ ok: true, slug, restored: Object.keys(b.files).length });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const idx = await readIndex();
  const sets = idx.sets.map((s) => ({
    slug: s.slug, name: s.name, owner: s.owner ?? null, scoring: s.scoring, hasBonuses: s.hasBonuses,
    visibility: s.visibility ?? "listed", effectiveVisibility: effectiveVisibility(s), autoPublicAt: s.autoPublicAt ?? null,
    inviteCount: (s.invites || []).length, numGames: s.numGames, numTeams: s.numTeams, numPlayers: s.numPlayers,
    numTossups: s.numTossups, rounds: s.rounds, createdAt: s.createdAt,
  }));
  return res.status(200).json({ role, isAdmin: role === "admin", sets });
}
