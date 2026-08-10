import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

export function Login() {
  const { login, signup, resendVerification, forgotPassword, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";

  const [mode, setMode] = useState<"login" | "signup" | "forgot">(params.get("mode") === "signup" ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [institution, setInstitution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // verification screen state
  const [pending, setPending] = useState<{ email: string; devUrl?: string; delivered?: boolean } | null>(null);
  const [resent, setResent] = useState<string | null>(null);
  // "we've sent a reset link" screen
  const [sentReset, setSentReset] = useState<{ email: string; devUrl?: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "signup" && fullName.trim().length < 2) return setError("Enter your real name.");
    setBusy(true);
    try {
      if (mode === "forgot") {
        const r = await forgotPassword(email.trim(), next);
        setSentReset({ email: email.trim(), devUrl: r.devUrl });
      } else if (mode === "signup") {
        // Pass `next` along: the verification email carries it, so finishing
        // signup drops them back where they were headed (usually an invite link)
        // instead of on the tournament list.
        const r = await signup(email.trim(), password, fullName.trim(), institution.trim() || undefined, next);
        setPending({ email: email.trim(), devUrl: r.devUrl, delivered: r.delivered });
      } else {
        await login(email.trim(), password, next);
        navigate(next, { replace: true });
      }
    } catch (err) {
      const e2 = err as Error & { needsVerification?: boolean; devUrl?: string };
      // Logging in unverified re-sends the link server-side (carrying `next`).
      if (e2.needsVerification) setPending({ email: email.trim(), devUrl: e2.devUrl });
      else setError(String(e2.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResent(null);
    try { const r = await resendVerification(pending!.email, next); setResent(r.devUrl ? `dev:${r.devUrl}` : "sent"); }
    catch (e) { setError(String((e as Error).message || e)); }
  }

  if (sentReset) {
    return (
      <div className="app">
        <header className="topbar"><div className="topbar-inner"><Link to="/" className="brand">Buzzpoints</Link></div></header>
        <main className="content">
          <h1>Check your email</h1>
          <p>
            If an account exists for <strong>{sentReset.email}</strong>, a link to choose a new password is on its way.
            It expires in an hour.
          </p>
          {sentReset.devUrl && (
            <div className="caveat">
              Email delivery isn't configured yet, so here's your link directly:{" "}
              <a className="link" href={sentReset.devUrl}>Reset password →</a>
            </div>
          )}
          <p className="muted">
            <Link to="/login" className="link" onClick={() => { setSentReset(null); setMode("login"); }}>← Back to log in</Link>
          </p>
        </main>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="app">
        <header className="topbar"><div className="topbar-inner"><Link to="/" className="brand">Buzzpoints</Link></div></header>
        <main className="content">
          <h1>Verify your email</h1>
          <p>We sent a verification link to <strong>{pending.email}</strong>. Click it to finish and sign in.</p>
          {pending.devUrl && (
            <div className="caveat">
              Email delivery isn't configured yet, so here's your link directly:{" "}
              <a className="link" href={pending.devUrl}>Verify now →</a>
            </div>
          )}
          <p className="muted">
            Didn't get it? <button className="btn-link" onClick={resend}>Resend</button>
            {resent === "sent" && " — sent."}
            {resent && resent.startsWith("dev:") && <> — <a className="link" href={resent.slice(4)}>verify link</a></>}
          </p>
          {error && <div className="error-box">{error}</div>}
          <p className="muted"><Link to="/login" className="link" onClick={() => setPending(null)}>← Back to log in</Link></p>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
        </div>
      </header>
      <main className="content">
        <div className="breadcrumb">
          <Link to="/" className="link">← All tournaments</Link>
        </div>
        <h1>{mode === "signup" ? "Create an account" : mode === "forgot" ? "Reset your password" : "Log in"}</h1>
        {user ? (
          <p className="caveat">
            You are signed in as <strong>{user}</strong>. <Link to={next} className="link">Continue →</Link>
          </p>
        ) : (
          <form className="create-form" onSubmit={submit} style={{ maxWidth: 380 }}>
            {mode === "forgot" && (
              <p className="muted" style={{ margin: 0 }}>Enter your email and we'll send you a link to choose a new one.</p>
            )}
            {mode === "signup" && (
              <>
                <label className="field">
                  <span>Full name</span>
                  <input autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jordan Smith" />
                </label>
                <label className="field">
                  <span>Institution <span className="muted">(optional)</span></span>
                  <input autoComplete="organization" value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="School or club" />
                </label>
              </>
            )}
            <label className="field">
              <span>Email</span>
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {mode !== "forgot" && (
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
                />
              </label>
            )}
            {mode === "login" && (
              <p className="muted" style={{ margin: "-4px 0 0" }}>
                <button type="button" className="btn-link" onClick={() => { setMode("forgot"); setError(null); }}>
                  Forgot your password?
                </button>
              </p>
            )}
            {error && <div className="error-box">{error}</div>}
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? "Working…" : mode === "signup" ? "Sign up" : mode === "forgot" ? "Send reset link" : "Log in"}
            </button>
            <p className="muted" style={{ marginTop: 4 }}>
              {mode === "signup" ? "Already have an account? " : mode === "forgot" ? "Remembered it? " : "Need an account? "}
              <button
                type="button"
                className="btn-link"
                onClick={() => { setMode(mode === "signup" ? "login" : mode === "forgot" ? "login" : "signup"); setError(null); }}
              >
                {mode === "signup" || mode === "forgot" ? "Log in" : "Sign up"}
              </button>
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
