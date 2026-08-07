import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

export function Verify() {
  const { verify } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [msg, setMsg] = useState("");
  const [dest, setDest] = useState("/");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setState("error"); setMsg("Missing verification token."); return; }
    verify(token)
      .then((next) => {
        // Resume whatever they were doing before signing up — normally the
        // invite link they clicked. Only same-site paths are honored; the
        // server signs `next` into the token, and this re-checks it.
        const to = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
        setState("ok");
        setDest(to);
        setTimeout(() => navigate(to, { replace: true }), 1200);
      })
      .catch((e) => { setState("error"); setMsg(String((e as Error).message || e)); });
  }, [token, verify, navigate]);

  return (
    <div className="app">
      <header className="topbar"><div className="topbar-inner"><Link to="/" className="brand">Buzzpoints</Link></div></header>
      <main className="content">
        <h1>Email verification</h1>
        {state === "working" && <p className="loading">Verifying…</p>}
        {state === "ok" && (
          <p className="caveat">
            <span className="ok-msg">Verified — you're signed in.</span>{" "}
            {dest.startsWith("/join/") ? "Opening the tournament you were invited to…" : "Redirecting…"}
          </p>
        )}
        {state === "error" && (
          <>
            <div className="error-box">{msg}</div>
            <p className="muted"><Link to="/login" className="link">Back to log in</Link> (you can resend the link there).</p>
          </>
        )}
      </main>
    </div>
  );
}
