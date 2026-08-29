import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { PageHeader, Loading, ErrorBox } from "../components/Common";
import { BBCode } from "../bbcode";
import { ForumStatus, ForumThreadSummary, ForumThreadView } from "../types";

// A set's discussion: threads of posts by approved members. Reading needs a
// login and access to the set; posting needs the owner's approval first. Bodies
// are BBCode, phpBB-style — see src/bbcode.tsx.

async function post(body: Record<string, unknown>) {
  const r = await fetch("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

interface ForumResp {
  enabled: boolean; status: ForumStatus; threads: ForumThreadSummary[]; thread?: ForumThreadView; isOwner: boolean;
}

function useForum(slug: string, threadId: string | undefined, nonce: number) {
  const [data, setData] = useState<ForumResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    fetch(`/api/requests?slug=${encodeURIComponent(slug)}&forum=1${threadId ? `&thread=${encodeURIComponent(threadId)}` : ""}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (!alive) return; if (!ok) throw new Error(d.error || "Failed to load"); setData(d); })
      .catch((e) => { if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, [slug, threadId, nonce]);
  return { data, error };
}

// Ask to post / status line for someone who isn't a member yet.
function JoinBox({ slug, status, onChange }: { slug: string; status: ForumStatus; onChange: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (status === "pending") return <p className="caveat">Your request to post is waiting for the tournament owner. You can read everything in the meantime.</p>;
  return (
    <div className="caveat forum-join">
      <p style={{ margin: 0 }}>
        {status === "declined" ? "The owner declined your earlier request to post. You can ask again." : "You can read this discussion. To post, ask the tournament owner to approve you."}
      </p>
      <div className="field-inline" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who you are (optional)" style={{ minWidth: 260 }} maxLength={300} />
        <button className="btn-primary btn-sm" disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { await post({ slug, action: "forum-join", note: note.trim() || undefined }); onChange(); }
          catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
        }}>{busy ? "Sending…" : "Ask to post"}</button>
        {err && <span className="error-inline">{err}</span>}
      </div>
    </div>
  );
}

function Composer({ label, placeholder, busyLabel, withTitle, onSubmit, onCancel }: {
  label: string; placeholder: string; busyLabel: string; withTitle?: boolean;
  onSubmit: (title: string, body: string) => Promise<void>; onCancel?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const ok = body.trim().length > 0 && (!withTitle || title.trim().length > 0);
  return (
    <div className="forum-composer">
      {withTitle && <input className="forum-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Thread title" maxLength={120} />}
      {preview
        ? <div className="forum-preview"><BBCode src={body} /></div>
        : <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder} rows={6} maxLength={8000} />}
      <div className="forum-composer-foot">
        <small className="muted">BBCode: [b]bold[/b] [i]italic[/i] [quote=name]…[/quote] [url=https://…]link[/url] [code]…[/code] [list][*]item[/list]</small>
        <div className="buzz-edit-actions">
          <button type="button" className="btn-link" onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</button>
          {onCancel && <button type="button" className="btn-link" onClick={onCancel}>Cancel</button>}
          <button className="btn-primary btn-sm" disabled={!ok || busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { await onSubmit(title.trim(), body.trim()); setTitle(""); setBody(""); setPreview(false); }
            catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
          }}>{busy ? busyLabel : label}</button>
        </div>
      </div>
      {err && <span className="error-inline">{err}</span>}
    </div>
  );
}

export function Discussion() {
  const { slug = "", thread: threadId } = useParams();
  const { meta, user, isOwner } = useSetCtx();
  const navigate = useNavigate();
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);
  const { data, error } = useForum(slug, threadId, nonce);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [replying, setReplying] = useState(false);
  const [starting, setStarting] = useState(false);

  if (!user)
    return <p className="caveat">Discussion is for signed-in viewers. <Link className="link" to={`/login?next=${encodeURIComponent(`/set/${slug}/discussion`)}`}>Log in →</Link></p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.enabled) return <p className="caveat">This tournament's owner hasn't turned on discussion.</p>;

  const canPost = data.status === "owner" || data.status === "member";
  const t = data.thread;

  // ---- one thread ----
  if (threadId) {
    if (!t) return <ErrorBox error="Thread not found." />;
    return (
      <div className="forum">
        <div className="breadcrumb"><Link to={`/set/${slug}/discussion`} className="link">← Discussion</Link></div>
        <PageHeader title={t.title} subtitle={`Started by ${t.byName} · ${when(t.at)}${t.locked ? " · locked" : ""}`}>
          {isOwner && (
            <button className="btn-link" onClick={async () => { await post({ slug, action: "forum-lock", thread: t.id, locked: !t.locked }); refresh(); }}>
              {t.locked ? "Unlock thread" : "Lock thread"}
            </button>
          )}
        </PageHeader>
        <div className="forum-posts">
          {t.posts.map((p, i) => (
            <article key={p.id} className={"forum-post" + (p.deleted ? " deleted" : "")} id={`post-${p.id}`}>
              <header className="forum-post-head">
                <strong>{p.byName}</strong>
                {isOwner && p.by && <span className="muted"> · {p.by}</span>}
                <span className="muted"> · {when(p.at)}</span>
                {p.editedAt && <span className="muted" title={when(p.editedAt)}> · edited</span>}
                <span className="forum-post-num muted">#{i + 1}</span>
              </header>
              {p.deleted ? (
                <p className="muted"><em>This post was removed.</em></p>
              ) : editing === p.id ? (
                <div className="forum-composer">
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={6} maxLength={8000} />
                  <div className="buzz-edit-actions">
                    <button className="btn-primary btn-sm" disabled={!editBody.trim()} onClick={async () => { await post({ slug, action: "forum-edit", thread: t.id, post: p.id, body: editBody.trim() }); setEditing(null); refresh(); }}>Save</button>
                    <button className="btn-link" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <BBCode src={p.body} />
              )}
              {!p.deleted && editing !== p.id && (p.mine || isOwner) && (
                <footer className="forum-post-actions">
                  {p.mine && !t.locked && <button className="btn-link" onClick={() => { setEditing(p.id); setEditBody(p.body); }}>Edit</button>}
                  {canPost && !t.locked && <button className="btn-link" onClick={() => { setReplying(true); setEditBody(""); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }}>Reply</button>}
                  <button className="btn-link" onClick={async () => { if (!window.confirm("Remove this post?")) return; await post({ slug, action: "forum-delete", thread: t.id, post: p.id }); refresh(); }}>Remove</button>
                </footer>
              )}
            </article>
          ))}
        </div>
        {t.locked ? (
          <p className="caveat">This thread is locked.</p>
        ) : !canPost ? (
          <JoinBox slug={slug} status={data.status} onChange={refresh} />
        ) : replying ? (
          <Composer label="Post reply" busyLabel="Posting…" placeholder="Your reply…" onCancel={() => setReplying(false)}
            onSubmit={async (_, body) => { await post({ slug, action: "forum-reply", thread: t.id, body }); setReplying(false); refresh(); }} />
        ) : (
          <button className="btn-primary" onClick={() => setReplying(true)}>Reply</button>
        )}
      </div>
    );
  }

  // ---- thread list ----
  return (
    <div className="forum">
      <PageHeader title="Discussion" subtitle={`${data.threads.length} thread${data.threads.length === 1 ? "" : "s"} about ${meta.setName}`}>
        {canPost && !starting && <button className="btn-primary" onClick={() => setStarting(true)}>New thread</button>}
      </PageHeader>
      {starting && (
        <Composer label="Start thread" busyLabel="Posting…" placeholder="What's on your mind about this tournament?" withTitle onCancel={() => setStarting(false)}
          onSubmit={async (title, body) => { const d = await post({ slug, action: "forum-thread", title, body }); setStarting(false); navigate(`/set/${slug}/discussion/${d.id}`); }} />
      )}
      {!canPost && <JoinBox slug={slug} status={data.status} onChange={refresh} />}
      {data.threads.length === 0 ? (
        <p className="empty">No threads yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table forum-list">
            <thead><tr><th>Thread</th><th>Started</th><th className="right">Posts</th><th>Last post</th></tr></thead>
            <tbody>
              {data.threads.map((th) => (
                <tr key={th.id}>
                  <td><Link className="link" to={`/set/${slug}/discussion/${th.id}`}>{th.title}</Link>{th.locked && <span className="set-row-level" style={{ marginLeft: 6 }}>locked</span>}</td>
                  <td>{th.byName} <span className="muted">· {when(th.at)}</span></td>
                  <td className="right mono">{th.postCount}</td>
                  <td>{th.lastByName} <span className="muted">· {when(th.lastAt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
