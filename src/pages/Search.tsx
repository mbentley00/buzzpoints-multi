import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AuthNav, Loading, ErrorBox } from "../components/Common";
import { DataTable, Column } from "../components/DataTable";
import { Html, CategoryTag, num, roundLabel, primaryAnswer } from "../util";
import { TOURNAMENT_LEVELS, CATEGORY_BUCKETS, Visibility, levelLabel, difficultyLabel } from "../types";
import { useAuth } from "../auth";

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
  parts?: { answer: string; difficulty: string; convPct: number | null; convCount: number | null }[]; matchedPart?: number | null;
  // A window of question text around the match, when that's what matched.
  snippet?: string;
  // A window of the answer line around the match, when that's what matched —
  // shown only if the answer as displayed doesn't already contain it.
  answerSnippet?: string;
  // Tossups: how buzzable it was — every placed buzz as [word, value], the
  // question's length, and the headline rates.
  heard?: number; correct?: number; convPct?: number | null; avgBuzzPct?: number | null; wordCount?: number | null; buzzes?: [number, number][];
}

// "50% (3/6)": a rate with the count behind it, so a striking figure from a
// handful of rooms reads as what it is.
const rate = (pct: number | null | undefined, n: number | null | undefined, of: number | null | undefined) =>
  pct == null ? null : `${num(pct, 0)}%${n != null && of != null ? ` (${n}/${of})` : ""}`;

// A part's difficulty mark, as packets write it ("easy", "e", "hard"), in one letter.
const diffShort = (d: string) => { const c = d.trim().charAt(0).toUpperCase(); return "EMH".includes(c) && c ? c : d; };

// The tournament column: its name, and under it the tags that place it — type,
// difficulty, format, and status (public is the norm, so only Listed / Private
// get a tag).
function SetCell({ s }: { s: SetFacts }) {
  const diff = difficultyLabel(s.level ?? undefined, s.difficulty ?? undefined);
  return (
    <div className="search-setcell">
      <Link className="link search-set" to={`/set/${s.slug}`}>{s.setName}</Link>
      <div className="search-settags">
        {s.visibility !== "public" && (
          <span className={`vis-badge vis-${s.visibility}`} title={s.visibility === "private" ? "Private — invite-only and unlisted" : "Listed — viewing needs an invite"}>
            {s.visibility === "private" ? "Private" : "Listed"}
          </span>
        )}
        {s.level && <span className="set-row-level">{levelLabel(s.level)}</span>}
        {diff && <span className="set-row-level" title="Question difficulty">{diff}</span>}
        {s.individual && <span className="set-row-level" title="Individual shootout">Individual</span>}
      </div>
    </div>
  );
}

// A tossup's buzzes as a small cumulative chart, the same shape as the one on
// the tossup page: how many buzzes had come in by each word (grey), and how many
// of those were correct (green, filled), with the average correct buzz as a
// dashed line. The question runs from 0 to its last word, both labelled.
function BuzzChart({ q }: { q: QuestionHit }) {
  const n = q.wordCount || 0;
  const buzzes = q.buzzes ?? [];
  if (!n || !q.heard) return <span className="muted">—</span>;
  const W = 150, H = 44, PAD_B = 11, top = 3;
  const plotH = H - PAD_B - top;
  const x = (w: number) => Math.min(W, Math.max(0, (w / n) * W));
  const total = buzzes.length || 1;
  const y = (c: number) => top + plotH - (c / total) * plotH;
  // A step path: count so far, stepping up at each buzz's word.
  const steps = (pts: number[]) => {
    const sorted = [...pts].sort((a, b) => a - b);
    let d = `M0,${y(0)}`, c = 0;
    for (const w of sorted) { d += ` H${x(w)}`; c++; d += ` V${y(c)}`; }
    return d + ` H${W}`;
  };
  const all = buzzes.map(([w]) => w);
  const correct = buzzes.filter(([, v]) => v > 0).map(([w]) => w);
  const avgX = q.avgBuzzPct != null ? (q.avgBuzzPct / 100) * W : null;
  return (
    <span className="buzz-chart" title={`${q.heard} heard · ${buzzes.length} buzzes, ${correct.length} correct · ${q.convPct ?? 0}% converted${q.avgBuzzPct != null ? ` · average correct buzz ${q.avgBuzzPct}% of the way through` : ""}`}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <line x1={0} y1={y(0)} x2={W} y2={y(0)} className="bc-axis" />
        <path d={`${steps(all)} V${y(0)} Z`} className="bc-total" />
        <path d={`${steps(correct)} V${y(0)} Z`} className="bc-correct" />
        {avgX != null && <line x1={avgX} x2={avgX} y1={top} y2={y(0)} className="bc-avg" />}
        <text x={0} y={H - 1} className="bc-label">0</text>
        <text x={W} y={H - 1} className="bc-label" textAnchor="end">end</text>
      </svg>
    </span>
  );
}

const yearOf = (iso: string | null) => (iso ? iso.slice(0, 4) : "");
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").toLowerCase();

