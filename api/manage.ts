// Tournament settings + access management.
//   GET  /api/manage?slug=...  (owner) -> { visibility, autoPublicAt, invites, accessRequests, links }
//   POST { slug, op } where op is one of:
//     open (any logged-in user):  request-access | join(key)
//     owner: settings | reaggregate | invite | uninvite |
//            approve-access(email) | deny-access(email) | create-link(label?) | revoke-link(id)
import crypto from "node:crypto";
import { list, del } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser, normEmail, canModerate, loadUsers } from "./_lib/auth.js";
import {
  readIndex, writeIndex, readSource, readCorrections, aggregateAndWrite,
  readAccess, writeAccess, readLinks, writeLinks, canViewContent, InviteLink, Visibility, AccessRole,
  writeVirtualCats, readRoundTags, writeRoundTags, DEFAULT_ROUND_TAGS, RoundTags, TOURNAMENT_LEVELS,
} from "./_lib/sets.js";
import { VirtualCategory } from "./_lib/aggregate.js";
import { sendEmail, appUrl, accessRequestBody, accessGrantedBody } from "./_lib/email.js";

const VIS = new Set<Visibility>(["public", "listed", "private"]);
const ROLES = new Set<string>(["player", "staff", "coach"]);
const isEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const setUrl = (slug: string) => `${appUrl()}/set/${slug}`;

