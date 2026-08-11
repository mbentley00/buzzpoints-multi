import { useEffect, useMemo, useState } from "react";
import { MetaField, MetaMap, MetaShape } from "../types";
import { clearSetCache, refreshIndex } from "../data";

// Owner-only: say what a set's question metadata actually means.
//
// A packet's metadata line is comma-separated, but sets disagree about the order.
// "<Mike Bentley, Painting - 1800-1900>" leads with the writer; "<Poetry, JL>"
// leads with the category. Guessing wrong is how a set ends up filed under a
// writer's initials. This scans the real metadata, shows the values found in each
// position, and lets the owner assign each field a role — the category, a tag
// dimension to split on later, or nothing.

interface Scan { total: number; shapes: MetaShape[]; metaMap: MetaMap | null }

const ROLES: { value: MetaField["role"]; label: string }[] = [
  { value: "category", label: "Category" },
  { value: "tag", label: "Tag" },
  { value: "ignore", label: "Ignore" },
];

export function MetaMapEditor({ slug }: { slug: string }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [fields, setFields] = useState<MetaField[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/manage?slug=${encodeURIComponent(slug)}&op=metascan`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed to scan metadata");
        setScan(d);
        // Start from what's saved, or from the guess in force today: the last
        // field is the category, everything before it is the writer.
        const n = d.shapes[0]?.fieldCount ?? 1;
        setFields(
          d.metaMap?.fields?.length
            ? d.metaMap.fields
            : Array.from({ length: n }, (_, i) => ({ role: i === n - 1 ? "category" : "ignore" } as MetaField))
        );
      })
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [slug]);

  // The widest shape decides how many role pickers there are; a question with
  // fewer fields simply doesn't fill the later ones.
  const width = useMemo(() => Math.max(1, ...(scan?.shapes || []).map((s) => s.fieldCount)), [scan]);
  const at = (i: number): MetaField => fields[i] ?? { role: "ignore" };
  const set = (i: number, f: MetaField) =>
    setFields((prev) => {
      const next = Array.from({ length: width }, (_, k) => prev[k] ?? { role: "ignore" as const });
      next[i] = f;
      // Only one field can be the category.
      if (f.role === "category") next.forEach((x, k) => { if (k !== i && x.role === "category") next[k] = { role: "ignore" }; });
      return next;
    });

  const catCount = Array.from({ length: width }, (_, i) => at(i)).filter((f) => f.role === "category").length;
  const missingTagName = Array.from({ length: width }, (_, i) => at(i)).some((f) => f.role === "tag" && !f.tag?.trim());
  const canSave = catCount === 1 && !missingTagName && !busy;

  async function save() {
    setBusy(true); setErr("");
    try {
      const payload = { fields: Array.from({ length: width }, (_, i) => { const f = at(i); return f.role === "tag" ? { role: f.role, tag: (f.tag || "").trim() } : { role: f.role }; }) };
      const r = await fetch("/api/manage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "metamap", metaMap: payload }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
      clearSetCache(slug);
      refreshIndex();
      window.location.reload();
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  }

  if (err && !scan) return <div className="error-box">{err}</div>;
  if (!scan) return <p className="muted">Scanning question metadata…</p>;
  if (!scan.total) return <p className="muted">These questions carry no metadata to read categories from.</p>;

  return (
    <div className="srcfiles">
      {err && <div className="error-box">{err}</div>}
      <p className="muted srcfiles-note">
        Read from {scan.total} question{scan.total === 1 ? "" : "s"}
        {scan.shapes.length > 1 && <> in {scan.shapes.length} different shapes</>}. Example:{" "}
        <span className="mono">{scan.shapes[0]?.examples[0]}</span>
      </p>

      <table className="data-table srcfiles-table" style={{ maxWidth: 860 }}>
        <thead>
          <tr><th className="right">Field</th><th>This field means</th><th>Values found</th></tr>
        </thead>
        <tbody>
          {Array.from({ length: width }, (_, i) => {
            const f = at(i);
            const samples = scan.shapes.find((s) => s.fieldCount > i)?.samples[i] ?? [];
            const distinct = scan.shapes.find((s) => s.fieldCount > i)?.distinct[i] ?? 0;
            return (
              <tr key={i}>
                <td className="right mono">{i + 1}</td>
                <td>
                  <select value={f.role} onChange={(e) => set(i, { role: e.target.value as MetaField["role"], tag: f.tag })}>
                    {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                  {f.role === "tag" && (
                    <input
                      value={f.tag ?? ""}
                      onChange={(e) => set(i, { role: "tag", tag: e.target.value })}
                      placeholder="name it, e.g. Writer"
                      style={{ marginLeft: 8, padding: "4px 8px", border: "1px solid #cdd5e0", borderRadius: 4, width: 160 }}
                    />
                  )}
                </td>
                <td className="srcfiles-sample">
                  {samples.length ? samples.slice(0, 8).join(" · ") : <span className="muted">—</span>}
                  {distinct > 8 && <span className="muted"> … {distinct} distinct</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="muted srcfiles-note">
        {catCount === 1
          ? <>Categories will come from field <strong>{Array.from({ length: width }, (_, i) => i).find((i) => at(i).role === "category")! + 1}</strong>. A field marked <strong>Tag</strong> becomes its own dimension you can filter and compare on.</>
          : <span className="error-inline">Pick exactly one field to be the category.</span>}
        {missingTagName && <span className="error-inline"> Every tag field needs a name.</span>}
      </p>

      <div className="srcfiles-actions">
        <button className="btn-primary btn-sm" disabled={!canSave} onClick={save}>
          {busy ? "Re-reading questions…" : "Save & rebuild stats"}
        </button>
        <span className="muted">Re-reads every question and recomputes the set.</span>
      </div>
    </div>
  );
}
