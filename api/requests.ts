// Correction requests: submit (non-owner), list, approve/reject (owner).
// GET  /api/requests?slug=...                         -> { requests, isOwner }
// POST /api/requests { slug, action: "submit", correction, desc? }  (any viewer)
// POST /api/requests { slug, id, action: approve|reject }           (owner only)
import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser } from "./_lib/auth.js";
import {
  getSetEntry, readRequests, writeRequests, readSource, readCorrections, writeCorrections,
  aggregateAndWrite, mergeCorrection, validCorrection, canView, CorrectionRequest,
} from "./_lib/sets.js";
import { sendEmail, appUrl, correctionRequestBody } from "./_lib/email.js";

// Human-readable one-line summary of a proposed correction, for the owner email.
function correctionSummary(c: any): string {
  const where = `Round ${c.round}, Q${c.num} (${c.team})`;
  const parts: string[] = [];
  if (c.toPlayer !== undefined)
    parts.push(`buzz reassigned ${c.fromPlayer ?? "—"} → ${c.toPlayer ?? "—"}`);
  if (c.toWordIndex !== undefined)
    parts.push(`buzz word moved ${c.fromWordIndex ?? "—"} → ${c.toWordIndex ?? "—"}`);
  return `${where}: ${parts.join("; ") || "edit"}.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);

  if (req.method === "GET") {
    const slug = String(req.query.slug || "");
    const entry = await getSetEntry(slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    const isOwner = !!user && entry.owner === user;
    if (!isOwner) return res.status(200).json({ requests: [], isOwner: false });
    return res.status(200).json({ requests: await readRequests(slug), isOwner: true });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
  if (!user) return res.status(401).json({ error: "Log in." });

  const body = (req.body || {}) as any;

  // ---- submit a correction request (any logged-in viewer) ----
  if (body.action === "submit") {
    const { slug, correction, desc } = body;
    if (typeof slug !== "string" || !validCorrection(correction))
      return res.status(400).json({ error: "Invalid request." });
    try {
      const entry = await getSetEntry(slug);
      if (!entry) return res.status(404).json({ error: "Tournament not found." });
      if (!canView(entry, user)) return res.status(403).json({ error: "You don't have access to this tournament." });
      const reqs = await readRequests(slug);
      const r: CorrectionRequest = {
        id: crypto.randomUUID(),
        correction: { ...correction, by: user, at: new Date().toISOString() },
        by: user, at: new Date().toISOString(), status: "pending",
        desc: typeof desc === "string" ? desc.slice(0, 300) : undefined,
      };
      reqs.unshift(r);
      await writeRequests(slug, reqs);
      if (entry.owner && entry.owner !== user)
        await sendEmail({
          to: entry.owner,
          subject: `Edit suggested — ${entry.name}`,
          html: correctionRequestBody(user, entry.name, correctionSummary(r.correction), r.desc || "", `${appUrl()}/set/${slug}/requests`),
        });
      return res.status(200).json({ ok: true, id: r.id });
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  }

  // ---- approve / reject (owner only) ----
  const { slug, id, action } = body as { slug?: string; id?: string; action?: string };
  if (!slug || !id || (action !== "approve" && action !== "reject"))
    return res.status(400).json({ error: "Bad request." });

  try {
    const entry = await getSetEntry(slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (entry.owner !== user) return res.status(403).json({ error: "Owner only." });

    const reqs = await readRequests(slug);
    const r = reqs.find((x) => x.id === id);
    if (!r || r.status !== "pending") return res.status(404).json({ error: "Request not found or already handled." });

    if (action === "approve") {
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      const corrections = await readCorrections(slug);
      const next = mergeCorrection(corrections, r.correction);
      await writeCorrections(slug, next);
      await aggregateAndWrite(slug, source, next);
    }
    r.status = action === "approve" ? "approved" : "rejected";
    await writeRequests(slug, reqs);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
