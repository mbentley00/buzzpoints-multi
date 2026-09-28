import { useEffect, useMemo, useState } from "react";
import { loadSetJson, clearSetCache } from "../data";
import { GameRow, PlayerRow, TeamRow } from "../types";
import { findDuplicates, PlayerPair, TeamPair } from "../dupes";

// Suggested merges for teams and players spelled differently from sheet to
// sheet. Nothing merges until the owner ticks it; each merge is an ordinary
// rename (listed under "Applied renames" and undoable there). Teams go first,
// since two spellings of one person on two spellings of one team only become
// the same row once the teams are one.

type Pick = { swap: boolean; on: boolean };
const pairKey = (kind: string, a: string, b: string, team = "") => `${kind}|${team}|${[a, b].sort().join("|")}`;

export function DupeFinder({ slug, individual }: { slug: string; individual: boolean }) {
  const [bust, setBust] = useState(0);
  const [data, setData] = useState<{ teams: TeamPair[]; players: PlayerPair[] } | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dismissKey = `dupes-dismissed:${slug}`;
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(dismissKey) || "[]")); } catch { return new Set(); }
  });

  useEffect(() => {
    let live = true;
    setData(null);
    Promise.all([
      loadSetJson<TeamRow[]>(slug, "teams.json", bust),
      loadSetJson<PlayerRow[]>(slug, "players.json", bust),
      loadSetJson<GameRow[]>(slug, "games.json", bust).catch(() => [] as GameRow[]),
    ]).then(([t, p, g]) => {
      if (!live) return;
      const found = findDuplicates(
        t.map((x) => ({ name: x.name, games: x.games })),
        p.map((x) => ({ name: x.name, team: x.team, games: x.games })),
        g.map((x) => ({ round: x.round, editionId: x.editionId, teams: x.teams.map((tm: any) => ({ name: tm.name, players: tm.players })) })),
      );
      // In a shootout every player is their own team, so only player merges make sense.
      setData(individual ? { teams: [], players: found.players } : found);
    }).catch((e) => live && setErr(String((e as Error).message || e)));
    return () => { live = false; };
  }, [slug, bust, individual]);

  const dismiss = (k: string) => setDismissed((d) => {
    const n = new Set(d); n.add(k);
    try { localStorage.setItem(dismissKey, JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });
  const teams = useMemo(() => (data?.teams ?? []).filter((p) => !dismissed.has(pairKey("t", p.a.name, p.b.name))), [data, dismissed]);
  const players = useMemo(() => (data?.players ?? []).filter((p) => !dismissed.has(pairKey("p", p.a.name, p.b.name, p.team))), [data, dismissed]);
  const pick = (k: string) => picks[k] ?? { swap: false, on: false };
  const setPick = (k: string, v: Partial<Pick>) => setPicks((m) => ({ ...m, [k]: { ...pick(k), ...v } }));

  async function mergeTicked() {
    const todo = [
      ...teams.filter((p) => pick(pairKey("t", p.a.name, p.b.name)).on).map((p) => {
        const s = pick(pairKey("t", p.a.name, p.b.name)).swap;
        return { kind: "team" as const, from: s ? p.a.name : p.b.name, to: s ? p.b.name : p.a.name, team: null };
      }),
      ...players.filter((p) => pick(pairKey("p", p.a.name, p.b.name, p.team)).on).map((p) => {
        const s = pick(pairKey("p", p.a.name, p.b.name, p.team)).swap;
        return { kind: "player" as const, from: s ? p.a.name : p.b.name, to: s ? p.b.name : p.a.name, team: individual ? null : p.team };
      }),
    ];
    if (!todo.length) return;
    setBusy(true); setErr(null);
    const fails: string[] = [];
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i];
      setStatus(`Merging ${i + 1} of ${todo.length}: “${r.from}” into “${r.to}”…`);
      try {
        const res = await fetch("/api/correct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, rename: r }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((d as { error?: string }).error || `Failed (${res.status})`);
      } catch (e) { fails.push(`“${r.from}”: ${(e as Error).message}`); }
    }
    clearSetCache(slug);
    setPicks({});
    setBust((b) => b + 1);
    setStatus(`Merged ${todo.length - fails.length} of ${todo.length}. Suggestions below are refreshed — merging teams can reveal more player pairs.`);
    if (fails.length) setErr(fails.join("; "));
    setBusy(false);
  }

  const nTicked = teams.filter((p) => pick(pairKey("t", p.a.name, p.b.name)).on).length +
    players.filter((p) => pick(pairKey("p", p.a.name, p.b.name, p.team)).on).length;

  const Row = ({ k, keep, drop, why, extra }: { k: string; keep: string; drop: string; why: string; extra?: string }) => {
    const pk = pick(k);
    const [to, from] = pk.swap ? [drop, keep] : [keep, drop];
    return (
      <tr className={pk.on ? "row-picked" : ""}>
        <td><input type="checkbox" checked={pk.on} disabled={busy} onChange={(e) => setPick(k, { on: e.target.checked })} aria-label={`Merge ${from} into ${to}`} /></td>
        <td>
          <span className="muted">“{from}”</span> → <strong>“{to}”</strong>
          {extra && <span className="muted"> · {extra}</span>}
          <div className="muted" style={{ fontSize: 12 }}>{why}</div>
        </td>
        <td className="admin-actions">
          <button className="btn-link" disabled={busy} onClick={() => setPick(k, { swap: !pk.swap })} title="Keep the other spelling">Swap</button>
          <button className="btn-link" disabled={busy} onClick={() => dismiss(k)} title="Not the same — stop suggesting this">Dismiss</button>
        </td>
      </tr>
    );
  };

  if (err && !data) return <div className="error-box">{err}</div>;
  if (!data) return <p className="muted">Looking for likely duplicates…</p>;
  if (!teams.length && !players.length) return <p className="muted">No likely duplicates found.</p>;

  return (
    <div className="dupe-finder">
      {teams.length > 0 && (
        <>
          <h3 className="settings-sub">Teams ({teams.length})</h3>
          <div className="table-wrap"><table className="data-table"><tbody>
            {teams.map((p) => (
              <Row key={pairKey("t", p.a.name, p.b.name)} k={pairKey("t", p.a.name, p.b.name)} keep={p.a.name} drop={p.b.name}
                why={p.why} extra={`${p.a.games} + ${p.b.games} games`} />
            ))}
          </tbody></table></div>
        </>
      )}
      {players.length > 0 && (
        <>
          <h3 className="settings-sub">Players ({players.length})</h3>
          <div className="table-wrap"><table className="data-table"><tbody>
            {players.map((p) => (
              <Row key={pairKey("p", p.a.name, p.b.name, p.team)} k={pairKey("p", p.a.name, p.b.name, p.team)} keep={p.a.name} drop={p.b.name}
                why={p.why} extra={individual ? undefined : p.team} />
            ))}
          </tbody></table></div>
        </>
      )}
      <div className="cat-toolbar" style={{ marginTop: 10 }}>
        <button className="btn-primary btn-sm" disabled={busy || !nTicked} onClick={mergeTicked}>
          {busy ? "Merging…" : nTicked ? `Merge ${nTicked} ticked` : "Tick the ones to merge"}
        </button>
        {dismissed.size > 0 && (
          <button className="btn-link" disabled={busy} onClick={() => { setDismissed(new Set()); try { localStorage.removeItem(dismissKey); } catch { /* ignore */ } }}>
            show {dismissed.size} dismissed
          </button>
        )}
      </div>
      {status && <p className="muted">{status}</p>}
      {err && <div className="error-box">{err}</div>}
    </div>
  );
}
