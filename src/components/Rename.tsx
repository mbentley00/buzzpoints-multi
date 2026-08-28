import { useState } from "react";
import { clearSetCache } from "../data";

// Rename a player or a team across the whole tournament. Sources often spell the
// same person — or the same school — two ways between games, which splits their
// stats in half; this folds every appearance onto one spelling.
//
// Same two-track flow as a buzz correction: the owner applies it immediately,
// anyone else with access proposes it and the owner approves on the Corrections
// page. A player rename defaults to the player's own team, since two different
// people on different teams can share a name; a team rename is always set-wide.

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}

export function Rename({ slug, kind, name, team, isOwner, individual = false }: {
  slug: string; kind: "player" | "team"; name: string; team?: string; isOwner: boolean;
  // An individual shootout: the player is their own team, so there's no
  // "which team" to scope by and the rename is always set-wide.
  individual?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(name);
  const [allTeams, setAllTeams] = useState(false);
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const isTeam = kind === "team";
  const changed = to.trim() !== "" && to.trim() !== name;

  async function submit() {
    setErr(null);
    setBusy(true);
    const rename = { kind, from: name, to: to.trim(), team: isTeam || allTeams || individual ? null : team };
    try {
      if (isOwner) {
        await postJson("/api/correct", { slug, rename });
        clearSetCache(slug);
        // Player and team ids are positional, so a rename reshuffles them and this
        // page's URL no longer resolves. A full load of the list picks up the rebuild.
        window.location.href = `/set/${slug}/${kind}`;
      } else {
        await postJson("/api/requests", { slug, action: "submit", rename, desc: desc.trim() || undefined });
        setDone("Rename suggested — the owner will review it.");
      }
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="caveat"><span className="ok-msg">{done}</span></p>;

  if (!open)
    return (
      <button type="button" className="btn-link" onClick={() => setOpen(true)}>
        {isOwner ? `Rename ${kind}` : "Suggest a name fix"}
      </button>
    );

  return (
    <div className="buzz-edit rename-box">
      <label className="field-inline">
        <span>Rename to</span>
        <input value={to} onChange={(e) => setTo(e.target.value)} style={{ minWidth: 220 }} />
      </label>
      {!isTeam && !individual && (
        <label className="field-inline">
          <input type="checkbox" checked={allTeams} onChange={(e) => setAllTeams(e.target.checked)} />
          <span>Apply on every team, not just {team}</span>
        </label>
      )}
      {!isOwner && (
        <label className="field-inline" style={{ flex: "1 1 220px" }}>
          <span>Reason</span>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="optional note for the owner" style={{ flex: 1 }} />
        </label>
      )}
      <small className="muted" style={{ flexBasis: "100%" }}>
        {isTeam ? (
          <>
            Every buzz, box score and roster entry recorded for <strong>{name}</strong> will use the new name. If another
            team already goes by the new name, the two merge into one — so only do this for two spellings of the same
            team, never for two teams that played each other.
          </>
        ) : (
          <>
            Every buzz, box score and roster entry for <strong>{name}</strong>
            {allTeams || individual ? "" : <> on <strong>{team}</strong></>} will use the new name. If someone already appears under the
            new spelling, the two merge into one player.
          </>
        )}
      </small>
      <div className="buzz-edit-actions">
        <button className="btn-primary btn-sm" disabled={!changed || busy} onClick={submit}>
          {busy ? "Working…" : isOwner ? "Rename & rebuild" : "Suggest rename"}
        </button>
        <button className="btn-link" onClick={() => { setOpen(false); setTo(name); setErr(null); }}>Cancel</button>
      </div>
      {err && <span className="error-inline">{err}</span>}
    </div>
  );
}
