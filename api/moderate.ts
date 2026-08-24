// Moderation dashboard backend.
//   GET  /api/moderate -> { role, pending, users?, blocklist? }  (mod/admin)
//   POST { op } where op is one of:
//     mod/admin: approve-submission(id) | reject-submission(id, reason?) | delete-account(email)
//     admin:     set-role(email, role) | set-blocklist(words)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  currentUser, getRole, roleOf, normEmail, isAdminEmail, loadUsers, saveUsers, readPurpose, Role,
} from "./_lib/auth.js";
import { createTournament, normVisibility, CreateError } from "./_lib/publish.js";
import { readIndex, writeIndex, ownerEmails } from "./_lib/sets.js";
import {
  readPending, writePending, readPendingPayload, delPendingPayload,
  readModConfig, writeModConfig, PendingSubmission,
} from "./_lib/moderation.js";
import { sendEmail, appUrl, submissionApprovedBody, submissionRejectedBody, publishApprovedBody, publishRejectedBody } from "./_lib/email.js";

// A minimal HTML response for the email-link approval flow (clicked in a browser).
function page(res: VercelResponse, status: number, title: string, body: string) {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;color:#1c2530;line-height:1.5">` +
    `<h1 style="font-size:20px">${title}</h1>${body}</div>`
  );
}

