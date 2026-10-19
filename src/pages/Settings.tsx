import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { clearSetCache, refreshIndex } from "../data";
import { Visibility, TOURNAMENT_LEVELS, difficultyOptions } from "../types";
import { Loading } from "../components/Common";
import { RoundTagsEditor } from "../components/RoundTagsEditor";
import { RoundAlignEditor, GameFilesEditor, UploadCleanup, RenamesEditor } from "../components/SourceFiles";
import { MetaMapEditor } from "../components/MetaMapEditor";
import { BonusDifficultyEditor } from "../components/BonusDifficulty";
import { ForumMembers } from "../components/ForumMembers";
import { RenamePicker } from "../components/Rename";
import { byLabel, hasYearFirst, yearFirstSuggestion } from "../util";
import { AddFilesForm } from "../components/AddFiles";
import { PacketTextFill } from "../components/BonusTextRepair";
import { QuestionEditor } from "../components/QuestionEditor";
import { DupeFinder } from "../components/DupeFinder";
import { ReplacementEditor } from "../components/Replacements";
import { ReplaceData } from "../components/ReplaceData";
import { KlaxonUpload } from "../components/KlaxonUpload";

const VIS_OPTIONS: { id: Visibility; label: string; desc: string }[] = [
  { id: "listed", label: "Listed (login + invite)", desc: "Shown in the list; only invited, logged-in people can view." },
  { id: "private", label: "Private (invite only)", desc: "Hidden from the list; only you and invitees can view." },
  { id: "public", label: "Public (open to all)", desc: "Shown in the list and viewable by anyone." },
];

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}
const toDateInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

