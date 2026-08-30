// Returns the list of tournaments visible to the caller, and (with `?q=`) a
// cross-tournament player/question search scoped to sets the caller can view.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readBlobJson } from "./_lib/blob.js";
import { currentUser, canModerate } from "./_lib/auth.js";
import { SetEntry, canList, canViewContent, sanitizeEntry, effectiveVisibility, TOURNAMENT_LEVELS } from "./_lib/sets.js";
import { sendEmail, emailEnabled, feedbackBody } from "./_lib/email.js";
import { isCategoryBucket, CategoryBucket } from "./_lib/categories.js";
import { getSearchDoc } from "./_lib/searchIndex.js";
import { readForum, unreadFor } from "./_lib/forum.js";

const MAX_SETS = 80;   // cap how many accessible sets a single query scans
const MAX_RESULTS = 200;

// What a question search looks at. "answer" = answer lines only; "text" = the
// question text (a tossup's body, a bonus's lead-in and parts); "all" = both.
// Never the category name — that's what the category filter is for, and a
// query like "history" matching every history question by its label was noise.
export type QField = "all" | "answer" | "text";
export type QKind = "all" | "tossup" | "bonus";
export interface SearchOpts {
  level?: string;   // only tournaments of this type (TOURNAMENT_LEVELS id)
  kind?: QKind;     // questions: tossups, bonuses or both
  field?: QField;   // questions: answer lines, question text or both
  // Questions: only those in one of these subject buckets (see categories.ts),
  // which is how a filter can span sets that each name their categories
  // differently.
  cats?: CategoryBucket[];
  // Which of the caller's viewable sets to search. "public" (the default) is
  // only the ones anyone could see; "all" adds the listed and private sets this
  // caller has been let into. Never anything beyond canViewContent.
  scope?: "public" | "all";
}

// How a query matches: a bare query matches anywhere in the text ("nabok"
// finds Nabokov); one in quotes matches only as whole words ("art" no longer
// finds Bartók or Descartes). Either way it's a phrase — the words must appear
// together, in order. Returns the match position, or -1.
type Matcher = { find: (plain: string) => number; len: number };
function matcherFor(q: string): Matcher {
  const quoted = /^"(.+)"$/.exec(q.trim());
  const needle = (quoted ? quoted[1] : q).trim().toLowerCase();
  if (!quoted) return { find: (s) => (s || "").indexOf(needle), len: needle.length };
  // Whole words: no letter or digit may touch either end of the phrase.
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
  return { find: (s) => { const m = re.exec(s || ""); return m ? m.index + m[1].length : -1; }, len: needle.length };
}

// A short window of (already plain, lowercase) text around the first match, so
// a text hit shows WHY it matched instead of just an answer line that doesn't
// contain the query.
function snippet(plain: string, m: Matcher, width = 70): string | null {
  const i = m.find(plain);
  if (i < 0) return null;
  const from = Math.max(0, i - width), to = Math.min(plain.length, i + m.len + width);
  return `${from > 0 ? "…" : ""}${plain.slice(from, to)}${to < plain.length ? "…" : ""}`;
}

// What every hit says about the tournament it came from: its type, its question
// difficulty, its format, and its status — a listed or private set the caller
// happens to be able to view is worth flagging next to the public ones.
const setFacts = (s: SetEntry) => ({
  slug: s.slug, setName: s.name, createdAt: s.createdAt ?? null,
  level: s.level ?? null, difficulty: s.difficulty ?? null, individual: !!s.individual,
  visibility: effectiveVisibility(s),
});

