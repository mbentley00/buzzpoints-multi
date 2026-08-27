import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { clearSetCache, refreshIndex } from "../data";
import { Visibility, TOURNAMENT_LEVELS } from "../types";
import { Loading } from "../components/Common";
import { RoundTagsEditor } from "../components/RoundTagsEditor";
import { RoundAlignEditor, GameFilesEditor, UploadCleanup, RenamesEditor } from "../components/SourceFiles";
import { MetaMapEditor } from "../components/MetaMapEditor";
import { BonusDifficultyEditor } from "../components/BonusDifficulty";

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

export function Settings() {
  const { slug = "" } = useParams();
  const { isOwner, meta, user } = useSetCtx();
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
  const [newInvite, setNewInvite] = useState("");
  const [coOwners, setCoOwners] = useState<string[]>([]);
  const [newCoOwner, setNewCoOwner] = useState("");
  // The creator alone may edit the co-owner list and delete the set; a co-owner
  // looking at this page gets everything else.
  const [isPrimary, setIsPrimary] = useState(false);
  const [hasYf, setHasYf] = useState(false);
  const [level, setLevel] = useState("");
  const [tdLink, setTdLink] = useState("");
  const [accessRequests, setAccessRequests] = useState<{ email: string; name: string; at: string; role?: string; team?: string }[]>([]);
  const [resolved, setResolved] = useState<{ email: string; name: string; status: string; via?: string; resolvedAt?: string }[]>([]);
  const [links, setLinks] = useState<{ id: string; label: string; at: string; revoked?: boolean; uses: number }[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // A queued request to make this set public, awaiting a moderator (fresh
  // uploads need approval), and whether picking Public would queue one.
  const [publicPending, setPublicPending] = useState(false);
  const [publicNeedsApproval, setPublicNeedsApproval] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Deleting is irreversible and takes the uploaded files with it, so the name
  // has to be typed out — a stray click can't do it.
  const [confirmDelete, setConfirmDelete] = useState("");

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
        setIsPrimary(!!d.isPrimaryOwner);
        setHasYf(!!d.hasYf);
        setLevel(d.level || "");
        setTdLink(d.tdLink || "");
        setPublicPending(!!d.publicPending);
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
  useEffect(() => {
    if (loading || !loc.hash) return;
    const el = document.getElementById(loc.hash.slice(1));
    if (!el) return;
    // A frame's grace so the section has laid out before we measure it.
    const t = setTimeout(() => el.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
    return () => clearTimeout(t);
  }, [loading, loc.hash]);

  if (!user)
    return (
      <p className="caveat">
        {reviewingAccess ? "Log in as the tournament owner to review access requests." : "Log in as the tournament owner to change settings."}{" "}
        <Link to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} className="link">Log in →</Link>
      </p>
    );
  if (!isOwner) return <p className="caveat">Only the set owner can change settings.</p>;
  if (loading) return <Loading />;

  async function saveSettings() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const autoPublicAt = visibility === "public" ? null : autoPublish ? new Date(date).toISOString() : null;
      const d = await postJson("/api/manage", { slug, op: "settings", visibility, autoPublicAt, allowRequests });
      refreshIndex();
      if (d.publicPending) {
        // The switch to public wasn't applied — it's queued for a moderator.
        setPublicPending(true);
        setVisibility(d.visibility);
        setAutoPublish(!!d.autoPublicAt);
        setMsg("Settings saved. Making a newly uploaded tournament public needs a moderator's approval — your request has been sent, and you'll get an email when it's decided.");
      } else {
        setPublicPending(false);
        setMsg("Settings saved.");
      }
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function saveDetails() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      if (!level) throw new Error("Choose a tournament type.");
      await postJson("/api/manage", { slug, op: "details", level, tdLink: tdLink.trim() });
      refreshIndex();
      setMsg("Tournament details saved.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function rebuild() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await postJson("/api/manage", { slug, op: "reaggregate" });
      setMsg("Stats rebuilt. Reload the pages to see the latest.");
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
      if (op === "invite") setNewInvite("");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  async function coOwner(op: "coowner" | "uncoowner", email: string) {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const d = await postJson("/api/manage", { slug, op, email });
      setCoOwners(d.coOwners || []);
      // Adding a co-owner drops them from the invite list — they can see
      // everything now, so listing them twice would be confusing.
      setInvites(d.invites || []);
      if (op === "coowner") { setNewCoOwner(""); setMsg(`${email} can now manage this tournament.`); }
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
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  const linkUrl = (id: string) => `${window.location.origin}/join/${slug}?key=${id}`;
  async function createLink() {
    setErr(null); setMsg(null); setBusy(true);
    try { const d = await postJson("/api/manage", { slug, op: "create-link" }); setLinks(d.links || []); }
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

  const accessSection = (
    <>
      <h2 style={{ marginTop: reviewingAccess ? 0 : 28 }}>Access requests ({accessRequests.length})</h2>
      {accessRequests.length === 0 ? (
        <p className="muted">
          No pending requests.
          {resolved.some((r) => r.via === "link") &&
            " If you followed a request email here, the person has since let themselves in with an invite link — see below."}
        </p>
      ) : (
        <ul className="invite-list">
          {accessRequests.map((a) => (
            <li key={a.email}>
              <span>
                <strong>{a.name}</strong> <span className="muted">· {a.email}</span>
                {(a.role || a.team) && (
                  <span className="muted"> · {[a.role, a.team].filter(Boolean).join(" — ")}</span>
                )}
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
        <>
          <h3 className="settings-sub">Recently settled</h3>
          <ul className="invite-list">
            {resolved.map((r) => (
              <li key={r.email}>
                <span>
                  <strong>{r.name}</strong> <span className="muted">· {r.email}</span>
                </span>
                <span className="muted">
                  {r.status === "denied"
                    ? "denied"
                    : r.via === "link"
                    ? "joined via invite link — request auto-approved"
                    : "approved by you"}
                  {r.resolvedAt ? ` · ${new Date(r.resolvedAt).toLocaleDateString()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );

  return (
    <div className="detail">
      <h1>Settings</h1>
      {err && <div className="error-box">{err}</div>}
      {msg && <div className="caveat"><span className="ok-msg">{msg}</span></div>}

      {reviewingAccess && visibility !== "public" && (
        <div className="caveat" style={{ marginBottom: 28 }}>{accessSection}</div>
      )}

      <h2>Tournament details</h2>
      <div className="create-form" style={{ maxWidth: 520 }}>
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
        </label>
        <button className="btn-primary" disabled={busy} onClick={saveDetails}>Save details</button>
      </div>

      <h2 style={{ marginTop: 28 }}>Visibility</h2>
      <div className="create-form" style={{ maxWidth: 520 }}>
        <label className="field">
          <span>Who can see this tournament</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
            {VIS_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <small className="muted">{visDesc}</small>
          {publicPending ? (
            <small className="muted">Your request to make this tournament public is awaiting a moderator's approval. Until then it stays {visibility}.</small>
          ) : publicNeedsApproval && visibility !== "public" ? (
            <small className="muted">This tournament was uploaded less than three months ago, so making it public needs a moderator's approval — selecting Public sends them a request.</small>
          ) : null}
        </label>

        {visibility !== "public" && (
          <div className="field">
            <label className="field-inline">
              <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
              <span>Automatically make public on</span>
              <input type="date" value={date} disabled={!autoPublish} onChange={(e) => setDate(e.target.value)} />
            </label>
            <small className="muted">
              {autoPublish ? "On this date it becomes public and open to all." : "Off — it stays restricted until you change visibility yourself."}
            </small>
          </div>
        )}
        <div className="field">
          <label className="field-inline">
            <input type="checkbox" checked={allowRequests} onChange={(e) => setAllowRequests(e.target.checked)} />
            <span>Let viewers suggest corrections</span>
          </label>
          <small className="muted">
            {allowRequests
              ? "Anyone who can view this tournament can propose a buzz fix, a bonus-parts fix, or a rename, and you approve or reject it on the Corrections page."
              : "Off — the Edit and rename controls are hidden from viewers, and no new requests can be submitted. You and any co-owners still edit directly."}
          </small>
        </div>
        <button className="btn-primary" disabled={busy} onClick={saveSettings}>Save settings</button>
      </div>

      {meta?.kind !== "results" && (meta?.rounds?.length ?? 0) > 0 && (
        <>
          <h2 style={{ marginTop: 28 }}>Round phases / tags</h2>
          <p className="muted">
            Tag rounds with phases (e.g. Prelims, Playoffs, Finals). Viewers can then filter every page to a phase. A
            round can carry more than one tag. Mirrors that ran different schedules — different packets in the
            playoffs, say — can each have their own, so a phase only ever collects the games actually played in it.
          </p>
          <RoundTagsEditor slug={slug} rounds={meta!.rounds} />
        </>
      )}

      {meta?.kind !== "results" && (
        <>
          <h2 id="categories" style={{ marginTop: 28 }}>Question categories &amp; tags</h2>
          <p className="muted">
            Each question's metadata is a comma-separated line, but sets order it differently — some lead with the
            writer, some with the category — so a set can end up filed under a writer's initials. Say what each field
            means here and every question is re-read. Fields marked <strong>Tag</strong> become extra dimensions you can
            filter and compare on, like the writer.
          </p>
          <MetaMapEditor slug={slug} />

          {meta?.hasBonuses && (
            <>
              <h2 id="bonusdiff" style={{ marginTop: 28 }}>Bonus difficulty marks</h2>
              <p className="muted">
                A three-part bonus is written easy, medium and hard — in some order. When a packet tags one
                "medium, easy, easy" the mistake is invisible everywhere except{" "}
                <Link to={`/set/${slug}/bonus-order`} className="link">Difficulty order</Link>, where the bonus turns up
                under an order nobody wrote: its real hard part is counted as an easy one, and every easy/medium/hard
                figure in the tournament is averaged with a part that was never that difficulty. Re-mark the parts here
                and the stats are rebuilt — the packet file itself is left alone.
              </p>
              <BonusDifficultyEditor slug={slug} warnings={meta?.bonusDiffWarnings ?? []} />
            </>
          )}

          <h2 id="rounds" style={{ marginTop: 28 }}>Round alignment</h2>
          <p className="muted">
            Each packet's round is taken from its <strong>filename</strong> when you upload it ("Round_3.json" → round
            3); a file with no number in its name falls back to round 0. Games carry their own round from inside the QBJ.
            If the two don't match, the buzzes never reach the questions — the packet shows 0 heard everywhere while
            player and team stats still look normal. Fix it by setting the right round below.
          </p>
          <RoundAlignEditor slug={slug} />

          <h2 id="uploads" style={{ marginTop: 28 }}>Remove uploaded rounds</h2>
          <p className="muted">
            Adding files to an edition <strong>appends</strong> them, so uploading the same files twice stores them
            twice, and a wrong upload lands alongside the right one. Clear a round, an edition, or everything — the
            tournament keeps its address, settings, invites and corrections, so you can upload replacements into it
            instead of starting a new one.
          </p>
          <UploadCleanup slug={slug} />

          <h2 id="games" style={{ marginTop: 28 }}>Individual games</h2>
          <p className="muted">
            For a single stray game rather than a whole round — a duplicate matchup, or one file that shouldn't be here.
          </p>
          <GameFilesEditor slug={slug} />

          <h2 id="renames" style={{ marginTop: 28 }}>Renamed players and teams</h2>
          <p className="muted">
            A rename folds every buzz, box score and roster entry for a player or a team onto one spelling — useful when
            the source spells the same person or school two ways and splits their stats. Start one from a player’s or a
            team’s page; viewers can suggest one there too, and it lands on the <Link to={`/set/${slug}/requests`} className="link">Corrections</Link> page for approval.
          </p>
          <RenamesEditor slug={slug} />
        </>
      )}

      {hasYf && (
        <>
          <h2 style={{ marginTop: 28 }}>YellowFruit export</h2>
          <p className="muted">
            Download the uploaded YellowFruit file with your buzz corrections applied to its box scores, ready to
            re-import into YellowFruit.
          </p>
          <a className="btn-primary" href={`/api/yf-export?slug=${encodeURIComponent(slug)}`}>
            Download updated .yft
          </a>
        </>
      )}

      <h2 style={{ marginTop: 28 }}>Maintenance</h2>
      <p className="muted">Recompute all stats from the uploaded files (use this to pick up new stats pages or fixes).</p>
      <button className="btn-primary" disabled={busy} onClick={rebuild}>Rebuild stats</button>

      {visibility !== "public" && (
        <>
          {!reviewingAccess && accessSection}

          <h2 style={{ marginTop: 28 }}>Invite links</h2>
          <p className="muted">Anyone with an account who opens an active link gets access to this tournament.</p>
          <button className="btn-primary btn-sm" disabled={busy} onClick={createLink}>Create invite link</button>
          {activeLinks.length > 0 && (
            <ul className="invite-list" style={{ marginTop: 12 }}>
              {activeLinks.map((l) => (
                <li key={l.id}>
                  <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{linkUrl(l.id)}</span>
                  <span className="req-actions">
                    <span className="muted">{l.uses} use{l.uses === 1 ? "" : "s"}</span>
                    <button className="btn-link" onClick={() => copyLink(l.id)}>{copiedId === l.id ? "Copied!" : "Copy"}</button>
                    <button className="btn-link danger" disabled={busy} onClick={() => revokeLink(l.id)}>Revoke</button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ marginTop: 28 }}>Invited people ({invites.length})</h2>
          <p className="muted">Invited accounts can view this tournament and submit correction requests.</p>
          <div className="buzz-edit" style={{ marginBottom: 12 }}>
            <input
              type="email"
              placeholder="person@example.com"
              value={newInvite}
              onChange={(e) => setNewInvite(e.target.value)}
              style={{ padding: "6px 8px", border: "1px solid #cdd5e0", borderRadius: 4, minWidth: 260 }}
            />
            <button className="btn-primary btn-sm" disabled={busy || !newInvite.trim()} onClick={() => invite("invite", newInvite.trim())}>
              Add invite
            </button>
          </div>
          {invites.length === 0 ? (
            <p className="muted">No one invited yet.</p>
          ) : (
            <ul className="invite-list">
              {invites.map((e) => (
                <li key={e}>
                  <span>{e}</span>
                  <button className="btn-link" disabled={busy} onClick={() => invite("uninvite", e)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h2 style={{ marginTop: 28 }}>Co-owners ({coOwners.length})</h2>
      <p className="muted">
        Co-owners manage this tournament alongside you: uploading files, fixing buzzes, approving edit and access
        requests, and changing these settings. Only you can delete the tournament or change who co-owns it.
        They need a Buzzpoints account before you can add them.
      </p>
      {isPrimary && (
        <div className="buzz-edit" style={{ marginBottom: 12 }}>
          <input
            type="email"
            placeholder="person@example.com"
            value={newCoOwner}
            onChange={(e) => setNewCoOwner(e.target.value)}
            style={{ padding: "6px 8px", border: "1px solid #cdd5e0", borderRadius: 4, minWidth: 260 }}
          />
          <button className="btn-primary btn-sm" disabled={busy || !newCoOwner.trim()} onClick={() => coOwner("coowner", newCoOwner.trim())}>
            Add co-owner
          </button>
        </div>
      )}
      {coOwners.length === 0 ? (
        <p className="muted">No co-owners yet.</p>
      ) : (
        <ul className="invite-list">
          {coOwners.map((e) => (
            <li key={e}>
              <span>{e}</span>
              {isPrimary && <button className="btn-link" disabled={busy} onClick={() => coOwner("uncoowner", e)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {!isPrimary && <p className="muted">You're a co-owner here — only the tournament's owner can change this list.</p>}

      {isPrimary && (
        <>
      <h2 style={{ marginTop: 28 }}>Delete this tournament</h2>
      <div className="danger-zone">
        <p style={{ margin: 0 }}>
          Deleting removes <strong>{meta.setName}</strong> for good: every stat page, buzz correction and uploaded
          packet and game file goes with it. Links to it stop working, and there's no undo — putting it back means
          uploading everything again.
        </p>
        <label className="field-inline" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <span>Type <strong>{meta.setName}</strong> to confirm</span>
          <input
            value={confirmDelete}
            onChange={(e) => setConfirmDelete(e.target.value)}
            placeholder={meta.setName}
            style={{ padding: "6px 8px", border: "1px solid #cdd5e0", borderRadius: 4, minWidth: 260 }}
          />
        </label>
        <div style={{ marginTop: 12 }}>
          <button
            className="btn-primary btn-sm danger-btn"
            disabled={busy || confirmDelete.trim() !== meta.setName}
            onClick={deleteSet}
          >
            {busy ? "Deleting…" : "Delete tournament"}
          </button>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
