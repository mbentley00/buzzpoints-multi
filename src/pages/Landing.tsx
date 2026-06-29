import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useIndex } from "../data";
import { useAuth } from "../auth";
import { SetEntry, TOURNAMENT_LEVELS, levelLabel } from "../types";
import { Loading, ErrorBox, AuthNav, SearchInput } from "../components/Common";
import { formatDate, relativeTime } from "../util";

// Access groups for the listing, ordered top → bottom.
const GROUP_LABELS = [
  "Your tournaments & shared with you",
  "Public tournaments",
  "Invite-only — request access",
];
// 0 = owned or granted access, 1 = public, 2 = invite-only without access yet.
function groupOf(s: SetEntry, user: string | null): 0 | 1 | 2 {
  const isPublic = (s.visibility ?? "public") === "public";
  const owned = !!user && s.owner === user;
  if (owned || (s.hasAccess && !isPublic)) return 0;
  if (isPublic) return 1;
  return 2;
}

const VisBadge = ({ s }: { s: SetEntry }) =>
  s.visibility && s.visibility !== "public" ? (
    <span className={`vis-badge vis-${s.visibility}`}>{s.visibility === "private" ? "Private" : "Invite"}</span>
  ) : null;

// Short labels for the scoring filter; mirrors api/_lib/scoring.ts ids.
const SCORING_LABELS: Record<string, string> = {
  ACF: "ACF", mACF: "mACF", PACE: "PACE", SUPERPOWER: "Super-power",
};
const scoringLabel = (id: string) => SCORING_LABELS[id] ?? id;

type Sort = "new" | "old" | "name" | "games";
const PAGE = 24; // cards shown per "page"; incremented by Show more