// Cross-tournament search over the sets the caller has *content* access to
// (public, owned, or invited), reading each set's prebuilt search document
// (see _lib/searchIndex.ts).
async function search(user: string | null, q: string, type: "players" | "questions", opts: SearchOpts, res: VercelResponse) {
  const m = matcherFor(q);
  if (!m.len) return res.status(200).json({ results: [], total: 0, type });
  const idx = await readBlobJson<{ sets: SetEntry[] }>("sets/index.json", false);
  // canViewContent is the same test /api/data applies before serving question
  // content unredacted — the search must never show a question, a snippet or
  // an answer from a set the caller couldn't open and read in full. (Moderators
  // and admins get no special reach here: their redacted view of a private set
  // doesn't extend to searching its text.)
  const accessible = (idx?.sets ?? [])
    .filter((s) => canViewContent(s, user))
    .filter((s) => opts.scope === "all" || effectiveVisibility(s) === "public")
    .filter((s) => !opts.level || s.level === opts.level)
    .slice(0, MAX_SETS);
  const kind = opts.kind ?? "all";
  const field = opts.field ?? "all";
  const inAnswer = field !== "text";
  const inText = field !== "answer";
  const hit = (s: string) => m.find(s) >= 0;
  const wantCats = opts.cats?.length ? new Set<string>(opts.cats) : null;
  const inCats = (buckets: string[]) => !wantCats || buckets.some((b) => wantCats.has(b));

  const results: any[] = [];
  await Promise.all(
    accessible.map(async (s) => {
      const doc = await getSearchDoc(s.slug);
      if (!doc) return;
      if (type === "players") {
        for (const p of doc.players)
          if (hit(p.n) || hit(p.tm))
            results.push({ ...setFacts(s), playerId: p.id, name: p.name, team: p.team, ppg: p.ppg, games: p.games, pts: p.pts, topCats: p.topCats });
        return;
      }
      if (kind !== "bonus")
        for (const r of doc.tossups) {
          const byAnswer = inAnswer && hit(r.a);
          const byText = inText && !byAnswer ? snippet(r.t, m) : null;
          if (!byAnswer && !byText) continue;
          // Where in the answer line it matched — an "accept"/"prompt" clause
          // the result's answer doesn't show, as often as not.
          const aSnip = byAnswer ? snippet(r.a, m, 40) : null;
          if (!inCats(r.buckets)) continue;
          results.push({
            ...setFacts(s), kind: "tossup", id: r.id, round: r.round, num: r.num, answer: r.answer, category: r.category,
            heard: r.heard, correct: r.correct, convPct: r.convPct, avgBuzzPct: r.avgBuzzPct, wordCount: r.wordCount, buzzes: r.buzzes,
            ...(byText ? { snippet: byText } : {}), ...(aSnip ? { answerSnippet: aSnip } : {}),
          });
        }
      if (kind !== "tossup")
        for (const r of doc.bonuses) {
          const ai = inAnswer ? r.a.findIndex(hit) : -1;
          const byText = inText && ai < 0 ? snippet(r.t, m) : null;
          if (ai < 0 && !byText) continue;
          const aSnip = ai >= 0 ? snippet(r.a[ai], m, 40) : null;
          if (!inCats(r.buckets)) continue;
          results.push({
            ...setFacts(s), kind: "bonus", id: r.id, round: r.round, num: r.num,
            answer: ai >= 0 ? r.answers[ai] : r.answers[0] ?? "", matchedPart: ai >= 0 ? ai : null,
            heard: r.heard,
            parts: r.answers.map((a, i) => ({ answer: a, difficulty: r.parts[i]?.difficulty ?? "", convPct: r.parts[i]?.convPct ?? null, convCount: r.parts[i]?.convCount ?? null })),
            category: r.category, ...(byText ? { snippet: byText } : {}), ...(aSnip ? { answerSnippet: aSnip } : {}),
          });
        }
    })
  );

  if (type === "players") {
    // Default order: most recent tournament first (the client offers other sorts).
    results.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || (b.ppg || 0) - (a.ppg || 0) || String(a.name).localeCompare(String(b.name)));
  } else {
    results.sort((a, b) => String(a.setName).localeCompare(String(b.setName)) || a.round - b.round || a.num - b.num);
  }
  res.setHeader("cache-control", "no-store");
  return res.status(200).json({ results: results.slice(0, MAX_RESULTS), total: results.length, type });
}

// ---- site feature requests / bug reports ("Feature Requests" in the topbar) ----
// A new route would put api/ over the Hobby plan's 12-function ceiling, so this
// rides along on the index handler as a POST op.
const FEEDBACK_TO = process.env.FEEDBACK_EMAIL || "bentley.michael.j@gmail.com";
const MAX_MESSAGE = 4000;
// Best-effort throttle: the map lives in one warm instance, so it slows a single
// sender down rather than sealing the endpoint. Enough to stop a stuck retry
// loop or a bored visitor from filling an inbox.
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const FEEDBACK_PER_WINDOW = 5;
const recentFeedback = new Map<string, number[]>();

