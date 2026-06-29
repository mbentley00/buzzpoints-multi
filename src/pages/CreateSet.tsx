import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { refreshIndex } from "../data";
import { useAuth } from "../auth";
import { AuthNav } from "../components/Common";
import { detectScoring } from "../detectScoring";
import { uploadFiles } from "../upload";
import { Visibility } from "../types";

const SCORING_OPTIONS = [
  { id: "mACF", label: "mACF (15 / 10 / -5)" },
  { id: "ACF", label: "ACF (10 / -5)" },
  { id: "PACE", label: "PACE (20 / 10 / 0)" },
  { id: "SUPERPOWER", label: "Super-power (20 / 15 / 10 / -5)" },
];

const VISIBILITY_OPTIONS: { id: Visibility; label: string; desc: string }[] = [
  { id: "listed", label: "Listed (login + invite)", desc: "Shown in the tournament list, but only invited, logged-in people can view it." },
  { id: "private", label: "Private (invite only)", desc: "Hidden from the list; only you and people you invite can view it." },
  { id: "public", label: "Public (open to all)", desc: "Shown in the list and viewable by anyone, no login required." },
];

async function readFiles(files: FileList) {
  const out: { name: string; json: any }[] = [];
  for (const f of Array.from(files)) {
    const text = await f.text();
    try {
      out.push({ name: f.name, json: JSON.parse(text) });
    } catch {
      throw new Error(`${f.name} is not valid JSON.`);
    }
  }
  return out;
}

// YYYY-MM-DD for an <input type="date">, default two years out.
function plusYears(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

export function CreateSet() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [name, setName] = useState("");
  const [scoring, setScoring] = useState("mACF");
  const [detected, setDetected] = useState<string | null>(null);
  const [hasBonuses, setHasBonuses] = useState(true);
  const [packets, setPackets] = useState<FileList | null>(null);
  const [games, setGames] = useState<FileList | null>(null);
  const [yfFile, setYfFile] = useState<FileList | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("listed");
  const [autoPublish, setAutoPublish] = useState(true);
  const [autoPublishDate, setAutoPublishDate] = useState(plusYears(2));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onGames(files: FileList | null) {
    setGames(files);
    setDetected(null);
    if (!files?.length) return;
    try {
      const parsed = await readFiles(files);
      const id = detectScoring(parsed);
      if (id) { setScoring(id); setDetected(id); }
    } catch {
      /* detection is best-effort; ignore parse errors here */
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter a tournament name.");
    if (!packets?.length) return setError("Choose at least one packet file.");
    if (!games?.length) return setError("Choose at least one QBJ game file.");

    setBusy(true);
    try {
      const packetRefs = await uploadFiles(packets, (d, t) => setStatus(`Uploading packets… ${d}/${t}`));
      const gameRefs = await uploadFiles(games, (d, t) => setStatus(`Uploading games… ${d}/${t}`));

      let yf: any = undefined;
      if (yfFile?.length) {
        setStatus("Reading YellowFruit file…");
        const parsedYf = await readFiles(yfFile);
        yf = parsedYf[0]?.json;
      }

      const autoPublicAt =
        visibility === "public" ? null : autoPublish ? new Date(autoPublishDate).toISOString() : null;

      setStatus("Aggregating…");
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), scoring, hasBonuses, visibility, autoPublicAt,
          packets: packetRefs, games: gameRefs, ...(yf ? { yf } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `ingest failed (${res.status})`);
      if (json.pending) {
        // First-time poster: held for moderator review rather than published.
        setSubmitted(json.message || "Your first tournament was submitted for review. You'll get an email when it's approved.");
        setBusy(false);
        setStatus(null);
        return;
      }
      refreshIndex();
      navigate(`/set/${json.slug}`);
    } catch (err) {
      setError(String((err as Error).message || err));
      setBusy(false);
      setStatus(null);
    }
  }

  const visDesc = VISIBILITY_OPTIONS.find((v) => v.id === visibility)?.desc;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            Buzzpoints
          </Link>
          <nav className="nav">
            <AuthNav />
          </nav>
        </div>
      </header>
      <main className="content">
        <div className="breadcrumb">
          <Link to="/" className="link">
            ← All tournaments
          </Link>
        </div>
        <h1>New tournament</h1>
        {!authLoading && !user && (
          <p className="caveat">
            You need to <Link to="/login?next=/new" className="link">log in</Link> to create a tournament. You'll
            become its owner and can approve edits from others.
          </p>
        )}
        {!authLoading && user && submitted && (
          <div className="caveat" role="status">
            <strong>Submitted for review.</strong> {submitted}
            <div style={{ marginTop: 10 }}>
              <Link to="/" className="link">← Back to tournaments</Link>
            </div>
          </div>
        )}
        {!authLoading && user && !submitted && (
        <form className="create-form" onSubmit={submit}>
          <p className="muted" style={{ marginTop: 0 }}>
            Upload packets and QBJ scoresheets for full buzz-level stats. Optionally attach the YellowFruit file you
            scored from to export a corrected copy after editing buzzes.
          </p>

          <label className="field">
            <span>Tournament name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring Open 2026" />
          </label>

          <label className="field">
            <span>Scoring format</span>
            <select value={scoring} onChange={(e) => { setScoring(e.target.value); setDetected(null); }}>
              {SCORING_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <small className="muted">
              {detected
                ? `Detected ${detected} from the uploaded games — change it if that's wrong.`
                : "Auto-detected from the games once you choose them."}
            </small>
          </label>

          <label className="field-inline">
            <input type="checkbox" checked={hasBonuses} onChange={(e) => setHasBonuses(e.target.checked)} />
            <span>This format has bonuses</span>
          </label>

          <label className="field">
            <span>Packet files (one JSON per round)</span>
            <input type="file" multiple accept=".json" onChange={(e) => setPackets(e.target.files)} />
            <small className="muted">{packets ? `${packets.length} selected` : "Standard packet-parser JSON"}</small>
          </label>

          <label className="field">
            <span>Game files (QBJ scoresheets)</span>
            <input type="file" multiple accept=".json,.qbj" onChange={(e) => onGames(e.target.files)} />
            <small className="muted">{games ? `${games.length} selected` : "QBJ match files (.json / .qbj)"}</small>
          </label>

          <label className="field">
            <span>YellowFruit file (optional)</span>
            <input type="file" accept=".yft,.json,.qbj" onChange={(e) => setYfFile(e.target.files)} />
            <small className="muted">
              {yfFile?.length
                ? `${yfFile[0].name} selected`
                : "Attach the .yft you scored from to download a corrections-applied copy later."}
            </small>
          </label>

          <label className="field">
            <span>Visibility</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              {VISIBILITY_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <small className="muted">{visDesc}</small>
          </label>

          {visibility !== "public" && (
            <div className="field">
              <label className="field-inline">
                <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
                <span>Automatically make this tournament public on</span>
                <input
                  type="date"
                  value={autoPublishDate}
                  disabled={!autoPublish}
                  onChange={(e) => setAutoPublishDate(e.target.value)}
                />
              </label>
              <small className="muted">
                {autoPublish
                  ? "On this date it becomes public and open to all."
                  : "Auto-publish is off — it stays private until you change the visibility yourself."}
              </small>
            </div>
          )}

          {error && <div className="error-box">{error}</div>}
          {status && <div className="caveat">{status}</div>}

          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Working…" : "Create tournament"}
          </button>
        </form>
        )}
      </main>
    </div>
  );
}
