import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { refreshIndex, useIndex } from "../data";
import { useAuth } from "../auth";
import { AuthNav } from "../components/Common";
import { TOURNAMENT_LEVELS, difficultyOptions, levelLabel } from "../types";

// Pool several of your own tournaments into a NEW one — e.g. two practice sets
// as one "Level 7" stats page. The originals stay as they are; each keeps its
// questions apart (its packets are renumbered after the previous set's) while
// players and teams with the same name pool together. See api/_lib/combine.ts.
export function CombineSets() {
  const { user, loading: authLoading } = useAuth();
  const { data: index, loading } = useIndex();
  const navigate = useNavigate();
  // Picked slugs, in the order they'll be numbered.
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [level, setLevel] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [visibility, setVisibility] = useState<"private" | "listed">("private");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mine = useMemo(
    () => (index?.sets ?? []).filter((s) => s.owns && s.kind !== "results").sort((a, b) => a.name.localeCompare(b.name)),
    [index]
  );
  const bySlug = useMemo(() => new Map(mine.map((s) => [s.slug, s])), [mine]);
  const chosen = picked.map((s) => bySlug.get(s)).filter((s): s is NonNullable<typeof s> => !!s);
  // Defaults to practice when everything picked is practice.
  const effLevel = level || (chosen.length && chosen.every((s) => s.level === "practice") ? "practice" : chosen[0]?.level || "");
  const mismatch =
    chosen.find((s) => s.scoring !== chosen[0].scoring) ? "These tournaments use different scoring, so they can't be combined."
    : chosen.find((s) => !!s.individual !== !!chosen[0].individual) ? "Individual and team tournaments can't be combined."
    : null;

  const toggle = (slug: string) => setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));
  const move = (i: number, d: -1 | 1) => setPicked((p) => {
    const j = i + d;
    if (j < 0 || j >= p.length) return p;
    const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/ingest", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "combine", sources: picked, name: name.trim(), level: effLevel, difficulty, visibility }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      refreshIndex();
      navigate(`/set/${d.slug}`);
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  // Running packet numbers, so the owner sees where each set will land.
  let next = 1;
  const ranges = chosen.map((s) => { const from = next; next += s.rounds; return { from, to: next - 1 }; });

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav"><Link to="/search" className="nav-link">Search across tournaments</Link></nav>
          <div className="topbar-auth"><AuthNav /></div>
        </div>
      </header>
      <main className="content">
        <div className="breadcrumb"><Link to="/" className="link">← All tournaments</Link></div>
        <h1>Combine tournaments</h1>
        <p className="muted" style={{ maxWidth: 720 }}>
          Build one stats page out of several tournaments you own — two practice sets as a single “Level 7” page, say.
          The originals aren't changed. Each set's questions stay separate (its packets are numbered after the previous
          set's), while players and teams with the same name are pooled, and each set becomes a phase you can filter by.
          The combination is a copy: later edits to the originals don't carry over.
        </p>

        {!authLoading && !user && (
          <p className="caveat">
            <Link to="/login?next=/combine" className="link">Log in</Link> to combine your tournaments.
          </p>
        )}
        {user && !loading && mine.length < 2 && (
          <p className="caveat">You need to own at least two tournaments with buzz data to combine them.</p>
        )}

        {user && mine.length >= 2 && (
          <form className="create-form" onSubmit={submit}>
            <div className="field">
              <span>Tournaments to combine</span>
              <div className="combine-list">
                {mine.map((s) => (
                  <label key={s.slug} className="combine-opt">
                    <input type="checkbox" checked={picked.includes(s.slug)} onChange={() => toggle(s.slug)} />
                    <span>{s.name}</span>
                    <small className="muted">{[levelLabel(s.level), `${s.rounds} packets`, `${s.numGames} games`].filter(Boolean).join(" · ")}</small>
                  </label>
                ))}
              </div>
            </div>

            {chosen.length > 0 && (
              <div className="field">
                <span>Order (sets packet numbering)</span>
                <ol className="combine-order">
                  {chosen.map((s, i) => (
                    <li key={s.slug}>
                      <span>{s.name}</span>
                      <small className="muted"> → packets {ranges[i].from}–{ranges[i].to}</small>
                      <button type="button" className="btn-link" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                      <button type="button" className="btn-link" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    </li>
                  ))}
                </ol>
                <small className="muted">Packet counts are approximate until it's built.</small>
              </div>
            )}

            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Level 7 practice" required />
            </label>

            <label className="field">
              <span>Tournament type</span>
              <select value={effLevel} onChange={(e) => { setLevel(e.target.value); setDifficulty(""); }} required>
                <option value="" disabled>Choose a type…</option>
                {TOURNAMENT_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </label>
            {difficultyOptions(effLevel).length > 0 && (
              <label className="field">
                <span>Question difficulty (optional)</span>
                <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                  <option value="">Not set</option>
                  {difficultyOptions(effLevel).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </label>
            )}

            <label className="field">
              <span>Visibility</span>
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "listed")}>
                <option value="private">Private (invite only)</option>
                <option value="listed">Listed (login + invite)</option>
              </select>
              <small className="muted">You can change this, or ask to make it public, in Settings afterwards.</small>
            </label>

            {mismatch && <div className="error-box">{mismatch}</div>}
            {err && <div className="error-box">{err}</div>}
            <div>
              <button className="btn-primary" type="submit" disabled={busy || chosen.length < 2 || !name.trim() || !effLevel || !!mismatch}>
                {busy ? "Combining…" : `Combine ${chosen.length || ""} tournaments`}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