// Settings is split into tabs, each its own URL (settings/<tab>). Older links
// point at a section by its #id (the warning banners do), so an id alone still
// opens the tab that holds it.
const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "access", label: "Access & sharing" },
  { id: "questions", label: "Questions & categories", sourceOnly: true },
  { id: "files", label: "Rounds & files", sourceOnly: true },
  { id: "renames", label: "Players & teams", sourceOnly: true },
  { id: "maintenance", label: "Maintenance" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
const TAB_OF_SECTION: Record<string, SettingsTab> = {
  rename: "general", details: "general", visibility: "access", yf: "maintenance", maintenance: "maintenance", delete: "maintenance",
  requests: "access", people: "access", links: "access", phases: "questions", roundsgames: "files", replace: "files", klaxon: "files", categories: "questions", bonusdiff: "questions", bonustext: "questions", questionedits: "questions",
  rounds: "files", addrounds: "files", uploads: "files", games: "files", replacements: "files", renames: "renames", dupes: "renames", discussion: "access", revoke: "access",
};

export function Settings() {
  const { slug = "", tab: tabParam } = useParams();
  const { isOwner, meta, user, editions } = useSetCtx();
  const loc = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Access-request emails deep-link here with ?review=access, so lead with the
  // pending list instead of burying it under the rest of the settings.
  const reviewingAccess = params.get("review") === "access";
  const [loading, setLoading] = useState(true);
  const [visibility, setVisibility] = useState<Visibility>("listed");
  const [autoPublish, setAutoPublish] = useState(false);
  // Whether viewers may propose buzz corrections / renames.
  const [allowRequests, setAllowRequests] = useState(true);
  const [date, setDate] = useState("");
  const [invites, setInvites] = useState<string[]>([]);
  // People: one add box for viewers and co-owners.
  const [newPerson, setNewPerson] = useState("");
  const [newRole, setNewRole] = useState<"viewer" | "coowner">("viewer");
  const [coOwners, setCoOwners] = useState<string[]>([]);
  // Co-owners who were invited before they had an account and haven't signed up.
  const [coOwnersPending, setCoOwnersPending] = useState<string[]>([]);
  // The creator alone may edit the co-owner list and delete the set; a co-owner
  // looking at this page gets everything else.
  const [isPrimary, setIsPrimary] = useState(false);
  const [hasYf, setHasYf] = useState(false);
  const [level, setLevel] = useState("");
  const [individual, setIndividual] = useState(false);
  const [forum, setForum] = useState(false);
  const [tdLink, setTdLink] = useState("");
  const [tournamentDate, setTournamentDate] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [accessRequests, setAccessRequests] = useState<{ email: string; name: string; at: string; role?: string; team?: string; fromLink?: string }[]>([]);
  const [resolved, setResolved] = useState<{ email: string; name: string; status: string; via?: string; resolvedAt?: string }[]>([]);
  const [links, setLinks] = useState<{ id: string; label: string; at: string; revoked?: boolean; uses: number; approval?: boolean }[]>([]);
  // Whether the next link created files requests rather than letting people in.
  const [linkApproval, setLinkApproval] = useState(false);
  // "Revoke all access": a two-step confirm, and — only for a public set —
  // whether it ends up listed or private.
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [revokeTo, setRevokeTo] = useState<"listed" | "private">("listed");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // A queued request to make this set public, awaiting a moderator (fresh
  // uploads need approval), and whether picking Public would queue one.
  const [publicPending, setPublicPending] = useState(false);
  const [publicNeedsApproval, setPublicNeedsApproval] = useState(false);
  const [pendingVis, setPendingVis] = useState<string>("public");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Deleting is irreversible and takes the uploaded files with it, so the name
  // has to be typed out — a stray click can't do it.
  const [confirmDelete, setConfirmDelete] = useState("");
  // Renaming. Seeded from what's published rather than fetched: the set's name
  // and its edition labels are already in this page's context.
  const [nameDraft, setNameDraft] = useState(meta?.setName ?? "");
  const [edLabels, setEdLabels] = useState<Record<string, string>>({});
  useEffect(() => setNameDraft(meta?.setName ?? ""), [meta?.setName]);
  useEffect(() => setEdLabels(Object.fromEntries(editions.map((e) => [e.id, e.label]))), [editions]);
  const renameDirty =
    nameDraft.trim() !== (meta?.setName ?? "") ||
    editions.some((e) => (edLabels[e.id] ?? e.label).trim() !== e.label);

  useEffect(() => {
    if (!isOwner) { setLoading(false); return; }
    fetch(`/api/manage?slug=${encodeURIComponent(slug)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed to load settings");
        setVisibility(d.visibility);
        setAutoPublish(!!d.autoPublicAt);
        setAllowRequests(d.allowRequests !== false);
        setDate(toDateInput(d.autoPublicAt) || new Date(Date.now() + 2 * 365 * 864e5).toISOString().slice(0, 10));
        setInvites(d.invites || []);
        setCoOwners(d.coOwners || []);
        setCoOwnersPending(d.coOwnersPending || []);
        setIsPrimary(!!d.isPrimaryOwner);
        setHasYf(!!d.hasYf);
        setLevel(d.level || "");
        setIndividual(!!d.individual);
        setForum(!!d.forum);
        setTdLink(d.tdLink || "");
        setTournamentDate(d.tournamentDate || "");
        setDifficulty(d.difficulty || "");
        setPublicPending(!!d.publicPending);
        setPendingVis(d.pendingVisibility || "public");
        setPublicNeedsApproval(!!d.publicNeedsApproval);
        setAccessRequests(d.accessRequests || []);
        setResolved(d.resolvedRequests || []);
        setLinks(d.links || []);
      })
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [slug, isOwner]);

  // A client-side navigation doesn't do what the browser does with a #hash, and
  // the section it names isn't on the page until the settings have loaded — so
  // the warning banners' "Fix …" buttons, which promise to take the owner to
  // one particular repair, were landing them at the top of a long page with it
  // somewhere below. Go to it once it's actually there.
  // The editors above a section fetch their own data after this, and as they
  // fill in they push it down the page — "Map these questions" was landing two
  // screens short of the mapper. So keep it pinned while the page settles, until
  // the owner scrolls for themselves.
  useEffect(() => {
    if (loading || !loc.hash) return;
    const el = document.getElementById(loc.hash.slice(1));
    if (!el) return;
    for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
    // A frame's grace so the section has laid out before we measure it.
    const t = setTimeout(() => el.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
    const ro = new ResizeObserver(() => el.scrollIntoView({ block: "start" }));
    ro.observe(document.body);
    const stop = () => {
      ro.disconnect();
      for (const ev of ["wheel", "touchstart", "keydown", "mousedown"]) window.removeEventListener(ev, stop);
    };
    for (const ev of ["wheel", "touchstart", "keydown", "mousedown"]) window.addEventListener(ev, stop, { passive: true });
    const done = setTimeout(stop, 5000);
    return () => { clearTimeout(t); clearTimeout(done); stop(); };
  }, [loading, loc.hash]);

  const tabs = SETTINGS_TABS.filter((t) => !("sourceOnly" in t) || meta?.kind !== "results");
  const hashTab = loc.hash ? TAB_OF_SECTION[loc.hash.slice(1)] : undefined;
  const tab: SettingsTab = (tabs.find((t) => t.id === tabParam)?.id) ?? hashTab ?? "general";

  if (!user)
    return (
      <p className="caveat">
        {reviewingAccess ? "Log in as the tournament owner to review access requests." : "Log in as the tournament owner to change settings."}{" "}
        <Link to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} className="link">Log in →</Link>
      </p>
    );
  if (!isOwner) return <p className="caveat">Only the set owner can change settings.</p>;
  if (loading) return <Loading />;

  // The General tab's one Save. Names are only sent when they changed (a
  // rename rebuilds the stats); the details always are.
  async function saveDetails() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      if (!nameDraft.trim()) throw new Error("Enter a tournament name.");
      if (!level) throw new Error("Choose a tournament type.");
      const notes: string[] = [];
      let rebuilt = false;
      if (renameDirty) {
        const changedEds = Object.fromEntries(
          editions.filter((e) => (edLabels[e.id] ?? e.label).trim() !== e.label).map((e) => [e.id, (edLabels[e.id] ?? e.label).trim()])
        );
        const nameChanged = nameDraft.trim() !== (meta?.setName ?? "");
        await postJson("/api/manage", {
          slug, op: "rename",
          ...(nameChanged ? { name: nameDraft.trim() } : {}),
          ...(Object.keys(changedEds).length ? { editions: changedEds } : {}),
        });
        rebuilt = true;
      }
      const d = await postJson("/api/manage", { slug, op: "details", level, tdLink: tdLink.trim(), difficulty, tournamentDate, individual });
      setTournamentDate(d.tournamentDate || "");
      setDifficulty(d.difficulty || "");
      if (d.rebuilt) rebuilt = true;
      // Reclassifying as practice can take a public set down to listed, and
      // changes whether going public needs a moderator.
      if (d.visibility && d.visibility !== visibility) {
        setVisibility(d.visibility);
        if (d.level === "practice") notes.push("Practice tournaments can't be public, so it's listed now.");
      }
      if (d.level === "practice") setAutoPublish(false);
      setPublicPending(!!d.publicPending);
      setPublicNeedsApproval(!!d.publicNeedsApproval);
      if (rebuilt) clearSetCache(slug);
      refreshIndex();
      setMsg(["Saved.", ...notes].join(" "));
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function saveVisibility() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const notes: string[] = [];
      const autoPublicAt = visibility === "public" || level === "practice" ? null : autoPublish ? new Date(date).toISOString() : null;
      const s = await postJson("/api/manage", { slug, op: "settings", visibility, autoPublicAt, allowRequests });
      if (s.publicPending) {
        // The switch wasn't applied: it's queued for a moderator.
        setPublicPending(true);
        setPendingVis(s.pendingVisibility || "public");
        setVisibility(s.visibility);
        setAutoPublish(!!s.autoPublicAt);
        notes.push(`Making it ${s.pendingVisibility === "listed" ? "listed" : "public"} needs a moderator; you'll get an email when it's decided.`);
      } else setPublicPending(false);
      refreshIndex();
      setMsg(["Saved.", ...notes].join(" "));
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function rebuild() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await postJson("/api/manage", { slug, op: "reaggregate" });
      setMsg("Stats rebuilt. Reload to see them.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function deleteSet() {
    if (confirmDelete.trim() !== meta.setName) return;
    setErr(null); setMsg(null); setBusy(true);
    try {
      await postJson("/api/manage", { slug, op: "delete" });
      clearSetCache(slug);
      refreshIndex();
      navigate("/", { replace: true });
    } catch (e) {
      setErr(String((e as Error).message || e));
      setBusy(false);
    }
  }

  async function invite(op: "invite" | "uninvite", email: string) {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const d = await postJson("/api/manage", { slug, op, email });
      setInvites(d.invites || []);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function coOwner(op: "coowner" | "uncoowner", email: string) {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const d = await postJson("/api/manage", { slug, op, email });
      setCoOwners(d.coOwners || []);
      setCoOwnersPending(d.coOwnersPending || []);
      // Adding a co-owner drops them from the invite list — they can see
      // everything now, so listing them twice would be confusing.
      setInvites(d.invites || []);
      if (op === "coowner") {
        if (d.invited === undefined) setMsg(`${email} is now a co-owner.`);
        else if (d.invited) setMsg(`${email} has no account yet, so we emailed them an invitation. They become a co-owner when they sign up.`);
        else setMsg(`${email} is on the list, but the invitation email failed. Ask them to sign up with that address.`);
      }
      refreshIndex();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function decide(email: string, approve: boolean) {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const d = await postJson("/api/manage", { slug, op: approve ? "approve-access" : "deny-access", email });
      setAccessRequests(d.accessRequests || accessRequests.filter((a) => a.email !== email));
      if (d.resolvedRequests) setResolved(d.resolvedRequests);
      if (approve) setInvites((prev) => [...new Set([...prev, email])].sort());
      refreshIndex(); // the waiting-request badges count these
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  async function revokeAll() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const d = await postJson("/api/manage", { slug, op: "revoke-all-access", visibility: revokeTo });
      setInvites([]);
      setLinks(d.links || []);
      setAccessRequests([]);
      if (d.resolvedRequests) setResolved(d.resolvedRequests);
      setVisibility(d.visibility);
      setAutoPublish(false);
      setPublicPending(false);
      setRevokeConfirm(false);
      refreshIndex();
      const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
      setMsg(`Access revoked: removed ${n(d.removed, "person")}, ${n(d.revokedLinks, "link")} and ${n(d.declined, "request")}. It's ${d.visibility} now.`);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  const linkUrl = (id: string) => `${window.location.origin}/join/${slug}?key=${id}`;
  async function createLink() {
    setErr(null); setMsg(null); setBusy(true);
    try { const d = await postJson("/api/manage", { slug, op: "create-link", approval: linkApproval }); setLinks(d.links || []); }
    catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }
  async function revokeLink(id: string) {
    setBusy(true);
    try { const d = await postJson("/api/manage", { slug, op: "revoke-link", id }); setLinks(d.links || []); }
    catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }
  async function copyLink(id: string) {
    try { await navigator.clipboard.writeText(linkUrl(id)); setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); } catch { /* ignore */ }
  }

  const visDesc = VIS_OPTIONS.find((v) => v.id === visibility)?.desc;
  const activeLinks = links.filter((l) => !l.revoked);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // What needs fixing, from the warnings the stats build already records. These
  // replace the big banners the rest of the tournament shows an owner.
  const roundWarn = meta?.roundWarnings?.length ?? 0;
  const crossTeams = meta?.crossMirrorTeams?.length ?? 0;
  const missingQs = meta?.missingQuestions?.length ?? 0;
  const bonusDiff = meta?.bonusDiffWarnings?.length ?? 0;
  const needsMap = !!meta?.needsCategoryMapping;
  const attention: { text: string; to: string }[] = [
    ...(roundWarn ? [{ text: `${plural(roundWarn, "packet round")} not lined up with ${roundWarn === 1 ? "its" : "their"} games`, to: "files#rounds" }] : []),
    ...(crossTeams ? [{ text: `${plural(crossTeams, "team")} played in more than one edition`, to: "files#games" }] : []),
    ...(missingQs ? [{ text: `${plural(missingQs, "question")} read that ${missingQs === 1 ? "isn't" : "aren't"} in the packets`, to: "files#replacements" }] : []),
    ...(bonusDiff ? [{ text: `${plural(bonusDiff, "bonus", "bonuses")} with impossible difficulty marks`, to: "questions#bonusdiff" }] : []),
    ...(needsMap ? [{ text: "Category fields need confirming", to: "questions#categories" }] : []),
  ];
  const tabCount: Partial<Record<SettingsTab, number>> = {
    access: accessRequests.length,
    files: (roundWarn ? 1 : 0) + (crossTeams ? 1 : 0) + (missingQs ? 1 : 0),
    questions: (bonusDiff ? 1 : 0) + (needsMap ? 1 : 0),
  };

  // People: co-owners and invited viewers in one list. A public tournament
  // needs no viewers, and only the creator manages co-owners.
  const canAddViewer = visibility !== "public";
  const roleChoices = [...(canAddViewer ? ["viewer"] : []), ...(isPrimary ? ["coowner"] : [])] as ("viewer" | "coowner")[];
  const role = roleChoices.includes(newRole) ? newRole : roleChoices[0];
  const people = [
    ...coOwners.map((e) => ({ email: e, role: "coowner" as const })),
    ...(canAddViewer ? invites.filter((e) => !coOwners.includes(e)).map((e) => ({ email: e, role: "viewer" as const })) : []),
  ];
  async function addPerson() {
    const email = newPerson.trim();
    if (!email) return;
    if (role === "coowner") await coOwner("coowner", email);
    else await invite("invite", email);
    setNewPerson("");
  }

  const accessSection = (accessRequests.length > 0 || resolved.length > 0) && (
    <Sec id="requests" title={`Access requests (${accessRequests.length})`}>
      {accessRequests.length > 0 && (
        <ul className="invite-list">
          {accessRequests.map((a) => (
            <li key={a.email}>
              <span>
                <strong>{a.name}</strong> <span className="muted">· {a.email}</span>
                {(a.role || a.team) && <span className="muted"> · {[a.role, a.team].filter(Boolean).join(" — ")}</span>}
                {a.fromLink !== undefined && <span className="muted"> · via invite link{a.fromLink ? ` "${a.fromLink}"` : ""}</span>}
              </span>
              <span className="req-actions">
                <button className="btn-primary btn-sm" disabled={busy} onClick={() => decide(a.email, true)}>Approve</button>
                <button className="btn-link" disabled={busy} onClick={() => decide(a.email, false)}>Deny</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <details className="set-sub">
          <summary>Recently settled ({resolved.length})</summary>
          <ul className="invite-list">
            {resolved.map((r) => (
              <li key={r.email}>
                <span><strong>{r.name}</strong> <span className="muted">· {r.email}</span></span>
                <span className="muted">
                  {r.status === "denied" ? "denied" : r.via === "link" ? "joined by invite link" : "approved"}
                  {r.resolvedAt ? ` · ${new Date(r.resolvedAt).toLocaleDateString()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Sec>
  );

  const isResults = meta?.kind === "results";

  return (
    <div className="detail settings-page">
      <h1>Settings</h1>
      {err && <div className="error-box">{err}</div>}
      {msg && <div className="caveat"><span className="ok-msg">{msg}</span></div>}

      {reviewingAccess && accessSection && <div className="caveat" style={{ marginBottom: 20 }}>{accessSection}</div>}

      {attention.length > 0 && (
        <div className="set-attn" role="status">
          <strong>Needs attention</strong>
          <ul>
            {attention.map((a) => (
              <li key={a.to}><span>{a.text}</span> <Link className="link" to={`/set/${slug}/settings/${a.to}`}>Fix</Link></li>
            ))}
          </ul>
        </div>
      )}

      <nav className="admin-tabs" aria-label="Settings sections">
        {tabs.map((t) => (
          <NavLink key={t.id} to={t.id === "general" ? `/set/${slug}/settings` : `/set/${slug}/settings/${t.id}`} end
            className={() => "admin-tab" + (tab === t.id ? " active" : "")}>
            {t.label}
            {!!tabCount[t.id] && <span className="badge-new">{tabCount[t.id]}</span>}
          </NavLink>
        ))}
        <a className="admin-tab set-help-tab" href="/help/settings" target="_blank" rel="noreferrer">Help ↗</a>
      </nav>

      {/* Every tab stays mounted and is only hidden, so an upload or repair in one
          keeps going while you look at another. */}
      <section hidden={tab !== "general"}>
        <Sec id="details" title="Tournament" line="Renaming keeps the web address, so shared links still work." help="details">
          <div className="create-form" style={{ maxWidth: 560 }}>
            <label className="field" id="rename">
              <span>Name</span>
              <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="e.g. 2026 PACE NSC" />
            </label>
            {!!nameDraft.trim() && !hasYearFirst(nameDraft) && (
              <p className="caveat name-hint">
                Names here go year first.{" "}
                {yearFirstSuggestion(nameDraft) && <>Use <button type="button" className="btn-link" onClick={() => setNameDraft(yearFirstSuggestion(nameDraft)!)}>{yearFirstSuggestion(nameDraft)}</button>?</>}
              </p>
            )}
            {editions.length > 0 && (
              <details className="set-sub">
                <summary>Edition names ({editions.length})</summary>
                {byLabel(editions).map((e) => (
                  <label className="field" key={e.id}>
                    <input value={edLabels[e.id] ?? e.label} aria-label={`Name for edition ${e.label}`}
                      onChange={(ev) => setEdLabels((m) => ({ ...m, [e.id]: ev.target.value }))} />
                  </label>
                ))}
              </details>
            )}
            <div className="set-row">
              <label className="field">
                <span>Type</span>
                <select value={level} onChange={(e) => { setLevel(e.target.value); setDifficulty(""); }}>
                  <option value="" disabled>Choose a type…</option>
                  {TOURNAMENT_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </label>
              {difficultyOptions(level).length > 0 && (
                <label className="field">
                  <span>Difficulty</span>
                  <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                    <option value="">Not set</option>
                    {difficultyOptions(level).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                </label>
              )}
              <label className="field">
                <span>Date first played</span>
                <input type="date" value={tournamentDate} onChange={(e) => setTournamentDate(e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span>Tournament Database link</span>
              <input type="url" value={tdLink} onChange={(e) => setTdLink(e.target.value)} placeholder="https://hsquizbowl.org/db/tournaments/…" />
            </label>
            <label className="field-inline">
              <input type="checkbox" checked={individual} onChange={(e) => setIndividual(e.target.checked)} />
              <span>Individual shootout: rank players, not teams</span>
            </label>

            <button className="btn-primary" disabled={busy || !nameDraft.trim()} onClick={saveDetails}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </Sec>
      </section>

      <section hidden={tab !== "maintenance"}>
        <Sec id="maintenance" title="Rebuild stats" line="Recompute every stat from the uploaded files." help="delete">
          <div><button className="btn-secondary" disabled={busy} onClick={rebuild}>Rebuild stats</button></div>
        </Sec>

        {hasYf && (
          <Sec id="yf" title="YellowFruit export" line="Your .yft with buzz corrections applied.">
            <div><a className="btn-secondary" href={`/api/yf-export?slug=${encodeURIComponent(slug)}`}>Download .yft</a></div>
          </Sec>
        )}

        {isPrimary && (
          <Sec id="delete" title="Delete this tournament" line="Removes every stat, correction and uploaded file for good." help="delete">
            <div className="danger-zone">
              <label className="field-inline" style={{ flexWrap: "wrap" }}>
                <span>Type <strong>{meta.setName}</strong> to confirm</span>
                <input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={meta.setName} className="set-input" />
              </label>
              <div style={{ marginTop: 10 }}>
                <button className="btn-primary btn-sm danger-btn" disabled={busy || confirmDelete.trim() !== meta.setName} onClick={deleteSet}>
                  {busy ? "Deleting…" : "Delete tournament"}
                </button>
              </div>
            </div>
          </Sec>
        )}
      </section>

      <section hidden={tab !== "access"}>
        {!reviewingAccess && accessSection}

        <Sec id="visibility" title="Visibility" help="visibility">
          <div className="create-form" style={{ maxWidth: 560 }}>
            <label className="field">
              <span>Who can see it</span>
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
                {VIS_OPTIONS.filter((o) => o.id !== "public" || level !== "practice").map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <small className="muted">
                {visDesc}
                {level === "practice" ? " Practice tournaments can't be public."
                  : publicPending ? ` Waiting for a moderator to approve making it ${pendingVis === "listed" ? "listed" : "public"}.`
                  : publicNeedsApproval && visibility !== "public" ? " Going public needs a moderator's approval." : ""}
              </small>
            </label>
            {visibility !== "public" && level !== "practice" && (
              <label className="field-inline">
                <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
                <span>Make public on</span>
                <input type="date" value={date} disabled={!autoPublish} onChange={(e) => setDate(e.target.value)} />
              </label>
            )}
            <label className="field-inline">
              <input type="checkbox" checked={allowRequests} onChange={(e) => setAllowRequests(e.target.checked)} />
              <span>Let viewers suggest corrections</span>
            </label>
            <button className="btn-primary" disabled={busy} onClick={saveVisibility}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </Sec>


        <Sec id="people" title={`People (${people.length})`} line={canAddViewer ? "Viewers can open it and suggest fixes. Co-owners can manage everything but this list and deleting." : "Co-owners can manage everything but this list and deleting."} help="people">
          {roleChoices.length > 0 && (
            <div className="buzz-edit" style={{ marginBottom: 10 }}>
              <input type="email" placeholder="person@example.com" value={newPerson} onChange={(e) => setNewPerson(e.target.value)} className="set-input" />
              {roleChoices.length > 1 ? (
                <select value={role} onChange={(e) => setNewRole(e.target.value as "viewer" | "coowner")} aria-label="Role">
                  <option value="viewer">Viewer</option>
                  <option value="coowner">Co-owner</option>
                </select>
              ) : <span className="muted">{role === "coowner" ? "as co-owner" : "as viewer"}</span>}
              <button className="btn-primary btn-sm" disabled={busy || !newPerson.trim()} onClick={addPerson}>Add</button>
            </div>
          )}
          {people.length === 0 ? <p className="muted">Nobody yet.</p> : (
            <ul className="invite-list">
              {people.map((p) => (
                <li key={p.role + p.email}>
                  <span>
                    {p.email} <span className="muted">· {p.role === "coowner" ? "co-owner" : "viewer"}</span>
                    {p.role === "coowner" && coOwnersPending.includes(p.email) && <span className="muted"> · no account yet</span>}
                  </span>
                  <span className="req-actions">
                    {p.role === "coowner" && isPrimary && coOwnersPending.includes(p.email) && <button className="btn-link" disabled={busy} onClick={() => coOwner("coowner", p.email)}>Resend</button>}
                    {(p.role === "viewer" || isPrimary) && (
                      <button className="btn-link" disabled={busy} onClick={() => (p.role === "viewer" ? invite("uninvite", p.email) : coOwner("uncoowner", p.email))}>Remove</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Sec>

        {visibility !== "public" && (
          <Sec id="links" title="Invite links" line="Anyone with an account who opens a link gets in, or asks you first." help="links">
            <div className="buzz-edit">
              <label className="field-inline">
                <input type="checkbox" checked={linkApproval} onChange={(e) => setLinkApproval(e.target.checked)} /> Ask me first
              </label>
              <button className="btn-primary btn-sm" disabled={busy} onClick={createLink}>Create link</button>
            </div>
            {activeLinks.length > 0 && (
              <ul className="invite-list" style={{ marginTop: 10 }}>
                {activeLinks.map((l) => (
                  <li key={l.id}>
                    <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{linkUrl(l.id)}</span>
                    <span className="req-actions">
                      {l.approval && <span className="muted">asks first ·</span>}
                      <span className="muted">{plural(l.uses, "use")}</span>
                      <button className="btn-link" onClick={() => copyLink(l.id)}>{copiedId === l.id ? "Copied!" : "Copy"}</button>
                      <button className="btn-link danger" disabled={busy} onClick={() => revokeLink(l.id)}>Revoke</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Sec>
        )}

        <Sec id="discussion" title="Discussion" line="Signed-in viewers can read; people you approve can post." help="discussion">
          <label className="field-inline">
            <input type="checkbox" checked={forum} onChange={async (e) => {
              const on = e.target.checked; setForum(on); setErr(null);
              try { await postJson("/api/manage", { slug, op: "settings", forum: on }); refreshIndex(); setMsg(on ? "Discussion is open." : "Discussion is closed."); }
              catch (err) { setForum(!on); setErr(String((err as Error).message || err)); }
            }} />
            <span>Open a discussion for this tournament</span>
          </label>
          {forum && <ForumMembers slug={slug} enabled={forum} />}
        </Sec>

        <Sec id="revoke" title="Revoke all access" line="Remove everyone but the owners, stop every invite link and decline pending requests." help="revoke" fold>
          <div className="danger-zone">
            {visibility === "public" && (
              <label className="field" style={{ marginBottom: 10, maxWidth: 420 }}>
                <span>It's public now, so it becomes</span>
                <select value={revokeTo} onChange={(e) => setRevokeTo(e.target.value as "listed" | "private")} disabled={busy}>
                  <option value="listed">Listed: in the list, content hidden</option>
                  <option value="private">Private: hidden from the list too</option>
                </select>
              </label>
            )}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {!revokeConfirm ? (
                <button className="btn-primary btn-sm danger-btn" disabled={busy} onClick={() => setRevokeConfirm(true)}>Revoke all access…</button>
              ) : (
                <>
                  <span>Remove everyone but the owners?</span>
                  <button className="btn-primary btn-sm danger-btn" disabled={busy} onClick={revokeAll}>{busy ? "Revoking…" : "Yes, revoke"}</button>
                  <button className="btn-link" disabled={busy} onClick={() => setRevokeConfirm(false)}>Cancel</button>
                </>
              )}
            </div>
          </div>
        </Sec>
      </section>

      <section hidden={tab !== "questions"}>
        {!isResults && (meta?.rounds?.length ?? 0) > 0 && (
          <Sec id="phases" title="Round phases" line="Tag rounds as Prelims, Playoffs and so on so viewers can filter by phase." help="phases">
            <RoundTagsEditor slug={slug} rounds={meta!.rounds} />
          </Sec>
        )}
        {!isResults && (
          <>
            <Sec id="categories" title="Category fields" line="Say what each metadata field means. Tag fields become filters." help="categories"
              fold open={needsMap} flag={needsMap ? "needs confirming" : undefined}>
              <MetaMapEditor slug={slug} />
            </Sec>
            <Sec id="questionedits" title="Edit questions" line="File selected questions under one category or tag. Edits survive re-uploads." help="questionedits" fold>
              <QuestionEditor slug={slug} hasBonuses={!!meta?.hasBonuses} />
            </Sec>
            {meta?.hasBonuses && (
              <>
                <Sec id="bonusdiff" title="Bonus difficulty marks" line="Fix bonuses whose parts aren't marked easy, medium and hard once each." help="bonusdiff"
                  fold open={bonusDiff > 0} flag={bonusDiff ? plural(bonusDiff, "bonus", "bonuses") : undefined}>
                  <BonusDifficultyEditor slug={slug} warnings={meta?.bonusDiffWarnings ?? []} />
                </Sec>
                <Sec id="bonustext" title="Fill bonus text" line="Add missing bonus lead-ins and parts from a fill file." help="bonustext" fold>
                  <PacketTextFill slug={slug} name={meta?.setName ?? slug} />
                </Sec>
              </>
            )}
          </>
        )}
      </section>

      <section hidden={tab !== "files"}>
        {!isResults && (
          <>
            <Sec id="addrounds" title="Add rounds or games" line="Upload more rounds, or tick Replace to redo one." help="addrounds">
              {/* A set uploaded before editions existed has no summary row; it still has
                  the one edition every set has. */}
              <AddFilesForm slug={slug} editions={editions.length ? editions : [{ id: "e0", label: "Original" }]} />
            </Sec>

            <Sec id="roundsgames" title="Rounds & games" line="Fix a wrong round number, or remove duplicate or misfiled uploads." help="rounds">
              <details id="rounds" className="set-sub" open={roundWarn > 0 || undefined}>
                <summary>Round numbers{roundWarn > 0 && <span className="warn-text"> · {plural(roundWarn, "problem")}</span>}</summary>
                <RoundAlignEditor slug={slug} />
              </details>
              <details id="games" className="set-sub" open={crossTeams > 0 || undefined}>
                <summary>Games{crossTeams > 0 && <span className="warn-text"> · {plural(crossTeams, "team")} in more than one edition</span>}</summary>
                <GameFilesEditor slug={slug} />
              </details>
              <details id="uploads" className="set-sub">
                <summary>Remove rounds</summary>
                <UploadCleanup slug={slug} />
              </details>
            </Sec>

            <Sec id="klaxon" title="Klaxon buzz logs" line="Add every press behind each buzz from Klaxon rooms. Shown on its own page." help="klaxon"
              fold open={!!meta?.hasKlaxon} flag={meta?.hasKlaxon ? "attached" : undefined}>
              <KlaxonUpload slug={slug} hasKlaxon={!!meta?.hasKlaxon} multiEdition={editions.length > 1} />
            </Sec>

            <Sec id="replacements" title="Tiebreakers & replacements" line="Point tiebreakers and replacement questions at the question the room actually read." help="replacements"
              fold open={missingQs > 0} flag={missingQs ? plural(missingQs, "question") : undefined}>
              <ReplacementEditor slug={slug} />
            </Sec>

            <Sec id="replace" title="Replace all data" line="Swap in a new .db or data folder. Settings and corrections are kept." help="replace" fold>
              <ReplaceData
                slug={slug} setName={meta?.setName ?? ""} scoring={meta?.scoring ?? ""}
                editions={editions.length ? editions : [{ id: "e0", label: "Original" }]}
                onDone={() => setTimeout(() => window.location.reload(), 1500)}
              />
            </Sec>
          </>
        )}
      </section>

      <section hidden={tab !== "renames"}>
        {!isResults && (
          <>
            <Sec id="renames" title="Rename players and teams" line="Merge two spellings of a player or team. Viewers can suggest renames too." help="renames">
              <RenamePicker slug={slug} individual={!!meta.individual} returnTo={`${loc.pathname}#renames`} />
              <details className="set-sub">
                <summary>Applied renames</summary>
                <RenamesEditor slug={slug} />
              </details>
            </Sec>
            <Sec id="dupes" title="Possible duplicates" line="These look like the same team or player. Tick and merge." help="dupes" fold>
              <DupeFinder slug={slug} individual={!!meta.individual} />
            </Sec>
          </>
        )}
      </section>
    </div>
  );
}

// One Settings section: a heading, one line saying what it does, a Help link to
// the longer explanation, and its tool. A `fold` section collapses to that
// heading and line unless it has something to fix (`open`).
function Sec({ id, title, line, help, fold, open, flag, children }: {
  id: string; title: string; line?: string; help?: string; fold?: boolean; open?: boolean; flag?: string; children?: ReactNode;
}) {
  const head = (
    <>
      <h2 className="set-h">{title}{flag && <span className="set-flag">{flag}</span>}</h2>
      {(line || help) && (
        <p className="muted set-line">
          {line}
          {help && <> <a className="link" href={`/help/settings#${help}`} target="_blank" rel="noreferrer">Help</a></>}
        </p>
      )}
    </>
  );
  if (fold)
    return (
      <details id={id} className="set-sec set-fold" open={open || undefined}>
        <summary>{head}</summary>
        <div className="set-body">{children}</div>
      </details>
    );
  return <div id={id} className="set-sec">{head}<div className="set-body">{children}</div></div>;
}
