// Ingest: a logged-in user creates a tournament (becoming its owner), or appends
// a new edition/mirror to an existing tournament they own.
//
// First-post review: a brand-new poster (owns no tournaments yet, and isn't a
// moderator/admin) doesn't publish directly — their upload is held in the
// moderation queue and moderators are emailed. Established posters publish
// immediately. A name blocklist is enforced for everyone.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { put, del } from "@vercel/blob";
import { SCORINGS } from "./_lib/scoring.js";
import { readBlobJson } from "./_lib/blob.js";
import { currentUser, isAdminEmail, canModerate, loadUsers, moderatorEmails, signPurpose } from "./_lib/auth.js";
import {
  readIndex, writeIndex, readSource, writeSource, writeCorrections, readCorrections,
  aggregateAndWrite, editionsOf, SetSource,
} from "./_lib/sets.js";
import { createTournament, createFromSource, parseFiles, validLevel, cleanTdLink, CreateError, FileRef } from "./_lib/publish.js";
import { parseYellowFruit } from "./_lib/yellowfruit.js";
import { scrapeEdition, listEditions, listSets, parseTarget, slugToName, scoringFor, setNameFrom } from "./_lib/importBuzzpoints.js";
import {
  readModConfig, findBlocked, readPending, writePending, writePendingPayload, PendingSubmission,
} from "./_lib/moderation.js";

// A single edition scrape (hundreds of page fetches) needs room within the limit.
export const config = { maxDuration: 60 };

// ---- async import job state (driven across many requests by the browser) ----
interface ImportJob { base: string; by: string; editions: { slug: string; name: string }[]; imported: number[]; values: number[]; hasBonuses: boolean; createdAt: string; }
const jobPath = (id: string) => `imports/${id}.json`;
const edPath = (id: string, i: number) => `imports/${id}-e${i}.json`;
const writeJson = (path: string, obj: unknown) => put(path, JSON.stringify(obj), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });

async function handleImport(body: any, owner: string, res: VercelResponse) {
  // discover every set at a Buzzpoints base URL (for the admin bulk import)
  if (body.op === "import-sets") {
    let base: string, sets: { slug: string; name: string }[];
    try { base = parseTarget(String(body.importUrl || "")).base; sets = await listSets(base); }
    catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    return res.status(200).json({ base, sets });
  }

  // start: figure out which editions to import and open a job
  if (body.op === "import-start") {
    let base: string, eds: { slug: string; name: string }[];
    try {
      const t = parseTarget(String(body.importUrl || ""));
      base = t.base;
      if (t.kind === "tournament") eds = [{ slug: t.slug!, name: slugToName(t.slug!) }];
      else eds = await listEditions(base, t.kind === "set" ? `/set/${t.slug}` : "/tournament");
    } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    if (!eds.length) return res.status(400).json({ error: "No tournaments found at that URL. Make sure it's a Buzzpoints link." });
    const jobId = crypto.randomBytes(9).toString("base64url");
    const job: ImportJob = { base, by: owner, editions: eds, imported: [], values: [], hasBonuses: false, createdAt: new Date().toISOString() };
    await writeJson(jobPath(jobId), job);
    return res.status(200).json({ jobId, editions: eds.map((e) => ({ name: e.name })), total: eds.length });
  }

  const jobId = String(body.jobId || "");
  const job = await readBlobJson<ImportJob>(jobPath(jobId), false);
  if (!job) return res.status(404).json({ error: "Import session not found or expired. Start over." });
  if (job.by !== owner) return res.status(403).json({ error: "This import belongs to another account." });

  // edition: scrape one edition and stash it
  if (body.op === "import-edition") {
    const i = Number(body.index);
    if (!Number.isInteger(i) || i < 0 || i >= job.editions.length) return res.status(400).json({ error: "Invalid edition index." });
    let scraped;
    try { scraped = await scrapeEdition(job.base, job.editions[i].slug); }
    catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    await writeJson(edPath(jobId, i), { packets: scraped.packets, games: scraped.games });
    if (!job.imported.includes(i)) job.imported.push(i);
    job.values = [...new Set([...job.values, ...scraped.values])];
    if (scraped.hasBonuses) job.hasBonuses = true;
    await writeJson(jobPath(jobId), job);
    return res.status(200).json({ index: i, name: job.editions[i].name, imported: job.imported.length, total: job.editions.length });
  }

  // finish: assemble every scraped edition into one tournament
  if (body.op === "import-finish") {
    let level: string, tdLink: string | undefined;
    try { level = validLevel(body.level); tdLink = cleanTdLink(body.tdLink); }
    catch (e) { if (e instanceof CreateError) return res.status(e.status).json({ error: e.message }); throw e; }
    const editions: any[] = [];
    for (let i = 0; i < job.editions.length; i++) {
      const ed = await readBlobJson<{ packets: any[]; games: any[] }>(edPath(jobId, i), false);
      if (ed) editions.push({ id: `e${editions.length}`, label: job.editions[i].name || job.editions[i].slug, packets: ed.packets, games: ed.games });
    }
    if (!editions.length) return res.status(400).json({ error: "Nothing was imported." });
    const name = (body.name || "").trim() || setNameFrom(job.editions.map((e) => e.name || e.slug));
    const { blocklist } = await readModConfig();
    const blocked = findBlocked(name, blocklist);
    if (blocked) return res.status(400).json({ error: `Tournament name contains a disallowed word: "${blocked}".` });
    const scoring = scoringFor(new Set(job.values));
    const source: SetSource = { name, scoring, hasBonuses: job.hasBonuses, editions };
    try {
      const { slug } = await createFromSource(source, owner, { name, visibility: body.visibility, autoPublicAt: body.autoPublicAt ?? null, level, tdLink });
      await del([jobPath(jobId), ...job.editions.map((_, i) => edPath(jobId, i))]).catch(() => {});
      return res.status(200).json({ slug, editions: editions.length });
    } catch (e) {
      if (e instanceof CreateError) return res.status(e.status).json({ error: e.message });
      return res.status(500).json({ error: (e as Error).message });
    }
  }

  return res.status(400).json({ error: "Unknown import op." });
}
import { sendEmail, appUrl, submissionPendingBody } from "./_lib/email.js";

