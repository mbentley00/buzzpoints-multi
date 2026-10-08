import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { refreshIndex, clearSetCache } from "../data";

export function Join() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const key = params.get("key") || "";
  const [state, setState] = useState<"working" | "ok" | "pending" | "error">("working");
  const [msg, setMsg] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (loading || ran.current) return;
    const here = `/join/${slug}?key=${encodeURIComponent(key)}`;
    if (!user) { navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true }); return; }
    ran.current = true;
    if (!key) { setState("error"); setMsg("Missing invite key."); return; }
    fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, op: "join", key }) })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Failed (${r.status})`); return d; })
      .then((d) => {
        // A link that needs the owner's approval: the request is filed, and
        // there's nothing to open yet.
        if (d.pending) { setState("pending"); return; }
        refreshIndex(); clearSetCache(slug); setState("ok"); setTimeout(() => navigate(`/set/${slug}`, { replace: true }), 900); })
      .catch((e) => { setState("error"); setMsg(String((e as Error).message || e)); });
  }, [user, loading, slug, key, navigate]);

  return (
    <div className="app">
      <header className="topbar"><div className="topbar-inner"><Link to="/" className="brand">Buzzpoints</Link></div></header>
      <main className="content">
        <h1>Joining tournament</h1>
        {state === "working" && <p className="loading">Granting you access…</p>}
        {state === "ok" && <p className="caveat"><span className="ok-msg">You're in.</span> Opening the tournament…</p>}
        {state === "pending" && (
          <>
            <p className="caveat">
              <span className="ok-msg">Request sent.</span> This link needs the owner's approval — you'll get an email
              when they let you in.
            </p>
            <p className="muted"><Link to="/" className="link">← All tournaments</Link></p>
          </>
        )}
        {state === "error" && (
          <>
            <div className="error-box">{msg}</div>
            <p className="muted"><Link to="/" className="link">← All tournaments</Link></p>
          </>
        )}
      </main>
    </div>
  );
}
