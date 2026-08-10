import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

// Landing page for the emailed reset link. Setting the password also signs them
// in, so there's no second trip through the login form.
export function ResetPassword() {
  const { resetPassword } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      const next = await resetPassword(token, password);
      setDone(true);
      // Same rule as verification: only same-site paths are honored.
      const to = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      setTimeout(() => navigate(to, { replace: true }), 1200);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar"><div className="topbar-inner"><Link to="/" className="brand">Buzzpoints</Link></div></header>
      <main className="content">
        <h1>Choose a new password</h1>
        {!token ? (
          <>
            <div className="error-box">This link is missing its token.</div>
            <p className="muted"><Link to="/login" className="link">Back to log in</Link> — you can request a new link there.</p>
          </>
        ) : done ? (
          <p className="caveat"><span className="ok-msg">Password changed — you're signed in.</span> Redirecting…</p>
        ) : (
          <form className="create-form" onSubmit={submit} style={{ maxWidth: 380 }}>
            <label className="field">
              <span>New password</span>
              <input type="password" autoComplete="new-password" value={password} placeholder="At least 8 characters" onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>Confirm password</span>
              <input type="password" autoComplete="new-password" value={confirm} placeholder="Type it again" onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {error && <div className="error-box">{error}</div>}
            <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Set password"}</button>
            <p className="muted" style={{ marginTop: 4 }}>
              <Link to="/login" className="link">← Back to log in</Link>
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
