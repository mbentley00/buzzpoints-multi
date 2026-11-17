import { useEffect, useMemo, useState } from "react";
import { clearSetCache, refreshIndex } from "../data";

// Owner-only: put single-level categories under a subject ("Biology" → "Science - Biology").
interface Cat { name: string; count: number; acf: string | null }

const SUBJECTS = [
  "Literature", "History", "Science", "Fine Arts", "Religion", "Mythology", "Philosophy",
  "Social Science", "Geography", "Current Events", "Other Academic", "Pop Culture",
];

export function CategoryParentsEditor({ slug }: { slug: string }) {
  const [cats, setCats] = useState<Cat[] | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [parents, setParents] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/manage?slug=${encodeURIComponent(slug)}&op=catparents`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed to load categories");
        setCats(d.cats);
        setSaved(d.parents || {});
        setParents(d.parents || {});
      })
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [slug]);

  const subjects = useMemo(() => {
    const s = new Set(SUBJECTS);
    for (const c of cats || []) s.add(c.name);
    return [...s];
  }, [cats]);
  const suggestible = (cats || []).filter((c) => c.acf && parents[c.name] !== c.acf).length;
  const dirty = JSON.stringify(parents) !== JSON.stringify(saved);

  const autofill = () =>
    setParents((p) => {
      const next = { ...p };
      for (const c of cats || []) if (c.acf && !next[c.name]) next[c.name] = c.acf;
      return next;
    });

  async function save() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/manage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "catparents", parents }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
      clearSetCache(slug);
      refreshIndex();
      window.location.reload();
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  }

  if (err && !cats) return <div className="error-box">{err}</div>;
  if (!cats) return <p className="muted">Loading categories…</p>;
  if (!cats.length) return <p className="muted">No categories.</p>;

  return (
    <div className="srcfiles">
      {err && <div className="error-box">{err}</div>}
      <div className="srcfiles-actions" style={{ marginBottom: 8 }}>
        <button className="mini-btn" disabled={!suggestible || busy} onClick={autofill}>
          Group by ACF{suggestible ? ` (${suggestible})` : ""}
        </button>
      </div>
      <datalist id="cat-subjects">{subjects.map((s) => <option key={s} value={s} />)}</datalist>
      <table className="data-table srcfiles-table" style={{ maxWidth: 640 }}>
        <thead><tr><th>Category</th><th className="right">Qs</th><th>Under</th></tr></thead>
        <tbody>
          {cats.map((c) => (
            <tr key={c.name}>
              <td>{parents[c.name] ? <><span className="muted">{parents[c.name]} - </span>{c.name}</> : c.name}</td>
              <td className="right">{c.count}</td>
              <td>
                <input
                  list="cat-subjects"
                  value={parents[c.name] ?? ""}
                  placeholder={c.acf ?? "—"}
                  onChange={(e) => setParents((p) => {
                    const next = { ...p };
                    if (e.target.value.trim()) next[c.name] = e.target.value; else delete next[c.name];
                    return next;
                  })}
                  style={{ padding: "4px 8px", border: "1px solid #cdd5e0", borderRadius: 4, width: 180 }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="srcfiles-actions">
        <button className="btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>
          {busy ? "Rebuilding…" : "Save & rebuild stats"}
        </button>
        {dirty && !busy && <button className="btn-link" onClick={() => setParents(saved)}>Discard changes</button>}
      </div>
    </div>
  );
}
