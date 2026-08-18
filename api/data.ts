// Read proxy for a set's computed JSON (private Blob -> client).
// GET /api/data?path=sets/<slug>/<file>
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readBlobText } from "./_lib/blob.js";
import { currentUser, getRole } from "./_lib/auth.js";
import { getSetEntry, canView, canViewContent, effectiveVisibility, redactContent, CONTENT_FILES } from "./_lib/sets.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = String(req.query.path || "");
  // Block the internal "_source/_corrections/_requests" files (raw data, emails).
  const base = path.split("/").pop() || "";
  const m = path.match(/^sets\/([a-z0-9-]+)\//);
  if (!m || !/^sets\/[a-z0-9-]+\/[A-Za-z0-9_./-]+\.json$/.test(path) || path.includes("..") || base.startsWith("_"))
    return res.status(400).json({ error: "Invalid path." });
  try {
    const user = currentUser(req);
    const role = await getRole(user);
    const canReach = role !== "user"; // moderators + admins may reach a set to manage it
    const canReveal = role === "admin"; // but only admins may unmask question content
    // Enforce per-set visibility: public sets are open; "listed"/"private" need
    // login + invite (the owner always has access). Moderators/admins may reach
    // the set but get redacted content unless they legitimately have access; only
    // admins may reveal it.
    const entry = await getSetEntry(m[1]);
    if (!entry) return res.status(404).json({ error: "Not found." });
    if (!canView(entry, user, canReach))
      return res.status(403).json({ error: "This tournament is private. Log in and ask the owner for access." });

    // Read fresh from the store so edits/re-aggregations are visible immediately.
    let text = await readBlobText(path, false);
    if (text === null) return res.status(404).json({ error: "Not found." });

    const legit = canViewContent(entry, user); // owner / invited / public
    const reveal = String(req.query.reveal || "") === "1";
    const revealing = !legit && canReveal && reveal;
    if (!legit) {
      if (revealing) {
        console.warn(`[admin-reveal] ${user} viewed content of ${path}`);
      } else if (CONTENT_FILES.has(base)) {
        try { text = JSON.stringify(redactContent(base, JSON.parse(text))); } catch { /* serve as-is on parse failure */ }
      }
    }
    res.setHeader("content-type", "application/json");
    // Whether question content is being withheld from this caller. The client
    // used to work this out for itself from the set index, which meant a banner
    // announcing hidden content could contradict the content actually sent --
    // after being invited to a set, say. This is the same `legit` the masking
    // above is keyed on, so the notice and the bytes can no longer disagree.
    // Sent on every file, not just maskable ones, so any request answers it.
    res.setHeader("x-bp-content", legit || revealing ? "full" : "redacted");
    // Only effectively-public content is cacheable by shared caches.
    res.setHeader("cache-control", legit && effectiveVisibility(entry) === "public" ? "public, max-age=30, stale-while-revalidate=300" : "private, no-store");
    return res.status(200).send(text);
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
