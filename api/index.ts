// Returns the list of tournaments visible to the caller (private Blob store).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readBlobJson } from "./_lib/blob.js";
import { currentUser, canModerate } from "./_lib/auth.js";
import { SetEntry, canList, sanitizeEntry } from "./_lib/sets.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const user = currentUser(req);
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
