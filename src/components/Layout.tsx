import { useState } from "react";
import { NavLink, Link, Outlet, useParams, useLocation, useOutletContext } from "react-router-dom";
import { useSetJson, useIndex, isRevealed, setRevealed, clearSetCache } from "../data";
import { Meta, SetCtx } from "../types";
import { useAuth } from "../auth";
import { Loading, ErrorBox, AuthNav } from "./Common";

// Child pages read the set context (meta + ownership + scope) through this hook.
export function useSetCtx(): SetCtx {
  return useOutletContext<SetCtx>();
}

// Load a per-set data file scoped to the currently-selected edition ("all" =
// combined, served from the top level; a specific edition from editions/<id>/).
export function useScopedJson<T>(file: string, nonce = 0) {
  const { slug, scope } = useOutletContext<SetCtx>();
  const path = scope && scope !== "all" ? `editions/${scope}/${file}` : file;
  return useSetJson<T>(slug, path, nonce);
}

export function SetLayout() {
  const { slug = "" } = useParams();
  const loc = useLocation();
  const { data: index } = useIndex();
  const { user, isAdmin, loading: authLoading } = useAuth();

  const entry = index?.sets.find((s) => s.slug === slug);
  const [scope, setScope] = useState("all");
  const scopePath = (f: string) => (scope !== "all" ? `editions/${scope}/${f}` : f);
  const { data: meta, error, loading } = useSetJson<Meta>(slug, scopePath("meta.json"));

  const owner = entry?.owner ?? null;
  const isOwner = !!user && !!owner && user === owner;
  const editions = entry?.editions ?? meta?.editions ?? [];
  const hasEditions = editions.length > 1;
  const ctx: SetCtx = { meta: meta as Meta, slug, scope, editions, owner, isOwner, user };
  const denied = !!error && /\b(401|403)\b/.test(error);
  const [reqState, setReqState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [reqMsg, setReqMsg] = useState("");
  async function requestAccess() {
    setReqState("sending"); setReqMsg("");
    try {
      const r = await fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, op: "request-access" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      setReqState("sent");
    } catch (e) { setReqState("error"); setReqMsg(String((e as Error).message || e)); }
  }

  // An admin viewing a non-public set they don't own sees redacted question
  // content until they explicitly reveal it (recorded server-side).
  const redactedForAdmin = isAdmin && !isOwner && !!entry && entry.visibility !== "public" && !isRevealed(slug);
  const reveal = () => {
    if (window.confirm("Reveal the hidden question content for this private tournament? This access is recorded.")) {
      setRevealed(slug);
      clearSetCache(slug);
      window.location.reload();
    }
  };

  const base = `/set/${slug}`;
  const tabs = [
    { to: base, label: "Overview", end: true },
    { to: `${base}/tossup`, label: "Tossups" },
    ...(meta?.hasBonuses ? [{ to: `${base}/bonus`, label: "Bonuses" }] : []),
    { to: `${base}/packet`, label: "Packets" },
    { to: `${base}/buzzer-races`, label: "Buzzer Races" },
    { to: `${base}/first-sentence`, label: "First Sentence" },
    { to: `${base}/player`, label: "Players" },
    { to: `${base}/team`, label: "Teams" },
    { to: `${base}/category/tossup`, label: "Categories (Tossup)" },
    ...(meta?.hasBonuses ? [{ to: `${base}/category/bonus`, label: "Categories (Bonus)" }] : []),
    ...(hasEditions || isOwner ? [{ to: `${base}/editions`, label: "Editions" }] : []),
    ...(isOwner ? [{ to: `${base}/requests`, label: "Requests" }] : []),
    ...(isOwner ? [{ to: `${base}/settings`, label: "Settings" }] : []),
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" title="All tournaments">
            Buzzpoints
          </Link>
          {meta?.setName && <span className="brand-set" title={meta.setName}>{meta.setName}</span>}
          <nav className="nav">
            {meta &&
              tabs.map((t) => (
                <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}>
                  {t.label}
                </NavLink>
              ))}
            <AuthNav />
          </nav>
        </div>
      </header>
      {hasEditions && (
        <div className="editions-bar">
          <span className="muted">Showing</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All editions (combined)</option>
            {editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          {scope !== "all" && <span className="muted">· filtered to one edition · <button className="btn-link" onClick={() => setScope("all")}>show combined</button></span>}
        </div>
      )}
      <main className="content">
        {redactedForAdmin && (
          <div className="caveat admin-reveal">
            <span><strong>Admin view.</strong> Question content is hidden for this {entry?.visibility} tournament. Stats are shown; answers and question text are masked.</span>
            <button className="btn-primary btn-sm" onClick={reveal}>Reveal content</button>
          </div>
        )}
        {loading && <Loading />}
        {denied && !authLoading && (
          <div className="caveat">
            <strong>This tournament is private.</strong>{" "}
            {user ? (
              reqState === "sent" ? (
                <span className="ok-msg">Access request sent — the owner will review it.</span>
              ) : (
                <>
                  Your account hasn't been invited to view it.{" "}
                  <button className="btn-link" disabled={reqState === "sending"} onClick={requestAccess}>
                    {reqState === "sending" ? "Sending…" : "Request access"}
                  </button>
                  {reqState === "error" && <span className="error-inline"> {reqMsg}</span>}
                </>
              )
            ) : (
              <>You need to <Link to={`/login?next=${encodeURIComponent(loc.pathname)}`} className="link">log in</Link> (and be invited) to view it.</>
            )}
          </div>
        )}
        {error && !denied && <ErrorBox error={error} />}
        {meta && <Outlet context={ctx} />}
      </main>
      <footer className="footer">
        <Link to="/" className="link">
          ← All tournaments
        </Link>
        {meta && <span> · {meta.scoringLabel}</span>}
      </footer>
    </div>
  );
}
