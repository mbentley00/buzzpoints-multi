import { useMemo, useState } from "react";
import { refreshIndex } from "../data";
import { uploadFiles } from "../upload";
import { FileDrop } from "./FileDrop";
import { roundLabel, roundFromFileName } from "../util";

// Add rounds to a tournament that already exists — a league playing a round a
// week, a tournament finishing on a second day, a round that has to be redone.
//
// This lives on its own so it can appear both on Editions (where a set with
// mirrors manages them) and in Settings next to the tools that remove rounds.
// It was only ever on the Editions page before, under a heading about mirrors,
// which is a hard place to find when what you have is one tournament and one
// more week of it.
export function AddFilesForm({ slug, editions }: { slug: string; editions: { id: string; label: string }[] }) {
  const [intoId, setIntoId] = useState(editions[0]?.id ?? "");
  const [packets, setPackets] = useState<File[]>([]);
  const [games, setGames] = useState<File[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);

  // Which rounds the chosen filenames cover — what "replace" would overwrite.
  const rounds = useMemo(() => {
    const rs = new Set<number>();
    for (const f of [...packets, ...games]) {
      const r = roundFromFileName(f.name);
      if (r !== null) rs.add(r);
    }
    return [...rs].sort((a, b) => a - b);
  }, [packets, games]);
  const unnamedRound = [...packets, ...games].some((f) => roundFromFileName(f.name) === null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!intoId) { setErr("Pick an edition."); return; }
    if (!packets?.length && !games?.length) { setErr("Choose packet and/or game files to add."); return; }
    setBusy(true);
    try {
      const packetRefs = packets.length ? await uploadFiles(packets, (d, t) => setStatus(`Uploading packets… ${d}/${t}`)) : [];
      const gameRefs = games.length ? await uploadFiles(games, (d, t) => setStatus(`Uploading games… ${d}/${t}`)) : [];
      setStatus("Aggregating…");
      const r = await fetch("/api/ingest", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ editionOf: slug, editionId: intoId, packets: packetRefs, games: gameRefs, replaceRound: replace }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      refreshIndex();
      window.location.reload();
    } catch (e) {
      setErr(String((e as Error).message || e)); setBusy(false); setStatus(null);
    }
  }

  return (
    <form className="create-form" onSubmit={submit} style={{ maxWidth: 520 }}>
      {editions.length > 1 && (
        <label className="field">
          <span>Edition</span>
          <select value={intoId} onChange={(e) => setIntoId(e.target.value)}>
            {editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </label>
      )}
      <div className="field">
        <span>Packet files <span className="muted">(optional)</span></span>
        <FileDrop accept=".json" value={packets} onChange={setPackets} hint="One JSON per round" />
      </div>
      <div className="field">
        <span>Game files (QBJ) <span className="muted">(optional)</span></span>
        <FileDrop accept=".json,.qbj" value={games} onChange={setGames} hint="QBJ match files" />
      </div>
      <label className="field-inline" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
        <span style={{ fontWeight: 400 }}>
          Replace the rounds these files cover
          {rounds.length > 0 && (
            <> — <strong>round {rounds.map(roundLabel).join(", ")}</strong></>
          )}
          <span className="muted">
            {" "}Anything already filed under {rounds.length === 1 ? "that round" : "those rounds"} in this
            edition is dropped first, so a re-upload fixes the round instead of stacking a second copy.
          </span>
        </span>
      </label>
      {replace && unnamedRound && (
        <span className="error-inline">
          Every file has to say which round it is — name them like “Round_09.json” (or “Round A.json”).
        </span>
      )}
      {err && <div className="error-box">{err}</div>}
      {status && <div className="caveat">{status}</div>}
      <button className="btn-primary" type="submit" disabled={busy || (replace && unnamedRound)}>
        {busy ? "Working…" : replace ? "Replace files" : "Add files"}
      </button>
    </form>
  );
}
