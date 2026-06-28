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

// Map the current scope to a data path. "all" = combined (top level); an edition
// id = editions/<id>/; "tag:<slug>" = a round-tag phase under tags/<slug>/.
export function scopedPath(scope: string, file: string): string {
  if (!scope || scope === "all") return file;
  if (scope.startsWith("tag:")) return `tags/${scope.slice(4)}/${file}`;
  return `editions/${scope}/${file}`;
}

// Load a per-set data file scoped to the currently-selected edition/phase.
export function useScopedJson<T>(file: string, nonce = 0) {
  const { slug, scope } = useOutletContext<SetCtx>();
  return useSetJson<T>(slug, scopedPath(scope, file), nonce);
}

export function SetLayout() {
  const { slug = "" } = useParams();
  const loc = useLocation();
  const { data: index } = useIndex();
  const { user, isAdmin, loading: authLoading } = useAuth();

  const entry = index?.sets.find((s) => s.slug === slug);
  const [scope, setScope] = useState("all");
  const { data: meta, error, loading } = useSetJson<Meta>(slug, scopedPath(scope, "meta.json"));

  const owner = entry?.owner ?? null;
  const isOwner = !!user && !!owner && user === owner;
  const editions = entry?.editions ?? meta?.editions ?? [];
  const hasEditions = editions.length > 1;
  const tags = entry?.tags ?? [];
  const hasScopes = hasEditions || tags.length > 0;
  const ctx: SetCtx = { meta: meta as Meta, slug, scope, editions, owner, isOwner, user };
  const denied = !!error && /\b(401|403)\b/.test(error);
  const [reqState, setReqState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [reqMsg, setReqMsg] = useState("");
  const [reqRole, setReqRole] = useState("");
  const [reqTeam, setReqTeam] = useState("");
  async function requestAccess() {
    if (!reqRole || !reqTeam.trim()) {
      setReqState("error"); setReqMsg("Select your role and enter the team you were affiliated with.");
      return;
    }
    setReqState("sending"); setReqMsg("");
    try {
      const r = await fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, op: "request-access", role: reqRole, team: reqTeam.trim() }) });
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
  const isResults = meta?.kind === "results";
  // Results (YellowFruit) tournaments have only box-score stats — the set name
  // links to Standings; buzz/question tabs don't apply.
  const tabs = isResults
    ? [
        { to: `${base}/players`, label: "Players" },
        { to: `${base}/games`, label: "Games" },
        ...(isOwner ? [{ to: `${base}/settings`, label: "Settings" }] : []),
      ]
    : [
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
        ...(isOwner ? [{ to: `${base}/requests`, label: "Corrections" }] : []),
        ...(isOwner ? [{ to: `${base}/settings`, label: "Settings" }] : []),
      ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" title="All tournaments">
            Buzzpoints
          </Link>
          {meta?.setName && (
            <NavLink to={base} end className={({ isActive }) => "brand-set" + (isActive ? " active" : "")} title={meta.setName}>
              {meta.setName}
            </NavLink>
          )}
          <div className="topbar-auth"><AuthNav /></div>
          <nav className="nav nav-tabs">
            {meta &&
              tabs.map((t) => (
                <NavLink key={t.to} to={t.to} className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}>
                  {t.label}
                </NavLink>
              ))}
          </nav>
        </div>
      </header>
      {hasScopes && (
        <div className="editions-bar">
          <span className="muted">Showing</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">{hasEditions ? "All editions (combined)" : "All rounds"}</option>
            {hasEditions && (
              <optgroup label="Editions">
                {editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </optgroup>
            )}
            {tags.length > 0 && (
              <optgroup label="Phases">
                {tags.map((t) => <option key={t.slug} value={`tag:${t.slug}`}>{t.name} ({t.rounds.length} rd{t.rounds.length === 1 ? "" : "s"})</option>)}
              </optgroup>
            )}
          </select>
          {scope !== "all" && <span className="muted">· <button className="btn-link" onClick={() => setScope("all")}>show all</button></span>}
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
                  <div>Your account hasn't been invited to view it. To request access, tell the owner how you were affiliated with this tournament.</div>
                  <div className="request-form">
                    <label className="field">
                      <span>Your role</span>
                      <select value={reqRole} onChange={(e) => setReqRole(e.target.value)}>
                        <option value="">Select a role…</option>
                        <option value="player">Player</option>
                        <option value="staff">Staff</option>
                        <option value="coach">Coach</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Team you were affiliated with</span>
                      <input type="text" value={reqTeam} placeholder="e.g. Lincoln High School A" onChange={(e) => setReqTeam(e.target.value)} />
                    </label>
                    <button className="btn-primary btn-sm" disabled={reqState === "sending"} onClick={requestAccess}>
                      {reqState === "sending" ? "Sending…" : "Request access"}
                    </button>
                  </div>
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
