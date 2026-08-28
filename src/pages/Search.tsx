import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AuthNav, Loading, ErrorBox } from "../components/Common";
import { Html, CategoryTag, num, roundLabel, primaryAnswer } from "../util";
import { TOURNAMENT_LEVELS, Visibility, levelLabel, difficultyLabel } from "../types";

type SearchType = "players" | "questions";
type QKind = "all" | "tossup" | "bonus";
type QField = "all" | "answer" | "text";
interface CatHit { category: string; points: number }
// What every hit carries about its tournament.
interface SetFacts { slug: string; setName: string; createdAt: string | null; level: string | null; difficulty: string | null; individual: boolean; visibility: Visibility }
interface PlayerHit extends SetFacts { playerId: string; name: string; team: string; ppg: number; games: number; pts: number; topCats?: CatHit[] }
interface QuestionHit extends SetFacts {
  kind: "tossup" | "bonus"; id: string; round: number; num: number; answer: string; category: string;
  // Bonuses: every part (answer, difficulty mark, field-wide conversion), and
  // which one matched (null when the lead-in / parts / category did instead).
  parts?: { answer: string; difficulty: string; convPct: number | null }[]; matchedPart?: number | null;
  // A window of question text around the match, when that's what matched.
  snippet?: string;
}

// A part's difficulty mark, as packets write it ("easy", "e", "hard"), in one letter.
const diffShort = (d: string) => { const c = d.trim().charAt(0).toUpperCase(); return "EMH".includes(c) && c ? c : d; };

// The tournament's status and standing, as tags on a hit. Public sets are the
// norm, so only the other two statuses get a tag; type and difficulty always do.
function SetTags({ s }: { s: SetFacts }) {
  const diff = difficultyLabel(s.level ?? undefined, s.difficulty ?? undefined);
  return (
    <>
      {s.visibility !== "public" && (
        <span className={`vis-badge vis-${s.visibility}`} title={s.visibility === "private" ? "Private — invite-only and unlisted" : "Listed — viewing needs an invite"}>
          {s.visibility === "private" ? "Private" : "Listed"}
        </span>
      )}
      {s.level && <span className="set-row-level">{levelLabel(s.level)}</span>}
      {diff && <span className="set-row-level" title="Question difficulty">{diff}</span>}
      {s.individual && <span className="set-row-level" title="Individual shootout">Individual</span>}
    </>
  );
}

