import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { refreshIndex } from "../data";
import { useAuth } from "../auth";
import { AuthNav } from "../components/Common";
import { detectScoring } from "../detectScoring";
import { uploadFiles } from "../upload";
import { FileDrop } from "../components/FileDrop";
import { Visibility, TOURNAMENT_LEVELS } from "../types";

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

async function readFiles(files: File[]) {
  const out: { name: string; json: any }[] = [];
  for (const f of files) {
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
  const [mode, setMode] = useState<"upload" | "import">("upload");
  const [importUrl, setImportUrl] = useState("");
  const [importBonuses, setImportBonuses] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState("");
  const [tdLink, setTdLink] = useState("");
  const [scoring, setScoring] = useState("mACF");
  const [detected, setDetected] = useState<string | null>(null);
  const [hasBonuses, setHasBonuses] = useState(true);
  const [packets, setPackets] = useState<File[]>([]);
  const [games, setGames] = useState<File[]>([]);
  const [yfFile, setYfFile] = useState<File[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("listed");
  const [autoPublish, setAutoPublish] = useState(true);
  const [autoPublishDate, setAutoPublishDate] = useState(plusYears(2));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onGames(files: File[]) {
    setGames(files);
    setDetected(null);
    if (!files.length) return;
    try {
      const parsed = await readFiles(files);
      const id = detectScoring(parsed);
      if (id) { setScoring(id); setDetected(id); }
    } catch {
      /* detection is best-effort; ignore parse errors here */
    }
  }

  // The browser drives the import across many requests so each one (a single
  // edition scrape) stays within the function time limit. Large multi-mirror
  // tournaments (e.g. 17 editions) import fully, edition by edition.
  async function importPost(b: any) {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return d;
      lastErr = new Error(d.error || `Failed (${r.status})`);
      if (r.status < 500) break; // only retry transient server/timeout errors
    }
    throw lastErr;
  }

  async function submitImport() {
    setError(null);
    if (!importUrl.trim()) return setError("Enter the URL of a Buzzpoints site.");
    if (!level) return setError("Choose a tournament type.");
    setBusy(true);
    try {
      setStatus("Reading the source site…");
      const start = await importPost({ op: "import-start", importUrl: importUrl.trim() });
      const total: number = start.total;
      const eds: { name: string }[] = start.editions || [];
      for (let i = 0; i < total; i++) {
        setStatus(`Importing edition ${i + 1} of ${total}${eds[i]?.name ? `: ${eds[i].name}` : ""}…`);
        const ed = await importPost({ op: "import-edition", jobId: start.jobId, index: i });
        // Optional: scrape per-team bonus results in chunks (slow; some pages 504).
        if (importBonuses && ed.bonusTotal > 0) {
          let done = false;
          while (!done) {
            const r = await importPost({ op: "import-bonus-chunk", jobId: start.jobId, index: i });
            setStatus(`Bonus results, edition ${i + 1} of ${total}: ${Math.min(r.cursor, r.total)}/${r.total}…`);
            done = r.done;
          }
        }
      }
      setStatus("Building the tournament…");
      const autoPublicAt = visibility === "public" ? null : autoPublish ? new Date(autoPublishDate).toISOString() : null;
      const fin = await importPost({ op: "import-finish", jobId: start.jobId, name: name.trim() || undefined, level, tdLink: tdLink.trim() || undefined, visibility, autoPublicAt });
      refreshIndex();
      navigate(`/set/${fin.slug}`);
    } catch (err) {
      setError(String((err as Error).message || err));
      setBusy(false);
      setStatus(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "import") return submitImport();
    setError(null);
    if (!name.trim()) return setError("Enter a tournament name.");
    if (!level) return setError("Choose a tournament type.");
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
          name: name.trim(), level, tdLink: tdLink.trim() || undefined, scoring, hasBonuses, visibility, autoPublicAt,
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
            <Link to="/search" className="nav-link">Search across tournaments</Link>
          </nav>
          <div className="topbar-auth"><AuthNav /></div>
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
          <label className="field">
            <span>How do you want to add this tournament?</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "upload" | "import")}>
              <option value="upload">Upload packets &amp; QBJ scoresheets</option>
              <option value="import">Import from an existing Buzzpoints site</option>
            </select>
            <small className="muted">
              {mode === "upload"
                ? "Upload your files for full buzz-level stats. Optionally attach the YellowFruit file you scored from."
                : "Paste the link to another Buzzpoints site (e.g. one deployed on Vercel). Every edition listed there is imported as one tournament."}
            </small>
          </label>

          {mode === "import" && (
            <>
              <label className="field">
                <span>Buzzpoints site URL</span>
                <input type="url" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://your-tournament.vercel.app" />
              </label>
              <label className="field-inline">
                <input type="checkbox" checked={importBonuses} onChange={(e) => setImportBonuses(e.target.checked)} />
                <span>Import full bonus data — question text + per-team results (slow; scrapes every bonus page, some may 504)</span>
              </label>
            </>
          )}

          <label className="field">
            <span>Tournament name{mode === "import" ? " (optional)" : ""}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "import" ? "defaults to the imported name" : "e.g. Spring Open 2026"} />
          </label>

          <label className="field">
            <span>Tournament type</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="" disabled>Choose a type…</option>
              {TOURNAMENT_LEVELS.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Tournament Database link (optional)</span>
            <input type="url" value={tdLink} onChange={(e) => setTdLink(e.target.value)} placeholder="https://hsquizbowl.org/db/tournaments/…" />
            <small className="muted">Link to this tournament's entry on the hsquizbowl Tournament Database, if it has one.</small>
          </label>

          {mode === "upload" && <>
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

          <div className="field">
            <span>Packet files (one JSON per round)</span>
            <FileDrop accept=".json" value={packets} onChange={setPackets} hint="Standard packet-parser JSON" />
          </div>

          <div className="field">
            <span>Game files (QBJ scoresheets)</span>
            <FileDrop accept=".json,.qbj" value={games} onChange={onGames} hint="QBJ match files (.json / .qbj)" />
          </div>

          <div className="field">
            <span>YellowFruit file (optional)</span>
            <FileDrop
              accept=".yft,.json,.qbj"
              multiple={false}
              value={yfFile}
              onChange={setYfFile}
              hint="Attach the .yft you scored from to download a corrections-applied copy later."
            />
          </div>
          </>}

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
            {busy ? "Working…" : mode === "import" ? "Import tournament" : "Create tournament"}
          </button>
        </form>
        )}
      </main>
    </div>
  );
}
