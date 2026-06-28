import { useMemo, useState } from "react";
import { CatTossupRow, VirtualCategory } from "../types";
import { clearSetCache } from "../data";

interface Option { value: string; label: string; depth: number }

// Owner-only panel for creating/editing merged ("virtual") categories. The whole
// list is sent to /api/categories on save, which replaces the stored definitions
// and re-aggregates the set.
export function MergeCategoriesEditor({ slug, groups }: { slug: string; groups: CatTossupRow[] }) {
  // Existing merged categories, reconstructed from the synthetic nodes in the tree.
  const existing = useMemo<VirtualCategory[]>(
    () => groups.filter((g) => g.virtual).map((g) => ({ name: g.category, members: g.subs.map((s) => s.subcategory) })),
    [groups]
  );
  // Every real (non-virtual) category/subcategory/leaf, flattened for the picker.
  const options = useMemo<Option[]>(() => {
    const opts: Option[] = [];
    for (const g of groups) {
      if (g.virtual) continue;
      opts.push({ value: g.category, label: g.category, depth: 0 });
      for (const s of g.subs) {
        opts.push({ value: s.subcategory, label: s.subLabel, depth: 1 });
        for (const lf of s.leaves || []) opts.push({ value: lf.subcategory, label: lf.subLabel, depth: 2 });
      }
    }
    return opts;
  }, [groups]);

  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<VirtualCategory[]>(existing);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const dirty = JSON.stringify(cats) !== JSON.stringify(existing);
  const names = cats.map((c) => c.name.trim().toLowerCase());
  const valid =
    cats.every((c) => c.name.trim() && c.members.length > 0) &&
    new Set(names).size === names.length;

  const update = (i: number, patch: Partial<VirtualCategory>) =>
    setCats((cs) => cs.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const remove = (i: number) => {
    setCats((cs) => cs.filter((_, k) => k !== i));
    setEditingIdx(null);
  };
  const add = () => {
    setCats((cs) => [...cs, { name: "", members: [] }]);
    setEditingIdx(cats.length);
    setFilter("");
  };
  const toggleMember = (i: number, value: string) =>
    setCats((cs) =>
      cs.map((c, k) =>
        k === i
          ? { ...c, members: c.members.includes(value) ? c.members.filter((m) => m !== value) : [...c.members, value] }
          : c
      )
    );

  async function save() {
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, virtualCategories: cats.map((c) => ({ name: c.name.trim(), members: c.members })) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      clearSetCache(slug);
      window.location.reload();
    } catch (e) {
      setError(String((e as Error).message || e));
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="merge-bar">
        <button className="mini-btn" onClick={() => setOpen(true)}>
          Merge categories{existing.length ? ` (${existing.length})` : ""}
        </button>
        <span className="muted">Group categories into a custom “merged” category (e.g. Fine Arts – Other = Opera + Jazz).</span>
      </div>
    );
  }

  return (
    <div className="merge-panel">
      <div className="merge-panel-head">
        <strong>Merged categories</strong>
        <button className="btn-link" onClick={() => { setCats(existing); setEditingIdx(null); setError(""); setOpen(false); }}>
          Close
        </button>
      </div>
      <p className="muted merge-help">
        A merged category groups existing categories under a new name. A category may belong to several merged
        categories. Members and totals are aggregated across the chosen categories.
      </p>

      {cats.length === 0 && <p className="muted">No merged categories yet.</p>}

      {cats.map((c, i) => (
        <div className="merge-cat" key={i}>
          <div className="merge-cat-head">
            <input
              type="text"
              className="merge-name"
              placeholder="Merged category name (e.g. Fine Arts - Other)"
              value={c.name}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <button className="mini-btn" onClick={() => setEditingIdx(editingIdx === i ? null : i)}>
              {editingIdx === i ? "Done choosing" : `Choose categories (${c.members.length})`}
            </button>
            <button className="btn-link danger" onClick={() => remove(i)}>Remove</button>
          </div>
          {c.members.length > 0 && (
            <div className="merge-members">{c.members.map((m) => m.split(" - ").slice(-1)[0]).join(", ")}</div>
          )}
          {editingIdx === i && (
            <div className="merge-picker">
              <input
                type="text"
                className="merge-filter"
                placeholder="Filter categories…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="merge-options">
                {options
                  .filter((o) => !filter.trim() || o.label.toLowerCase().includes(filter.toLowerCase()) || o.value.toLowerCase().includes(filter.toLowerCase()))
                  .map((o) => (
                    <label key={o.value} className={`merge-option depth-${o.depth}`}>
                      <input
                        type="checkbox"
                        checked={c.members.includes(o.value)}
                        onChange={() => toggleMember(i, o.value)}
                      />
                      <span>{o.label}</span>
                    </label>
                  ))}
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="merge-actions">
        <button className="mini-btn" onClick={add}>+ Add merged category</button>
        <button className="btn-primary btn-sm" disabled={!dirty || !valid || saving} onClick={save}>
          {saving ? "Saving…" : "Save & rebuild"}
        </button>
        {dirty && <button className="btn-link" onClick={() => { setCats(existing); setEditingIdx(null); }}>Discard changes</button>}
        {!valid && <span className="error-inline">Each merged category needs a unique name and at least one member.</span>}
        {error && <span className="error-inline">{error}</span>}
      </div>
    </div>
  );
}
