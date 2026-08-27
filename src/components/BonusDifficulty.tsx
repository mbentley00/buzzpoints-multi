import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { clearSetCache } from "../data";
import { BonusDiffWarning, BonusDiffFix } from "../types";
import { primaryAnswer, roundLabel, pct, Html } from "../util";

// Owner-only repair for a bonus whose difficulty marks can't be right.
//
// A three-part bonus is written easy, medium and hard. A packet that tags one
// "medium, easy, easy" has mistyped a mark, and nothing downstream can tell:
// the bonus lands in a difficulty order nobody wrote, its real hard part is
// counted as an easy one, and the set's easy/medium/hard conversion is averaged
// with a part that was never easy. The Difficulty Order page is where it becomes
// visible, because that view groups by exactly the string that went wrong.
//
// The fix is stored beside the source rather than written into it, like every
// other repair here, so re-uploading a corrected packet doesn't leave an old
// override fighting it — and a fix that agrees with the packet is dropped.

const MARKS: { value: string; label: string }[] = [
  { value: "e", label: "Easy" },
  { value: "m", label: "Medium" },
  { value: "h", label: "Hard" },
  { value: "", label: "— unmarked" },
];
const MARK_LABEL: Record<string, string> = { e: "Easy", m: "Medium", h: "Hard" };
const markWord = (m: string) => MARK_LABEL[m] || "unmarked";
const marksLine = (mods: string[]) => mods.map(markWord).join(", ");

// Why this bonus is listed, in the owner's terms rather than the scan's.
const KIND_HEAD: Record<BonusDiffWarning["kind"], string> = {
  duplicate: "Marks don't add up",
  unknown: "Unrecognized mark",
  partial: "Partly marked",
  unmarked: "No marks",
};

async function post(body: unknown) {
  const r = await fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `Failed (${r.status})`);
  return d as Record<string, any>;
}

