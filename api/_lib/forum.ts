// Per-set discussion: threads of posts by approved members, off unless the
// owner turns it on (SetEntry.forum). Lives in one `_forum.json` per set —
// underscore-prefixed, so /api/data never serves it: it holds members' emails.
//
// phpBB compatibility. The plan is for these discussions to sync to a phpBB
// forum one day, so the storage is shaped to make that a translation rather
// than a rewrite:
//  - post bodies are BBCode, phpBB's own markup ([b], [i], [u], [url], [quote],
//    [code], [list]) — the client renders a strict whitelist of it; nothing is
//    stored as HTML;
//  - every thread and post has the fields a phpBB topic / post row wants
//    (subject, text, poster name, and a Unix-seconds time), see toPhpbb();
//  - each carries an empty `phpbb` slot for the ids a sync would assign
//    (forum_id / topic_id / post_id), so a second sync can match rows it made.
import { put } from "@vercel/blob";
import { readBlobJson } from "./blob.js";

export const FORUM_FILE = "_forum.json";
export const MAX_TITLE = 120;
export const MAX_BODY = 8000;
export const MAX_NOTE = 300;

export interface ForumPost {
  id: string;
  by: string;        // email — never sent to non-owners (see viewOf)
  byName: string;    // display name at posting time
  at: string;        // ISO
  body: string;      // BBCode
  editedAt?: string;
  // A deleted post keeps its slot (phpBB does the same: the reply chain stays
  // readable) but loses its text.
  deleted?: boolean;
  phpbb?: { postId?: number };
}
export interface ForumThread {
  id: string;
  title: string;
  by: string;
  byName: string;
  at: string;
  updatedAt: string;
  locked?: boolean;
  posts: ForumPost[];
  phpbb?: { forumId?: number; topicId?: number };
}
export interface ForumJoinRequest { email: string; name: string; at: string; note?: string }
export interface ForumData {
  members: string[];              // approved to post (owners are implicit)
  pending: ForumJoinRequest[];    // asked, not yet decided
  declined: string[];             // asked and turned down (may ask again)
  // Threads each address has asked not to be emailed about.
  muted: Record<string, string[]>;
  threads: ForumThread[];
}

const empty = (): ForumData => ({ members: [], pending: [], declined: [], muted: {}, threads: [] });

export async function readForum(slug: string): Promise<ForumData> {
  const d = await readBlobJson<Partial<ForumData>>(`sets/${slug}/${FORUM_FILE}`, false);
  return { ...empty(), ...(d || {}) };
}
export async function writeForum(slug: string, data: ForumData) {
  await put(`sets/${slug}/${FORUM_FILE}`, JSON.stringify(data), {
    access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
  });
}

// Everyone who has written in a thread and would want to hear about a reply:
// the starter and every poster, minus whoever is writing now and anyone who
// muted the thread.
export function participants(t: ForumThread, data: ForumData, except: string): string[] {
  const all = new Set<string>([t.by, ...t.posts.filter((p) => !p.deleted).map((p) => p.by)]);
  all.delete(except);
  return [...all].filter((e) => !(data.muted[e] || []).includes(t.id));
}

// The bare text of a BBCode body, for email previews and subjects.
export const plainText = (bb: string) =>
  bb.replace(/\[quote[^\]]*\][\s\S]*?\[\/quote\]/gi, " ").replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();

// What a viewer gets to see. Emails stay with owners; everyone else gets names
// and a `mine` flag on what they wrote.
export function threadView(t: ForumThread, user: string, isOwner: boolean) {
  const post = (p: ForumPost) => ({
    id: p.id, byName: p.byName, at: p.at, body: p.deleted ? "" : p.body,
    ...(p.editedAt ? { editedAt: p.editedAt } : {}), ...(p.deleted ? { deleted: true } : {}),
    mine: p.by === user, ...(isOwner ? { by: p.by } : {}),
  });
  return {
    id: t.id, title: t.title, byName: t.byName, at: t.at, updatedAt: t.updatedAt, locked: !!t.locked,
    mine: t.by === user, ...(isOwner ? { by: t.by } : {}),
    postCount: t.posts.filter((p) => !p.deleted).length,
    posts: t.posts.map(post),
  };
}
export function threadSummary(t: ForumThread, user: string, isOwner: boolean) {
  const last = [...t.posts].reverse().find((p) => !p.deleted);
  return {
    id: t.id, title: t.title, byName: t.byName, at: t.at, updatedAt: t.updatedAt, locked: !!t.locked,
    mine: t.by === user, ...(isOwner ? { by: t.by } : {}),
    postCount: t.posts.filter((p) => !p.deleted).length,
    lastByName: last?.byName ?? t.byName, lastAt: last?.at ?? t.at,
  };
}

// The discussion in the shape a phpBB import wants: one topic per thread, one
// post per post, times in Unix seconds, text as BBCode. The first post of a
// topic is the thread's opening post (phpBB has no separate "topic body").
export function toPhpbb(slug: string, setName: string, data: ForumData) {
  const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  return {
    format: "buzzpoints-phpbb-export", version: 1, exportedAt: new Date().toISOString(),
    forum: { buzzpoints_slug: slug, forum_name: setName, forum_id: data.threads[0]?.phpbb?.forumId ?? null },
    topics: data.threads.map((t) => ({
      buzzpoints_id: t.id, topic_id: t.phpbb?.topicId ?? null,
      topic_title: t.title, topic_poster_email: t.by, topic_poster_name: t.byName,
      topic_time: unix(t.at), topic_last_post_time: unix(t.updatedAt), topic_status: t.locked ? 1 : 0,
      posts: t.posts.map((p, i) => ({
        buzzpoints_id: p.id, post_id: p.phpbb?.postId ?? null,
        poster_email: p.by, poster_name: p.byName, post_time: unix(p.at),
        post_subject: i === 0 ? t.title : `Re: ${t.title}`,
        post_text: p.deleted ? "" : p.body, post_edit_time: p.editedAt ? unix(p.editedAt) : 0,
        post_visibility: p.deleted ? 2 : 1, // phpBB: 1 approved, 2 soft-deleted
      })),
    })),
  };
}
