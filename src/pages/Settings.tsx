import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { refreshIndex } from "../data";
import { Visibility } from "../types";
import { Loading } from "../components/Common";
import { RoundTagsEditor } from "../components/RoundTagsEditor";

const VIS_OPTIONS: { id: Visibility; label: string; desc: string }[] = [
  { id: "listed", label: "Listed (login + invite)", desc: "Shown in the list; only invited, logged-in people can view." },
  { id: "private", label: "Private (invite only)", desc: "Hidden from the list; only you and invitees can view." },
  { id: "public", label: "Public (open to all)", desc: "Shown in the list and viewable by anyone." },
];

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}
const toDateInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

export function Settings() {
  const { slug = "" } = useParams();
  const { isOwner, meta } = useSetCtx();
  const [loading, setLoading] = useState(true);
  const [visibility, setVisibility] = useState<Visibility>("listed");
  const [autoPublish, setAutoPublish] = useState(false);
  const [date, setDate] = useState("");
  const [invites, setInvites] = useState<string[]>([]);
  const [newInvite, setNewInvite] = useState("");
  const [accessRequests, setAccessRequests] = useState<{ email: string; name: string; at: string; role?: string; team?: string }[]>([]);
  const [links, setLinks] = useState<{ id: string; label: string; at: string; revoked?: boolean; uses: number }[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOwner) { setLoading(false); return; }
    fetch(`/api/manage?slug=${encodeURIComponent(slug)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed to load settings");
        setVisibility(d.visibility);
        setAutoPublish(!!d.autoPublicAt);
        setDate(toDateInput(d.autoPublicAt) || new Date(Date.now() + 2 * 365 * 864e5).toISOString().slice(0, 10));
        setInvites(d.invites || []);
        setAccessRequests(d.accessRequests || []);
        setLinks(d.links || []);
      })
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [slug, isOwner]);

  if (!isOwner) return <p className="caveat">Only the set owner can change settings.</p>;
  if (loading) return <Loading />;

  async function saveSettings() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const autoPublicAt = visibility === "public" ? null : autoPublish ? new Date(date).toISOString() : null;
      await postJson("/api/manage", { slug, op: "settings", visibility, autoPublicAt });
      refreshIndex();
      setMsg("Settings saved.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function rebuild() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await postJson("/api/manage", { slug, op: "reaggregate" });
      setMsg("Stats rebuilt. Reload the pages to see the latest.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function invite(op: "invite" | "uninvite", email: string) {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const d = await postJson("/api/manage", { slug, op, email });
      setInvites(d.invites || []);
      if (op === "invite") setNewInvite("");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function decide(email: string, approve: boolean) {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const d = await postJson("/api/manage", { slug, op: approve ? "approve-access" : "deny-access", email });
      setAccessRequests(d.accessRequests || accessRequests.filter((a) => a.email !== email));
      if (approve) setInvites((prev) => [...new Set([...prev, email])].sort());
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  const linkUrl = (id: string) => `${window.location.origin}/join/${slug}?key=${id}`;
  async function createLink() {
    setErr(null); setMsg(null); setBusy(true);
    try { const d = await postJson("/api/manage", { slug, op: "create-link" }); setLinks(d.links || []); }
    catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }
  async function revokeLink(id: string) {
    setBusy(true);
    try { const d = await postJson("/api/manage", { slug, op: "revoke-link", id }); setLinks(d.links || []); }
    catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }
  async function copyLink(id: string) {
    try { await navigator.clipboard.writeText(linkUrl(id)); setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); } catch { /* ignore */ }
  }

  const visDesc = VIS_OPTIONS.find((v) => v.id === visibility)?.desc;
  const activeLinks = links.filter((l) => !l.revoked);

  return (
    <div className="detail">
      <h1>Settings</h1>
      {err && <div className="error-box">{err}</div>}
      {msg && <div className="caveat"><span className="ok-msg">{msg}</span></div>}

      <h2>Visibility</h2>
      <div className="create-form" style={{ maxWidth: 520 }}>
        <label className="field">
          <span>Who can see this tournament</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
            {VIS_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <small className="muted">{visDesc}</small>
        </label>

        {visibility !== "public" && (
          <div className="field">
            <label className="field-inline">
              <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
              <span>Automatically make public on</span>
              <input type="date" value={date} disabled={!autoPublish} onChange={(e) => setDate(e.target.value)} />
            </label>
            <small className="muted">
              {autoPublish ? "On this date it becomes public and open to all." : "Off — it stays restricted until you change visibility yourself."}
            </small>
          </div>
        )}
        <button className="btn-primary" disabled={busy} onClick={saveSettings}>Save settings</button>
      </div>

      {meta?.kind !== "results" && (meta?.rounds?.length ?? 0) > 0 && (
        <>
          <h2 style={{ marginTop: 28 }}>Round phases / tags</h2>
          <p className="muted">
            Tag rounds with phases (e.g. Prelims, Playoffs, Finals). Viewers can then filter every page to a phase. A
            round can carry more than one tag.
          </p>
          <RoundTagsEditor slug={slug} rounds={meta!.rounds} />
        </>
      )}

      <h2 style={{ marginTop: 28 }}>Maintenance</h2>
      <p className="muted">Recompute all stats from the uploaded files (use this to pick up new stats pages or fixes).</p>
      <button className="btn-primary" disabled={busy} onClick={rebuild}>Rebuild stats</button>

      {visibility !== "public" && (
        <>
          <h2 style={{ marginTop: 28 }}>Access requests ({accessRequests.length})</h2>
          {accessRequests.length === 0 ? (
            <p className="muted">No pending requests.</p>
          ) : (
            <ul className="invite-list">
              {accessRequests.map((a) => (
                <li key={a.email}>
                  <span>
                    <strong>{a.name}</strong> <span className="muted">· {a.email}</span>
                    {(a.role || a.team) && (
                      <span className="muted"> · {[a.role, a.team].filter(Boolean).join(" — ")}</span>
                    )}
                  </span>
                  <span className="req-actions">
                    <button className="btn-primary btn-sm" disabled={busy} onClick={() => decide(a.email, true)}>Approve</button>
                    <button className="btn-link" disabled={busy} onClick={() => decide(a.email, false)}>Deny</button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ marginTop: 28 }}>Invite links</h2>
          <p className="muted">Anyone with an account who opens an active link gets access to this tournament.</p>
          <button className="btn-primary btn-sm" disabled={busy} onClick={createLink}>Create invite link</button>
          {activeLinks.length > 0 && (
            <ul className="invite-list" style={{ marginTop: 12 }}>
              {activeLinks.map((l) => (
                <li key={l.id}>
                  <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{linkUrl(l.id)}</span>
                  <span className="req-actions">
                    <span className="muted">{l.uses} use{l.uses === 1 ? "" : "s"}</span>
                    <button className="btn-link" onClick={() => copyLink(l.id)}>{copiedId === l.id ? "Copied!" : "Copy"}</button>
                    <button className="btn-link danger" disabled={busy} onClick={() => revokeLink(l.id)}>Revoke</button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ marginTop: 28 }}>Invited people ({invites.length})</h2>
          <p className="muted">Invited accounts can view this tournament and submit correction requests.</p>
          <div className="buzz-edit" style={{ marginBottom: 12 }}>
            <input
              type="email"
              placeholder="person@example.com"
              value={newInvite}
              onChange={(e) => setNewInvite(e.target.value)}
              style={{ padding: "6px 8px", border: "1px solid #cdd5e0", borderRadius: 4, minWidth: 260 }}
            />
            <button className="btn-primary btn-sm" disabled={busy || !newInvite.trim()} onClick={() => invite("invite", newInvite.trim())}>
              Add invite
            </button>
          </div>
          {invites.length === 0 ? (
            <p className="muted">No one invited yet.</p>
          ) : (
            <ul className="invite-list">
              {invites.map((e) => (
                <li key={e}>
                  <span>{e}</span>
                  <button className="btn-link" disabled={busy} onClick={() => invite("uninvite", e)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