export function BonusDifficultyEditor({ slug, warnings }: { slug: string; warnings: BonusDiffWarning[] }) {
  // The list re-scans server-side on every save, so a fixed bonus leaves the list
  // and a fix that didn't help stays on it — without a page reload mid-repair.
  const [rows, setRows] = useState<BonusDiffWarning[]>(warnings);
  useEffect(() => setRows(warnings), [warnings]);
  const [fixes, setFixes] = useState<Record<string, BonusDiffFix> | null>(null);
  // What the owner has typed but not saved: bonus id -> one mark per part.
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch(`/api/manage?slug=${encodeURIComponent(slug)}&op=bonusdiff`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (!ok) throw new Error(d.error || "Failed to load"); setFixes(d.bonusDiffs || {}); })
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [slug]);

  const marksOf = (w: BonusDiffWarning) => edits[w.id] ?? w.mods;
  const changed = useMemo(
    () => rows.filter((w) => edits[w.id] && edits[w.id].some((m, i) => m !== (w.mods[i] || ""))),
    [rows, edits]
  );
  // Fixes already applied. These have dropped off the warning list — that's the
  // point of them — so they're listed separately, with what the packet said, so
  // a wrong fix can be put back.
  const applied = useMemo(
    () => Object.entries(fixes || {}).sort((a, b) => {
      const [ar, an] = a[0].split("-").map(Number), [br, bn] = b[0].split("-").map(Number);
      return ar - br || an - bn;
    }),
    [fixes]
  );

  const setMark = (id: string, i: number, v: string, mods: string[]) =>
    setEdits((e) => {
      const cur = [...(e[id] ?? mods)];
      cur[i] = v;
      return { ...e, [id]: cur };
    });

  function useSuggestions() {
    setEdits((e) => {
      const next = { ...e };
      for (const w of rows) if (w.suggested) next[w.id] = [...w.suggested];
      return next;
    });
  }

  async function save(only?: string) {
    const list = only ? changed.filter((w) => w.id === only) : changed;
    if (!list.length) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const d = await post({ slug, op: "bonus-difficulty", edits: Object.fromEntries(list.map((w) => [w.id, marksOf(w)])) });
      setFixes(d.bonusDiffs || {});
      setRows(d.bonusDiffWarnings || []);
      setEdits({});
      // Every difficulty figure in the set was just rebuilt on the new marks.
      clearSetCache(slug);
      setMsg(`Saved. ${list.length} bonus${list.length === 1 ? "" : "es"} re-marked and the stats rebuilt.`);
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  async function restore(id: string) {
    setBusy(true); setErr(""); setMsg("");
    try {
      const d = await post({ slug, op: "bonus-difficulty", edits: { [id]: null } });
      setFixes(d.bonusDiffs || {});
      setRows(d.bonusDiffWarnings || []);
      clearSetCache(slug);
      setMsg(`Bonus ${id} is back to the marks the packet gave it.`);
    } catch (e) { setErr(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  const suggestable = rows.some((w) => w.suggested);

  return (
    <div className="srcfiles bndiff">
      {err && <div className="error-box">{err}</div>}
      {msg && <p className="ok-msg">{msg}</p>}

      {rows.length === 0 && (
        <p className="muted">
          Nothing to fix — every bonus in this tournament carries one easy, one medium and one hard part.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="bndiff-actions">
            {suggestable && (
              <button className="btn-sm" disabled={busy} onClick={useSuggestions}>
                Fill in what conversion says
              </button>
            )}
            <button className="btn-primary" disabled={busy || !changed.length} onClick={() => save()}>
              {changed.length ? `Save ${changed.length} fix${changed.length === 1 ? "" : "es"} & rebuild` : "Save & rebuild"}
            </button>
          </div>
          <p className="muted srcfiles-note">
            Saving re-marks the parts and rebuilds every figure built on them. The packet file itself isn't touched, so
            uploading a corrected packet later replaces the fix rather than fighting it.
          </p>
          <div className="table-wrap">
            <table className="data-table srcfiles-table bndiff-table">
              <thead>
                <tr>
                  <th>Bonus</th>
                  <th>Problem</th>
                  <th className="right">Heard</th>
                  <th>Parts — answer, conversion, and the mark it should carry</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const mods = marksOf(w);
                  const dirty = mods.some((m, i) => m !== (w.mods[i] || ""));
                  return (
                    <tr key={w.id} className={dirty ? "srcfiles-dirty" : undefined}>
                      <td>
                        <Link className="link" to={`/set/${slug}/bonus/${w.id}`}>
                          Round {roundLabel(w.round)}, bonus {w.num}
                        </Link>
                      </td>
                      <td>
                        <span className="bndiff-kind">{KIND_HEAD[w.kind]}</span>
                        <small className="muted bndiff-reason">{w.reason}</small>
                      </td>
                      <td className="right mono">{w.heard}</td>
                      <td>
                        <ol className="bndiff-parts">
                          {mods.map((m, i) => {
                            // The answer line is the same trusted markup the rest
                            // of the app renders — bold and underline mark what a
                            // reader has to say, so an escaped "<b><u>" here made
                            // the one thing this table is for hard to read.
                            const ans = primaryAnswer(w.answers[i] || "");
                            return (
                              <li key={i}>
                                {ans
                                  ? <Html className="bndiff-answer" html={ans} />
                                  : <em className="bndiff-answer muted">(no answer line)</em>}
                                <span className="bndiff-conv mono">{w.convPct[i] === null ? "—" : pct(w.convPct[i])}</span>
                                <select
                                  className="bndiff-select"
                                  value={m}
                                  disabled={busy}
                                  aria-label={`Difficulty mark for part ${i + 1}`}
                                  onChange={(e) => setMark(w.id, i, e.target.value, w.mods)}
                                >
                                  {MARKS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                                {w.suggested && w.suggested[i] !== m && (
                                  <small className="muted bndiff-hint">conversion says {markWord(w.suggested[i])}</small>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                        {dirty && (
                          <div className="bndiff-row-actions">
                            <button className="btn-sm" disabled={busy} onClick={() => save(w.id)}>Save this one</button>
                            <button className="btn-link" disabled={busy} onClick={() => setEdits((e) => { const n = { ...e }; delete n[w.id]; return n; })}>
                              Undo
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {applied.length > 0 && (
        <>
          <h3 className="srcfiles-ed-name">Fixes you've applied ({applied.length})</h3>
          <ul className="bndiff-applied">
            {applied.map(([id, f]) => (
              <li key={id}>
                <Link className="link" to={`/set/${slug}/bonus/${id}`}>Round {roundLabel(Number(id.split("-")[0]))}, bonus {id.split("-")[1]}</Link>
                <span className="muted">
                  {" "}— now <strong>{marksLine(f.mods)}</strong>
                  {f.from?.length ? <>, was <span className="bndiff-was">{marksLine(f.from)}</span></> : <> — the packet marked nothing</>}
                </span>
                <button className="btn-link" disabled={busy} onClick={() => restore(id)}>Put the packet's marks back</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {fixes === null && <p className="muted">Loading applied fixes…</p>}
    </div>
  );
}
