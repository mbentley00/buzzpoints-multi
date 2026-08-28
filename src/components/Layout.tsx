import { useState } from "react";
import { NavLink, Link, Outlet, useParams, useLocation, useOutletContext } from "react-router-dom";
import { useSetJson, useIndex, isRevealed, setRevealed, clearSetCache, isContentRedacted, useSetEpoch } from "../data";
import { Meta, SetCtx } from "../types";
import { useAuth } from "../auth";
import { Loading, ErrorBox, AuthNav } from "./Common";
import { warningText } from "./SourceFiles";
import { byLabel } from "../util";

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
  // Refetch after a repair. The warning banners below are read from this meta,
  // and this layout outlives every page under it, so without following the
  // cache epoch an owner who had just fixed the thing a banner was complaining
  // about went on being told to fix it until they reloaded the page.
  const epoch = useSetEpoch();
  const { data: meta, error, loading } = useSetJson<Meta>(slug, scopedPath(scope, "meta.json"), epoch);

  const owner = entry?.owner ?? null;
  // Co-owners manage the set alongside its creator, so every owner-gated tab and
  // control treats them the same. `coOwners` only comes back to owners.
  const isOwner = !!user && (user === owner || (entry?.coOwners ?? []).includes(user));
  const editions = entry?.editions ?? meta?.editions ?? [];
  const hasEditions = editions.length > 1;
  const tags = entry?.tags ?? [];
  const hasScopes = hasEditions || tags.length > 0;
  // The owner can close the correction queue; absent on older index entries,
  // which means it was never closed.
  const allowRequests = entry?.allowRequests !== false;
  const ctx: SetCtx = { meta: meta as Meta, slug, scope, editions, owner, isOwner, user, allowRequests, level: entry?.level, tdLink: entry?.tdLink, difficulty: entry?.difficulty };
  // A player's or a team's id is assigned per aggregation scope: ids are handed
  // out in name order over whoever appears in THAT scope, so p25 in the combined
  // file and p25 in one edition's file are simply different people (checked on a
  // real set: of one edition's 22 team ids, not one referred to the same team as
  // the combined file, and the team being viewed wasn't in that edition at all).
  // Switching scope on one of these pages therefore can't filter it — it silently
  // swaps in somebody else, or 404s. So don't offer it: the page keeps whichever
  // scope it was opened from, and names the editions involved on the page itself.
  const idScopedPage = /\/(player|team)\/[^/]+$/.test(loc.pathname);
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

  // Say content is hidden only when the server actually hid it. Every earlier
  // version of this re-derived the answer on the client — from visibility and
  // ownership, then from the index's hasAccess — and a derived answer can
  // disagree with the bytes on screen: join a set and the index snapshot behind
  // the notice still says you're an outsider. /api/data now reports what it did,
  // so this reads the fact instead of predicting it. Gated on `meta` because
  // that report only exists once a response has come back.
  const redactedForAdmin = isAdmin && !!meta && isContentRedacted(slug) && !isRevealed(slug);
  const reveal = () => {
    if (window.confirm("Reveal the hidden question content for this private tournament? This access is recorded.")) {
      setRevealed(slug);
      clearSetCache(slug);
      window.location.reload();
    }
  };

  const base = `/set/${slug}`;
  const tabs = [
    { to: `${base}/tossup`, label: "Tossups" },
    ...(meta?.hasBonuses ? [{ to: `${base}/bonus`, label: "Bonuses" }] : []),
    { to: `${base}/packet`, label: "Packets" },
    { to: `${base}/buzzer-races`, label: "Buzzer Races" },
    { to: `${base}/first-sentence`, label: "First Sentence" },
    { to: `${base}/player`, label: "Players" },
    // A shootout's "teams" are its players — one page for them is enough.
    ...(meta?.individual ? [] : [{ to: `${base}/team`, label: "Teams" }]),
    { to: `${base}/standard`, label: "Standard Stats" },
    { to: `${base}/category/tossup`, label: "Categories (Tossup)" },
    ...(meta?.hasBonuses ? [{ to: `${base}/category/bonus`, label: "Categories (Bonus)" }] : []),
    // Only worth a tab once the owner has marked a metadata field as a tag.
    ...(meta?.hasTags ? [{ to: `${base}/tags`, label: "Tags" }] : []),
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
          <Link to="/search" className="nav-link topbar-search">Search across tournaments</Link>
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
      {hasScopes && !idScopedPage && (
        <div className="editions-bar">
          <span className="muted">Showing</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">{hasEditions ? "All editions (combined)" : "All rounds"}</option>
            {hasEditions && (
              <optgroup label="Editions">
                {byLabel(editions).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
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
        {isOwner && (meta?.roundWarnings?.length ?? 0) > 0 && (
          <div className="cat-warn round-warn" role="status">
            <strong>Some packets aren't lined up with the games.</strong>
            <p className="muted">
              A packet only collects buzzes when its round matches the round its games were played in — otherwise its
              questions show 0 heard while player and team stats still look fine.
            </p>
            <ul className="cat-warn-list">
              {meta!.roundWarnings!.map((w, i) => <li key={i}>{warningText(w)}</li>)}
            </ul>
            <div className="cat-warn-actions">
              <Link className="btn-primary" to={`${base}/settings#rounds`}>Fix round alignment</Link>
            </div>
          </div>
        )}
        {isOwner && (meta?.bonusDiffWarnings?.length ?? 0) > 0 && (
          <div className="cat-warn bndiff-warn" role="status">
            <strong>
              {meta!.bonusDiffWarnings!.length === 1
                ? "One bonus's difficulty marks can't be right."
                : `${meta!.bonusDiffWarnings!.length} bonuses have difficulty marks that can't be right.`}
            </strong>
            <p className="muted">
              A three-part bonus is written easy, medium and hard. Where a packet tagged one "medium, easy, easy" its
              real hard part is being counted as an easy one, and every easy/medium/hard figure built on it — including{" "}
              <Link to={`${base}/bonus-order`} className="link">Difficulty order</Link> — is off by that part.
            </p>
            <div className="cat-warn-actions">
              <Link className="btn-primary" to={`${base}/settings#bonusdiff`}>Fix difficulty marks</Link>
            </div>
          </div>
        )}
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
              <>You need to <Link to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} className="link">log in</Link> (and be invited) to view it.</>
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
