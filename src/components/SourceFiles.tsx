import { useEffect, useMemo, useState } from "react";
import { clearSetCache, refreshIndex } from "../data";
import { RoundWarning, Rename, renameKind } from "../types";
import { roundLabel, parseRoundInput } from "../util";

// Owner-only repair tools for a tournament's uploaded files.
//
//   RoundAlignEditor — a packet's round is read from its FILENAME, so a packet
//   named without a number ("Taylor_SMTMT.json") lands on round 0 while its
//   games sit on round 1; the questions then show 0 heard forever. This lets the
//   owner renumber a packet after the fact instead of re-uploading.
//
//   GameFilesEditor — uploads APPEND to an edition, so re-uploading the same
//   files makes every team look like it played the same games twice. This lists
//   the stored games and removes the ones the owner picks.

interface PacketRow { index: number; round: number; tossups: number; bonuses: number; sample: string }
interface EditionRounds { id: string; label: string; packets: PacketRow[]; gameRounds: { round: number; count: number }[]; warnings: RoundWarning[] }
interface GameRow { index: number; round: number; teams: string[]; tossups: number; copy: number; copies: number }
interface EditionGames { id: string; label: string; games: GameRow[] }

async function post(body: unknown) {
  const r = await fetch("/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}
async function load<T>(slug: string, op: string): Promise<T> {
  const r = await fetch(`/api/manage?slug=${encodeURIComponent(slug)}&op=${op}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d as T;
}

export function warningText(w: RoundWarning): string {
  if (w.kind === "packet-unplayed")
    return `Packet round ${roundLabel(w.round)} (${w.tossups} question${w.tossups === 1 ? "" : "s"}) has no games — nothing was ever read from it, so every question there shows 0 heard.`;
  if (w.kind === "games-unmatched")
    return `${w.games} game${w.games === 1 ? "" : "s"} were played in round ${roundLabel(w.round)}, but no packet is filed under that round, so their buzzes have no questions to attach to.`;
  return `${w.files} packet files share round ${roundLabel(w.round)} — only the last one's questions survive; the rest are silently dropped.`;
}

// Stats are stale the moment the source changes, so blow away the cached JSON
// and reload rather than trying to patch the page in place.
function applied(slug: string) {
  clearSetCache(slug);
  refreshIndex();
  window.location.reload();
}

export function RoundAlignEditor({ slug }: { slug: string }) {
  const [editions, setEditions] = useState<EditionRounds[] | null>(null);
  // packet index -> the round the owner typed, keyed `${editionId}:${index}`
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    load<{ editions: EditionRounds[] }>(slug, "rounds")
      .then((d) => setEditions(d.editions || []))
      .catch((e) => setErr(String(e.message || e)));
  }, [slug]);

  const roundOf = (edId: string, p: PacketRow) => {
    const v = edits[`${edId}:${p.index}`];
    return v === undefined ? roundLabel(p.round) : v;
  };
  const changesFor = (ed: EditionRounds) => {
    const out: Record<number, number> = {};
    for (const p of ed.packets) {
      const r = parseRoundInput(roundOf(ed.id, p));
      if (r === null) continue;
      if (r !== p.round) out[p.index] = r;
    }
    return out;
  };
  const invalid = (ed: EditionRounds) => ed.packets.some((p) => parseRoundInput(roundOf(ed.id, p)) === null);

  // "Apply suggested" fills every packet whose orphaned round the server could
  // pair with an unmatched game round.
  function useSuggestions(ed: EditionRounds) {
    const byRound = new Map<number, number>();
    for (const w of ed.warnings) if (w.kind === "packet-unplayed" && w.suggested !== null) byRound.set(w.round, w.suggested);
    setEdits((e) => {
      const next = { ...e };
      for (const p of ed.packets) { const s = byRound.get(p.round); if (s !== undefined) next[`${ed.id}:${p.index}`] = roundLabel(s); }
      return next;
    });
  }

  async function save(ed: EditionRounds) {
    const rounds = changesFor(ed);
    setBusy(true); setErr("");
    try {
      await post({ slug, op: "remap-rounds", editionId: ed.id, rounds });
      applied(slug);
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  }

  if (err && !editions) return <div className="error-box">{err}</div>;
  if (!editions) return <p className="muted">Loading packets…</p>;
  if (!editions.length) return <p className="muted">No packets uploaded.</p>;

  return (
    <div className="srcfiles">
      {err && <div className="error-box">{err}</div>}
      {editions.map((ed) => {
        const suggestable = ed.warnings.some((w) => w.kind === "packet-unplayed" && w.suggested !== null);
        const changed = Object.keys(changesFor(ed)).length;
        return (
          <div className="srcfiles-ed" key={ed.id}>
            {editions.length > 1 && <h3 className="srcfiles-ed-name">{ed.label}</h3>}
            {ed.warnings.length > 0 && (
              <ul className="srcfiles-warn">
                {ed.warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}
              </ul>
            )}
            <p className="muted srcfiles-note">
              Games were played in round{ed.gameRounds.length === 1 ? "" : "s"}{" "}
              <strong>{ed.gameRounds.length ? ed.gameRounds.map((g) => roundLabel(g.round)).join(", ") : "— (no games)"}</strong>. A
              packet only collects buzzes when its round matches the round its games were played in.
            </p>
            <table className="data-table srcfiles-table">
              <thead>
                <tr><th className="right">Round</th><th className="right">Tossups</th><th className="right">Bonuses</th><th>First answer</th><th className="right">Games</th></tr>
              </thead>
              <tbody>
                {ed.packets.map((p) => {
                  const cur = roundOf(ed.id, p);
                  const parsed = parseRoundInput(cur);
                  const games = ed.gameRounds.find((g) => g.round === parsed)?.count ?? 0;
                  const bad = parsed === null;
                  return (
                    <tr key={p.index} className={parsed !== p.round ? "srcfiles-dirty" : undefined}>
                      <td className="right">
                        {/* Text, not number: a lettered packet ("A") is a valid round here. */}
                        <input
                          className="num-input" type="text" value={cur} style={{ width: 70 }}
                          onChange={(e) => setEdits((s) => ({ ...s, [`${ed.id}:${p.index}`]: e.target.value }))}
                        />
                      </td>
                      <td className="right mono">{p.tossups}</td>
                      <td className="right mono">{p.bonuses}</td>
                      <td className="srcfiles-sample">{p.sample || <span className="muted">—</span>}</td>
                      <td className="right mono">
                        {bad ? <span className="error-inline">?</span> : games === 0 ? <span className="error-inline">0</span> : games}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="srcfiles-actions">
              {suggestable && <button type="button" className="mini-btn" onClick={() => useSuggestions(ed)}>Use suggested rounds</button>}
              <button className="btn-primary btn-sm" disabled={busy || !changed || invalid(ed)} onClick={() => save(ed)}>
                {busy ? "Saving…" : changed ? `Save ${changed} change${changed === 1 ? "" : "s"} & rebuild` : "No changes"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Player and team renames applied to this set, with an undo. Renames are applied
// from a player's or team's page (by the owner, or proposed by a viewer and
// approved on the Corrections page); this is where they can be taken back.
export function RenamesEditor({ slug }: { slug: string }) {
  const [renames, setRenames] = useState<Rename[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    load<{ renames: Rename[] }>(slug, "renames")
      .then((d) => setRenames(d.renames || []))
      .catch((e) => setErr(String(e.message || e)));
  }, [slug]);

  async function undo(r: Rename) {
    if (!window.confirm(`Undo the rename of "${r.from}" to "${r.to}"? The stats go back to the original spelling.`)) return;
    setBusy(true); setErr("");
    try {
      const d = await fetch("/api/correct", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, undoRename: { kind: renameKind(r), from: r.from, team: r.team ?? null } }),
      });
      const j = await d.json().catch(() => ({}));
      if (!d.ok) throw new Error((j as any).error || `Failed (${d.status})`);
      applied(slug);
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  }

  if (err && !renames) return <div className="error-box">{err}</div>;
  if (!renames) return <p className="muted">Loading renames…</p>;
  if (!renames.length)
    return <p className="muted">Nothing has been renamed. Use “Rename player” on a player’s page, or “Rename team” on a team’s.</p>;

  return (
    <div className="srcfiles">
      {err && <div className="error-box">{err}</div>}
      <ul className="invite-list">
        {renames.map((r) => (
          <li key={`${renameKind(r)}|${r.team ?? ""}|${r.from}`}>
            <span>
              <strong>{r.from}</strong> → <strong>{r.to}</strong>{" "}
              <span className="muted">
                · {renameKind(r) === "team" ? "team" : r.team ?? "every team"}{r.by ? ` · by ${r.by}` : ""}
              </span>
            </span>
            <button className="btn-link danger" disabled={busy} onClick={() => undo(r)}>Undo</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GameFilesEditor({ slug }: { slug: string }) {
  const [editions, setEditions] = useState<EditionGames[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({}); // `${editionId}:${index}`
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    load<{ editions: EditionGames[] }>(slug, "games")
      .then((d) => setEditions(d.editions || []))
      .catch((e) => setErr(String(e.message || e)));
  }, [slug]);

  const dupCount = useMemo(
    () => (editions || []).reduce((n, ed) => n + ed.games.filter((g) => g.copy > 1).length, 0),
    [editions]
  );
  const pickedIn = (ed: EditionGames) => ed.games.filter((g) => picked[`${ed.id}:${g.index}`]);

  const toggle = (edId: string, index: number) =>
    setPicked((p) => ({ ...p, [`${edId}:${index}`]: !p[`${edId}:${index}`] }));
  const setMany = (rows: { edId: string; index: number }[], on: boolean) =>
    setPicked((p) => { const n = { ...p }; for (const r of rows) n[`${r.edId}:${r.index}`] = on; return n; });

  async function remove(ed: EditionGames) {
    const games = pickedIn(ed).map((g) => g.index);
    if (!games.length) return;
    const plural = games.length === 1 ? "this game" : `these ${games.length} games`;
    if (!window.confirm(`Remove ${plural} from "${ed.label}"? Stats are rebuilt without them. This can't be undone — you'd have to re-upload the files.`)) return;
    setBusy(true); setErr("");
    try {
      await post({ slug, op: "remove-files", editionId: ed.id, games });
      applied(slug);
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  }

  if (err && !editions) return <div className="error-box">{err}</div>;
  if (!editions) return <p className="muted">Loading games…</p>;
  if (!editions.some((e) => e.games.length)) return <p className="muted">No games uploaded.</p>;

  return (
    <div className="srcfiles">
      {err && <div className="error-box">{err}</div>}
      {dupCount > 0 && (
        <div className="srcfiles-warn srcfiles-warn-block">
          <strong>{dupCount} duplicate game{dupCount === 1 ? "" : "s"}.</strong> The same matchup is stored more than
          once in the same round — the usual cause is uploading the same files again (adding files <em>appends</em> to an
          edition rather than replacing it). Every extra copy inflates games played, tossups heard, and totals.
          <div style={{ marginTop: 8 }}>
            <button
              type="button" className="mini-btn"
              onClick={() => setMany((editions || []).flatMap((ed) => ed.games.filter((g) => g.copy > 1).map((g) => ({ edId: ed.id, index: g.index }))), true)}
            >
              Select every extra copy
            </button>
          </div>
        </div>
      )}
      {editions.map((ed) => {
        const sel = pickedIn(ed);
        const dupes = ed.games.filter((g) => g.copy > 1).length;
        return (
          <div className="srcfiles-ed" key={ed.id}>
            {ed.games.length === 0 ? (
              <>
                {editions.length > 1 && <h3 className="srcfiles-ed-name">{ed.label}</h3>}
                <p className="muted">No games in this edition.</p>
              </>
            ) : (
              // A full season is hundreds of rows; keep it folded away unless the
              // owner is actually here to prune it. Editions with duplicates open
              // on their own, since those are the ones needing attention.
              <details className="srcfiles-fold" open={dupes > 0}>
                <summary>
                  {editions.length > 1 ? `${ed.label} — ` : ""}
                  {ed.games.length} game{ed.games.length === 1 ? "" : "s"}
                  {dupes > 0 && <span className="srcfiles-fold-warn"> · {dupes} duplicate{dupes === 1 ? "" : "s"}</span>}
                  {sel.length > 0 && <span className="muted"> · {sel.length} selected</span>}
                </summary>
                <div className="srcfiles-scroll">
                <table className="data-table srcfiles-table">
                  <thead>
                    <tr><th className="srcfiles-check"></th><th className="right">Round</th><th>Teams</th><th className="right">TUH</th><th>Copy</th></tr>
                  </thead>
                  <tbody>
                    {ed.games.map((g) => (
                      <tr key={g.index} className={g.copy > 1 ? "srcfiles-dupe" : undefined}>
                        <td className="srcfiles-check">
                          <input type="checkbox" checked={!!picked[`${ed.id}:${g.index}`]} onChange={() => toggle(ed.id, g.index)} />
                        </td>
                        <td className="right mono">{roundLabel(g.round)}</td>
                        <td>{g.teams.join(" vs ") || <span className="muted">—</span>}</td>
                        <td className="right mono">{g.tossups}</td>
                        <td className="mono">{g.copies > 1 ? `${g.copy} of ${g.copies}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <div className="srcfiles-actions">
                  <button type="button" className="mini-btn" onClick={() => setMany(ed.games.map((g) => ({ edId: ed.id, index: g.index })), true)}>Select all</button>
                  <button type="button" className="mini-btn" onClick={() => setMany(ed.games.map((g) => ({ edId: ed.id, index: g.index })), false)}>Clear</button>
                  <button className="btn-primary btn-sm danger-btn" disabled={busy || !sel.length} onClick={() => remove(ed)}>
                    {busy ? "Removing…" : sel.length ? `Remove ${sel.length} game${sel.length === 1 ? "" : "s"} & rebuild` : "Remove selected"}
                  </button>
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
