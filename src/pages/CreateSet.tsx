import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { refreshIndex } from "../data";
import { useAuth } from "../auth";
import { AuthNav } from "../components/Common";
import { detectScoring } from "../detectScoring";
import { uploadFiles } from "../upload";
import { FileDrop } from "../components/FileDrop";
import { Visibility, TOURNAMENT_LEVELS, RoundWarning, BonusDiffWarning, difficultyOptions } from "../types";
import { warningText } from "../components/SourceFiles";
import { hasYearFirst, yearFirstSuggestion } from "../util";
import { scanDataFolder, filesFromPicker, filesFromZip, mirrorPackets, mirrorCoverage, readSiteGames, sitePacketPlan, sitePacketFiles, FolderScan } from "../migratorFolder";
import { stageEditions, ingestPostRetry, StageEdition } from "../ingestClient";

interface CategoryWarning { category: string; count: number; reason: string; examples: string[] }

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

// The wizard's manual upload can hold several packet versions (American and
// British, say) and several sites (mirrors), each of which played one version.
// One version + one site is the plain single upload.
interface VersionDraft { id: string; name: string; packets: File[] }
interface SiteDraft { id: string; label: string; versionId: string; versionTouched: boolean; games: File[]; roundPacket: Map<number, string> }
let draftSeq = 0;
const draftId = (p: string) => `${p}${++draftSeq}`;
const newSite = (versionId: string): SiteDraft => ({ id: draftId("s"), label: "", versionId, versionTouched: false, games: [], roundPacket: new Map() });

