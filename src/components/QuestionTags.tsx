import { useState } from "react";
import { Link } from "react-router-dom";
import { clearSetCache } from "../data";

// The tags on one question. Everyone sees them as links into the filtered list;
// the owner can add or drop one here. Edits are stored as a small add/remove
// overlay, so re-reading the metadata later doesn't wipe them out.
export function QuestionTags({ slug, id, kind, tags, isOwner }: {
  slug: string;
  id: string;
  kind: "tossups" | "bonuses";
  tags: string[];
  isOwner: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listPath = kind === "tossups" ? "tossup" : "bonus";

  async function apply(add: string[], remove: string[]) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/manage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "question-tags", kind, id, add, remove }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
      clearSetCache(slug);
      window.location.reload();
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  }

  if (!tags.length && !isOwner) return null;

  return (
    <p className="q-tags">
      {tags.map((t) => (
        <Link key={t} className="q-tag" to={`/set/${slug}/${listPath}?tag=${encodeURIComponent(t)}`}>{t}</Link>
      ))}
      {isOwner && !editing && (
        <button className="btn-link" disabled={busy} onClick={() => setEditing(true)}>
          {tags.length ? "Edit tags" : "Add a tag"}
        </button>
      )}
      {isOwner && editing && (
        <span className="q-tag-edit">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Writer: JL"
            style={{ padding: "4px 8px", border: "1px solid #cdd5e0", borderRadius: 4, width: 200 }}
          />
          <button className="btn-link" disabled={busy || !draft.includes(": ")} onClick={() => apply([draft.trim()], [])}>
            Add
          </button>
          {tags.map((t) => (
            <button key={t} className="btn-link danger" disabled={busy} onClick={() => apply([], [t])}>
              Remove {t}
            </button>
          ))}
          <button className="btn-link" disabled={busy} onClick={() => { setEditing(false); setErr(null); }}>Done</button>
          <span className="muted">Name it “Dimension: value” so it groups with the others.</span>
        </span>
      )}
      {err && <span className="error-inline">{err}</span>}
    </p>
  );
}
