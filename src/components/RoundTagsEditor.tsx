import { useEffect, useMemo, useState } from "react";
import { refreshIndex } from "../data";

// Mirrors DEFAULT_ROUND_TAGS on the server.
const DEFAULTS = ["Prelims", "Playoffs", "Finals", "Superplayoffs", "Tiebreakers"];

type RoundTags = Record<string, string[]>;

// Owner-only editor for assigning tags ("phases") to rounds. Saving re-aggregates
// the set and updates the phase filter shown to all viewers.
export function RoundTagsEditor({ slug, rounds }: { slug: string; rounds: number[] }) {
  const [loading, setLoading] = useState(true);
  const [roundTags, setRoundTags] = useState<RoundTags>({});
  const [saved, setSaved] = useState<RoundTags>({});
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
        setRoundTags(d.roundTags || {});
        setSaved(d.roundTags || {});
      })
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [slug]);

  // Tag vocabulary: defaults + every tag already assigned + locally-added customs.
  const vocab = useMemo(() => {
    const s = new Set<string>(DEFAULTS);
    Object.values(roundTags).forEach((arr) => arr.forEach((t) => s.add(t)));
    custom.forEach((t) => s.add(t));
    return [...s];
  }, [roundTags, custom]);

  const toggle = (rnd: number, tag: string) =>
    setRoundTags((rt) => {
      const cur = rt[String(rnd)] || [];
      const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag];
      const copy = { ...rt };
      if (next.length) copy[String(rnd)] = next;
      else delete copy[String(rnd)];
      return copy;
    });

  const addCustom = () => {
    const t = newTag.trim();
    if (t && !vocab.some((v) => v.toLowerCase() === t.toLowerCase())) setCustom((c) => [...c, t]);
    setNewTag("");
  };

  const dirty = JSON.stringify(roundTags) !== JSON.stringify(saved);

  async function save() {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await fetch("/api/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "roundtags", roundTags }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      setSaved(roundTags);
      refreshIndex();
      setMsg("Round phases saved. Reload the tournament to use the phase filter.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading round phases…</p>;

  return (
    <div className="roundtags">
      {err && <div className="error-box">{err}</div>}
      {msg && <div className="caveat"><span className="ok-msg">{msg}</span></div>}
      <div className="rt-rounds">
        {rounds.map((rnd) => (
          <div className="rt-row" key={rnd}>
            <span className="rt-round">Round {rnd}</span>
            <div className="rt-chips">
              {vocab.map((tag) => {
                const on = (roundTags[String(rnd)] || []).includes(tag);
                return (
                  <button key={tag} type="button" className={"tag-chip" + (on ? " on" : "")} onClick={() => toggle(rnd, tag)}>
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="rt-actions">
        <input
          type="text"
          className="rt-newtag"
          placeholder="Add a custom tag…"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
        />
        <button type="button" className="mini-btn" onClick={addCustom} disabled={!newTag.trim()}>Add tag</button>
        <button className="btn-primary btn-sm" disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving…" : "Save phases & rebuild"}
        </button>
      </div>
    </div>
  );
}
