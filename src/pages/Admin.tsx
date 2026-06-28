import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth, Role } from "../auth";
import { refreshIndex } from "../data";
import { Visibility } from "../types";
import { Loading, AuthNav } from "../components/Common";
import { formatDate } from "../util";

interface AdminSet {
  slug: string; name: string; owner: string | null; scoring: string; hasBonuses: boolean;
  visibility: Visibility; effectiveVisibility: Visibility; autoPublicAt: string | null; inviteCount: number;
  numGames: number; numTeams: number; numPlayers: number; numTossups: number; rounds: number; createdAt: string;
}
interface PendingSub { id: string; by: string; byName: string; name: string; scoring: string; at: string; }
interface UserRow { email: string; name: string; institution: string | null; createdAt: string; role: Role; }

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}

const VIS: Visibility[] = ["listed", "private", "public"];
const ROLES: Role[] = ["user", "moderator", "admin"];

export function Admin() {
  const { user, isAdmin, isModerator, loading: authLoading } = useAuth();
  const [sets, setSets] = useState<AdminSet[] | null>(null);
  const [pending, setPending] = useState<PendingSub[]>([]);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [blocklist, setBlocklist] = useState<string>("");
  const [blocklistDirty, setBlocklistDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const [a, m] = await Promise.all([
        fetch("/api/admin").then((r) => r.json()),
        fetch("/api/moderate").then((r) => r.json()),
      ]);
      if (a.error) throw new Error(a.error);
      setSets(a.sets as AdminSet[]);
      setPending((m.pending as PendingSub[]) ?? []);
      if (m.users) setUsers(m.users as UserRow[]);
      if (m.blocklist && !blocklistDirty) setBlocklist((m.blocklist as string[]).join("\n"));
    } catch (e) { setErr(String((e as Error).message || e)); }
  }
  useEffect(() => { if (isModerator) load(); }, [isModerator]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setErr(null);
    try { await fn(); } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(null); }
  }

  const del = (s: AdminSet) =>
    window.confirm(`Delete "${s.name}" (${s.slug})? This permanently removes all its data.`) &&
    run(s.slug, async () => { await postJson("/api/manage", { slug: s.slug, op: "delete" }); refreshIndex(); await load(); });
  const rebuild = (s: AdminSet) => run(s.slug, () => postJson("/api/manage", { slug: s.slug, op: "reaggregate" }));
  const setVisibility = (s: AdminSet, visibility: Visibility) =>
    run(s.slug, async () => { await postJson("/api/manage", { slug: s.slug, op: "settings", visibility }); refreshIndex(); await load(); });

  const approve = (p: PendingSub) =>
    run(`p:${p.id}`, async () => { await postJson("/api/moderate", { op: "approve-submission", id: p.id }); refreshIndex(); await load(); });
  const reject = (p: PendingSub) => {
    const reason = window.prompt(`Reject "${p.name}" by ${p.by}? Optional reason (emailed to them):`, "");
    if (reason === null) return; // cancelled
    run(`p:${p.id}`, async () => { await postJson("/api/moderate", { op: "reject-submission", id: p.id, reason }); await load(); });
  };

  const changeRole = (u: UserRow, role: Role) =>
    run(`u:${u.email}`, async () => { await postJson("/api/moderate", { op: "set-role", email: u.email, role }); await load(); });
  const deleteAccount = (u: UserRow) =>
    window.confirm(`Delete account ${u.email}? Their tournaments are kept but become unowned.`) &&
    run(`u:${u.email}`, async () => { await postJson("/api/moderate", { op: "delete-account", email: u.email }); await load(); });

  const saveBlocklist = () =>
    run("blocklist", async () => {
      const words = blocklist.split(/[\n,]/).map((w) => w.trim()).filter(Boolean);
      const d = await postJson("/api/moderate", { op: "set-blocklist", words });
      setBlocklist((d.blocklist as string[]).join("\n"));
      setBlocklistDirty(false);
    });

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav"><AuthNav /></nav>
        </div>
      </header>
      <main className="content">
        <div className="breadcrumb"><Link to="/" className="link">← All tournaments</Link></div>
        <h1>{isAdmin ? "Admin" : "Moderation"}</h1>
        {authLoading ? (
          <Loading />
        ) : !isModerator ? (
          <p className="caveat">You don't have moderator access.</p>
        ) : (
          <>
            {err && <div className="error-box">{err}</div>}

            {/* ---- pending first-post submissions ---- */}
            <h2>Pending submissions {pending.length > 0 && <span className="edition-count">{pending.length}</span>}</h2>
            <p className="muted">First tournaments from new accounts. Approving publishes them under the submitter's account.</p>
            {pending.length === 0 ? (
              <p className="muted">Nothing awaiting review.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Tournament</th><th>Submitted by</th><th>Scoring</th><th>When</th><th>Actions</th></tr></thead>
                  <tbody>
                    {pending.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td className="muted">{p.byName}<div className="mono" style={{ fontSize: 12 }}>{p.by}</div></td>
                        <td>{p.scoring}</td>
                        <td className="muted">{formatDate(p.at)}</td>
                        <td className="admin-actions">
                          <button className="btn-link" disabled={busy === `p:${p.id}`} onClick={() => approve(p)}>Approve</button>
                          <button className="btn-link danger" disabled={busy === `p:${p.id}`} onClick={() => reject(p)}>Reject</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ---- tournaments ---- */}
            <h2>Tournaments</h2>
            <p className="muted">Question content stays hidden when you open a non-public set{isAdmin ? " until you reveal it" : ""}.</p>
            {sets === null ? <Loading /> : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tournament</th><th>Owner</th><th>Visibility</th>
                      <th className="right">Games</th><th className="right">Teams</th><th className="right">Players</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sets.map((s) => (
                      <tr key={s.slug}>
                        <td>
                          <Link className="link" to={`/set/${s.slug}`}>{s.name}</Link>
                          <div className="muted mono" style={{ fontSize: 12 }}>{s.slug} · {s.scoring} · {formatDate(s.createdAt)}</div>
                        </td>
                        <td className="muted">{s.owner || "—"}</td>
                        <td>
                          <select value={s.visibility} disabled={busy === s.slug} onChange={(e) => setVisibility(s, e.target.value as Visibility)}>
                            {VIS.map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                          {s.effectiveVisibility !== s.visibility && <span className="muted"> → {s.effectiveVisibility}</span>}
                        </td>
                        <td className="right mono">{s.numGames}</td>
                        <td className="right mono">{s.numTeams}</td>
                        <td className="right mono">{s.numPlayers}</td>
                        <td className="admin-actions">
                          <Link className="link" to={`/set/${s.slug}`}>View</Link>
                          <button className="btn-link" disabled={busy === s.slug} onClick={() => rebuild(s)}>Rebuild</button>
                          <button className="btn-link danger" disabled={busy === s.slug} onClick={() => del(s)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                    {sets.length === 0 && <tr><td colSpan={7} className="muted">No tournaments.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {/* ---- users (admin only) ---- */}
            {isAdmin && (
              <>
                <h2>Users</h2>
                <p className="muted">Grant moderator/admin roles or delete accounts. Built-in admins (set via ADMIN_EMAILS) can't be changed here.</p>
                {users === null ? <Loading /> : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>Email</th><th>Name</th><th>Joined</th><th>Role</th><th>Actions</th></tr></thead>
                      <tbody>
                        {users.map((u) => {
                          const self = u.email === user;
                          return (
                            <tr key={u.email}>
                              <td className="mono">{u.email}</td>
                              <td>{u.name}{u.institution ? <span className="muted"> · {u.institution}</span> : null}</td>
                              <td className="muted">{formatDate(u.createdAt)}</td>
                              <td>
                                <select value={u.role} disabled={busy === `u:${u.email}` || self} onChange={(e) => changeRole(u, e.target.value as Role)}>
                                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                                </select>
                              </td>
                              <td className="admin-actions">
                                <button className="btn-link danger" disabled={busy === `u:${u.email}` || self} onClick={() => deleteAccount(u)}>Delete</button>
                              </td>
                            </tr>
                          );
                        })}
                        {users.length === 0 && <tr><td colSpan={5} className="muted">No accounts.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* ---- blocklist (admin only) ---- */}
                <h2>Name blocklist</h2>
                <p className="muted">One word per line. Tournament names or edition labels containing any of these (whole-word, case-insensitive) are rejected at submission.</p>
                <textarea
                  className="blocklist-input"
                  rows={6}
                  value={blocklist}
                  placeholder="one banned word per line"
                  onChange={(e) => { setBlocklist(e.target.value); setBlocklistDirty(true); }}
                />
                <div>
                  <button className="btn-primary btn-sm" disabled={busy === "blocklist" || !blocklistDirty} onClick={saveBlocklist}>
                    {busy === "blocklist" ? "Saving…" : "Save blocklist"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