// What to show as the matched text: the question snippet if the text matched;
// else the answer-line window, but only when the match sits in a part of the
// answer line the row doesn't display — an "accept" or "prompt" clause — since
// repeating the visible answer says nothing.
function matchedText(r: QuestionHit, bare: string): string | null {
  if (r.snippet) return r.snippet;
  if (!r.answerSnippet) return null;
  const shown = r.kind === "bonus" && r.parts && r.matchedPart != null ? r.parts[r.matchedPart]?.answer ?? "" : r.answer;
  return plain(primaryAnswer(shown)).includes(bare) ? null : r.answerSnippet;
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") || "").trim();
  const type: SearchType = params.get("type") === "questions" ? "questions" : "players";
  // Filters live in the URL too, so a search can be shared or reloaded.
  const level = params.get("level") || "";
  const kind: QKind = (["tossup", "bonus"].includes(params.get("kind") || "") ? params.get("kind") : "all") as QKind;
  const field: QField = (["answer", "text"].includes(params.get("field") || "") ? params.get("field") : "all") as QField;
  const cat = CATEGORY_BUCKETS.some((b) => b.id === params.get("cat")) ? params.get("cat")! : "";
  // Public tournaments by default; a signed-in viewer can widen it to the listed
  // and private ones they've been let into. The server enforces access either way.
  const scope: "public" | "all" = params.get("scope") === "all" ? "all" : "public";
  const { user } = useAuth();
  // The query without its quotes, for checking whether a match is visible.
  const bare = q.replace(/^"(.*)"$/, "$1").trim().toLowerCase();

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
    const qs = new URLSearchParams({ q, type });
    if (scope === "all") qs.set("scope", "all");
    if (level) qs.set("level", level);
    if (type === "questions") { if (kind !== "all") qs.set("kind", kind); if (field !== "all") qs.set("field", field); if (cat) qs.set("cat", cat); }
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
  }, [q, type, level, kind, field, cat, scope]);

  type Filters = { level?: string; kind?: QKind; field?: QField; cat?: string; scope?: "public" | "all" };
  const paramsFor = (qq: string, nextType: SearchType, more: Filters) => {
    const next: Record<string, string> = {};
    if (qq) { next.q = qq; next.type = nextType; }
    const lv = more.level ?? level, kd = more.kind ?? kind, fd = more.field ?? field, ct = more.cat ?? cat, sc = more.scope ?? scope;
    if (sc === "all") next.scope = "all";
    if (lv) next.level = lv;
    if (nextType === "questions") { if (kd !== "all") next.kind = kd; if (fd !== "all") next.field = fd; if (ct) next.cat = ct; }
    return next;
  };
  const run = (nextQ: string, nextType: SearchType, more: Filters = {}) => setParams(paramsFor(nextQ.trim(), nextType, more));
  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); run(input, typeSel); };
  const onToggle = (t: SearchType) => { setTypeSel(t); run(q, t); };
  // A filter change re-runs the current query at once; with no query yet it
  // just waits in the URL for one.
  const setFilter = (more: Filters) => run(q, typeSel, more);

  const playerCols: Column<PlayerHit>[] = [
    { key: "name", label: "Player", sortVal: (p) => p.name.toLowerCase(), render: (p) => <Link className="link" to={`/set/${p.slug}/player/${p.playerId}`}>{p.name}</Link> },
    { key: "team", label: "Team", sortVal: (p) => p.team.toLowerCase(), render: (p) => (p.team && p.team !== p.name ? p.team : <span className="muted">—</span>) },
    { key: "set", label: "Tournament", sortVal: (p) => p.setName.toLowerCase(), render: (p) => <SetCell s={p} /> },
    { key: "year", label: "Added", align: "right", sortVal: (p) => p.createdAt || "", render: (p) => yearOf(p.createdAt) },
    { key: "ppg", label: "PPG", align: "right", sortVal: (p) => p.ppg, render: (p) => num(p.ppg) },
    { key: "games", label: "GP", align: "right", sortVal: (p) => p.games, render: (p) => p.games },
    { key: "pts", label: "Pts", align: "right", sortVal: (p) => p.pts, render: (p) => p.pts },
    { key: "cats", label: "Top categories", sortVal: (p) => p.topCats?.[0]?.points ?? 0, render: (p) => (
      <span className="search-cats">{(p.topCats ?? []).map((c) => <span key={c.category} className="search-cat">{c.category}<b>{c.points}</b></span>)}</span>
    ) },
  ];

  const questionCols: Column<QuestionHit>[] = [
    { key: "kind", label: "Type", sortVal: (r) => r.kind, render: (r) => <span className="set-row-level">{r.kind === "bonus" ? "Bonus" : "Tossup"}</span> },
    { key: "answer", label: "Answer", sortVal: (r) => primaryAnswer(r.answer).replace(/<[^>]+>/g, "").toLowerCase(), render: (r) => (
      r.kind === "bonus" && r.parts?.length ? (
        // Every part on its own line, in packet order, with its difficulty mark
        // and how often the field converted it; the matched part is bold.
        <div className="search-parts">
          {r.parts.map((pt, i) => (
            <div key={i} className={"search-part" + (i === r.matchedPart ? " matched" : "")}>
              <Link className="link" to={`/set/${r.slug}/bonus/${r.id}`}><Html html={primaryAnswer(pt.answer)} /></Link>
              <span className="search-part-stats">
                {pt.difficulty && <span className="search-part-diff" title="Difficulty mark">{diffShort(pt.difficulty)}</span>}
                {pt.convPct != null && <span className="search-part-conv" title="Conversion across the tournament (rooms that got it / rooms that heard it)">{rate(pt.convPct, pt.convCount, r.heard)}</span>}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Link className="link" to={`/set/${r.slug}/tossup/${r.id}`}><Html html={primaryAnswer(r.answer)} /></Link>
      )
    ) },
    { key: "match", label: "Matched text", sortVal: (r) => (matchedText(r, bare) ? 1 : 0), render: (r) => { const t = matchedText(r, bare); return t ? <span className="search-snippet">{t}</span> : <span className="muted">—</span>; } },
    ...(kind !== "bonus" ? [
      { key: "buzz", label: "Buzzes", sortVal: (r: QuestionHit) => r.avgBuzzPct ?? 999, render: (r: QuestionHit) => (r.kind === "tossup" ? <BuzzChart q={r} /> : <span className="muted">—</span>),
        title: "Cumulative buzzes as the question is read: grey is every buzz, green the correct ones; the dashed line is the average correct buzz." },
      { key: "avg", label: "Avg buzz", align: "right" as const, sortVal: (r: QuestionHit) => r.avgBuzzPct ?? 999, render: (r: QuestionHit) => (r.kind === "tossup" && r.avgBuzzPct != null ? `${num(r.avgBuzzPct, 0)}%` : <span className="muted">—</span>),
        title: "Average correct buzz, as a share of the way through the question. Lower is more buzzable." },
      { key: "conv", label: "Conv", align: "right" as const, sortVal: (r: QuestionHit) => r.convPct ?? -1, render: (r: QuestionHit) => (r.kind === "tossup" && r.convPct != null ? <span className="nowrap">{rate(r.convPct, r.correct, r.heard)}</span> : <span className="muted">—</span>),
        title: "Rooms that answered it correctly, out of rooms that heard it" },
      { key: "heard", label: "Heard", align: "right" as const, sortVal: (r: QuestionHit) => r.heard ?? -1, render: (r: QuestionHit) => (r.kind === "tossup" ? r.heard ?? 0 : <span className="muted">—</span>) },
    ] : []),
    { key: "cat", label: "Category", sortVal: (r) => r.category.toLowerCase(), render: (r) => (r.category ? <CategoryTag cat={r.category} /> : <span className="muted">—</span>) },
    { key: "set", label: "Tournament", sortVal: (r) => r.setName.toLowerCase(), render: (r) => <SetCell s={r} /> },
    { key: "rd", label: "Rd", align: "right", sortVal: (r) => r.round * 1000 + r.num, render: (r) => <span className="mono">{roundLabel(r.round)}-{r.num}</span> },
  ];

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

      <main className="content content-wide">
        <h1>Search</h1>
        <p className="subtitle">Find players or questions across public tournaments{user ? " — or every tournament you can view" : ""}.</p>

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
            placeholder={typeSel === "players" ? "Player or team name…" : field === "text" ? "Words from the question…" : field === "answer" ? "Answer line…" : "Answer or question text…"}
            autoFocus
          />
          <button className="btn-primary" type="submit">Search</button>
          <span className="muted search-hint">Quote a term for whole words only: <code>"art"</code></span>
        </form>
        <div className="search-filters">
          {/* Anonymous viewers can only ever see public sets, so the choice is
              only offered once there's something to widen to. */}
          {user && (
            <label className="filter">
              Tournaments{" "}
              <select value={scope} onChange={(e) => setFilter({ scope: e.target.value === "all" ? "all" : "public" })}>
                <option value="public">Public only</option>
                <option value="all">All I can view</option>
              </select>
            </label>
          )}
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
              <label className="filter" title="Subjects are matched across tournaments, whatever each one calls them">
                Category{" "}
                <select value={cat} onChange={(e) => setFilter({ cat: e.target.value })}>
                  <option value="">All</option>
                  {CATEGORY_BUCKETS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
              </label>
              <label className="filter">
                Search in{" "}
                <select value={field} onChange={(e) => setFilter({ field: e.target.value as QField })}>
                  <option value="all">Answers and question text</option>
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
          </div>
        )}

        {!loading && !error && results.length > 0 && (
          <div className="search-table">
            {type === "players"
              ? <DataTable rows={results as PlayerHit[]} columns={playerCols} initialSort="year" initialDir="desc" rowKey={(p) => `${p.slug}:${p.playerId}`} />
              : <DataTable rows={results as QuestionHit[]} columns={questionCols} initialSort="set" initialDir="asc" rowKey={(r) => `${r.slug}:${r.kind}:${r.id}`} />}
          </div>
        )}
      </main>
    </div>
  );
}
