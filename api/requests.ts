// Correction requests: submit (non-owner), list, approve/reject (owner).
// GET  /api/requests?slug=...                         -> { requests, isOwner }
// POST /api/requests { slug, action: "submit", correction, desc? }  (any viewer)
// POST /api/requests { slug, id, action: approve|reject }           (owner only)
import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser } from "./_lib/auth.js";
import {
  getSetEntry, readRequests, writeRequests, readSource, readCorrections, writeCorrections,
  aggregateAndWrite, mergeCorrection, validCorrection, canView, effectiveVisibility, CorrectionRequest,
  readRenames, writeRenames, mergeRename, validRename, teamMergeConflict, isSetOwner, ownerEmails, requestsAllowed,
  readBonusCorrections, writeBonusCorrections, mergeBonusCorrection, validBonusCorrection,
} from "./_lib/sets.js";
import { renameKind } from "./_lib/aggregate.js";
import { sendEmail, appUrl, correctionRequestBody, forumJoinRequestBody, forumApprovedBody, forumReplyBody } from "./_lib/email.js";
import { loadUsers, signPurpose, readPurpose, normEmail } from "./_lib/auth.js";
import { readForum, writeForum, participants, plainText, threadView, threadSummary, toPhpbb, unreadFor, markSeen, ForumData, ForumThread, MAX_TITLE, MAX_BODY, MAX_NOTE } from "./_lib/forum.js";
import { canViewContent, SetEntry } from "./_lib/sets.js";

/* ----------------------------- discussion ----------------------------- */
// The per-set forum rides on this endpoint (the function cap leaves no room
// for its own). GET ?slug&forum=1[&thread=id][&export=phpbb]; POST with an
// action of forum-join / -approve / -decline / -revoke / -thread / -reply /
// -edit / -delete / -lock; GET ?forumMute=<signed token> from an email link.

type ForumStatus = "owner" | "member" | "pending" | "declined" | "none";
function forumStatus(entry: SetEntry, data: ForumData, user: string): ForumStatus {
  if (isSetOwner(entry, user)) return "owner";
  if (data.members.includes(user)) return "member";
  if (data.pending.some((p) => p.email === user)) return "pending";
  if (data.declined.includes(user)) return "declined";
  return "none";
}
const canPostIn = (s: ForumStatus) => s === "owner" || s === "member";
const mutePurpose = (slug: string, thread: string) => `forum-mute:${slug}:${thread}`;
const cleanText = (v: unknown, max: number) => String(v ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);

async function displayName(email: string): Promise<string> {
  const u = (await loadUsers())[normEmail(email)];
  return (u?.name || "").trim() || email.split("@")[0];
}

