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
  aggregateAndWrite, editionsOf, SetSource, isSetOwner,
} from "./_lib/sets.js";
import { createTournament, createFromSource, updateFromSource, parseFiles, validLevel, cleanTdLink, normVisibility, CreateError, FileRef } from "./_lib/publish.js";
import { parseYellowFruit } from "./_lib/yellowfruit.js";
import { scrapeEdition, scrapeBonusResults, applyBonusResults, applyBonusText, listEditions, listSets, setEditions, parseTarget, slugToName, scoringFor, setNameFrom } from "./_lib/importBuzzpoints.js";
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
  // Discover what a Buzzpoints URL points at (for the admin bulk import).
  // A link to the site lists every set there; a link to ONE set or ONE
  // tournament resolves to just that, because someone who pasted a specific
  // page meant that page — reading only its origin and importing the whole
  // site instead is how a deliberate choice gets lost. Each row carries the
  // kind it was found as, so the importer can rebuild the right link.
  if (body.op === "import-sets") {
    let base: string, sets: { slug: string; name: string; kind: "set" | "tournament" }[];
    try {
      const t = parseTarget(String(body.importUrl || ""));
      base = t.base;
      // The display name lives on the listing page. It's a nicety, not the
      // point, so fall back to the slug rather than failing the discovery.
      if (t.kind === "set") {
        const found = (await listSets(base).catch(() => [])).find((s) => s.slug === t.slug);
        sets = [{ slug: t.slug!, name: found?.name || slugToName(t.slug!), kind: "set" }];
      } else if (t.kind === "tournament") {
        const found = (await listEditions(base, "/tournament").catch(() => [])).find((e) => e.slug === t.slug);
        sets = [{ slug: t.slug!, name: found?.name || slugToName(t.slug!), kind: "tournament" }];
      } else {
        sets = (await listSets(base)).map((s) => ({ ...s, kind: "set" as const }));
      }
    } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    return res.status(200).json({ base, sets });
  }

  // ---- local folder import (native packet + QBJ files, uploaded by the browser;
  //      no scraping). Same edition-by-edition job pattern as the URL import. ----
  if (body.op === "local-start") {
    const jobId = crypto.randomBytes(9).toString("base64url");
    await writeJson(jobPath(jobId), { local: true, by: owner, createdAt: new Date().toISOString() });
    return res.status(200).json({ jobId });
  }
  if (body.op === "local-edition" || body.op === "local-finish") {
    const jobId = String(body.jobId || "");
    const job = await readBlobJson<any>(jobPath(jobId), false);
    if (!job || !job.local) return res.status(404).json({ error: "Import session not found or expired. Start over." });
    if (job.by !== owner) return res.status(403).json({ error: "This import belongs to another account." });

    // stash one edition (mirror): resolve the uploaded packet+QBJ refs to JSON,
    // parse into packets (round from filename) + games (round from _round).
    if (body.op === "local-edition") {
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: "Invalid edition index." });
      const tempPaths: string[] = [];
      try {
        const packets = await resolveRefs(body.packets, tempPaths);
        const games = await resolveRefs(body.games, tempPaths);
        const parsed = parseFiles({ packets, games });
        await writeJson(edPath(jobId, i), { label: String(body.label || `Mirror ${i + 1}`), packets: parsed.packets, games: parsed.games });
        await cleanupTemp(tempPaths);
      } catch (e) {
        await cleanupTemp(tempPaths);
        if (e instanceof CreateError) return res.status(e.status).json({ error: e.message });
        return res.status(500).json({ error: (e as Error).message });
      }
      return res.status(200).json({ index: i });
    }

    // assemble every stashed edition into one set; create it or refresh in place.
    const count = Number(body.editionCount) || 0;
    const editions: any[] = [];
    for (let i = 0; i < count; i++) {
      const ed = await readBlobJson<{ label: string; packets: any[]; games: any[] }>(edPath(jobId, i), false);
      if (ed && Array.isArray(ed.games) && ed.games.length) editions.push({ id: `e${editions.length}`, label: ed.label, packets: ed.packets, games: ed.games });
    }
    if (!editions.length) return res.status(400).json({ error: "No editions with game data." });
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Set name is required." });
    if (!body.scoring || !(body.scoring in SCORINGS)) return res.status(400).json({ error: "Unknown scoring format." });
    const source: SetSource = { name, scoring: body.scoring, hasBonuses: !!body.hasBonuses, editions };
    const cleanup = () => del([jobPath(jobId), ...Array.from({ length: count }, (_, i) => edPath(jobId, i))]).catch(() => {});
    const refreshSlug = String(body.refreshSlug || "").trim();
    try {
      let result: { slug: string; editions?: number };
      if (refreshSlug) result = await updateFromSource(source, refreshSlug, owner, await canModerate(owner));
      else {
        const { blocklist } = await readModConfig();
        const blocked = findBlocked(name, blocklist);
        if (blocked) return res.status(400).json({ error: `Set name contains a disallowed word: "${blocked}".` });
        result = await createFromSource(source, owner, { name, level: validLevel(body.level), visibility: body.visibility, autoPublicAt: body.autoPublicAt ?? null });
      }
      await cleanup();
      return res.status(200).json({ slug: result.slug, editions: editions.length, refreshed: !!refreshSlug });
    } catch (e) {
      if (e instanceof CreateError) return res.status(e.status).json({ error: e.message });
      return res.status(500).json({ error: (e as Error).message });
    }
  }

  // start: figure out which editions to import and open a job

  // How much bonus text is missing, per edition. No network — just reads the source.
  if (body.op === "bonus-text-scan") {
    const slug = String(body.slug || "");
    const index = await readIndex();
    const entry = index.sets.find((s) => s.slug === slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (!isSetOwner(entry, owner) && !(await canModerate(owner))) return res.status(403).json({ error: "Owner only." });
    const source = await readSource(slug);
    if (!source) return res.status(200).json({ slug, editions: [], missing: 0 });
    const editions = editionsOf(source).map((ed, index2) => {
      const total = (ed.packets || []).reduce((n, p) => n + (p.bonuses || []).length, 0);
      return { index: index2, label: ed.label, total, missing: missingBonusPairs(ed).length };
    });
    return res.status(200).json({ slug, name: entry.name, editions, missing: editions.reduce((n, e) => n + e.missing, 0) });
  }

  // Scrape one slice of an edition's missing bonus pages and bake the text into
  // the stored source. Resumable: the client calls until `done`.
  if (body.op === "bonus-text-chunk") {
    const slug = String(body.slug || "");
    const edIndex = Number(body.edition) || 0;
    const index = await readIndex();
    const entry = index.sets.find((s) => s.slug === slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (!isSetOwner(entry, owner) && !(await canModerate(owner))) return res.status(403).json({ error: "Owner only." });
    const source = await readSource(slug);
    if (!source) return res.status(400).json({ error: "Source data not found." });
    const eds = editionsOf(source);
    const ed = eds[edIndex];
    if (!ed) return res.status(404).json({ error: "Edition not found." });

    const pairs = missingBonusPairs(ed);
    if (!pairs.length) return res.status(200).json({ done: true, fetched: 0, remaining: 0 });

    let src: { base: string; eds: { slug: string; name: string }[] };
    try { src = await sourceTournaments(String(body.importUrl || ""), entry.name); }
    catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    const target = src.eds[edIndex] || src.eds[0];
    if (!target) return res.status(400).json({ error: "No matching tournament at that link." });

    const CHUNK = 45;
    const deadline = Date.now() + 50000; // headroom under the function limit
    const { results } = await scrapeBonusResults(src.base, target.slug, pairs.slice(0, CHUNK), deadline);
    const withText = results.filter((r) => r.text);
    applyBonusText(ed.packets as any, results);
    await writeSource(slug, { name: source.name, scoring: source.scoring, hasBonuses: source.hasBonuses, editions: eds });
    const remaining = missingBonusPairs(ed).length;
    // Nothing came back and nothing moved: the source is refusing the detail pages,
    // so say so instead of spinning through every chunk to no effect.
    if (!withText.length) return res.status(200).json({ done: true, fetched: 0, remaining, stalled: true });
    return res.status(200).json({ done: remaining === 0, fetched: withText.length, remaining });
  }

  // Fold the refreshed text into the published stats.
  if (body.op === "bonus-text-finish") {
    const slug = String(body.slug || "");
    const index = await readIndex();
    const entry = index.sets.find((s) => s.slug === slug);
    if (!entry) return res.status(404).json({ error: "Tournament not found." });
    if (!isSetOwner(entry, owner) && !(await canModerate(owner))) return res.status(403).json({ error: "Owner only." });
    const source = await readSource(slug);
    if (!source) return res.status(400).json({ error: "Source data not found." });
    await aggregateAndWrite(slug, source, await readCorrections(slug));
    return res.status(200).json({ ok: true });
  }

  if (body.op === "import-start") {
    let base: string, eds: { slug: string; name: string }[];
    try {
      const t = parseTarget(String(body.importUrl || ""));
      base = t.base;
      if (t.kind === "tournament") eds = [{ slug: t.slug!, name: slugToName(t.slug!) }];
      else if (t.kind === "set") eds = await setEditions(base, t.slug!);
      else eds = await listEditions(base, "/tournament");
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

  // edition: scrape one edition (tossups, games, bonus index) and stash it
  if (body.op === "import-edition") {
    const i = Number(body.index);
    if (!Number.isInteger(i) || i < 0 || i >= job.editions.length) return res.status(400).json({ error: "Invalid edition index." });
    let scraped;
    try { scraped = await scrapeEdition(job.base, job.editions[i].slug); }
    catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    // Stash the bonus (round,num) pairs + a cursor so per-team bonus results can
    // be scraped later in browser-driven chunks (import-bonus-chunk).
    await writeJson(edPath(jobId, i), { packets: scraped.packets, games: scraped.games, bonusPairs: scraped.bonusPairs, bonusCursor: 0 });
    if (!job.imported.includes(i)) job.imported.push(i);
    job.values = [...new Set([...job.values, ...scraped.values])];
    if (scraped.hasBonuses) job.hasBonuses = true;
    await writeJson(jobPath(jobId), job);
    return res.status(200).json({ index: i, name: job.editions[i].name, imported: job.imported.length, total: job.editions.length, bonusTotal: scraped.bonusPairs.length });
  }

  // bonus chunk (optional): scrape the next slice of this edition's bonus detail
  // pages for per-team results AND the question text (leadin + prompts), baking
  // them into the stashed games + packets. Repeatable until done; each call stays
  // within the function limit via an internal deadline.
  if (body.op === "import-bonus-chunk") {
    const i = Number(body.index);
    if (!Number.isInteger(i) || i < 0 || i >= job.editions.length) return res.status(400).json({ error: "Invalid edition index." });
    const ed = await readBlobJson<{ packets: any[]; games: any[]; bonusPairs: [number, number][]; bonusCursor: number }>(edPath(jobId, i), false);
    if (!ed) return res.status(404).json({ error: "Edition not scraped yet." });
    const pairs = ed.bonusPairs || [];
    const cursor = ed.bonusCursor || 0;
    if (cursor >= pairs.length) return res.status(200).json({ index: i, cursor, total: pairs.length, done: true });
    const CHUNK = 45;
    const deadline = Date.now() + 50000; // leave headroom under the 60s limit
    const { results, attempted } = await scrapeBonusResults(job.base, job.editions[i].slug, pairs.slice(cursor, cursor + CHUNK), deadline);
    applyBonusResults(ed.games as any, results);
    applyBonusText(ed.packets as any, results);
    ed.bonusCursor = cursor + Math.max(1, attempted); // always advance so we can't loop forever
    await writeJson(edPath(jobId, i), ed);
    return res.status(200).json({ index: i, cursor: ed.bonusCursor, total: pairs.length, done: ed.bonusCursor >= pairs.length });
  }

  // finish: assemble every scraped edition into one tournament (or refresh an
  // existing one in place when refreshSlug is given)
  if (body.op === "import-finish") {
    const editions: any[] = [];
    for (let i = 0; i < job.editions.length; i++) {
      const ed = await readBlobJson<{ packets: any[]; games: any[] }>(edPath(jobId, i), false);
      // Skip editions with no game data (e.g. an unplayed/empty tournament) so we
      // never create an empty set.
      if (ed && Array.isArray(ed.games) && ed.games.length) editions.push({ id: `e${editions.length}`, label: job.editions[i].name || job.editions[i].slug, packets: ed.packets, games: ed.games });
    }
    if (!editions.length) return res.status(400).json({ error: "No game data found at that link." });
    const scoring = scoringFor(new Set(job.values));
    const cleanupJob = () => del([jobPath(jobId), ...job.editions.map((_, i) => edPath(jobId, i))]).catch(() => {});

    // Refresh an existing tournament in place: keep its slug/owner/visibility/
    // level/invites/corrections, replace only the re-scraped data.
    const refreshSlug = String(body.refreshSlug || "").trim();
    if (refreshSlug) {
      const source: SetSource = { name: "", scoring, hasBonuses: job.hasBonuses, editions };
      try {
        const r = await updateFromSource(source, refreshSlug, owner, await canModerate(owner));
        await cleanupJob();
        return res.status(200).json({ slug: r.slug, editions: r.editions, refreshed: true });
      } catch (e) {
        if (e instanceof CreateError) return res.status(e.status).json({ error: e.message });
        return res.status(500).json({ error: (e as Error).message });
      }
    }

    let level: string, tdLink: string | undefined;
    try { level = validLevel(body.level); tdLink = cleanTdLink(body.tdLink); }
    catch (e) { if (e instanceof CreateError) return res.status(e.status).json({ error: e.message }); throw e; }
    const name = (body.name || "").trim() || setNameFrom(job.editions.map((e) => e.name || e.slug));
    const { blocklist } = await readModConfig();
    const blocked = findBlocked(name, blocklist);
    if (blocked) return res.status(400).json({ error: `Tournament name contains a disallowed word: "${blocked}".` });
    const source: SetSource = { name, scoring, hasBonuses: job.hasBonuses, editions };
    try {
      const { slug } = await createFromSource(source, owner, { name, visibility: body.visibility, autoPublicAt: body.autoPublicAt ?? null, level, tdLink });
      await cleanupJob();
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
  replaceRound?: boolean; // with editionId: swap out the rounds these files cover instead of appending
  yf?: any; // optional companion YellowFruit (.yft) JSON for corrected re-export
  level?: string; tdLink?: string; // tournament type + optional Tournament Database link
  importUrl?: string; // import-start: the Buzzpoints site to import
  op?: string; jobId?: string; index?: number; // async import: import-start | import-edition | import-finish
  refreshSlug?: string; // import-finish: refresh this existing set in place instead of creating one
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


/* ---------------------- missing bonus text repair ------------------------- */
// A scraped import gets bonus ANSWERS and conversion from one cheap index page;
// the leadin and part prompts live only on the per-bonus detail pages, which are
// slow and often 504. When that pass fails the set lands with stats but no bonus
// text, and nothing said so. These ops re-run just that pass against an existing
// set, in resumable chunks (the detail pages are far too slow for one request).

export const bonusHasText = (b: { leadin?: string; parts?: string[] }) =>
  !!(b?.leadin || "").trim() || (b?.parts || []).some((p) => (p || "").trim());

// The (round, num) pairs in one edition whose bonus text never arrived.
export function missingBonusPairs(ed: { packets?: any[] }): [number, number][] {
  const out: [number, number][] = [];
  for (const p of ed.packets || [])
    (p.bonuses || []).forEach((b: any, i: number) => { if (!bonusHasText(b)) out.push([p.round, i + 1]); });
  return out;
}

// Which source tournament feeds each stored edition. A tournament link names one
// directly; a set/site link is resolved the same way the import did, and editions
// keep the order they were created in, so index lines up with index.
async function sourceTournaments(importUrl: string, setName: string): Promise<{ base: string; eds: { slug: string; name: string }[] }> {
  const t = parseTarget(importUrl);
  if (t.kind === "tournament") return { base: t.base, eds: [{ slug: t.slug!, name: slugToName(t.slug!) }] };
  if (t.kind === "set") return { base: t.base, eds: await setEditions(t.base, t.slug!) };
  // A bare site link: find the source set whose name matches this tournament's,
  // which is what makes a run across every imported set possible.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const sets = await listSets(t.base);
  const hit = sets.find((x) => norm(x.name) === norm(setName)) || sets.find((x) => norm(x.slug) === norm(setName));
  if (hit) return { base: t.base, eds: await setEditions(t.base, hit.slug) };
  const all = await listEditions(t.base, "/tournament");
  const one = all.find((x) => norm(x.name) === norm(setName) || norm(x.slug) === norm(setName));
  if (!one) throw new Error(`Couldn't find "${setName}" at that site — open its page there and paste that link instead.`);
  return { base: t.base, eds: [one] };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const owner = currentUser(req);
  if (!owner) return res.status(401).json({ error: "Log in to create a tournament." });

  const body = (req.body || {}) as Body;

  // Async import from another Buzzpoints site, or a local native-file import
  // (browser drives start/edition/finish).
  if (typeof body.op === "string" && (body.op.startsWith("import-") || body.op.startsWith("local-") || body.op.startsWith("bonus-text-"))) return handleImport(body, owner, res);

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
      if (!isSetOwner(parent, owner) && !isAdminEmail(owner))
        return res.status(403).json({ error: "Only the tournament's owner can add files." });

      const source = await readSource(editionOf);
      if (!source) return res.status(500).json({ error: "Source data not found." });
      const eds = editionsOf(source);
      const { packets, games } = parseFiles(body);

      const targetId = (body.editionId || "").trim();
      let next: SetSource;
      let resultId: string;
      if (targetId) {
        // Append packets/games to an edition that already exists, or — when the
        // owner is fixing a round they got wrong — throw away what's already filed
        // under the rounds being uploaded and put these in their place.
        const target = eds.find((e) => e.id === targetId);
        if (!target) return res.status(404).json({ error: "Edition not found." });
        const replace = !!body.replaceRound;
        if (replace && [...packets, ...games].some((f) => !f.round))
          return res.status(400).json({
            error: "To replace a round, every file has to say which round it is — name them like \"Round_09.json\" (or set the round inside the game file).",
          });
        const packetRounds = new Set(packets.map((p) => p.round));
        const gameRounds = new Set(games.map((g) => g.round));
        const kept = (e: typeof target) => ({
          packets: replace ? (e.packets || []).filter((p) => !packetRounds.has(p.round)) : e.packets || [],
          games: replace ? (e.games || []).filter((g) => !gameRounds.has(g.round)) : e.games || [],
        });
        const merged = eds.map((e) => {
          if (e.id !== targetId) return e;
          const k = kept(e);
          return { ...e, packets: [...k.packets, ...packets], games: [...k.games, ...games] };
        });
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
      return res.status(200).json({ slug: editionOf, editionId: resultId, editions, categoryWarnings: (meta as any).categoryWarnings || [], roundWarnings: (meta as any).roundWarnings || [] });
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
      const rec: PendingSubmission = {
        id, by: owner, byName, name, scoring: body.scoring!, at: new Date().toISOString(),
        visibility: normVisibility(body.visibility),
      };
      await writePending([rec, ...(await readPending()).filter((p) => p.id !== id)]);

      const reviewUrl = `${appUrl()}/admin`;
      // 30-day, signed one-click approval link the admin can act on from the email.
      const approveUrl = `${appUrl()}/api/moderate?approve=${encodeURIComponent(signPurpose(id, "approve-sub", 60 * 60 * 24 * 30))}`;
      for (const to of await moderatorEmails())
        await sendEmail({ to, subject: `Approve tournament — ${name}`, html: submissionPendingBody(`${byName} (${owner})`, name, reviewUrl, approveUrl, rec.visibility) });

      // The full JSON is now copied into the pending payload; drop the temp uploads.
      await cleanupTemp(tempPaths);
      return res.status(202).json({ pending: true, message: "Your first tournament was submitted for review. You'll get an email when it's approved." });
    }

    const { slug, categoryWarnings, roundWarnings } = await createTournament(body, owner);
    await cleanupTemp(tempPaths);
    return res.status(200).json({ slug, categoryWarnings, roundWarnings });
  } catch (e) {
    await cleanupTemp(tempPaths);
    if (e instanceof CreateError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: (e as Error).message });
  }
}
