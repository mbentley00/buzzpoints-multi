import { useEffect, useMemo, useState } from "react";
import { loadSetJson, clearSetCache } from "../data";
import { TossupRow, BonusRow } from "../types";
import { plain, primaryAnswer, roundLabel, searchable } from "../util";

// Re-file questions by hand. Some sets tag each round in its own style, so the
// same subject turns up under three spellings and the category pages split it
// three ways. Filter to the questions you mean, tick them, and give them one
// category (or add/drop a tag). Edits are an overlay on the metadata: a later
// re-upload or a change to the metadata mapping doesn't wipe them, and clearing
// one puts back what the packet said.

interface Row { id: string; round: number; num: number; answer: string; category: string; tags: string[] }
interface TagEdit { add?: string[]; remove?: string[]; category?: string }

async function post(body: unknown) {
  const r = await fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
  return d as Record<string, any>;
}

export function QuestionEditor({ slug, hasBonuses }: { slug: string; hasBonuses: boolean }) {
  const [kind, setKind] = useState<"tossups" | "bonuses">("tossups");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [edits, setEdits] = useState<Record<string, TagEdit>>({});
  const [bust, setBust] = useState(0);
  const [round, setRound] = useState("");
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [newCat, setNewCat] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null); setErr(null);
    const file = kind === "tossups" ? "tossups.json" : "bonuses.json";
    Promise.all([
      loadSetJson<(TossupRow | BonusRow)[]>(slug, file, bust),
      fetch(`/api/manage?slug=${encodeURIComponent(slug)}&op=tagedits`).then((r) => r.json()).catch(() => ({})),
    ]).then(([list, te]) => {
      if (!live) return;
      setRows(list.map((r) => {
        const b = r as BonusRow, t = r as TossupRow;
        const ans = kind === "tossups" ? t.answer : [b.easyAnswer, b.medAnswer, b.hardAnswer].filter(Boolean).map((a) => primaryAnswer(a!)).join(" / ");
        return { id: r.id, round: r.round, num: r.num, answer: plain(kind === "tossups" ? primaryAnswer(ans) : ans), category: r.subcategory || r.category, tags: r.tags || [] };
      }).sort((a, b) => a.round - b.round || a.num - b.num));
      setEdits((te?.tagEdits?.[kind] as Record<string, TagEdit>) || {});
    }).catch((e) => live && setErr(String((e as Error).message || e)));
    return () => { live = false; };
  }, [slug, kind, bust]);

  const rounds = useMemo(() => [...new Set((rows ?? []).map((r) => r.round))].sort((a, b) => a - b), [rows]);
  // Every category in use, most-used first, so the likely spellings are on top.
  const cats = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows ?? []) c.set(r.category, (c.get(r.category) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);
  const shown = useMemo(() => (rows ?? []).filter((r) =>
    (!round || r.round === Number(round)) && (!cat || r.category === cat) &&
    (!q.trim() || searchable(`${r.answer} ${r.category} ${r.tags.join(" ")}`).includes(searchable(q)))
  ), [rows, round, cat, q]);

  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const togglePick = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickShown = (on: boolean) => setPicked((p) => { const n = new Set(p); for (const r of shown) { if (on) n.add(r.id); else n.delete(r.id); } return n; });

  async function apply(change: { category?: string | null; addTags?: string[]; removeTags?: string[] }, what: string) {
    const ids = [...picked];
    if (!ids.length) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      await post({ slug, op: "question-edits", kind, ids, ...change });
      clearSetCache(slug);
      setBust((b) => b + 1);
      setPicked(new Set());
      setMsg(`${what} on ${ids.length} ${kind === "tossups" ? "tossup" : "bonus"}${ids.length === 1 ? "" : kind === "tossups" ? "s" : "es"}; stats rebuilt.`);
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  const nPicked = picked.size;
  return (
    <div className="question-editor">
      <div className="cat-toolbar">
        {hasBonuses && (
          <select className="subject-select" value={kind} disabled={busy} onChange={(e) => { setKind(e.target.value as "tossups" | "bonuses"); setPicked(new Set()); setCat(""); }}>
            <option value="tossups">Tossups</option>
            <option value="bonuses">Bonuses</option>
          </select>
        )}
        <select className="subject-select" value={round} onChange={(e) => setRound(e.target.value)} aria-label="Round">
          <option value="">All rounds</option>
          {rounds.map((r) => <option key={r} value={r}>{roundLabel(r)}</option>)}
        </select>
        <select className="subject-select" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {cats.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
        </select>
        <input className="admin-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search answers, categories, tags" style={{ minWidth: 200 }} />
      </div>

      <div className="cat-toolbar question-editor-actions">
        <strong>{nPicked} selected</strong>
        <input className="admin-filter" list={`qe-cats-${slug}`} value={newCat} onChange={(e) => setNewCat(e.target.value)}
          placeholder="Category, e.g. Science - Biology" style={{ minWidth: 240 }} aria-label="New category" />
        <datalist id={`qe-cats-${slug}`}>{cats.map(([c]) => <option key={c} value={c} />)}</datalist>
        <button className="btn-primary btn-sm" disabled={busy || !nPicked || !newCat.trim()} onClick={() => apply({ category: newCat.trim() }, `Category set to “${newCat.trim()}”`)}>Set category</button>
        <button className="btn-link" disabled={busy || !nPicked} onClick={() => apply({ category: null }, "Category reset to the packet's")}>Reset to packet's</button>
        <span className="muted">·</span>
        <input className="admin-filter" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag, e.g. Writer: JL" style={{ minWidth: 160 }} aria-label="Tag" />
        <button className="btn-link" disabled={busy || !nPicked || !tag.includes(": ")} onClick={() => apply({ addTags: [tag.trim()] }, `Tag “${tag.trim()}” added`)}>Add tag</button>
        <button className="btn-link danger" disabled={busy || !nPicked || !tag.includes(": ")} onClick={() => apply({ removeTags: [tag.trim()] }, `Tag “${tag.trim()}” removed`)}>Remove tag</button>
      </div>
      {busy && <p className="muted">Saving and rebuilding stats…</p>}
      {msg && <p className="muted">{msg}</p>}
      {err && <div className="error-box">{err}</div>}

      {rows === null ? <p className="muted">Loading questions…</p> : (
        <div className="table-wrap question-editor-table">
          <table className="data-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={allShownPicked} onChange={(e) => pickShown(e.target.checked)} aria-label="Select all shown" /></th>
                <th>Round</th><th className="right">#</th><th>Answer</th><th>Category</th><th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const e = edits[r.id];
                return (
                  <tr key={r.id} className={picked.has(r.id) ? "row-picked" : ""} onClick={() => togglePick(r.id)} style={{ cursor: "pointer" }}>
                    <td><input type="checkbox" checked={picked.has(r.id)} onChange={() => togglePick(r.id)} onClick={(ev) => ev.stopPropagation()} aria-label={`Select ${r.id}`} /></td>
                    <td>{roundLabel(r.round)}</td>
                    <td className="right mono">{r.num}</td>
                    <td>{r.answer}</td>
                    <td>{r.category}{e?.category && <span className="muted" title="Set by hand; the packet said otherwise"> · edited</span>}</td>
                    <td className="muted">{r.tags.join(", ")}</td>
                  </tr>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={6} className="muted">No questions match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