// YYYY-MM-DD for an <input type="date">, default two years out.
function plusYears(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

export function CreateSet() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [mode, setMode] = useState<"upload" | "folder" | "import">("upload");
  const [importUrl, setImportUrl] = useState("");
  const [importBonuses, setImportBonuses] = useState(false);
  const [name, setName] = useState("");
  const nameSuggestion = useMemo(() => yearFirstSuggestion(name), [name]);
  const [level, setLevel] = useState("");
  const [tdLink, setTdLink] = useState("");
  // Required for new tournaments; most are posted the day they're played, so
  // start from today (the viewer's own calendar day, not UTC's).
  const [tournamentDate, setTournamentDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [difficulty, setDifficulty] = useState("");
  const [scoring, setScoring] = useState("mACF");
  const [detected, setDetected] = useState<string | null>(null);
  const [hasBonuses, setHasBonuses] = useState(true);
  // Individual shootout (IPNCT-style): players compete for themselves. Such a
  // format is tossups-only, so ticking it unticks bonuses (still changeable).
  const [individual, setIndividual] = useState(false);
  const [versions, setVersions] = useState<VersionDraft[]>(() => [{ id: "v0", name: "", packets: [] }]);
  const [sites, setSites] = useState<SiteDraft[]>(() => [newSite("v0")]);
  const multi = versions.length > 1 || sites.length > 1;
  // The data-folder upload (buzzpoint-migrator / quizbowlstats layout).
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [scanSet, setScanSet] = useState("");
  const [scanMsg, setScanMsg] = useState("");
  const [folderLabels, setFolderLabels] = useState<Record<string, string>>({});
  const [folderSkip, setFolderSkip] = useState<Set<string>>(new Set());
  const dirInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [yfFile, setYfFile] = useState<File[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("listed");
  const [autoPublish, setAutoPublish] = useState(true);
  const [autoPublishDate, setAutoPublishDate] = useState(plusYears(2));
  const [status, setStatus] = useState<string | null>(null);
  // Practice tournaments are never public; switching to Practice after picking
  // Public would otherwise leave the select on a hidden option.
  useEffect(() => { if (level === "practice" && visibility === "public") setVisibility("listed"); }, [level, visibility]);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [warned, setWarned] = useState<{ slug: string; warnings: CategoryWarning[]; rounds: RoundWarning[]; bonusDiffs: BonusDiffWarning[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const updateSite = (id: string, patch: Partial<SiteDraft>) => setSites((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const updateVersion = (id: string, patch: Partial<VersionDraft>) => setVersions((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  async function onSiteGames(siteId: string, files: File[]) {
    updateSite(siteId, { games: files, roundPacket: new Map() });
    setDetected(null);
    if (!files.length) return;
    try {
      const parsed = await readFiles(files);
      const id = detectScoring(parsed);
      if (id) { setScoring(id); setDetected(id); }
    } catch {
      /* detection is best-effort; ignore parse errors here */
    }
    const { roundPacket } = await readSiteGames(files);
    setSites((l) => l.map((x) => {
      if (x.id !== siteId) return x;
      let versionId = x.versionId;
      // Guess which version this site played from the packet names its games
      // carry, unless the owner already picked one.
      if (!x.versionTouched && versions.length > 1) {
        let best = 0;
        for (const v of versions) {
          const n = sitePacketPlan(roundPacket, v.packets).byRound.size;
          if (n > best) { best = n; versionId = v.id; }
        }
      }
      return { ...x, roundPacket, versionId };
    }));
  }

  function addVersion() {
    setVersions((l) => [...l, { id: draftId("v"), name: "", packets: [] }]);
  }
  function removeVersion(id: string) {
    const rest = versions.filter((v) => v.id !== id);
    setVersions(rest);
    setSites((l) => l.map((x) => (x.versionId === id ? { ...x, versionId: rest[0].id, versionTouched: false } : x)));
  }
  function addSite() { setSites((l) => [...l, newSite(versions[0].id)]); }
  function removeSite(id: string) { setSites((l) => l.filter((x) => x.id !== id)); }

  // How each site's packets will be lined up with its games (see sitePacketPlan).
  const sitePlans = useMemo(() => new Map(sites.map((x) => {
    const v = versions.find((vv) => vv.id === x.versionId) || versions[0];
    return [x.id, x.games.length && v.packets.length ? sitePacketPlan(x.roundPacket, v.packets) : null] as const;
  })), [sites, versions]);

  async function onFolder(list: FileList | null, zip?: File) {
    setError(null); setScan(null); setScanMsg("");
    try {
      let files;
      if (zip) { setScanMsg("Unzipping…"); files = await filesFromZip(zip); }
      else files = list ? filesFromPicker(list) : [];
      if (!files.length) return;
      const sc = await scanDataFolder(files, setScanMsg);
      if (!sc.sets.length) throw new Error("No question set in that folder matched any site's games.");
      // The set with the most sites is almost always the one meant.
      const pick = [...sc.sets].sort((a, b) => b.mirrors.length - a.mirrors.length)[0];
      setScan(sc);
      chooseScanSet(sc, pick.key);
      setScanMsg("");
    } catch (e) { setError(String((e as Error).message || e)); setScanMsg(""); }
  }
  function chooseScanSet(sc: FolderScan, key: string) {
    const g = sc.sets.find((x) => x.key === key);
    if (!g) return;
    setScanSet(key);
    setFolderLabels(Object.fromEntries(g.mirrors.map((m) => [m.name, m.label])));
    setFolderSkip(new Set());
    if (g.scoring) { setScoring(g.scoring); setDetected(g.scoring); }
    setHasBonuses(g.hasBonuses);
    setName((n) => (n.trim() ? n : g.name));
  }
  const scanGroup = scan?.sets.find((g) => g.key === scanSet) || null;

  // The browser drives the import across many requests so each one (a single
  // edition scrape) stays within the function time limit. Large multi-mirror
  // tournaments (e.g. 17 editions) import fully, edition by edition.
  async function importPost(b: any) {
    let lastErr: Error | null = null;
    // Retry transient 5xx/timeouts with a growing backoff: heavy bonus scraping
    // makes the source throttle, and a bare 504 means our function timed out —
    // waiting lets the throttle subside. Each op is idempotent, so retrying is safe.
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return d;
      lastErr = new Error(d.error || `Failed (${r.status})`);
      if (r.status < 500) break; // don't retry client errors (validation etc.)
      if (attempt < 3) { const secs = 10 * (attempt + 1); setStatus(`Source is slow; retrying in ${secs}s…`); await new Promise((res) => setTimeout(res, secs * 1000)); }
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
      const fin = await importPost({ op: "import-finish", jobId: start.jobId, name: name.trim() || undefined, level, tdLink: tdLink.trim() || undefined, difficulty: difficulty || undefined, individual, visibility, autoPublicAt });
      refreshIndex();
      navigate(`/set/${fin.slug}`);
    } catch (err) {
      setError(String((err as Error).message || err));
      setBusy(false);
      setStatus(null);
    }
  }

  // What the server said after creating (or queueing) the tournament.
  function onCreated(json: any) {
    if (json.pending) {
      // First-time poster: held for moderator review rather than published.
      setSubmitted(json.message || "Your first tournament was submitted for review. You'll get an email when it's approved.");
      setBusy(false);
      setStatus(null);
      return;
    }
    refreshIndex();
    // Uploading straight to Public queues a moderator request instead (fresh
    // uploads need approval) — say so, or the owner would just see "listed"
    // and wonder where their choice went.
    if (json.publicPending)
      window.alert("Your tournament was created. Making a newly uploaded tournament public needs a moderator's approval — your request has been sent, and you'll get an email when it's decided. Until then the tournament is listed (shown in the list, invited viewers only).");
    // If the category heuristic flagged likely-mislabeled categories, the
    // packets' rounds don't line up with the games', or a bonus carries
    // difficulty marks that can't be right, pause on a review screen so the
    // owner can fix things before relying on the stats.
    const warnings: CategoryWarning[] = Array.isArray(json.categoryWarnings) ? json.categoryWarnings : [];
    const rounds: RoundWarning[] = Array.isArray(json.roundWarnings) ? json.roundWarnings : [];
    const bonusDiffs: BonusDiffWarning[] = Array.isArray(json.bonusDiffWarnings) ? json.bonusDiffWarnings : [];
    if (warnings.length || rounds.length || bonusDiffs.length) {
      setWarned({ slug: json.slug, warnings, rounds, bonusDiffs });
      setBusy(false);
      setStatus(null);
      return;
    }
    navigate(`/set/${json.slug}`);
  }

  // Several editions at once: each is uploaded and read by its own request,
  // then one last request builds the tournament (with the same review rules as
  // a single upload).
  async function submitStaged(build: () => Promise<StageEdition[]>) {
    setBusy(true);
    try {
      setStatus("Preparing files…");
      const editions = await build();
      const { jobId, editionCount } = await stageEditions(editions, setStatus);
      let yf: any = undefined;
      if (yfFile?.length) yf = (await readFiles(yfFile))[0]?.json;
      const autoPublicAt = visibility === "public" ? null : autoPublish ? new Date(autoPublishDate).toISOString() : null;
      setStatus(`Building the tournament from ${editionCount} site${editionCount === 1 ? "" : "s"}…`);
      const json = await ingestPostRetry({
        op: "local-create", jobId, editionCount,
        name: name.trim(), level, tdLink: tdLink.trim() || undefined, difficulty: difficulty || undefined, tournamentDate: tournamentDate || undefined,
        scoring, hasBonuses, individual, visibility, autoPublicAt, ...(yf ? { yf } : {}),
      }, (sec) => setStatus(`The server is busy; retrying in ${sec}s…`));
      onCreated(json);
    } catch (err) {
      setError(String((err as Error).message || err));
      setBusy(false);
      setStatus(null);
    }
  }

  function validateSites(): string | null {
    for (const [i, v] of versions.entries()) {
      const what = versions.length > 1 ? `packet version ${v.name.trim() || i + 1}` : "the packets";
      if (versions.length > 1 && !v.name.trim()) return `Name packet version ${i + 1} (e.g. "American" or "British").`;
      if (!v.packets.length) return `Choose the packet files for ${what}.`;
    }
    const seen = new Set<string>();
    for (const [i, x] of sites.entries()) {
      const label = x.label.trim();
      if (sites.length > 1 && !label) return `Name site ${i + 1} (e.g. "Chicago" or "Oxford").`;
      if (label && seen.has(label.toLowerCase())) return `Two sites are both named "${label}". Give each site its own name.`;
      seen.add(label.toLowerCase());
      if (!x.games.length) return `Choose the game files for ${label || `site ${i + 1}`}.`;
    }
    if (versions.length > 1) {
      const used = new Set(sites.map((x) => x.versionId));
      const unused = versions.find((v) => !used.has(v.id));
      if (unused) return `No site played packet version "${unused.name.trim()}". Pick it for a site, or remove it.`;
    }
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "import") return submitImport();
    setError(null);
    if (!name.trim()) return setError("Enter a tournament name.");
    if (!level) return setError("Choose a tournament type.");
    if (!tournamentDate) return setError("Enter the date the tournament was played.");
    if (mode === "folder") {
      if (!scan || !scanGroup) return setError("Choose the data folder (or its .zip) first.");
      const chosen = scanGroup.mirrors.filter((m) => !folderSkip.has(m.name));
      if (!chosen.length) return setError("Include at least one site.");
      return submitStaged(async () => {
        const out: StageEdition[] = [];
        for (const m of chosen) {
          const { files } = await mirrorPackets(scan, scanGroup.key, m);
          out.push({ label: (folderLabels[m.name] || "").trim() || m.label, packets: files, games: m.games });
        }
        return out;
      });
    }
    const bad = validateSites();
    if (bad) return setError(bad);
    if (multi) {
      return submitStaged(async () => {
        const out: StageEdition[] = [];
        for (const [i, x] of sites.entries()) {
          const v = versions.find((vv) => vv.id === x.versionId) || versions[0];
          const label = x.label.trim() || (versions.length > 1 ? v.name.trim() : "") || `Site ${i + 1}`;
          out.push({ label, packets: await sitePacketFiles(x.roundPacket, v.packets), games: x.games });
        }
        return out;
      });
    }
    const packets = versions[0].packets;
    const games = sites[0].games;

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
          name: name.trim(), level, tdLink: tdLink.trim() || undefined, difficulty: difficulty || undefined, tournamentDate: tournamentDate || undefined, scoring, hasBonuses, individual, visibility, autoPublicAt,
          packets: packetRefs, games: gameRefs, ...(yf ? { yf } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `ingest failed (${res.status})`);
      onCreated(json);
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
        {!authLoading && user && warned && warned.rounds.length > 0 && (
          <div className="cat-warn round-warn" role="status">
            <strong>Your tournament was created — but its packets aren't lined up with the games.</strong>
            <p className="muted">
              A packet's round comes from its <strong>filename</strong> ("Round_3.json" → round 3); a file with no
              number in its name falls back to round 0. Games carry their own round from inside the QBJ. When the two
              disagree the questions never pick up any buzzes — they'll show 0 heard even though player and team stats
              look fine. You can set the right rounds without re-uploading.
            </p>
            <ul className="cat-warn-list">
              {warned.rounds.map((w, i) => <li key={i}>{warningText(w)}</li>)}
            </ul>
            <div className="cat-warn-actions">
              <Link className="btn-primary" to={`/set/${warned.slug}/settings#rounds`}>Fix round alignment</Link>
              <Link className="link" to={`/set/${warned.slug}`}>Skip for now →</Link>
            </div>
          </div>
        )}
        {!authLoading && user && warned && warned.bonusDiffs.length > 0 && (
          <div className="cat-warn bndiff-warn" role="status">
            <strong>
              Your tournament was created — but{" "}
              {warned.bonusDiffs.length === 1 ? "one bonus has" : `${warned.bonusDiffs.length} bonuses have`} difficulty
              marks that can't be right.
            </strong>
            <p className="muted">
              A three-part bonus is written easy, medium and hard. Where the packet tagged one "medium, easy, easy" its
              real hard part will be counted as an easy one, and every easy/medium/hard figure built on it — conversion
              by category, and the Difficulty order view — is off by that part. Re-mark the parts and the stats are
              rebuilt; the packet file isn't touched.
            </p>
            <ul className="cat-warn-list">
              {warned.bonusDiffs.slice(0, 8).map((w) => (
                <li key={w.id}>
                  <span className="cat-warn-name">Round {w.round}, bonus {w.num}</span>
                  <span className="cat-warn-reason">{w.reason}</span>
                </li>
              ))}
              {warned.bonusDiffs.length > 8 && <li className="muted">…and {warned.bonusDiffs.length - 8} more.</li>}
            </ul>
            <div className="cat-warn-actions">
              <Link className="btn-primary" to={`/set/${warned.slug}/settings#bonusdiff`}>Fix difficulty marks</Link>
              <Link className="link" to={`/set/${warned.slug}`}>Skip for now →</Link>
            </div>
          </div>
        )}
        {!authLoading && user && warned && warned.warnings.length > 0 && (
          <div className="cat-warn" role="status">
            <strong>Some categories look off.</strong>
            <p className="muted">
              These parsed categories don't look like real subjects. Often this means the packet's
              category column actually holds author initials or names. Fix the packet metadata and
              re-upload (or refresh this tournament) if that's the case — otherwise you can ignore this.
            </p>
            <ul className="cat-warn-list">
              {warned.warnings.map((w) => (
                <li key={w.category}>
                  <span className="cat-warn-name">{w.category}</span>
                  <span className="cat-warn-count">{w.count} tossup{w.count === 1 ? "" : "s"}</span>
                  <span className="cat-warn-reason">{w.reason}</span>
                  {w.examples?.length > 0 && <span className="cat-warn-eg">e.g. {w.examples.join("; ")}</span>}
                </li>
              ))}
            </ul>
            <div className="cat-warn-actions">
              <button type="button" className="btn-primary" onClick={() => navigate(`/set/${warned.slug}`)}>
                View tournament
              </button>
              <Link to="/" className="link">← Back to tournaments</Link>
            </div>
          </div>
        )}
        {!authLoading && user && warned && !warned.warnings.length && !warned.bonusDiffs.length && (
          <p><Link to="/" className="link">← Back to tournaments</Link></p>
        )}
        {!authLoading && user && !submitted && !warned && (
        <form className="create-form" onSubmit={submit}>
          <label className="field">
            <span>How do you want to add this tournament?</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "upload" | "folder" | "import")}>
              <option value="upload">Upload packets &amp; game files (.qbj / .json)</option>
              <option value="folder">Upload a buzzpoint-migrator data folder (every site at once)</option>
              <option value="import">Import from an existing Buzzpoints site</option>
            </select>
            <small className="muted">
              {mode === "upload"
                ? "Upload your files for full buzz-level stats: one site, or several sites (mirrors) and packet versions at once. Optionally attach the YellowFruit file you scored from."
                : mode === "folder"
                ? <>The <code>data</code> folder you'd feed buzzpoint-migrator: <code>question_sets/</code> with the packets and <code>tournaments/</code> with each site's QBJs. Every site becomes a mirror, matched to the packet version it played.</>
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
            {/* The placeholder showed "Spring Open 2026" — the very shape the
                note below asks people not to use. */}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "import" ? "defaults to the imported name" : "e.g. 2026 PACE NSC"} />
          </label>
          {/* Outside the label: a click on a control nested in one is forwarded to
              the label's input as well, so the "did you mean" button would fight
              the field it is trying to fill.
              Advisory, never blocking — an unusual name is the owner's call, and
              a set that doesn't fit the house style is still worth having. */}
          {!!name.trim() && !hasYearFirst(name) && (
            <p className="caveat name-hint">
              Tournaments here are named <strong>year first</strong> — “2026 PACE NSC”, not “PACE NSC 2026” — so the
              list reads chronologically and one tournament's years sit together.{" "}
              {nameSuggestion
                ? <>Did you mean <button type="button" className="btn-link" onClick={() => setName(nameSuggestion)}>{nameSuggestion}</button>?</>
                : <>You can still use this name.</>}
            </p>
          )}

          <label className="field">
            <span>Tournament type</span>
            <select value={level} onChange={(e) => { setLevel(e.target.value); setDifficulty(""); }}>
              <option value="" disabled>Choose a type…</option>
              {TOURNAMENT_LEVELS.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </label>

          {difficultyOptions(level).length > 0 && (
            <label className="field">
              <span>Question difficulty (optional)</span>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                <option value="">Not set</option>
                {difficultyOptions(level).map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
              {level !== "hs" && (
                <small className="muted">
                  The <a className="link" href="https://collegequizbowlcalendar.com/difficulty-scale/" target="_blank" rel="noreferrer">College Quizbowl Calendar scale</a>, in half steps.
                </small>
              )}
            </label>
          )}

          <label className="field">
            <span>Tournament date</span>
            <input type="date" required value={tournamentDate} onChange={(e) => setTournamentDate(e.target.value)} style={{ maxWidth: 200 }} />
            <small className="muted">When it was first played (the earliest mirror). Defaults to today — change it if it was played earlier.</small>
          </label>
          <label className="field">
            <span>Tournament Database link (optional)</span>
            <input type="url" value={tdLink} onChange={(e) => setTdLink(e.target.value)} placeholder="https://hsquizbowl.org/db/tournaments/…" />
            <small className="muted">Link to this tournament's entry on the hsquizbowl Tournament Database, if it has one.</small>
          </label>

          <label className="field-inline">
            <input type="checkbox" checked={individual} onChange={(e) => { setIndividual(e.target.checked); if (e.target.checked) setHasBonuses(false); }} />
            <span>Individual shootout (players compete for themselves, like IPNCT)</span>
          </label>
          {individual && (
            <small className="muted">
              Every player is scored on their own, whatever "teams" the scoresheets were filed under — a room of six
              players is read as six competitors, and standings rank players rather than teams.
            </small>
          )}

          {mode !== "import" && <>
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

          {mode === "folder" && (
            <div className="field">
              <span>Data folder</span>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="btn-secondary" disabled={busy || !!scanMsg} onClick={() => dirInput.current?.click()}>Choose folder…</button>
                <button type="button" className="btn-secondary" disabled={busy || !!scanMsg} onClick={() => zipInput.current?.click()}>Choose a .zip…</button>
              </div>
              <input
                ref={dirInput} type="file" hidden multiple
                // @ts-expect-error non-standard directory picker
                webkitdirectory="" directory=""
                onChange={(e) => { onFolder(e.target.files); e.target.value = ""; }}
              />
              <input ref={zipInput} type="file" hidden accept=".zip" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFolder(null, f); e.target.value = ""; }} />
              {scanMsg && <small className="muted">{scanMsg}</small>}
              {!scan && !scanMsg && <small className="muted">Pick the folder that holds <code>question_sets/</code> and <code>tournaments/</code>, or a .zip of it.</small>}
            </div>
          )}
          {mode === "folder" && scan && scanGroup && (
            <div className="field">
              {scan.sets.length > 1 && (
                <label className="field">
                  <span>Question set</span>
                  <select value={scanSet} onChange={(e) => chooseScanSet(scan, e.target.value)}>
                    {scan.sets.map((g) => <option key={g.key} value={g.key}>{g.name} ({g.mirrors.length} site{g.mirrors.length === 1 ? "" : "s"})</option>)}
                  </select>
                  <small className="muted">The folder holds several question sets; one tournament is made from the one you pick.</small>
                </label>
              )}
              <span>{scanGroup.mirrors.length - folderSkip.size} of {scanGroup.mirrors.length} sites included</span>
              <div className="site-table-wrap">
                <table className="site-table">
                  <thead><tr><th></th><th>Site (shown as)</th>{scanGroup.editionNames.size > 1 && <th>Packets</th>}<th>Games</th><th>Rounds with packets</th></tr></thead>
                  <tbody>
                    {scanGroup.mirrors.map((m) => {
                      const cov = mirrorCoverage(scan, scanGroup.key, m);
                      const off = folderSkip.has(m.name);
                      return (
                        <tr key={m.name} className={off ? "muted" : ""}>
                          <td><input type="checkbox" aria-label={`Include ${m.label}`} checked={!off} onChange={() => setFolderSkip((s0) => { const n = new Set(s0); if (n.has(m.name)) n.delete(m.name); else n.add(m.name); return n; })} /></td>
                          <td><input value={folderLabels[m.name] ?? m.label} onChange={(e) => setFolderLabels((l) => ({ ...l, [m.name]: e.target.value }))} disabled={off} /></td>
                          {scanGroup.editionNames.size > 1 && <td>{scanGroup.editionNames.get(m.edKey) || "—"}</td>}
                          <td>{m.games.length}</td>
                          <td className={cov.matched < cov.rounds ? "warn-text" : ""}>{cov.matched} / {cov.rounds}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <small className="muted">
                Each site's packets are filed under the round that site played them, so sites that read the packets in a
                different order still line up question by question.
                {(scan.noGames > 0 || scan.unmatched > 0) && <> Skipped: {[scan.noGames && `${scan.noGames} site${scan.noGames === 1 ? "" : "s"} with no usable games`, scan.unmatched && `${scan.unmatched} that matched no question set`].filter(Boolean).join(", ")}.</>}
              </small>
            </div>
          )}

          {mode === "upload" && !multi && (
            <>
              <div className="field">
                <span>Packet files (one JSON per round)</span>
                <FileDrop accept=".json" value={versions[0].packets} onChange={(f) => updateVersion(versions[0].id, { packets: f })} hint="Standard packet-parser JSON" />
              </div>
              <div className="field">
                <span>Game files (.qbj or .json)</span>
                <FileDrop accept=".json,.qbj" value={sites[0].games} onChange={(f) => onSiteGames(sites[0].id, f)} hint="QBJ files or MODAQ saved games (.qbj / .json)" />
              </div>
              <div className="multi-add">
                <span className="muted">Played at several sites, or in more than one packet version?</span>
                <button type="button" className="btn-link" onClick={addSite}>+ Add another site</button>
                <button type="button" className="btn-link" onClick={addVersion}>+ Add a packet version</button>
              </div>
            </>
          )}

          {mode === "upload" && multi && (
            <>
              <div className="field">
                <span>Packet versions</span>
                <small className="muted">One per version of the questions (e.g. American and British). Sites that read the same version share its packets.</small>
                {versions.map((v, i) => (
                  <div key={v.id} className="site-block">
                    <div className="site-block-head">
                      <input value={v.name} onChange={(e) => updateVersion(v.id, { name: e.target.value })} placeholder={versions.length > 1 ? `Version ${i + 1} name, e.g. ${i === 0 ? "American" : "British"}` : "Version name (optional)"} />
                      {versions.length > 1 && <button type="button" className="btn-link danger" onClick={() => removeVersion(v.id)}>Remove</button>}
                    </div>
                    <FileDrop accept=".json" value={v.packets} onChange={(f) => updateVersion(v.id, { packets: f })} hint="Packet-parser JSON, one per packet" />
                  </div>
                ))}
                <button type="button" className="btn-link" onClick={addVersion}>+ Add a packet version</button>
              </div>

              <div className="field">
                <span>Sites</span>
                <small className="muted">One per mirror. Each site's games are matched to packets by the packet name in its QBJs, so sites can play the packets in any order.</small>
                {sites.map((x, i) => {
                  const plan = sitePlans.get(x.id);
                  const v = versions.find((vv) => vv.id === x.versionId) || versions[0];
                  return (
                    <div key={x.id} className="site-block">
                      <div className="site-block-head">
                        <input value={x.label} onChange={(e) => updateSite(x.id, { label: e.target.value })} placeholder={`Site ${i + 1} name, e.g. Chicago`} />
                        {versions.length > 1 && (
                          <select value={x.versionId} onChange={(e) => updateSite(x.id, { versionId: e.target.value, versionTouched: true })} aria-label="Packet version this site played">
                            {versions.map((vv, j) => <option key={vv.id} value={vv.id}>{vv.name.trim() || `Version ${j + 1}`}</option>)}
                          </select>
                        )}
                        {sites.length > 1 && <button type="button" className="btn-link danger" onClick={() => removeSite(x.id)}>Remove</button>}
                      </div>
                      <FileDrop accept=".json,.qbj" value={x.games} onChange={(f) => onSiteGames(x.id, f)} hint="This site's QBJ files or MODAQ saved games" />
                      {plan && (
                        <small className={plan.mode === "name" && !plan.unmatched.length ? "muted" : "warn-text"}>
                          {plan.mode === "name"
                            ? <>Packets matched by name for {plan.byRound.size} of {plan.named} rounds.
                                {plan.unmatched.length > 0 && <> No packet in {v.name.trim() || "this version"} matches {plan.unmatched.slice(0, 3).map((u) => `round ${u.round} ("${u.packet}")`).join(", ")}{plan.unmatched.length > 3 ? `, and ${plan.unmatched.length - 3} more` : ""}, so those rounds will have no questions.</>}</>
                            : plan.named
                            ? <>Only {plan.byRound.size} of {plan.named} rounds' packet names match these packet files, so each packet's round comes from its filename (Round_3.json → round 3). Check that's the order this site played them.</>
                            : <>These games don't name their packets, so each packet's round comes from its filename (Round_3.json → round 3). Check that's the order this site played them.</>}
                        </small>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="btn-link" onClick={addSite}>+ Add another site</button>
              </div>
            </>
          )}

          {mode === "upload" && <div className="field">
            <span>YellowFruit file (optional)</span>
            <FileDrop
              accept=".yft,.json,.qbj"
              multiple={false}
              value={yfFile}
              onChange={setYfFile}
              hint="Attach the .yft you scored from to download a corrections-applied copy later."
            />
          </div>}
          </>}

          <label className="field">
            <span>Visibility</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              {VISIBILITY_OPTIONS.filter((o) => o.id !== "public" || level !== "practice").map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <small className="muted">{visDesc}</small>
            {level === "practice" && (
              <small className="muted">Practice tournaments stay listed or private, and don't need a moderator's review.</small>
            )}
            {level !== "practice" && visibility === "private" && (
              <small className="muted">Private tournaments go up right away, without waiting for a moderator's review.</small>
            )}
          </label>

          {visibility !== "public" && level !== "practice" && (
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