type PlayerSort = "recent" | "ppg" | "points" | "name";
const SORTS: { id: PlayerSort; label: string }[] = [
  { id: "recent", label: "Most recent tournament" },
  { id: "ppg", label: "Points per game" },
  { id: "points", label: "Total points" },
  { id: "name", label: "Name (A–Z)" },
];
function sortPlayers(rows: PlayerHit[], sort: PlayerSort): PlayerHit[] {
  const by = [...rows];
  const cmp: Record<PlayerSort, (a: PlayerHit, b: PlayerHit) => number> = {
    recent: (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || b.ppg - a.ppg,
    ppg: (a, b) => b.ppg - a.ppg || b.pts - a.pts,
    points: (a, b) => b.pts - a.pts || b.ppg - a.ppg,
    name: (a, b) => a.name.localeCompare(b.name) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  };
  return by.sort(cmp[sort]);
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") || "").trim();
  const type: SearchType = params.get("type") === "questions" ? "questions" : "players";
  // Filters live in the URL too, so a search can be shared or reloaded.
  const level = params.get("level") || "";
  const kind: QKind = (["tossup", "bonus"].includes(params.get("kind") || "") ? params.get("kind") : "all") as QKind;
  const field: QField = (["answer", "text"].includes(params.get("field") || "") ? params.get("field") : "all") as QField;

  const [input, setInput] = useState(q);
  const [typeSel, setTypeSel] = useState<SearchType>(type);
  const [sort, setSort] = useState<PlayerSort>("recent");
  const [results, setResults] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setInput(q); }, [q]);
  useEffect(() => { setTypeSel(type); }, [type]);

  useEffect(() => {
    if (q.length < 2) { setResults([]); setTotal(0); setError(""); return; }
    let alive = true;
    setLoading(true); setError("");
    const qs = new URLSearchParams({ q, type });
    if (level) qs.set("level", level);
    if (type === "questions") { if (kind !== "all") qs.set("kind", kind); if (field !== "all") qs.set("field", field); }
    fetch(`/api/index?${qs}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok) throw new Error(d.error || `Search failed (${d.status || ""})`);
        setResults(d.results || []);
        setTotal(d.total || 0);
      })
      .catch((e) => { if (alive) setError(String(e.message || e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [q, type, level, kind, field]);

  const run = (nextQ: string, nextType: SearchType, more: { level?: string; kind?: QKind; field?: QField } = {}) => {
    const qq = nextQ.trim();
    if (!qq) { setParams({}); return; }
    const next: Record<string, string> = { q: qq, type: nextType };
    const lv = more.level ?? level, kd = more.kind ?? kind, fd = more.field ?? field;
    if (lv) next.level = lv;
    if (nextType === "questions") { if (kd !== "all") next.kind = kd; if (fd !== "all") next.field = fd; }
    setParams(next);
  };
  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); run(input, typeSel); };
  const onToggle = (t: SearchType) => { setTypeSel(t); if (q) run(q, t); };
  // A filter change re-runs the current query at once; with no query yet it
  // just waits in the URL for one.
  const setFilter = (more: { level?: string; kind?: QKind; field?: QField }) => {
    if (q) run(q, typeSel, more);
    else {
      const next: Record<string, string> = {};
      const lv = more.level ?? level, kd = more.kind ?? kind, fd = more.field ?? field;
      if (lv) next.level = lv; if (kd !== "all") next.kind = kd; if (fd !== "all") next.field = fd;
      setParams(next);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Tournaments</Link>
            <Link to="/search" className="nav-link active">Search across tournaments</Link>
            <Link to="/new" className="nav-link">+ New tournament</Link>
          </nav>
          <div className="topbar-auth"><AuthNav /></div>
        </div>
      </header>

      <main className="content">
        <h1>Search</h1>
        <p className="subtitle">Find players or questions across every tournament you can view.</p>

        <form className="search-form" onSubmit={onSubmit}>
          <div className="search-toggle">
            <button type="button" className={"mini-btn" + (typeSel === "players" ? " on" : "")} onClick={() => onToggle("players")}>Players</button>
            <button type="button" className={"mini-btn" + (typeSel === "questions" ? " on" : "")} onClick={() => onToggle("questions")}>Questions</button>
          </div>
          <input
            className="search-box"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={typeSel === "players" ? "Player or team name…" : field === "text" ? "Words from the question…" : field === "answer" ? "Answer line…" : "Answer, question text or category…"}
            autoFocus
          />
          <button className="btn-primary" type="submit">Search</button>
        </form>
        <div className="search-filters">
          <label className="filter">
            Tournament type{" "}
            <select value={level} onChange={(e) => setFilter({ level: e.target.value })}>
              <option value="">All</option>
              {TOURNAMENT_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>
          {typeSel === "questions" && (
            <>
              <label className="filter">
                Questions{" "}
                <select value={kind} onChange={(e) => setFilter({ kind: e.target.value as QKind })}>
                  <option value="all">Tossups and bonuses</option>
                  <option value="tossup">Tossups only</option>
                  <option value="bonus">Bonuses only</option>
                </select>
              </label>
              <label className="filter">
                Search in{" "}
                <select value={field} onChange={(e) => setFilter({ field: e.target.value as QField })}>
                  <option value="all">Answers, text and category</option>
                  <option value="answer">Answer lines only</option>
                  <option value="text">Question text only</option>
                </select>
              </label>
            </>
          )}
        </div>

        {loading && <Loading />}
        {error && <ErrorBox error={error} />}

        {!loading && !error && q.length >= 2 && (
          <div className="search-summary">
            <span className="subtitle">{total === 0 ? "No matches." : `${total}${total >= 200 ? "+" : ""} match${total === 1 ? "" : "es"}`}{total > results.length ? ` (showing first ${results.length})` : ""}</span>
            {type === "players" && results.length > 1 && (
              <label className="search-sort">
                Sort by
                <select value={sort} onChange={(e) => setSort(e.target.value as PlayerSort)}>
                  {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        {!loading && !error && (
          <div className="search-results">
            {type === "players"
              ? sortPlayers(results as PlayerHit[], sort).map((p) => (
                  <Link key={`${p.slug}:${p.playerId}`} to={`/set/${p.slug}/player/${p.playerId}`} className="search-result player">
                    <div className="search-result-row">
                      <div className="search-result-main">{p.name}</div>
                      <div className="search-result-meta">
                        {p.team && p.team !== p.name && <span>{p.team}</span>}
                        <span className="search-set">{p.setName}</span>
                        <SetTags s={p} />
                        <span className="search-stat">{num(p.ppg)} PPG · {p.games} G</span>
                      </div>
                    </div>
                    {p.topCats && p.topCats.length > 0 && (
                      <div className="search-cats">
                        {p.topCats.map((c) => (
                          <span key={c.category} className="search-cat">
                            {c.category}<b>{c.points}</b>
                          </span>
                        ))}
                      </div>
                    )}
                  </Link>
                ))
              : (results as QuestionHit[]).map((qr) => (
                  <Link key={`${qr.slug}:${qr.kind}:${qr.id}`} to={`/set/${qr.slug}/${qr.kind === "bonus" ? "bonus" : "tossup"}/${qr.id}`} className="search-result">
                    {qr.kind === "bonus" && qr.parts?.length ? (
                      // Every part, matched one first — each with its difficulty
                      // mark and how often the field converted it.
                      <div className="search-result-main search-bonus-parts">
                        {qr.parts.map((pt, i) => ({ pt, i })).sort((a, b) => (a.i === qr.matchedPart ? -1 : b.i === qr.matchedPart ? 1 : a.i - b.i)).map(({ pt, i }) => (
                          <span key={i} className={"search-bonus-part" + (i === qr.matchedPart ? " matched" : "")}>
                            <Html html={primaryAnswer(pt.answer)} />
                            {pt.difficulty && <span className="search-part-diff" title="Difficulty mark">{diffShort(pt.difficulty)}</span>}
                            {pt.convPct != null && <span className="search-part-conv" title="Conversion across the tournament">{num(pt.convPct, 0)}%</span>}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="search-result-main"><Html html={primaryAnswer(qr.answer)} /></div>
                    )}
                    {qr.snippet && <div className="search-snippet">{qr.snippet}</div>}
                    <div className="search-result-meta">
                      <span className="set-row-level">{qr.kind === "bonus" ? "Bonus" : "Tossup"}</span>
                      {qr.category && <CategoryTag cat={qr.category} />}
                      <span className="search-set">{qr.setName}</span>
                      <SetTags s={qr} />
                      <span>R{roundLabel(qr.round)}-{qr.num}</span>
                    </div>
                  </Link>
                ))}
          </div>
        )}
      </main>
    </div>
  );
}
