// Moderation dashboard backend.
//   GET  /api/moderate -> { role, pending, users?, blocklist? }  (mod/admin)
//   POST { op } where op is one of:
//     mod/admin: approve-submission(id) | reject-submission(id, reason?) | delete-account(email)
//     admin:     set-role(email, role) | set-blocklist(words)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  currentUser, getRole, roleOf, normEmail, isAdminEmail, loadUsers, saveUsers, Role,
} from "./_lib/auth.js";
import { createTournament, createResultsTournament, CreateError } from "./_lib/publish.js";
import {
  readPending, writePending, readPendingPayload, delPendingPayload,
  readModConfig, writeModConfig,
} from "./_lib/moderation.js";
import { sendEmail, appUrl, submissionApprovedBody, submissionRejectedBody } from "./_lib/email.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = currentUser(req);
  res.setHeader("cache-control", "no-store");
  const role = await getRole(user);
  if (role === "user" || !user) return res.status(403).json({ error: "Moderator access required.", role: "user" });
  const isAdmin = role === "admin";

  try {
    if (req.method === "GET") {
      const users = await loadUsers();
      const out: any = { role, pending: await readPending() };
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
        const { slug } = payload.kind === "results"
          ? await createResultsTournament({ name: payload.name, yf: payload.yf, visibility: payload.visibility, autoPublicAt: payload.autoPublicAt }, rec.by)
          : await createTournament(payload, rec.by);
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