export function Landing() {
  const { data, error, loading } = useIndex();
  const { user } = useAuth();
  const sets = data?.sets ?? [];

  const [q, setQ] = useState("");
  const [scoring, setScoring] = useState<string>("all");
  const [vis, setVis] = useState<string>("all");
  const [lvl, setLvl] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [limit, setLimit] = useState(PAGE);

  // Scoring formats actually present, so the filter only offers real options.
  const scoringOpts = useMemo(
    () => [...new Set(sets.map((s) => s.scoring).filter(Boolean))].sort(),
    [sets]
  );
  // Only worth showing a visibility filter when some non-public sets are visible.
  const hasNonPublic = useMemo(() => sets.some((s) => s.visibility && s.visibility !== "public"), [sets]);
  const levelOpts = useMemo(() => TOURNAMENT_LEVELS.filter((l) => sets.some((s) => s.level === l.id)), [sets]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = sets.filter((s) => {
      if (needle && !s.name.toLowerCase().includes(needle)) return false;
      if (scoring !== "all" && s.scoring !== scoring) return false;
      if (vis !== "all" && (s.visibility ?? "public") !== vis) return false;
      if (lvl !== "all" && s.level !== lvl) return false;
      return true;
    });
    r = [...r].sort((a, b) => {
      const g = groupOf(a, user) - groupOf(b, user); // keep access groups contiguous
      if (g !== 0) return g;
      switch (sort) {
        case "name": return a.name.localeCompare(b.name);
        case "games": return b.numGames - a.numGames;
        case "old": return (a.createdAt || "").localeCompare(b.createdAt || "");
        case "new":
        default: return (b.createdAt || "").localeCompare(a.createdAt || "");
      }
    });
    return r;
  }, [sets, q, scoring, vis, lvl, sort, user]);

  // Reset paging whenever the result set changes.
  useEffect(() => setLimit(PAGE), [q, scoring, vis, lvl, sort]);

  const visible = filtered.slice(0, limit);
  const showControls = data && !data.needsSetup && sets.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            Buzzpoints
          </Link>
          <nav className="nav">
            <Link to="/search" className="nav-link">
              Search
            </Link>
            <Link to="/new" className="nav-link active">
              + New tournament
            </Link>
            <Link to="/about" className="nav-link">
              About
            </Link>
          </nav>
          <div className="topbar-auth"><AuthNav /></div>
        </div>
      </header>
      <main className="content">
        <div className="hero">
          <h1>Buzzpoints</h1>
          <p>Upload packets and QBJ scoresheets to generate a quiz-bowl stats site for any tournament.</p>
        </div>
        <div className="page-header">
          <div>
            <h2 style={{ margin: 0 }}>Tournaments</h2>
            {showControls && (
              <p className="subtitle">
                {filtered.length === sets.length
                  ? `${sets.length} ${sets.length === 1 ? "tournament" : "tournaments"}`
                  : `${filtered.length} of ${sets.length} match`}
              </p>
            )}
          </div>
          <Link to="/new" className="btn-primary">
            Create new
          </Link>
        </div>

        {showControls && (
          <div className="list-controls">
            <SearchInput value={q} onChange={setQ} placeholder="Search tournaments" />
            {scoringOpts.length > 1 && (
              <label className="filter">
                Scoring:{" "}
                <select value={scoring} onChange={(e) => setScoring(e.target.value)}>
                  <option value="all">All</option>
                  {scoringOpts.map((id) => (
                    <option key={id} value={id}>{scoringLabel(id)}</option>
                  ))}
                </select>
              </label>
            )}
            {levelOpts.length > 1 && (
              <label className="filter">
                Type:{" "}
                <select value={lvl} onChange={(e) => setLvl(e.target.value)}>
                  <option value="all">All</option>
                  {levelOpts.map((l) => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
              </label>
            )}
            {hasNonPublic && (
              <label className="filter">
                Visibility:{" "}
                <select value={vis} onChange={(e) => setVis(e.target.value)}>
                  <option value="all">All</option>
                  <option value="public">Public</option>
                  <option value="listed">Invite</option>
                  <option value="private">Private</option>
                </select>
              </label>
            )}
            <label className="filter">
              Sort:{" "}
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="new">Newest</option>
                <option value="old">Oldest</option>
                <option value="name">Name</option>
                <option value="games">Most games</option>
              </select>
            </label>
          </div>
        )}

        {loading && <Loading />}
        {error && <ErrorBox error={error} />}
        {data?.needsSetup && (
          <div className="caveat">
            <strong>Data store not connected.</strong> Add a Vercel Blob store to this
            project (Storage → Create → Blob → connect to <code>buzzpoints-multi</code>),
            then redeploy. That sets <code>BLOB_READ_WRITE_TOKEN</code> and enables creating
            and viewing tournaments.
          </div>
        )}
        {data && !data.needsSetup && sets.length === 0 && (
          <p className="muted">No tournaments yet. Create one to get started.</p>
        )}
        {showControls && filtered.length === 0 && (
          <p className="muted">No tournaments match your search.</p>
        )}
        {visible.length > 0 && (() => {
          const renderCard = (s: SetEntry) => (
            <Link key={s.slug} to={s.kind === "results" ? `/set/${s.slug}` : `/set/${s.slug}/tossup`} className="nav-card">
              <div className="nav-card-title">
                {s.name} <VisBadge s={s} />
                {s.editions && s.editions.length > 1 && <span className="edition-count">{s.editions.length} editions</span>}
              </div>
              <div className="nav-card-desc">
                {s.level && <span className="level-badge">{levelLabel(s.level)}</span>}
                {s.numGames} games · {s.numTeams} teams · {s.numPlayers} players · {s.rounds} rounds
              </div>
              {s.createdAt && (
                <div className="nav-card-date" title={new Date(s.createdAt).toLocaleString()}>
                  Added {formatDate(s.createdAt)} · {relativeTime(s.createdAt)}
                </div>
              )}
            </Link>
          );
          const sections = ([0, 1, 2] as const)
            .map((g) => ({ g, items: visible.filter((s) => groupOf(s, user) === g) }))
            .filter((sec) => sec.items.length);
          // Only label sections once more than one access group is on screen.
          if (sections.length <= 1) return <div className="card-grid">{visible.map(renderCard)}</div>;
          return sections.map((sec) => (
            <section className="set-section" key={sec.g}>
              <h3 className="set-section-title">{GROUP_LABELS[sec.g]}</h3>
              <div className="card-grid">{sec.items.map(renderCard)}</div>
            </section>
          ));
        })()}
        {visible.length < filtered.length && (
          <div className="show-more">
            <button className="btn-secondary" onClick={() => setLimit((n) => n + PAGE)}>
              Show more ({filtered.length - visible.length} more)
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
