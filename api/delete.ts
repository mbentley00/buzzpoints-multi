// Delete a tournament: remove its blobs and its index entry.
// POST /api/delete { slug }
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list, del, put } from "@vercel/blob";
import { readBlobJson } from "./_lib/blob.js";
import { currentUser, canModerate } from "./_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Log in to delete a tournament." });
  const slug = String((req.body || {}).slug || "");
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: "Invalid slug." });
  try {
    const idxBefore = (await readBlobJson<{ sets: any[] }>("sets/index.json", false)) || { sets: [] };
    const entry = (idxBefore.sets || []).find((s) => s.slug === slug);
    // Owner, moderator, or admin (legacy sets without an owner: any logged-in user).
    if (entry && entry.owner && entry.owner !== user && !(await canModerate(user)))
      return res.status(403).json({ error: "Only the owner or a moderator can delete this tournament." });
    const { blobs } = await list({ prefix: `sets/${slug}/` });
    if (blobs.length) await del(blobs.map((b) => b.url));
    const idx = (await readBlobJson<{ sets: any[] }>("sets/index.json", false)) || { sets: [] };
    const sets = (idx.sets || []).filter((s) => s.slug !== slug);
    await del("sets/index.json").catch(() => {});
    await put("sets/index.json", JSON.stringify({ sets }), {
      access: "private", contentType: "application/json", addRandomSuffix: false,
    });
    return res.status(200).json({ deleted: slug, removedBlobs: blobs.length });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
