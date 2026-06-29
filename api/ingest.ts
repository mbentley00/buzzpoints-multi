// Ingest: a logged-in user creates a tournament (becoming its owner), or appends
// a new edition/mirror to an existing tournament they own.
//
// First-post review: a brand-new poster (owns no tournaments yet, and isn't a
// moderator/admin) doesn't publish directly — their upload is held in the
// moderation queue and moderators are emailed. Established posters publish
// immediately. A name blocklist is enforced for everyone.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { del } from "@vercel/blob";
import { SCORINGS } from "./_lib/scoring.js";
import { readBlobJson } from "./_lib/blob.js";
import { currentUser, isAdminEmail, canModerate, loadUsers, moderatorEmails } from "./_lib/auth.js";
import {
  readIndex, writeIndex, readSource, writeSource, writeCorrections, readCorrections,
  aggregateAndWrite, editionsOf, SetSource,
} from "./_lib/sets.js";
import { createTournament, parseFiles, CreateError, FileRef } from "./_lib/publish.js";
import { parseYellowFruit } from "./_lib/yellowfruit.js";
import {
  readModConfig, findBlocked, readPending, writePending, writePendingPayload, PendingSubmission,
} from "./_lib/moderation.js";
import { sendEmail, appUrl, submissionPendingBody } from "./_lib/email.js";

interface Body {
  name?: string; scoring?: string; hasBonuses?: boolean; packets?: FileRef[]; games?: FileRef[];
  visibility?: string; autoPublicAt?: string | null; editionOf?: string; edition?: string;
  editionId?: string; // when set with editionOf: append files to this existing edition
  yf?: any; // optional companion YellowFruit (.yft) JSON for corrected re-export
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
        edition: body.edition,
        packets: body.packets!.map((r) => ({ name: r.name, json: r.json })),
        games: body.games!.map((r) => ({ name: r.name, json: r.json })),
        ...(body.yf ? { yf: body.yf } : {}),
      });
      const byName = (await loadUsers())[owner]?.name || owner;
      const rec: PendingSubmission = { id, by: owner, byName, name, scoring: body.scoring!, at: new Date().toISOString() };
      await writePending([rec, ...(await readPending()).filter((p) => p.id !== id)]);

      const reviewUrl = `${appUrl()}/admin`;
      for (const to of await moderatorEmails())
        await sendEmail({ to, subject: `Tournament awaiting review — ${name}`, html: submissionPendingBody(`${byName} (${owner})`, name, reviewUrl) });

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
