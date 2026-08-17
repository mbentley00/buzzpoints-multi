// Tournament settings + access management.
//   GET  /api/manage?slug=...  (owner) -> { visibility, autoPublicAt, invites, accessRequests, links }
//   POST { slug, op } where op is one of:
//     open (any logged-in user):  request-access | join(key)
//     owner: settings | reaggregate | invite | uninvite |
//            approve-access(email) | deny-access(email) | create-link(label?) | revoke-link(id)
import crypto from "node:crypto";
import { list, del } from "@vercel/blob";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { currentUser, normEmail, canModerate, getRole, loadUsers } from "./_lib/auth.js";
import {
  readIndex, writeIndex, readSource, writeSource, readCorrections, writeCorrections, corrKey, aggregateAndWrite,
  readAccess, writeAccess, readLinks, writeLinks, canViewContent, effectiveVisibility, InviteLink, Visibility, AccessRole,
  writeVirtualCats, readRoundTags, writeRoundTags, DEFAULT_ROUND_TAGS, RoundTags, RoundTagsDoc, TOURNAMENT_LEVELS,
  editionsOf, canonicalizeEditions, Edition, SetSource, AccessRequest, readRenames, writeRenames, renameKey,
  readMetaMap, writeMetaMap, readTagEdits, writeTagEdits, isSetOwner, isPrimaryOwner, ownerEmails, requestsAllowed,
} from "./_lib/sets.js";
import { VirtualCategory, scanRoundAlignment, metaFields, MetaMap, MetaField } from "./_lib/aggregate.js";
import { LETTER_ROUND_BASE } from "./_lib/publish.js";
import { sendEmail, appUrl, accessRequestBody, accessGrantedBody, coOwnerBody } from "./_lib/email.js";

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

// ---- metadata mapping ("op: metamap") + per-question tags ------------------
const MAX_META_FIELDS = 8, MAX_DIM_NAME = 40, MAX_TAGS_PER_QUESTION = 12, MAX_TAG_LEN = 120;
function sanitizeMetaMap(input: unknown): MetaMap | null {
  if (!input || typeof input !== "object") return null;
  const fields = (input as { fields?: unknown }).fields;
  if (!Array.isArray(fields) || !fields.length || fields.length > MAX_META_FIELDS) return null;
  const out: MetaField[] = [];
  let categories = 0;
  for (const f of fields as any[]) {
    const role = f?.role;
    if (role !== "category" && role !== "tag" && role !== "ignore") return null;
    if (role === "category") categories++;
    if (role === "tag") {
      const tag = String(f.tag ?? "").trim().slice(0, MAX_DIM_NAME);
      // A dimension name with the separator in it would split wrong on the way back out.
      if (!tag || tag.includes(":")) return null;
      out.push({ role, tag });
    } else out.push({ role });
  }
  // Exactly one field can be the category; none would leave every question "Other".
  if (categories !== 1) return null;
  return { fields: out };
}
function cleanTagList(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_TAGS_PER_QUESTION) return null;
  return [...new Set(v.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, MAX_TAG_LEN)).filter(Boolean))];
}

// ---- source-file inspection ("op: rounds" / "op: games") --------------------
// Packets and games are stored per edition as plain arrays, one entry per
// uploaded file. Their positions in those arrays are the handles the owner-side
// editors use to renumber a packet's round or drop a file, so every listing
// below carries its `index`.
const stripTags = (s: unknown) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function packetRows(e: Edition) {
  return (e.packets || []).map((p, index) => {
    const tossups = (p.tossups || []).filter(Boolean);
    // The packet's filename isn't kept, so show the first answer line as a
    // human-recognizable handle for "which packet is this?".
    const first = stripTags(tossups[0]?.answer);
    return {
      index, round: p.round, tossups: tossups.length,
      bonuses: (p.bonuses || []).filter(Boolean).length,
      sample: first.length > 70 ? first.slice(0, 67) + "…" : first,
    };
  });
}