interface Body {
  name?: string; scoring?: string; hasBonuses?: boolean; packets?: FileRef[]; games?: FileRef[];
  visibility?: string; autoPublicAt?: string | null; editionOf?: string; edition?: string;
  editionId?: string; // when set with editionOf: append files to this existing edition
  yf?: any; // optional companion YellowFruit (.yft) JSON for corrected re-export
  level?: string; tdLink?: string; // tournament type + optional Tournament Database link
  importUrl?: string; // import-start: the Buzzpoints site to import
  op?: string; jobId?: string; index?: number; // async import: import-start | import-edition | import-finish
}

// Resolve a list of file refs to inline JSON. A ref uploaded directly to Blob
// carries a `pathname` (under uploads/) we read and then mark for cleanup;
// legacy inline `json` refs pass through unchanged.
async function resolveRefs(refs: FileRef[] | undefined, tempPaths: string[]): Promise<FileRef[]> {
  const out: FileRef[] = [];
  for (const r of refs || []) {
    if (r && typeof r.pathname === "string" && r.pathname) {
      if (!r.pathname.startsWith("uploads/")) throw new CreateError(400, "Invalid file reference.");
      const json = await readBlobJson<any>(r.pathname, false);
      if (json === null) throw new CreateError(400, `Uploaded file "${r.name}" could not be read.`);
      out.push({ name: r.name, json });
      tempPaths.push(r.pathname);
    } else {
      out.push({ name: r.name, json: r.json });
    }
  }
  return out;
}
const cleanupTemp = (paths: string[]) => (paths.length ? del(paths).catch(() => {}) : Promise.resolve());

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const owner = currentUser(req);
  if (!owner) return res.status(401).json({ error: "Log in to create a tournament." });

  const body = (req.body || {}) as Body;

  // Async import from another Buzzpoints site (browser drives start/edition/finish).
  if (typeof body.op === "string" && body.op.startsWith("import-")) return handleImport(body, owner, res);

  // Validate the optional companion YellowFruit file up front (so a first-post
  // submission isn't queued with an unreadable file).
  if (body.yf) {
    try { parseYellowFruit(body.yf); }
    catch (e) { return res.status(400).json({ error: `YellowFruit file: ${(e as Error).message}` }); }
  }

  const editionAppend = !!(body.editionOf || "").trim() && !!(body.editionId || "").trim();
  // Appending to an existing edition may add only packets OR only games; every
  // other path requires both.
  if (!editionAppend) {
    if (!body.packets?.length) return res.status(400).json({ error: "At least one packet is required." });
    if (!body.games?.length) return res.status(400).json({ error: "At least one game (QBJ) is required." });
  } else if (!body.packets?.length && !body.games?.length) {
    return res.status(400).json({ error: "Choose packet and/or game files to add." });
  }

  const tempPaths: string[] = [];
  try {
    body.packets = await resolveRefs(body.packets, tempPaths);
    body.games = await resolveRefs(body.games, tempPaths);
    const editionOf = (body.editionOf || "").trim();
    const { blocklist } = await readModConfig();

    // ---- add files to an existing tournament (append to a specific edition,
    //      or create a new edition/mirror) ----
    if (editionOf) {
      const index = await readIndex();
      const parent = index.sets.find((s) => s.slug === editionOf);
      if (!parent) return res.status(404).json({ error: "Tournament not found." });
      if (parent.owner !== owner && !isAdminEmail(owner))
        return res.status(403).json({ error: "Only the tournament's owner can add files." });

      const source = await readSource(editionOf);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      const eds = editionsOf(source);
      const { packets, games } = parseFiles(body);

      const targetId = (body.editionId || "").trim();
      let next: SetSource;
      let resultId: string;
      if (targetId) {
        // Append packets/games to an edition that already exists.
        const target = eds.find((e) => e.id === targetId);
        if (!target) return res.status(404).json({ error: "Edition not found." });
        const merged = eds.map((e) =>
          e.id === targetId
            ? { ...e, packets: [...(e.packets || []), ...packets], games: [...(e.games || []), ...games] }
            : e
        );
        next = { name: source.name, scoring: source.scoring, hasBonuses: source.hasBonuses, editions: merged };
        resultId = targetId;
      } else {
        // Create a new edition / mirror.
        const blockedLabel = findBlocked(body.edition || "", blocklist);
        if (blockedLabel) return res.status(400).json({ error: `Edition label contains a disallowed word: "${blockedLabel}".` });
        const id = `e${eds.length}`;
        const label = (body.edition || "").trim() || `Mirror ${eds.length + 1}`;
        next = {
          name: source.name, scoring: source.scoring, hasBonuses: source.hasBonuses,
          editions: [...eds, { id, label, packets, games }],
        };
        resultId = id;
      }

      await writeSource(editionOf, next);
      const corrections = await readCorrections(editionOf);
      const { meta, editions } = await aggregateAndWrite(editionOf, next, corrections);
      Object.assign(parent, {
        numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
        numTossups: meta.numTossups, rounds: meta.rounds.length, editions,
      });
      await writeIndex(index);
      await cleanupTemp(tempPaths);
      return res.status(200).json({ slug: editionOf, editionId: resultId, editions });
    }

    // ---- create a new tournament ----
    const name = (body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Tournament name is required." });
    if (!body.scoring || !(body.scoring in SCORINGS)) return res.status(400).json({ error: "Unknown scoring format." });
    const blocked = findBlocked(name, blocklist) || findBlocked(body.edition || "", blocklist);
    if (blocked) return res.status(400).json({ error: `Tournament name contains a disallowed word: "${blocked}".` });
    // Validate the tournament type + optional TD link now, so a queued first post
    // doesn't fail only at approval time.
    let level: string, tdLink: string | undefined;
    try { level = validLevel(body.level); tdLink = cleanTdLink(body.tdLink); }
    catch (e) { if (e instanceof CreateError) return res.status(e.status).json({ error: e.message }); throw e; }

    // First-post gate: queue for review unless this account has posted before or
    // is a moderator/admin.
    const index = await readIndex();
    const established = index.sets.some((s) => s.owner === owner);
    const privileged = await canModerate(owner);
    if (!established && !privileged) {
      const id = crypto.randomBytes(9).toString("base64url");
      await writePendingPayload(id, {
        name, scoring: body.scoring!, hasBonuses: !!body.hasBonuses,
        visibility: body.visibility, autoPublicAt: body.autoPublicAt ?? null,
        edition: body.edition, level, ...(tdLink ? { tdLink } : {}),
        packets: body.packets!.map((r) => ({ name: r.name, json: r.json })),
        games: body.games!.map((r) => ({ name: r.name, json: r.json })),
        ...(body.yf ? { yf: body.yf } : {}),
      });
      const byName = (await loadUsers())[owner]?.name || owner;
      const rec: PendingSubmission = { id, by: owner, byName, name, scoring: body.scoring!, at: new Date().toISOString() };
      await writePending([rec, ...(await readPending()).filter((p) => p.id !== id)]);

      const reviewUrl = `${appUrl()}/admin`;
      // 30-day, signed one-click approval link the admin can act on from the email.
      const approveUrl = `${appUrl()}/api/moderate?approve=${encodeURIComponent(signPurpose(id, "approve-sub", 60 * 60 * 24 * 30))}`;
      for (const to of await moderatorEmails())
        await sendEmail({ to, subject: `Approve tournament — ${name}`, html: submissionPendingBody(`${byName} (${owner})`, name, reviewUrl, approveUrl) });

      // The full JSON is now copied into the pending payload; drop the temp uploads.
      await cleanupTemp(tempPaths);
      return res.status(202).json({ pending: true, message: "Your first tournament was submitted for review. You'll get an email when it's approved." });
    }

    const { slug } = await createTournament(body, owner);
    await cleanupTemp(tempPaths);
    return res.status(200).json({ slug });
  } catch (e) {
    await cleanupTemp(tempPaths);
    if (e instanceof CreateError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: (e as Error).message });
  }
}