async function forumGet(req: VercelRequest, res: VercelResponse, user: string | null) {
  const slug = String(req.query.slug || "");
  const entry = await getSetEntry(slug);
  if (!entry) return res.status(404).json({ error: "Tournament not found." });
  if (!user) return res.status(401).json({ error: "Log in to read the discussion." });
  // Reading the discussion takes the same access as reading the set's questions.
  if (!canViewContent(entry, user)) return res.status(403).json({ error: "You don't have access to this tournament." });
  const isOwner = isSetOwner(entry, user);
  const data = await readForum(slug);
  const status = forumStatus(entry, data, user);
  if (req.query.export === "phpbb") {
    if (!isOwner) return res.status(403).json({ error: "Owner only." });
    res.setHeader("content-disposition", `attachment; filename="${slug}-discussion-phpbb.json"`);
    return res.status(200).json(toPhpbb(slug, entry.name, data));
  }
  const threadId = String(req.query.thread || "");
  const t = threadId ? data.threads.find((x) => x.id === threadId) : undefined;
  if (threadId && !t) return res.status(404).json({ error: "Thread not found." });
  const out = {
    enabled: !!entry.forum, status, isOwner,
    threads: [...data.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((x) => threadSummary(x, user, isOwner, data)),
    ...(t ? { thread: threadView(t, user, isOwner) } : {}),
    ...(isOwner ? { members: data.members, pending: data.pending } : {}),
    unread: unreadFor(data, user),
  };
  // Opening a thread is reading it: everything in it stops being new. (Counted
  // into `out` first, so the page can still say what was new on arrival.)
  if (t) { markSeen(data, user, t); await writeForum(slug, data); }
  return res.status(200).json(out);
}

async function forumMute(req: VercelRequest, res: VercelResponse) {
  const token = String(req.query.forumMute || "");
  const slug = String(req.query.slug || ""), thread = String(req.query.thread || "");
  const email = readPurpose(token, mutePurpose(slug, thread));
  if (!email) return res.status(400).send("This link has expired or isn't valid.");
  const data = await readForum(slug);
  const list = new Set(data.muted[email] || []); list.add(thread); data.muted[email] = [...list];
  await writeForum(slug, data);
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(200).send(`<p style="font-family:sans-serif">You won't get more emails about that thread. <a href="${appUrl()}/set/${slug}/discussion/${thread}">Open it</a>.</p>`);
}

async function forumPost(body: any, res: VercelResponse, user: string) {
  const action = String(body.action || "");
  const slug = String(body.slug || "");
  const entry = await getSetEntry(slug);
  if (!entry) return res.status(404).json({ error: "Tournament not found." });
  if (!canViewContent(entry, user)) return res.status(403).json({ error: "You don't have access to this tournament." });
  const isOwner = isSetOwner(entry, user);
  if (!entry.forum && !isOwner) return res.status(403).json({ error: "This tournament's discussion isn't open." });
  const data = await readForum(slug);
  const status = forumStatus(entry, data, user);
  const base = `${appUrl()}/set/${slug}/discussion`;
  const now = new Date().toISOString();

  if (action === "forum-join") {
    if (canPostIn(status)) return res.status(200).json({ ok: true, status });
    if (status === "pending") return res.status(200).json({ ok: true, status });
    const name = await displayName(user);
    const note = cleanText(body.note, MAX_NOTE);
    data.pending.push({ email: user, name, at: now, ...(note ? { note } : {}) });
    data.declined = data.declined.filter((e) => e !== user);
    await writeForum(slug, data);
    for (const to of ownerEmails(entry))
      await sendEmail({ to, subject: `Request to post — ${entry.name}`, html: forumJoinRequestBody(user, name, entry.name, note, `${appUrl()}/set/${slug}/settings#discussion`) });
    return res.status(200).json({ ok: true, status: "pending" });
  }

  if (action === "forum-approve" || action === "forum-decline" || action === "forum-revoke") {
    if (!isOwner) return res.status(403).json({ error: "Owner only." });
    const email = normEmail(String(body.email || ""));
    if (!email) return res.status(400).json({ error: "Which account?" });
    data.pending = data.pending.filter((p) => p.email !== email);
    if (action === "forum-approve") {
      if (!data.members.includes(email)) data.members.push(email);
      data.declined = data.declined.filter((e) => e !== email);
    } else if (action === "forum-decline") {
      if (!data.declined.includes(email)) data.declined.push(email);
    } else {
      data.members = data.members.filter((e) => e !== email);
    }
    await writeForum(slug, data);
    if (action === "forum-approve")
      await sendEmail({ to: email, subject: `You can post — ${entry.name}`, html: forumApprovedBody(entry.name, base) });
    return res.status(200).json({ ok: true, members: data.members, pending: data.pending });
  }

  // Everything below writes into a thread.
  if (!canPostIn(status)) return res.status(403).json({ error: status === "pending" ? "Your request to post is still waiting for the owner." : "Ask the tournament's owner to approve you before posting." });

  if (action === "forum-thread") {
    const title = cleanText(body.title, MAX_TITLE), text = cleanText(body.body, MAX_BODY);
    if (!title || !text) return res.status(400).json({ error: "A thread needs a title and a first post." });
    const byName = await displayName(user);
    const t: ForumThread = {
      id: crypto.randomBytes(6).toString("base64url"), title, by: user, byName, at: now, updatedAt: now,
      posts: [{ id: crypto.randomBytes(6).toString("base64url"), by: user, byName, at: now, body: text }],
    };
    data.threads.push(t);
    markSeen(data, user, t);
    await writeForum(slug, data);
    return res.status(200).json({ ok: true, id: t.id });
  }

  const t = data.threads.find((x) => x.id === String(body.thread || ""));
  if (!t) return res.status(404).json({ error: "Thread not found." });

  if (action === "forum-lock") {
    if (!isOwner) return res.status(403).json({ error: "Owner only." });
    t.locked = !!body.locked;
    await writeForum(slug, data);
    return res.status(200).json({ ok: true, locked: t.locked });
  }
  if (t.locked && !isOwner) return res.status(403).json({ error: "This thread is locked." });

  if (action === "forum-reply") {
    const text = cleanText(body.body, MAX_BODY);
    if (!text) return res.status(400).json({ error: "Write something first." });
    const byName = await displayName(user);
    const p = { id: crypto.randomBytes(6).toString("base64url"), by: user, byName, at: now, body: text };
    t.posts.push(p); t.updatedAt = now;
    markSeen(data, user, t);
    await writeForum(slug, data);
    // Everyone who has written in the thread hears about the reply, with a
    // signed link to stop hearing about this thread.
    const excerpt = plainText(text).slice(0, 300);
    for (const to of participants(t, data, user)) {
      const token = signPurpose(to, mutePurpose(slug, t.id), 60 * 60 * 24 * 90);
      const muteUrl = `${appUrl()}/api/requests?forumMute=${encodeURIComponent(token)}&slug=${encodeURIComponent(slug)}&thread=${encodeURIComponent(t.id)}`;
      await sendEmail({ to, subject: `Re: ${t.title} — ${entry.name}`, html: forumReplyBody(byName, entry.name, t.title, excerpt, `${base}/${t.id}#post-${p.id}`, muteUrl) });
    }
    return res.status(200).json({ ok: true, id: p.id });
  }

  const p = t.posts.find((x) => x.id === String(body.post || ""));
  if (!p) return res.status(404).json({ error: "Post not found." });
  if (action === "forum-edit") {
    if (p.by !== user) return res.status(403).json({ error: "You can only edit your own posts." });
    if (p.deleted) return res.status(400).json({ error: "That post was removed." });
    const text = cleanText(body.body, MAX_BODY);
    if (!text) return res.status(400).json({ error: "Write something first." });
    p.body = text; p.editedAt = now;
    await writeForum(slug, data);
    return res.status(200).json({ ok: true });
  }
  if (action === "forum-delete") {
    if (p.by !== user && !isOwner) return res.status(403).json({ error: "Owner only." });
    p.deleted = true; p.body = "";
    await writeForum(slug, data);
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "Unknown discussion action." });
}