function gameRows(e: Edition) {
  const rows = (e.games || []).map((g, index) => {
    const teams = (g.match_teams || []).map((t) => t?.team?.name).filter(Boolean) as string[];
    return {
      index, round: g.round, teams,
      tossups: (g.match_questions || []).length,
      key: `${g.round}\u0000${[...teams].sort().join("|")}`,
      copy: 0, copies: 1,
    };
  });
  // Re-uploading the same files appends them again, so the same matchup shows up
  // two or three times and every player looks like they played it repeatedly.
  // Number each duplicate so the UI can offer "keep the first, drop the rest".
  const seen = new Map<string, number>();
  for (const r of rows) { const n = (seen.get(r.key) || 0) + 1; seen.set(r.key, n); r.copy = n; }
  for (const r of rows) r.copies = seen.get(r.key) || 1;
  return rows;
}

const editionView = (e: Edition) => ({
  id: e.id, label: e.label,
  packets: packetRows(e),
  gameRounds: [...(e.games || []).reduce((m, g) => m.set(g.round, (m.get(g.round) || 0) + 1), new Map<number, number>())]
    .map(([round, count]) => ({ round, count })).sort((a, b) => a.round - b.round),
  warnings: scanRoundAlignment(e.packets || [], e.games || []),
});

// Replace a source's editions, normalizing a legacy single-edition source to the
// multi-edition model on the way (same shape ingest writes when appending).
const withEditions = (source: SetSource, editions: Edition[]): SetSource =>
  ({ name: source.name, scoring: source.scoring, hasBonuses: source.hasBonuses, editions });

// The most recently settled access requests, newest first.
const resolvedList = (access: AccessRequest[]) =>
  access
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.resolvedAt || b.at || "").localeCompare(a.resolvedAt || a.at || ""))
    .slice(0, 8);

