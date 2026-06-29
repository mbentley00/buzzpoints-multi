import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AuthNav, Loading, ErrorBox } from "../components/Common";
import { Html, CategoryTag, num } from "../util";

type SearchType = "players" | "questions";
interface PlayerHit { slug: string; setName: string; playerId: string; name: string; team: string; ppg: number; games: number }
interface QuestionHit { slug: string; setName: string; id: string; round: number; num: number; answer: string; category: string }

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") || "").trim();
  const type: SearchType = params.get("type") === "questions" ? "questions" : "players";

  const [input, setInput] = useState(q);
  const [typeSel, setTypeSel] = useState<SearchType>(type);
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
    fetch(`/api/index?q=${encodeURIComponent(q)}&type=${type}`)
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
  }, [q, type]);

  const run = (nextQ: string, nextType: SearchType) => {
    const qq = nextQ.trim();
    setParams(qq ? { q: qq, type: nextType } : {});
  };
  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); run(input, typeSel); };
  const onToggle = (t: SearchType) => { setTypeSel(t); if (q) run(q, t); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Tournaments</Link>
            <Link to="/search" className="nav-link active">Search</Link>
            <Link to="/new" className="nav-link">+ New tournament</Link>
            <Link to="/about" className="nav-link">About</Link>
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
            placeholder={typeSel === "players" ? "Player or team name…" : "Answer or category…"}
            autoFocus
          />
          <button className="btn-primary" type="submit">Search</button>
        </form>

        {loading && <Loading />}
        {error && <ErrorBox error={error} />}

        {!loading && !error && q.length >= 2 && (
          <p className="subtitle">{total === 0 ? "No matches." : `${total}${total >= 200 ? "+" : ""} match${total === 1 ? "" : "es"}`}{total > results.length ? ` (showing first ${results.length})` : ""}</p>
        )}

        {!loading && !error && (
          <div className="search-results">
            {type === "players"
              ? (results as PlayerHit[]).map((p) => (
                  <Link key={`${p.slug}:${p.playerId}`} to={`/set/${p.slug}/player/${p.playerId}`} className="search-result">
                    <div className="search-result-main">{p.name}</div>
                    <div className="search-result-meta">
                      {p.team && <span>{p.team}</span>}
                      <span className="search-set">{p.setName}</span>
                      <span>{num(p.ppg)} PPG · {p.games} G</span>
                    </div>
                  </Link>
                ))
              : (results as QuestionHit[]).map((qr) => (
                  <Link key={`${qr.slug}:${qr.id}`} to={`/set/${qr.slug}/tossup/${qr.id}`} className="search-result">
                    <div className="search-result-main"><Html html={qr.answer} /></div>
                    <div className="search-result-meta">
                      {qr.category && <CategoryTag cat={qr.category} />}
                      <span className="search-set">{qr.setName}</span>
                      <span>R{qr.round}-{qr.num}</span>
                    </div>
                  </Link>
                ))}
          </div>
        )}
      </main>
    </div>
  );
}