// Human-readable one-line summary of a proposed edit, for the owner email.
function requestSummary(r: CorrectionRequest): string {
  if (r.rename) {
    if (renameKind(r.rename) === "team") return `Rename team: ${r.rename.from} → ${r.rename.to}.`;
    const scope = r.rename.team ? ` on ${r.rename.team}` : " (every team)";
    return `Rename player${scope}: ${r.rename.from} → ${r.rename.to}.`;
  }
  if (r.bonus) {
    const b = r.bonus;
    const got = (pts: number[]) => pts.map((v, i) => (v > 0 ? i + 1 : null)).filter(Boolean).join(", ") || "none";
    return `Bonus ${b.round}-${b.num} (${b.team}): parts converted ${got(b.fromPartPts || [])} → ${got(b.toPartPts || [])}.`;
  }
  const c = r.correction as any;
  if (!c) return "Edit.";
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

  if (req.method === "GET" && req.query.forumMute) return forumMute(req, res);
  if (req.method === "GET" && req.query.forum) return forumGet(req, res, user);

  if (req.method === "GET") {
    const slug = String(req.query.slug || "");
    const entry = await getSetEntry(slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    const isOwner = isSetOwner(entry, user);
    if (!isOwner) return res.status(200).json({ requests: [], isOwner: false });
    return res.status(200).json({ requests: await readRequests(slug), isOwner: true });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
  if (!user) return res.status(401).json({ error: "Log in." });

  const body = (req.body || {}) as any;
  if (typeof body.action === "string" && body.action.startsWith("forum-")) {
    try { return await forumPost(body, res, user); }
    catch (e) { return res.status(500).json({ error: (e as Error).message }); }
  }

  // ---- submit a correction request (any logged-in viewer) ----
  if (body.action === "submit") {
    const { slug, correction, bonus, rename, desc } = body;
    const isRename = rename !== undefined;
    const isBonus = bonus !== undefined;
    const valid = isRename ? validRename(rename) : isBonus ? validBonusCorrection(bonus) : validCorrection(correction);
    if (typeof slug !== "string" || !valid)
      return res.status(400).json({
        error: isRename ? "Enter a different, non-empty name."
          : isBonus ? "Pick a different set of parts than the ones already recorded."
          : "Invalid request.",
      });
    try {
      const entry = await getSetEntry(slug);
      if (!entry) return res.status(404).json({ error: "Tournament not found." });
      if (!canView(entry, user)) return res.status(403).json({ error: "You don't have access to this tournament." });
      // The owner has closed the request queue for this tournament. Owners and
      // co-owners still edit directly, so they bypass it.
      if (!requestsAllowed(entry) && !isSetOwner(entry, user))
        return res.status(403).json({ error: "This tournament's owner isn't accepting correction requests." });
      const reqs = await readRequests(slug);
      const stamp = { by: user, at: new Date().toISOString() };
      const r: CorrectionRequest = {
        id: crypto.randomUUID(),
        ...(isRename ? { rename: { ...rename, ...stamp } }
          : isBonus ? { bonus: { ...bonus, ...stamp } }
          : { correction: { ...correction, ...stamp } }),
        by: user, at: stamp.at, status: "pending",
        desc: typeof desc === "string" ? desc.slice(0, 300) : undefined,
      };
      reqs.unshift(r);
      await writeRequests(slug, reqs);
      // Everyone who can act on it hears about it — co-owners included.
      for (const to of ownerEmails(entry).filter((e) => e !== user))
        await sendEmail({
          to,
          subject: `Edit suggested — ${entry.name}`,
          html: correctionRequestBody(user, entry.name, requestSummary(r), r.desc || "", `${appUrl()}/set/${slug}/requests`, effectiveVisibility(entry)),
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
    if (!isSetOwner(entry, user)) return res.status(403).json({ error: "Owner only." });

    const reqs = await readRequests(slug);
    const r = reqs.find((x) => x.id === id);
    if (!r || r.status !== "pending") return res.status(404).json({ error: "Request not found or already handled." });

    if (action === "approve") {
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      if (r.rename) {
        const renames = await readRenames(slug);
        if (renameKind(r.rename) === "team") {
          const conflict = teamMergeConflict(source, renames, r.rename);
          if (conflict) return res.status(400).json({ error: conflict });
        }
        await writeRenames(slug, mergeRename(renames, r.rename));
        await aggregateAndWrite(slug, source, await readCorrections(slug));
      } else if (r.bonus) {
        await writeBonusCorrections(slug, mergeBonusCorrection(await readBonusCorrections(slug), r.bonus));
        await aggregateAndWrite(slug, source, await readCorrections(slug));
      } else if (r.correction) {
        const next = mergeCorrection(await readCorrections(slug), r.correction);
        await writeCorrections(slug, next);
        await aggregateAndWrite(slug, source, next);
      }
    }
    r.status = action === "approve" ? "approved" : "rejected";
    await writeRequests(slug, reqs);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