// ---- merged-category ("op: categories") + round-tag ("op: roundtags") helpers ----
const MAX_CATS = 50, MAX_MEMBERS = 300, MAX_NAME = 80, MAX_MEMBER_LEN = 200;
function sanitizeVirtualCats(input: unknown): VirtualCategory[] | null {
  if (!Array.isArray(input) || input.length > MAX_CATS) return null;
  const out: VirtualCategory[] = [];
  const seen = new Set<string>();
  for (const v of input as any[]) {
    if (!v || typeof v.name !== "string" || !Array.isArray(v.members)) return null;
    const name = v.name.trim().slice(0, MAX_NAME);
    if (!name) return null;
    const key = name.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const members = [...new Set((v.members as unknown[]).filter((m): m is string => typeof m === "string").map((m) => m.trim().slice(0, MAX_MEMBER_LEN)).filter(Boolean))];
    if (!members.length || members.length > MAX_MEMBERS) return null;
    out.push({ name, members });
  }
  return out;
}
const MAX_TAGS_PER_ROUND = 12, MAX_TAG_NAME = 40;
function sanitizeRoundTags(input: unknown): RoundTags | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: RoundTags = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !Array.isArray(v)) return null;
    const names = [...new Set(v.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, MAX_TAG_NAME)).filter(Boolean))];
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

  try {
    // ---------------- open ops: any logged-in user ----------------
    if (req.method === "POST" && (body.op === "request-access" || body.op === "join")) {
      if (!user) return res.status(401).json({ error: "Log in first." });

      if (body.op === "request-access") {
        if (canViewContent(entry, user)) return res.status(400).json({ error: "You already have access." });
        const role = String(body.role || "").trim().toLowerCase();
        const team = String(body.team || "").trim().slice(0, 120);
        if (!ROLES.has(role)) return res.status(400).json({ error: "Select your role (player, staff, or coach)." });
        if (!team) return res.status(400).json({ error: "Enter the team you were affiliated with." });
        const u = (await loadUsers())[user];
        const access = await readAccess(slug);
        const prior = access.find((a) => a.email === user);
        if (prior && prior.status === "pending") return res.status(200).json({ ok: true, already: true });
        const rec = { email: user, name: u?.name || user, at: new Date().toISOString(), status: "pending" as const, role: role as AccessRole, team };
        await writeAccess(slug, [rec, ...access.filter((a) => a.email !== user)]);
        if (entry.owner)
          await sendEmail({ to: entry.owner, subject: `Access request — ${entry.name}`, html: accessRequestBody(`${rec.name} (${user})`, entry.name, `${setUrl(slug)}/settings`, `${role}, ${team}`) });
        return res.status(200).json({ ok: true });
      }

      // join via invite link
      const key = String(body.key || "");
      const links = await readLinks(slug);
      const link = links.find((l) => l.id === key && !l.revoked);
      if (!link) return res.status(404).json({ error: "This invite link is invalid or has been revoked." });
      if (!canViewContent(entry, user)) {
        entry.invites = [...new Set([...(entry.invites ?? []), user])].sort();
        await writeIndex(index);
      }
      link.uses = (link.uses || 0) + 1;
      await writeLinks(slug, links);
      const access = await readAccess(slug);
      const ar = access.find((a) => a.email === user);
      if (ar && ar.status === "pending") { ar.status = "approved"; await writeAccess(slug, access); }
      return res.status(200).json({ ok: true });
    }

    // ---------------- owner / moderator / admin only ----------------
    if (!user || (entry.owner !== user && !(await canModerate(user)))) return res.status(403).json({ error: "Owner only." });

    if (req.method === "GET") {
      if (req.query.op === "roundtags")
        return res.status(200).json({ roundTags: await readRoundTags(slug), defaults: DEFAULT_ROUND_TAGS, tags: entry.tags ?? [] });
      return res.status(200).json({
        visibility: entry.visibility ?? "listed",
        autoPublicAt: entry.autoPublicAt ?? null,
        invites: entry.invites ?? [],
        hasYf: !!entry.hasYf,
        level: entry.level ?? "",
        tdLink: entry.tdLink ?? "",
        accessRequests: (await readAccess(slug)).filter((a) => a.status === "pending"),
        links: await readLinks(slug),
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });

    const op = body.op as string;
    if (op === "settings") {
      const v = body.visibility;
      if (v !== undefined) { if (!VIS.has(v)) return res.status(400).json({ error: "Invalid visibility." }); entry.visibility = v; }
      const a = body.autoPublicAt;
      if (a !== undefined) {
        if (a === null) entry.autoPublicAt = null;
        else if (typeof a === "string" && !Number.isNaN(Date.parse(a))) entry.autoPublicAt = new Date(a).toISOString();
        else return res.status(400).json({ error: "Invalid date." });
      }
      if (entry.visibility === "public") entry.autoPublicAt = null;
    } else if (op === "reaggregate") {
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found (set predates source storage; re-create it)." });
      const { meta, editions } = await aggregateAndWrite(slug, source, await readCorrections(slug));
      Object.assign(entry, { numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers, numTossups: meta.numTossups, rounds: meta.rounds.length, editions });
      await writeIndex(index);
      return res.status(200).json({ ok: true, rebuilt: true });
    } else if (op === "invite" || op === "uninvite") {
      const email = normEmail(body.email);
      if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email." });
      const set = new Set(entry.invites ?? []);
      if (op === "invite") set.add(email); else set.delete(email);
      entry.invites = [...set].sort();
    } else if (op === "approve-access" || op === "deny-access") {
      const email = normEmail(body.email);
      const access = await readAccess(slug);
      const rec = access.find((a) => a.email === email);
      if (!rec) return res.status(404).json({ error: "Request not found." });
      if (op === "approve-access") {
        rec.status = "approved";
        entry.invites = [...new Set([...(entry.invites ?? []), email])].sort();
        await writeIndex(index);
        await sendEmail({ to: email, subject: `Access granted — ${entry.name}`, html: accessGrantedBody(entry.name, setUrl(slug)) });
      } else rec.status = "denied";
      await writeAccess(slug, access);
      return res.status(200).json({ ok: true, accessRequests: access.filter((a) => a.status === "pending") });
    } else if (op === "create-link") {
      const links = await readLinks(slug);
      const link: InviteLink = { id: crypto.randomBytes(9).toString("base64url"), label: String(body.label || "").slice(0, 60), by: user, at: new Date().toISOString(), uses: 0 };
      links.unshift(link);
      await writeLinks(slug, links);
      return res.status(200).json({ ok: true, link, url: `${appUrl()}/join/${slug}?key=${link.id}`, links });
    } else if (op === "revoke-link") {
      const links = await readLinks(slug);
      const link = links.find((l) => l.id === String(body.id || ""));
      if (link) link.revoked = true;
      await writeLinks(slug, links);
      return res.status(200).json({ ok: true, links });
    } else if (op === "categories") {
      if (entry.kind === "results") return res.status(400).json({ error: "Category groups apply to buzz tournaments only." });
      const clean = sanitizeVirtualCats(body.virtualCategories);
      if (!clean) return res.status(400).json({ error: "Invalid category groups." });
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      await writeVirtualCats(slug, clean);
      await aggregateAndWrite(slug, source, await readCorrections(slug));
      return res.status(200).json({ ok: true });
    } else if (op === "roundtags") {
      if (entry.kind === "results") return res.status(400).json({ error: "Round tags apply to buzz tournaments only." });
      const clean = sanitizeRoundTags(body.roundTags);
      if (!clean) return res.status(400).json({ error: "Invalid round tags." });
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      await writeRoundTags(slug, clean);
      const { tags } = await aggregateAndWrite(slug, source, await readCorrections(slug));
      entry.tags = tags;
      await writeIndex(index);
      return res.status(200).json({ ok: true, roundTags: clean, tags });
    } else if (op === "delete") {
      const { blobs } = await list({ prefix: `sets/${slug}/` });
      if (blobs.length) await del(blobs.map((b) => b.url));
      await writeIndex({ sets: index.sets.filter((s) => s.slug !== slug) });
      return res.status(200).json({ deleted: slug, removedBlobs: blobs.length });
    } else if (op === "details") {
      const lvl = String(body.level || "");
      if (!(TOURNAMENT_LEVELS as readonly string[]).includes(lvl))
        return res.status(400).json({ error: "Choose a tournament type." });
      entry.level = lvl;
      const link = String(body.tdLink || "").trim();
      if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: "The Tournament Database link must be a valid URL." });
      if (link) entry.tdLink = link.slice(0, 500); else delete entry.tdLink;
      await writeIndex(index);
      return res.status(200).json({ ok: true, level: entry.level, tdLink: entry.tdLink ?? "" });
    } else {
      return res.status(400).json({ error: "Unknown op." });
    }

    await writeIndex(index);
    return res.status(200).json({ ok: true, visibility: entry.visibility, autoPublicAt: entry.autoPublicAt ?? null, invites: entry.invites ?? [] });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