const esc = (s: string) => (s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

const VIS_DESC: Record<string, string> = {
  public: "shown in the list and viewable by anyone, no login required",
  listed: "shown in the tournament list, but only invited, logged-in people can view it",
  private: "hidden from the list; only the owner and people they invite can view it",
};

// The visibility a submission will get on approval. Older queue entries predate
// recording it on the index record, so fall back to the stored payload.
async function visibilityOf(rec: PendingSubmission): Promise<string> {
  if (rec.visibility) return rec.visibility;
  const payload = await readPendingPayload(rec.id);
  return normVisibility(payload?.visibility);
}

// Approve a queued first-post submission straight from the emailed link. The
// signed token IS the authorization, so no login is required. A first GET only
// shows a confirmation (so email link scanners/prefetchers can't auto-approve);
// the actual approval happens on the confirmed (`&confirm=1`) request.
async function approveByToken(token: string, confirmed: boolean, res: VercelResponse) {
  const id = readPurpose(token, "approve-sub");
  if (!id)
    return page(res, 400, "Link expired", `<p>This approval link is invalid or has expired. Open the <a href="${appUrl()}/admin">moderation dashboard</a> to review pending submissions.</p>`);
  const pending = await readPending();
  const rec = pending.find((p) => p.id === id);
  if (!rec)
    return page(res, 200, "Already handled", `<p>This submission has already been approved or removed.</p><p><a href="${appUrl()}/admin">Open the dashboard</a></p>`);

  if (!confirmed) {
    const confirmUrl = `${appUrl()}/api/moderate?approve=${encodeURIComponent(token)}&confirm=1`;
    const vis = await visibilityOf(rec);
    return page(res, 200, "Approve submission?",
      `<p><strong>${esc(rec.name)}</strong> submitted by ${esc(rec.byName)}.</p>` +
      `<p style="font-size:13px;color:#555">Visibility on approval: <strong>${esc(vis)}</strong>${VIS_DESC[vis] ? ` — ${VIS_DESC[vis]}` : ""}.</p>` +
      `<p><a href="${confirmUrl}" style="display:inline-block;background:#4b8bf5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Approve &amp; publish</a></p>` +
      `<p style="font-size:13px;color:#555">Or <a href="${appUrl()}/admin">review it in the dashboard</a> first.</p>`);
  }

  try {
    const payload = await readPendingPayload(id);
    if (!payload)
      return page(res, 410, "Submission missing", `<p>The submission data is missing. Ask the submitter to upload it again.</p>`);
    const { slug } = await createTournament(payload, rec.by);
    await writePending(pending.filter((p) => p.id !== id));
    await delPendingPayload(id);
    await sendEmail({ to: rec.by, subject: `Approved — ${rec.name}`, html: submissionApprovedBody(rec.name, `${appUrl()}/set/${slug}`) });
    res.statusCode = 302;
    res.setHeader("Location", `${appUrl()}/set/${slug}`);
    return res.end();
  } catch (e) {
    if (e instanceof CreateError) return page(res, e.status, "Approval failed", `<p>${esc(e.message)}</p>`);
    return page(res, 500, "Approval failed", `<p>${esc((e as Error).message)}</p>`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);
  res.setHeader("cache-control", "no-store");

  // Approval link from the notification email (token-authorized; confirm step
  // guards against link prefetchers).
  if (req.method === "GET" && req.query.approve) return approveByToken(String(req.query.approve), req.query.confirm === "1", res);

  const role = await getRole(user);
  if (role === "user" || !user) return res.status(403).json({ error: "Moderator access required.", role: "user" });
  const isAdmin = role === "admin";

  try {
    if (req.method === "GET") {
      const users = await loadUsers();
      const pending = await readPending();
      // Existing sets whose owners asked to go public (fresh uploads need a
      // moderator's approval for that) — small enough to scan off the index.
      const publishRequests = (await readIndex()).sets
        .filter((e) => e.publicPending)
        .map((e) => ({ slug: e.slug, name: e.name, by: e.publicPending!.by, at: e.publicPending!.at, createdAt: e.createdAt, visibility: e.visibility }))
        .sort((a, b) => (a.at < b.at ? -1 : 1));
      const out: any = {
        role,
        pending: await Promise.all(pending.map(async (p) => ({ ...p, visibility: await visibilityOf(p) }))),
        publishRequests,
      };
      if (isAdmin) {
        out.blocklist = (await readModConfig()).blocklist;
        out.users = Object.values(users)
          .map((u) => ({ email: u.email, name: u.name, institution: u.institution ?? null, createdAt: u.createdAt, role: roleOf(u.email, users) }))
          .sort((a, b) => a.email.localeCompare(b.email));
      }
      return res.status(200).json(out);
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });

    const body = (req.body || {}) as any;
    const op = String(body.op || "");

    // -------- first-post review queue (mod/admin) --------
    if (op === "approve-submission" || op === "reject-submission") {
      const id = String(body.id || "");
      const pending = await readPending();
      const rec = pending.find((p) => p.id === id);
      if (!rec) return res.status(404).json({ error: "Submission not found." });

      if (op === "approve-submission") {
        const payload = await readPendingPayload(id);
        if (!payload) return res.status(410).json({ error: "Submission data is missing; reject it and ask the user to resubmit." });
        const { slug } = await createTournament(payload, rec.by);
        await writePending(pending.filter((p) => p.id !== id));
        await delPendingPayload(id);
        await sendEmail({ to: rec.by, subject: `Approved — ${rec.name}`, html: submissionApprovedBody(rec.name, `${appUrl()}/set/${slug}`) });
        return res.status(200).json({ ok: true, slug, pending: pending.filter((p) => p.id !== id) });
      }

      // reject
      const reason = String(body.reason || "").slice(0, 300);
      await writePending(pending.filter((p) => p.id !== id));
      await delPendingPayload(id);
      await sendEmail({ to: rec.by, subject: `Submission not approved — ${rec.name}`, html: submissionRejectedBody(rec.name, reason) });
      return res.status(200).json({ ok: true, pending: pending.filter((p) => p.id !== id) });
    }

    // -------- public-viewing requests on existing sets (mod/admin) --------
    if (op === "approve-publish" || op === "reject-publish") {
      const slug = String(body.slug || "");
      const index = await readIndex();
      const entry = index.sets.find((e) => e.slug === slug);
      if (!entry || !entry.publicPending) return res.status(404).json({ error: "No pending public request for that set." });
      const requester = entry.publicPending.by;
      delete entry.publicPending;
      if (op === "approve-publish") {
        entry.visibility = "public";
        entry.autoPublicAt = null; // public now; a scheduled auto-publish is moot
        await writeIndex(index);
        for (const to of new Set([requester, ...ownerEmails(entry)]))
          await sendEmail({ to, subject: `Now public — ${entry.name}`, html: publishApprovedBody(entry.name, `${appUrl()}/set/${slug}`) });
        return res.status(200).json({ ok: true });
      }
      // reject: the set keeps its current visibility, only the request is closed
      await writeIndex(index);
      const reason = String(body.reason || "").slice(0, 300);
      await sendEmail({ to: requester, subject: `Public request declined — ${entry.name}`, html: publishRejectedBody(entry.name, reason) });
      return res.status(200).json({ ok: true });
    }

    // -------- delete an account (mod/admin, with guards) --------
    if (op === "delete-account") {
      const email = normEmail(body.email);
      const users = await loadUsers();
      const target = users[email];
      if (!target) return res.status(404).json({ error: "Account not found." });
      if (email === normEmail(user)) return res.status(400).json({ error: "You can't delete your own account here." });
      if (isAdminEmail(email)) return res.status(403).json({ error: "Built-in admins can't be deleted." });
      const targetRole = roleOf(email, users);
      // Moderators may only delete regular users; deleting mods/admins is admin-only.
      if (!isAdmin && targetRole !== "user") return res.status(403).json({ error: "Only an admin can delete moderators or admins." });
      delete users[email];
      await saveUsers(users);
      return res.status(200).json({ ok: true, deleted: email });
    }

    // -------- admin-only below --------
    if (!isAdmin) return res.status(403).json({ error: "Admin access required." });

    if (op === "set-role") {
      const email = normEmail(body.email);
      const next = String(body.role || "") as Role;
      if (!["user", "moderator", "admin"].includes(next)) return res.status(400).json({ error: "Invalid role." });
      const users = await loadUsers();
      const target = users[email];
      if (!target) return res.status(404).json({ error: "Account not found." });
      if (isAdminEmail(email)) return res.status(400).json({ error: "This account is a built-in admin (set via ADMIN_EMAILS); its role can't be changed here." });
      if (next === "user") delete target.role; else target.role = next;
      await saveUsers(users);
      return res.status(200).json({ ok: true, email, role: roleOf(email, users) });
    }

    if (op === "set-blocklist") {
      const raw: unknown[] = Array.isArray(body.words) ? body.words : [];
      const cleaned: string[] = [...new Set(raw.map((w) => String(w ?? "").trim().toLowerCase()).filter(Boolean))].slice(0, 500);
      await writeModConfig({ blocklist: cleaned });
      return res.status(200).json({ ok: true, blocklist: cleaned });
    }

    return res.status(400).json({ error: "Unknown op." });
  } catch (e) {
    if (e instanceof CreateError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: (e as Error).message });
  }
}
