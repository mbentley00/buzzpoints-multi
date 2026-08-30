import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AuthNav, Loading } from "../components/Common";
import { useAuth } from "../auth";

// Your account: the name shown on posts and corrections, and an affiliation
// (school, club, or team).

export function Profile() {
  const { user, name, institution, role, loading, updateProfile } = useAuth();
  const loc = useLocation();
  const [nameDraft, setNameDraft] = useState("");
  const [instDraft, setInstDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setNameDraft(name ?? ""); setInstDraft(institution ?? ""); }, [name, institution]);

  const dirty = nameDraft.trim() !== (name ?? "") || instDraft.trim() !== (institution ?? "");

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Tournaments</Link>
            <Link to="/search" className="nav-link">Search across tournaments</Link>
            <Link to="/new" className="nav-link">+ New tournament</Link>
          </nav>
          <div className="topbar-auth"><AuthNav /></div>
        </div>
      </header>
      <main className="content">
        <h1>Your profile</h1>
        {loading ? <Loading /> : !user ? (
          <p className="caveat">
            <Link to={`/login?next=${encodeURIComponent(loc.pathname)}`} className="link">Log in</Link> to see your profile.
          </p>
        ) : (
          <div className="create-form" style={{ maxWidth: 520 }}>
            <p className="subtitle" style={{ marginTop: 0 }}>
              Signed in as <strong>{user}</strong>{role !== "user" && <> · {role}</>}
            </p>
            <label className="field">
              <span>Name</span>
              <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={80} placeholder="How you're shown on posts and corrections" />
            </label>
            <label className="field">
              <span>Affiliation (optional)</span>
              <input value={instDraft} onChange={(e) => setInstDraft(e.target.value)} maxLength={120} placeholder="School, club, or team" />
              <small className="muted">Shown to tournament owners when you ask for access or to post, so they know who's asking.</small>
            </label>
            <div className="buzz-edit-actions">
              <button className="btn-primary" disabled={busy || !dirty || !nameDraft.trim()} onClick={async () => {
                setBusy(true); setErr(null); setMsg(null);
                try { await updateProfile(nameDraft.trim(), instDraft.trim()); setMsg("Saved."); }
                catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
              }}>{busy ? "Saving…" : "Save"}</button>
              {msg && <span className="ok-msg">{msg}</span>}
              {err && <span className="error-inline">{err}</span>}
            </div>
            <p className="muted" style={{ marginTop: 18 }}>
              Your email address is your login and can't be changed here. To change your password, log out and use{" "}
              <Link className="link" to="/login?mode=forgot">Forgot password</Link>.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
