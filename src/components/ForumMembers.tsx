import { useEffect, useState } from "react";
import { ForumStatus } from "../types";

// Settings → Discussion: who may post. Owners approve or decline requests to
// post, can revoke a member, and can download the discussion in phpBB shape.

async function post(body: Record<string, unknown>) {
  const r = await fetch("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}

interface Resp { enabled: boolean; status: ForumStatus; members?: string[]; pending?: { email: string; name: string; at: string; note?: string }[]; threads: unknown[] }

export function ForumMembers({ slug, enabled }: { slug: string; enabled: boolean }) {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);
  useEffect(() => {
    let alive = true;
    fetch(`/api/requests?slug=${encodeURIComponent(slug)}&forum=1`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (!alive) return; if (!ok) throw new Error(d.error || "Failed"); setData(d); })
      .catch((e) => { if (alive) setErr(String(e.message || e)); });
    return () => { alive = false; };
  }, [slug, nonce, enabled]);
  const act = async (body: Record<string, unknown>) => {
    setErr(null);
    try { await post({ slug, ...body }); refresh(); } catch (e) { setErr(String((e as Error).message || e)); }
  };
  if (!data) return err ? <span className="error-inline">{err}</span> : null;
  const pending = data.pending ?? [];
  const members = data.members ?? [];
  return (
    <div style={{ marginTop: 12 }}>
      {pending.length > 0 && (
        <>
          <h3 className="settings-sub">Waiting to post ({pending.length})</h3>
          <ul className="invite-list">
            {pending.map((p) => (
              <li key={p.email}>
                <span><strong>{p.name}</strong> <span className="muted">· {p.email}{p.note ? ` — ${p.note}` : ""}</span></span>
                <span>
                  <button className="btn-link" onClick={() => act({ action: "forum-approve", email: p.email })}>Approve</button>
                  {" · "}
                  <button className="btn-link" onClick={() => act({ action: "forum-decline", email: p.email })}>Decline</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="settings-sub">Approved to post ({members.length})</h3>
      {members.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>Nobody yet besides the owners. People who ask to post will appear above.</p>
      ) : (
        <ul className="invite-list">
          {members.map((m) => (
            <li key={m}><span>{m}</span><button className="btn-link" onClick={() => act({ action: "forum-revoke", email: m })}>Revoke</button></li>
          ))}
        </ul>
      )}
      <p style={{ marginTop: 12 }}>
        <a className="link" href={`/api/requests?slug=${encodeURIComponent(slug)}&forum=1&export=phpbb`} target="_blank" rel="noreferrer">Download discussion (phpBB-shaped JSON)</a>
        <span className="muted"> — {String(data.threads?.length ?? 0)} thread{(data.threads?.length ?? 0) === 1 ? "" : "s"}; bodies are BBCode, ready for a phpBB import.</span>
      </p>
      {err && <span className="error-inline">{err}</span>}
    </div>
  );
}
