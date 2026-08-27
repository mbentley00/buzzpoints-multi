import { useEffect, useMemo, useState } from "react";
import { refreshIndex } from "../data";
import { byLabel } from "../util";

// Mirrors DEFAULT_ROUND_TAGS on the server.
const DEFAULTS = ["Prelims", "Playoffs", "Finals", "Superplayoffs", "Tiebreakers"];

type RoundTags = Record<string, string[]>;
interface RoundTagsDoc { all?: RoundTags; editions?: Record<string, RoundTags> }
interface EdRounds { id: string; label: string; rounds: number[] }

// The schedule being edited: "all" is the shared one, otherwise an edition id.
const SHARED = "all";

// Owner-only editor for assigning tags ("phases") to rounds. Saving re-aggregates
// the set and updates the phase filter shown to all viewers.
//
// Mirrors often run different schedules — one site plays nine prelim packets and
// three playoff packets, another eight and four — so each edition can have its own
// schedule. An edition without one follows the shared schedule; giving it one
// replaces the shared schedule for that edition rather than adding to it.
export function RoundTagsEditor({ slug, rounds }: { slug: string; rounds: number[] }) {
  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState<RoundTagsDoc>({});
  const [savedDoc, setSavedDoc] = useState<RoundTagsDoc>({});
  const [editions, setEditions] = useState<EdRounds[]>([]);
  const [target, setTarget] = useState<string>(SHARED);
  const [custom, setCustom] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/manage?slug=${encodeURIComponent(slug)}&op=roundtags`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed to load round tags");
        setDoc(d.roundTags || {});
        setSavedDoc(d.roundTags || {});
        setEditions(d.editions || []);
      })
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [slug]);

  const multi = editions.length > 1;
  const shared = doc.all || {};
  const ownSchedule = target !== SHARED && !!doc.editions?.[target];
  // What's actually being edited. An edition with no schedule of its own shows
  // the shared one read-only, so it's obvious what it's inheriting.
  const current: RoundTags = target === SHARED ? shared : doc.editions?.[target] ?? shared;
  const editable = target === SHARED || ownSchedule;

  // Only the rounds this edition actually played — that's the whole point of a
  // per-edition schedule. The shared one covers every round in the tournament.
  const shownRounds = useMemo(() => {
    if (target === SHARED) return rounds;
    return editions.find((e) => e.id === target)?.rounds ?? rounds;
  }, [target, editions, rounds]);

  // Tag vocabulary: defaults + every tag assigned anywhere + locally-added customs.
  const vocab = useMemo(() => {
    const s = new Set<string>(DEFAULTS);
    const eat = (rt: RoundTags) => Object.values(rt).forEach((arr) => arr.forEach((t) => s.add(t)));
    eat(shared);
    Object.values(doc.editions || {}).forEach(eat);
    custom.forEach((t) => s.add(t));
    return [...s];
  }, [doc, shared, custom]);

  const setCurrent = (next: RoundTags) =>
    setDoc((d) =>
      target === SHARED
        ? { ...d, all: next }
        : { ...d, editions: { ...(d.editions || {}), [target]: next } }
    );

  const toggle = (rnd: number, tag: string) => {
    const cur = current[String(rnd)] || [];
    const next = { ...current };
    const after = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag];
    if (after.length) next[String(rnd)] = after;
    else delete next[String(rnd)];
    setCurrent(next);
  };

  // Start this edition on its own schedule, seeded from the shared one so the
  // owner edits the differences rather than rebuilding from scratch.
  const detach = () => setCurrent({ ...shared });
  const reattach = () =>
    setDoc((d) => {
      const eds = { ...(d.editions || {}) };
      delete eds[target];
      return { ...d, editions: eds };
    });

  const addCustom = () => {
    const t = newTag.trim();
    if (t && !vocab.some((v) => v.toLowerCase() === t.toLowerCase())) setCustom((c) => [...c, t]);
    setNewTag("");
  };

  // Only the schedule on screen is saved, so dirtiness is measured against it.
  const savedCurrent = target === SHARED ? savedDoc.all || {} : savedDoc.editions?.[target];
  const dirty = JSON.stringify(current) !== JSON.stringify(savedCurrent ?? (target === SHARED ? {} : undefined));

  async function save() {
    setBusy(true); setErr(""); setMsg("");
    try {
      // An edition back on the shared schedule saves an empty map, which the
      // server reads as "drop the override".
      const roundTags = target !== SHARED && !ownSchedule ? {} : current;
      const r = await fetch("/api/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "roundtags", roundTags, ...(target === SHARED ? {} : { editionId: target }) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      setDoc(d.roundTags || {});
      setSavedDoc(d.roundTags || {});
      refreshIndex();
      setMsg("Round phases saved. Reload the tournament to use the phase filter.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading round phases…</p>;

  const targetLabel = target === SHARED ? "all editions" : editions.find((e) => e.id === target)?.label ?? target;

  return (
    <div className="roundtags">
      {err && <div className="error-box">{err}</div>}
      {msg && <div className="caveat"><span className="ok-msg">{msg}</span></div>}

      {multi && (
        <div className="rt-scope">
          <label className="field-inline">
            <span>Phase schedule for</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value={SHARED}>All editions (shared)</option>
              {byLabel(editions).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}{doc.editions?.[e.id] ? " — own schedule" : ""}
                </option>
              ))}
            </select>
          </label>
          {target === SHARED ? (
            <small className="muted">
              Every edition follows this unless you give it its own schedule.
              {Object.keys(doc.editions || {}).length > 0 &&
                ` ${Object.keys(doc.editions!).length} edition(s) already have one and won't be affected.`}
            </small>
          ) : ownSchedule ? (
            <small className="muted">
              This edition runs its own schedule — the shared one doesn't apply to it.{" "}
              <button type="button" className="btn-link" onClick={reattach}>Go back to the shared schedule</button>
            </small>
          ) : (
            <small className="muted">
              Following the shared schedule (shown below, read-only).{" "}
              <button type="button" className="btn-link" onClick={detach}>Give this edition its own schedule</button>
            </small>
          )}
        </div>
      )}

      <div className="rt-rounds">
        {shownRounds.map((rnd) => (
          <div className={"rt-row" + (editable ? "" : " rt-row-locked")} key={rnd}>
            <span className="rt-round">Round {rnd}</span>
            <div className="rt-chips">
              {vocab.map((tag) => {
                const on = (current[String(rnd)] || []).includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className={"tag-chip" + (on ? " on" : "")}
                    disabled={!editable}
                    onClick={() => toggle(rnd, tag)}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {shownRounds.length === 0 && <p className="muted">This edition has no rounds yet.</p>}
      </div>

      <div className="rt-actions">
        <input
          type="text"
          className="rt-newtag"
          placeholder="Add a custom tag…"
          value={newTag}
          disabled={!editable}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
        />
        <button type="button" className="mini-btn" onClick={addCustom} disabled={!editable || !newTag.trim()}>Add tag</button>
        <button className="btn-primary btn-sm" disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving…" : multi ? `Save ${targetLabel} & rebuild` : "Save phases & rebuild"}
        </button>
      </div>
    </div>
  );
}