function throttled(ip: string): boolean {
  const now = Date.now();
  const hits = (recentFeedback.get(ip) ?? []).filter((t) => now - t < FEEDBACK_WINDOW_MS);
  hits.push(now);
  recentFeedback.set(ip, hits);
  if (recentFeedback.size > 500) for (const [k, v] of recentFeedback) if (!v.some((t) => now - t < FEEDBACK_WINDOW_MS)) recentFeedback.delete(k);
  return hits.length > FEEDBACK_PER_WINDOW;
}

async function feedback(req: VercelRequest, res: VercelResponse, user: string | null) {
  const body = (req.body || {}) as { message?: unknown; email?: unknown; page?: unknown };
  const message = String(body.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Write a message first." });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ error: `Please keep it under ${MAX_MESSAGE} characters.` });

  // An address is required so feedback can be answered — a signed-in sender's
  // account supplies it, anyone else types one.
  const replyTo = user || String(body.email ?? "").trim().slice(0, 200);
  if (!replyTo) return res.status(400).json({ error: "Add your email so I can reply." });
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(replyTo)) return res.status(400).json({ error: "That email address doesn't look right." });
  const page = String(body.page ?? "").trim().slice(0, 300);

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) return res.status(429).json({ error: "That's a lot of requests in one go — try again in a few minutes." });

  if (!emailEnabled()) return res.status(503).json({ error: "This form isn't set up to send right now. Please try again later." });
  const from = replyTo; // always set: an account address, or the one they typed
  const sent = await sendEmail({
    to: FEEDBACK_TO,
    subject: `Buzzpoints feature request from ${from}`,
    html: feedbackBody(from, page, message),
    text: `From: ${from}\nPage: ${page || "—"}\n\n${message}`,
    replyTo,
  });
  if (!sent) return res.status(502).json({ error: "Couldn't send that just now. Please try again later." });
  return res.status(200).json({ ok: true });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const user = currentUser(req);

    if (req.method === "POST") {
      res.setHeader("cache-control", "no-store");
      if (String((req.body as any)?.op || "") === "feedback") return await feedback(req, res, user);
      return res.status(400).json({ error: "Unknown op." });
    }

    const q = String(req.query.q || "").trim();
    if (q) {
      if (q.length < 2) return res.status(200).json({ results: [], total: 0, type: req.query.type === "questions" ? "questions" : "players" });
      const type = req.query.type === "questions" ? "questions" : "players";
      const level = String(req.query.level || "");
      const kindQ = String(req.query.kind || ""), fieldQ = String(req.query.field || "");
      const opts: SearchOpts = {
        level: (TOURNAMENT_LEVELS as readonly string[]).includes(level) ? level : undefined,
        kind: kindQ === "tossup" || kindQ === "bonus" ? kindQ : "all",
        field: fieldQ === "answer" || fieldQ === "text" ? fieldQ : "all",
        cats: String(req.query.cat || "").split(",").map((c) => c.trim()).filter(isCategoryBucket),
        scope: req.query.scope === "all" ? "all" : "public",
      };
      return await search(user, q, type, opts, res);
    }

    const admin = await canModerate(user); // moderators/admins see every listable set
    const idx = await readBlobJson<{ sets: SetEntry[] }>("sets/index.json", false);
    const sets = (idx?.sets ?? [])
      .filter((s) => canList(s, user, admin))
      .map((s) => sanitizeEntry(s, user) as ReturnType<typeof sanitizeEntry> & { forumUnread?: number });
    // How many forum posts this viewer hasn't seen, per set with a discussion
    // they can read — what the badges show. Only such sets are read, and only
    // for a signed-in viewer, so the list stays one file for everyone else.
    if (user)
      await Promise.all(sets.map(async (s) => {
        const full = (idx?.sets ?? []).find((e) => e.slug === s.slug);
        if (!full?.forum || !canViewContent(full, user)) return;
        const data = await readForum(s.slug).catch(() => null);
        if (data) s.forumUnread = unreadFor(data, user);
      }));
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ sets });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
