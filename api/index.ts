// Returns the list of tournaments visible to the caller, and (with `?q=`) a
// cross-tournament player/question search scoped to sets the caller can view.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readBlobJson } from "./_lib/blob.js";
import { currentUser, canModerate } from "./_lib/auth.js";
import { SetEntry, canList, canViewContent, sanitizeEntry } from "./_lib/sets.js";
import { sendEmail, emailEnabled, feedbackBody } from "./_lib/email.js";

const stripHtml = (s: string) =>
  (s || "").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").trim();

const MAX_SETS = 80;   // cap how many accessible sets a single query scans
const MAX_RESULTS = 200;

// Cross-tournament search over the sets the caller has *content* access to
// (public, owned, or invited). Reads each set's already-computed players.json /
// tossups.json, so it covers every existing tournament without re-aggregation.
async function search(user: string | null, q: string, type: "players" | "questions", res: VercelResponse) {
  const needle = q.toLowerCase();
  const idx = await readBlobJson<{ sets: SetEntry[] }>("sets/index.json", false);
  const accessible = (idx?.sets ?? []).filter((s) => canViewContent(s, user)).slice(0, MAX_SETS);
  const file = type === "players" ? "players.json" : "tossups.json";

  const results: any[] = [];
  await Promise.all(
    accessible.map(async (s) => {
      const rows = await readBlobJson<any[]>(`sets/${s.slug}/${file}`, true);
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        if (type === "players") {
          if (String(r.name || "").toLowerCase().includes(needle) || String(r.team || "").toLowerCase().includes(needle))
            results.push({ slug: s.slug, setName: s.name, createdAt: s.createdAt ?? null, playerId: r.id, name: r.name, team: r.team, ppg: r.ppg ?? 0, games: r.games ?? 0, pts: r.pts ?? 0 });
        } else {
          const answer = stripHtml(String(r.answer || "")).toLowerCase();
          if (answer.includes(needle) || String(r.category || "").toLowerCase().includes(needle) || String(r.subcategory || "").toLowerCase().includes(needle))
            results.push({ slug: s.slug, setName: s.name, id: r.id, round: r.round, num: r.num, answer: r.answer, category: r.category });
        }
      }
    })
  );

  if (type === "players") {
    // Default order: most recent tournament first (client offers other sorts).
    results.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || (b.ppg || 0) - (a.ppg || 0) || String(a.name).localeCompare(String(b.name)));
    const shown = results.slice(0, MAX_RESULTS);
    // Attach each hit's three best categories (by points earned in that set),
    // reading each matched set's players_detail.json once.
    const slugs = [...new Set(shown.map((r) => r.slug))];
    const detail = new Map<string, Record<string, any>>();
    await Promise.all(
      slugs.map(async (slug) => {
        const d = await readBlobJson<Record<string, any>>(`sets/${slug}/players_detail.json`, true);
        if (d) detail.set(slug, d);
      })
    );
    for (const r of shown) {
      const cats = detail.get(r.slug)?.[r.playerId]?.categories as any[] | undefined;
      r.topCats = Array.isArray(cats)
        ? cats
            .filter((c) => (c.points || 0) > 0)
            .sort((a, b) => (b.points || 0) - (a.points || 0))
            .slice(0, 3)
            .map((c) => ({ category: c.category, points: c.points || 0 }))
        : [];
    }
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ results: shown, total: results.length, type });
  }

  results.sort((a, b) => String(a.setName).localeCompare(String(b.setName)) || a.round - b.round || a.num - b.num);

  res.setHeader("cache-control", "no-store");
  return res.status(200).json({ results: results.slice(0, MAX_RESULTS), total: results.length, type });
}

// ---- site feedback ("Send feedback" in the topbar) ----
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

  const replyTo = user || String(body.email ?? "").trim().slice(0, 200);
  if (replyTo && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(replyTo)) return res.status(400).json({ error: "That email address doesn't look right." });
  const page = String(body.page ?? "").trim().slice(0, 300);

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) return res.status(429).json({ error: "That's a lot of feedback in one go — try again in a few minutes." });

  if (!emailEnabled()) return res.status(503).json({ error: "Feedback isn't set up to send right now. Please try again later." });
  const from = user ? user : replyTo || "someone not signed in";
  const sent = await sendEmail({
    to: FEEDBACK_TO,
    subject: `Buzzpoints feedback from ${from}`,
    html: feedbackBody(from, page, message),
    text: `From: ${from}\nPage: ${page || "—"}\n\n${message}`,
    ...(replyTo ? { replyTo } : {}),
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
      return await search(user, q, type, res);
    }

    const admin = await canModerate(user); // moderators/admins see every listable set
    const idx = await readBlobJson<{ sets: SetEntry[] }>("sets/index.json", false);
    const sets = (idx?.sets ?? [])
      .filter((s) => canList(s, user, admin))
      .map((s) => sanitizeEntry(s, user));
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ sets });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