const intList = (v: unknown, max: number): number[] | null => {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map(Number))];
  if (out.some((n) => !Number.isInteger(n) || n < 0 || n >= max)) return null;
  return out.sort((a, b) => a - b);
};

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
        // Anyone who can approve it hears about it — co-owners included.
        for (const to of ownerEmails(entry))
          await sendEmail({ to, subject: `Access request — ${entry.name}`, html: accessRequestBody(`${rec.name} (${user})`, entry.name, `${setUrl(slug)}/settings?review=access`, `${role}, ${team}`, effectiveVisibility(entry)) });
        return res.status(200).json({ ok: true });
      }

      // join via invite link
      const key = String(body.key || "");
      const links = await readLinks(slug);
      // Never let a blank or stub key match: an id that somehow came out empty
      // would otherwise turn "no key at all" into a valid one.
      const link = key.length >= 8 ? links.find((l) => l.id === key && !l.revoked) : undefined;
      if (!link) return res.status(404).json({ error: "This invite link is invalid or has been revoked." });
      if (!canViewContent(entry, user)) {
        entry.invites = [...new Set([...(entry.invites ?? []), user])].sort();
        await writeIndex(index);
      }
      link.uses = (link.uses || 0) + 1;
      await writeLinks(slug, links);
      const access = await readAccess(slug);
      const ar = access.find((a) => a.email === user);
      // They'd already asked to be let in and have now let themselves in. Record
      // that so the owner, arriving from a request email, can see what happened
      // instead of an empty list.
      if (ar && ar.status === "pending") {
        ar.status = "approved"; ar.via = "link"; ar.resolvedAt = new Date().toISOString();
        await writeAccess(slug, access);
      }
      return res.status(200).json({ ok: true });
    }

    // ---------------- owner / moderator / admin only ----------------
    if (!user || (!isSetOwner(entry, user) && !(await canModerate(user)))) return res.status(403).json({ error: "Owner only." });
    // Two ops stay with the creator (or a moderator/admin): editing the co-owner
    // list and deleting the set. Otherwise a co-owner could remove the creator.
    const creatorOnly = async () => isPrimaryOwner(entry, user) || (await canModerate(user));

    if (req.method === "GET") {
      if (req.query.op === "roundtags") {
        // Each edition's own round list, so the owner tags the packets a mirror
        // actually played rather than the whole tournament's rounds. Canonical
        // numbering, the same rounds every other page shows.
        const source = await readSource(slug);
        const eds = source ? canonicalizeEditions(editionsOf(source)) : [];
        return res.status(200).json({
          roundTags: await readRoundTags(slug),
          defaults: DEFAULT_ROUND_TAGS,
          tags: entry.tags ?? [],
          editions: eds.map((e) => ({
            id: e.id, label: e.label,
            rounds: [...new Set((e.packets || []).map((p) => p.round).concat((e.games || []).map((g) => g.round)))].sort((a, b) => a - b),
          })),
        });
      }
      // Packet-round layout (+ alignment warnings) and the per-edition game list,
      // both keyed by source-array index so the editors can address one file.
      // Applied player and team renames, so the owner can see and undo them (undo itself
      // goes through /api/correct, which owns the renames file).
      if (req.query.op === "renames") return res.status(200).json({ renames: await readRenames(slug) });
      // What the question metadata actually looks like across the set: every
      // distinct comma-separated shape, with how often it occurs and sample
      // values per field, so the owner can say which field means what.
      if (req.query.op === "metascan") {
        const source = await readSource(slug);
        if (!source) return res.status(500).json({ error: "Source data not found." });
        const counts = new Map<number, { rows: number; samples: string[][]; examples: string[] }>();
        let total = 0;
        for (const ed of editionsOf(source))
          for (const p of ed.packets || [])
            for (const q of [...(p.tossups || []), ...(source.hasBonuses ? p.bonuses || [] : [])]) {
              const fields = metaFields((q as { metadata?: string }).metadata);
              if (!fields.length) continue;
              total++;
              let c = counts.get(fields.length);
              if (!c) { c = { rows: 0, samples: fields.map(() => []), examples: [] }; counts.set(fields.length, c); }
              c.rows++;
              fields.forEach((f, i) => { if (f && c!.samples[i].length < 40 && !c!.samples[i].includes(f)) c!.samples[i].push(f); });
              if (c.examples.length < 3) { const raw = String((q as { metadata?: string }).metadata || ""); if (!c.examples.includes(raw)) c.examples.push(raw); }
            }
        const shapes = [...counts.entries()]
          .map(([fieldCount, c]) => ({ fieldCount, questions: c.rows, examples: c.examples, samples: c.samples.map((v) => v.slice(0, 12)), distinct: c.samples.map((v) => v.length) }))
          .sort((a, b) => b.questions - a.questions);
        return res.status(200).json({ total, shapes, metaMap: await readMetaMap(slug), tagEdits: await readTagEdits(slug) });
      }
      if (req.query.op === "rounds" || req.query.op === "games") {
        const source = await readSource(slug);
        if (!source) return res.status(500).json({ error: "Source data not found (set predates source storage; re-create it)." });
        const eds = editionsOf(source);
        if (req.query.op === "games")
          return res.status(200).json({ editions: eds.map((e) => ({ id: e.id, label: e.label, games: gameRows(e) })) });
        return res.status(200).json({ editions: eds.map(editionView) });
      }
      const access = await readAccess(slug);
      return res.status(200).json({
        visibility: entry.visibility ?? "listed",
        autoPublicAt: entry.autoPublicAt ?? null,
        allowRequests: requestsAllowed(entry),
        invites: entry.invites ?? [],
        owner: entry.owner,
        coOwners: entry.coOwners ?? [],
        // Only the creator may edit the co-owner list or delete the set, so the
        // UI needs to know which kind of owner is looking.
        isPrimaryOwner: await creatorOnly(),
        hasYf: !!entry.hasYf,
        level: entry.level ?? "",
        tdLink: entry.tdLink ?? "",
        accessRequests: access.filter((a) => a.status === "pending"),
        // Recently-settled requests, so an owner following a request email to an
        // empty pending list can see the person let themselves in with a link.
        resolvedRequests: resolvedList(access),
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
      // Whether viewers may propose buzz corrections and renames.
      if (body.allowRequests !== undefined) entry.allowRequests = !!body.allowRequests;
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
    } else if (op === "coowner" || op === "uncoowner") {
      // Co-owners can do everything the creator can except manage this list and
      // delete the set, so only the creator may change it.
      if (!(await creatorOnly())) return res.status(403).json({ error: "Only the tournament's owner can change who co-owns it." });
      const email = normEmail(body.email);
      if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email." });
      if (email === entry.owner) return res.status(400).json({ error: "That's the tournament's owner already." });
      const set = new Set(entry.coOwners ?? []);
      if (op === "coowner") {
        if (!(await loadUsers())[email]) return res.status(400).json({ error: "No Buzzpoints account uses that email — ask them to sign up first." });
        set.add(email);
        // A co-owner can already see everything; keeping them on the invite list
        // too would double-list them in the access UI.
        entry.invites = (entry.invites ?? []).filter((e) => e !== email);
      } else set.delete(email);
      entry.coOwners = [...set].sort();
      await writeIndex(index);
      if (op === "coowner")
        await sendEmail({ to: email, subject: `You can now manage ${entry.name}`, html: coOwnerBody(entry.name, setUrl(slug)) });
      return res.status(200).json({ ok: true, coOwners: entry.coOwners, invites: entry.invites ?? [] });
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
      rec.via = "owner";
      rec.resolvedAt = new Date().toISOString();
      await writeAccess(slug, access);
      return res.status(200).json({ ok: true, accessRequests: access.filter((a) => a.status === "pending"), resolvedRequests: resolvedList(access) });
    } else if (op === "create-link") {
      const links = await readLinks(slug);
      // 256 bits. This id IS the credential — anyone holding it can add
      // themselves to a private tournament, it never expires, and nothing rate
      // limits attempts against it, so it has to be far out of guessing range
      // rather than merely inconvenient to type. Links issued before this stay
      // valid; only newly minted ones are longer.
      const link: InviteLink = { id: crypto.randomBytes(32).toString("base64url"), label: String(body.label || "").slice(0, 60), by: user, at: new Date().toISOString(), uses: 0 };
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
    } else if (op === "metamap") {
      if (entry.kind === "results") return res.status(400).json({ error: "Metadata mapping applies to buzz tournaments only." });
      const clean = sanitizeMetaMap(body.metaMap);
      if (!clean) return res.status(400).json({ error: "Invalid metadata mapping." });
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      await writeMetaMap(slug, clean);
      await aggregateAndWrite(slug, source, await readCorrections(slug));
      return res.status(200).json({ ok: true, metaMap: clean });
    } else if (op === "question-tags") {
      // One question's hand-edited tags, layered over whatever the mapping derived.
      if (entry.kind === "results") return res.status(400).json({ error: "Tags apply to buzz tournaments only." });
      const kind = body.kind === "bonuses" ? "bonuses" : "tossups";
      const id = String(body.id || "");
      if (!/^\d+-\d+$/.test(id)) return res.status(400).json({ error: "Unknown question." });
      const add = cleanTagList(body.add), remove = cleanTagList(body.remove);
      if (!add || !remove) return res.status(400).json({ error: "Invalid tags." });
      const edits = await readTagEdits(slug);
      const bucket = { ...(edits[kind] || {}) };
      if (!add.length && !remove.length) delete bucket[id];
      else bucket[id] = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
      const next = { ...edits, [kind]: bucket };
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      await writeTagEdits(slug, next);
      await aggregateAndWrite(slug, source, await readCorrections(slug));
      return res.status(200).json({ ok: true, tagEdits: next });
    } else if (op === "roundtags") {
      if (entry.kind === "results") return res.status(400).json({ error: "Round tags apply to buzz tournaments only." });
      const clean = sanitizeRoundTags(body.roundTags);
      if (!clean) return res.status(400).json({ error: "Invalid round tags." });
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      // One schedule is saved at a time: the shared one, or a single edition's
      // override. Merging into the stored doc keeps the other schedules intact.
      const doc = await readRoundTags(slug);
      const edId = body.editionId ? String(body.editionId) : "";
      let next: RoundTagsDoc;
      if (edId && edId !== "all") {
        if (!editionsOf(source).some((e) => e.id === edId)) return res.status(404).json({ error: "Edition not found." });
        const eds = { ...(doc.editions || {}) };
        // An empty schedule means "this mirror follows the shared one" — drop the
        // override rather than storing an override that tags nothing.
        if (Object.keys(clean).length) eds[edId] = clean; else delete eds[edId];
        next = { ...doc, ...(Object.keys(eds).length ? { editions: eds } : { editions: undefined }) };
        if (!next.editions) delete next.editions;
      } else {
        next = { ...doc, all: clean };
        if (!Object.keys(clean).length) delete next.all;
      }
      await writeRoundTags(slug, next);
      const { tags } = await aggregateAndWrite(slug, source, await readCorrections(slug));
      entry.tags = tags;
      await writeIndex(index);
      return res.status(200).json({ ok: true, roundTags: next, tags });
    } else if (op === "remap-rounds" || op === "remove-files" || op === "remove-uploads") {
      if (entry.kind === "results") return res.status(400).json({ error: "This applies to buzz tournaments only." });
      const source = await readSource(slug);
      if (!source) return res.status(500).json({ error: "Source data not found (set predates source storage; re-create it)." });
      const eds = editionsOf(source);
      let nextEds: Edition[];
      const removed = { packets: 0, games: 0 };

      // Clear uploads wholesale: by round, by edition, or the lot. A botched
      // upload is the common case (files APPEND, so a re-upload doubles
      // everything), and picking hundreds of game rows out of a table one at a
      // time is not a repair anyone completes. Scope is explicit rather than
      // inferred: "*" is every edition, and omitting `rounds` means every round.
      if (op === "remove-uploads") {
        const everyEdition = body.editionId === "*";
        const targets = everyEdition ? eds : eds.filter((e) => e.id === String(body.editionId || ""));
        if (!targets.length) return res.status(404).json({ error: "Edition not found." });
        const what = body.what === "games" || body.what === "packets" ? body.what : "all";
        let roundSet: Set<number> | null = null;
        if (body.rounds !== undefined && body.rounds !== null) {
          if (!Array.isArray(body.rounds) || body.rounds.some((r: unknown) => !Number.isInteger(Number(r))))
            return res.status(400).json({ error: "Invalid round selection." });
          roundSet = new Set(body.rounds.map(Number));
          if (!roundSet.size) return res.status(400).json({ error: "No rounds selected." });
        }
        const inScope = (r: number) => roundSet === null || roundSet.has(r);
        const ids = new Set(targets.map((e) => e.id));
        nextEds = eds.map((e) => {
          if (!ids.has(e.id)) return e;
          const packets = what === "games" ? e.packets || [] : (e.packets || []).filter((p) => !inScope(p.round));
          const games = what === "packets" ? e.games || [] : (e.games || []).filter((g) => !inScope(g.round));
          removed.packets += (e.packets || []).length - packets.length;
          removed.games += (e.games || []).length - games.length;
          return { ...e, packets, games };
        });
        if (!removed.packets && !removed.games)
          return res.status(400).json({ error: "Nothing to remove — no packets or games matched that selection." });
        // fall through to the shared write below
      } else {

      const edId = String(body.editionId || "");
      const ed = eds.find((e) => e.id === edId);
      if (!ed) return res.status(404).json({ error: "Edition not found." });
      let next: Edition;

      if (op === "remap-rounds") {
        // body.rounds: { "<packet index>": <new round> }. Packets keep their
        // position; only the round they're filed under changes.
        const moves = body.rounds;
        if (!moves || typeof moves !== "object" || Array.isArray(moves)) return res.status(400).json({ error: "Invalid round mapping." });
        const packets = [...(ed.packets || [])];
        const entries = Object.entries(moves as Record<string, unknown>);
        if (!entries.length) return res.status(400).json({ error: "No round changes to apply." });
        for (const [k, v] of entries) {
          const i = Number(k), round = Number(v);
          if (!Number.isInteger(i) || i < 0 || i >= packets.length) return res.status(400).json({ error: "Unknown packet." });
          // Above LETTER_ROUND_BASE are the lettered packets ("Round A"), which the
          // client sends through as their mapped number.
          const lettered = round > LETTER_ROUND_BASE && round <= LETTER_ROUND_BASE + 26;
          if (!Number.isInteger(round) || round < 0 || (round > 999 && !lettered))
            return res.status(400).json({ error: "Rounds must be whole numbers from 0 to 999, or a single letter." });
          packets[i] = { ...packets[i], round };
        }
        // Two packets on one round overwrite each other, so refuse to CREATE a
        // collision. Pre-existing ones are left alone: an owner cleaning up a
        // mess shouldn't be blocked by the mess itself.
        const count = (list: typeof packets) => list.reduce((m, p) => m.set(p.round, (m.get(p.round) || 0) + 1), new Map<number, number>());
        const before = count(ed.packets || []), after = count(packets);
        for (const [round, n] of after)
          if (n > 1 && n > (before.get(round) || 0))
            return res.status(400).json({ error: `That would put ${n} packets on round ${round} — their questions would overwrite each other.` });
        next = { ...ed, packets };
      } else {
        // body.packets / body.games: source-array indexes to drop. Used to undo an
        // accidental re-upload (files are APPENDED to an edition, never replaced).
        const dropP = intList(body.packets ?? [], (ed.packets || []).length);
        const dropG = intList(body.games ?? [], (ed.games || []).length);
        if (!dropP || !dropG) return res.status(400).json({ error: "Invalid file selection." });
        if (!dropP.length && !dropG.length) return res.status(400).json({ error: "Nothing selected to remove." });
        next = {
          ...ed,
          packets: (ed.packets || []).filter((_, i) => !dropP.includes(i)),
          games: (ed.games || []).filter((_, i) => !dropG.includes(i)),
        };
      }
      nextEds = eds.map((e) => (e.id === edId ? next : e));
      }

      // An edition with nothing left in it is dead weight in every edition
      // picker, so drop it — unless that would leave none: a tournament whose
      // uploads were all cleared keeps its shell (settings, invites, slug) so
      // replacements can be uploaded into it instead of it being re-created.
      const kept = nextEds.filter((e) => (e.packets || []).length || (e.games || []).length);
      const finalEds = kept.length ? kept : nextEds.slice(0, 1).map((e) => ({ ...e, packets: [], games: [] }));
      const nextSource = withEditions(source, finalEds);
      await writeSource(slug, nextSource);
      const { meta, editions, tags } = await aggregateAndWrite(slug, nextSource, await readCorrections(slug));
      Object.assign(entry, {
        numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
        numTossups: meta.numTossups, rounds: meta.rounds.length, editions, tags,
      });
      await writeIndex(index);
      return res.status(200).json({
        ok: true, editions: finalEds.map(editionView),
        games: finalEds.map((e) => ({ id: e.id, label: e.label, games: gameRows(e) })),
        roundWarnings: meta.roundWarnings || [], removed,
      });
    } else if (op === "merge") {
      // Fold other tournaments into this one as extra editions. Different hosts
      // run their own mirror of the same set and each uploads it separately, so
      // the site ends up with three tournaments that are one tournament; until
      // now the only way to combine them was to get hold of every host's files
      // and upload them all again into one.
      //
      // Who may do it: you must own (or co-own) the destination AND every
      // tournament being absorbed, because absorbing one consumes it. An admin
      // may do it regardless — which is the only way two different hosts'
      // uploads ever get combined, since neither owns the other's.
      if (entry.kind === "results") return res.status(400).json({ error: "This applies to buzz tournaments only." });
      const admin = (await getRole(user)) === "admin";
      const wanted = Array.isArray(body.sources) ? [...new Set(body.sources.map((s: unknown) => String(s)))] : null;
      if (!wanted || !wanted.length) return res.status(400).json({ error: "Choose at least one tournament to merge in." });
      if (wanted.includes(slug)) return res.status(400).json({ error: "A tournament can't be merged into itself." });

      const sources = [];
      for (const s of wanted) {
        const e = index.sets.find((x) => x.slug === s);
        if (!e) return res.status(404).json({ error: `Tournament "${s}" not found.` });
        if (!admin && !isSetOwner(e, user)) return res.status(403).json({ error: `You don't own "${e.name}", so you can't merge it in. An admin can.` });
        if (e.kind === "results") return res.status(400).json({ error: `"${e.name}" has no buzz data, so it can't become an edition.` });
        // Scoring is applied uniformly across a tournament's editions, so a
        // mirror scored differently would silently be re-scored by the merge —
        // powers counted as gets, or negs that never existed.
        if ((e.scoring || "") !== (entry.scoring || ""))
          return res.status(400).json({ error: `"${e.name}" is scored ${e.scoring} but this tournament is ${entry.scoring}. Merging would re-score its buzzes.` });
        sources.push(e);
      }

      const destSource = await readSource(slug);
      if (!destSource) return res.status(500).json({ error: "Source data not found." });
      let eds = editionsOf(destSource);
      const labels = new Set(eds.map((e) => e.label));
      let corrections = await readCorrections(slug);
      let renames = await readRenames(slug);
      const corrSeen = new Set(corrections.map(corrKey));
      const renameSeen = new Set(renames.map(renameKey));
      let hasBonuses = !!destSource.hasBonuses;
      const absorbed: { slug: string; name: string; editions: number }[] = [];

      for (const s of sources) {
        const src = await readSource(s.slug);
        if (!src) return res.status(500).json({ error: `Source data for "${s.name}" not found.` });
        hasBonuses = hasBonuses || !!src.hasBonuses;
        const incoming = editionsOf(src).filter((e) => (e.packets || []).length || (e.games || []).length);
        if (!incoming.length) return res.status(400).json({ error: `"${s.name}" has nothing uploaded to merge.` });
        for (const e of incoming) {
          // Ids are positional and labels are what people read, so both are
          // reassigned: an incoming "Original" would otherwise collide with the
          // destination's, leaving two editions nobody can tell apart.
          const base = labels.has(e.label) || e.label === "Original" ? s.name : e.label;
          let label = base, n = 2;
          while (labels.has(label)) label = `${base} (${n++})`;
          labels.add(label);
          eds = [...eds, { ...e, id: `e${eds.length}`, label }];
        }
        // The absorbed tournament's edits are its owner's work, so they come
        // along. Anything already keyed the same in the destination wins —
        // re-applying a correction the destination already states differently
        // would silently overwrite the more recent decision.
        for (const c of await readCorrections(s.slug)) if (!corrSeen.has(corrKey(c))) { corrSeen.add(corrKey(c)); corrections = [...corrections, c]; }
        for (const r of await readRenames(s.slug)) if (!renameSeen.has(renameKey(r))) { renameSeen.add(renameKey(r)); renames = [...renames, r]; }
        absorbed.push({ slug: s.slug, name: s.name, editions: incoming.length });
      }

      const nextSource: SetSource = { name: destSource.name, scoring: destSource.scoring, hasBonuses, editions: eds };
      await writeSource(slug, nextSource);
      await writeCorrections(slug, corrections);
      await writeRenames(slug, renames);
      const { meta, editions, tags } = await aggregateAndWrite(slug, nextSource, corrections);
      Object.assign(entry, {
        hasBonuses,
        numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
        numTossups: meta.numTossups, rounds: meta.rounds.length, editions, tags,
      });
      // The absorbed tournaments are now duplicates of part of this one, so they
      // go — anyone invited to one is carried onto the survivor, since the thing
      // they were given access to still exists here.
      entry.invites = [...new Set([...(entry.invites || []), ...sources.flatMap((s) => s.invites || [])])].sort();
      const gone = new Set(absorbed.map((a) => a.slug));
      await writeIndex({ sets: index.sets.filter((s) => !gone.has(s.slug)) });
      for (const a of absorbed) {
        const { blobs } = await list({ prefix: `sets/${a.slug}/` });
        if (blobs.length) await del(blobs.map((b) => b.url));
      }
      return res.status(200).json({ ok: true, absorbed, editions });
    } else if (op === "delete") {
      if (!(await creatorOnly())) return res.status(403).json({ error: "Only the tournament's owner can delete it." });
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
    return res.status(200).json({ ok: true, visibility: entry.visibility, autoPublicAt: entry.autoPublicAt ?? null, allowRequests: requestsAllowed(entry), invites: entry.invites ?? [] });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
