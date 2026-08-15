import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { clearSetCache } from "../data";
import { CorrectionRequest, renameKind } from "../types";
import { Loading } from "../components/Common";
import { roundLabel } from "../util";

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}

function describe(r: CorrectionRequest) {
  if (r.rename)
    return renameKind(r.rename) === "team"
      ? `rename ${r.rename.from} to ${r.rename.to}`
      : `rename ${r.rename.from} to ${r.rename.to}${r.rename.team ? ` on ${r.rename.team}` : " on every team"}`;
  const c = r.correction;
  if (!c) return "no change";
  const parts: string[] = [];
  const from = c.fromPlayer ?? "(unknown)";
  if (c.toPlayer !== undefined && c.toPlayer !== null && c.toPlayer !== c.fromPlayer)
    parts.push(`reassign from ${from} to ${c.toPlayer}`);
  if (c.toWordIndex !== undefined && c.toWordIndex !== null)
    parts.push(`move buzz to word #${c.toWordIndex + 1}`);
  return parts.join("; ") || "no change";
}

// A rename has no single question to link to, so it gets a plain label.
function Title({ slug, r }: { slug: string; r: CorrectionRequest }) {
  if (r.rename)
    return renameKind(r.rename) === "team" ? (
      <span className="pill">Team rename</span>
    ) : (
      <>
        <span className="pill">Player rename</span>{" "}
        <span className="muted">{r.rename.team ?? "all teams"}</span>
      </>
    );
  if (!r.correction) return <span className="muted">Edit</span>;
  return (
    <>
      <Link to={`/set/${slug}/tossup/${r.correction.round}-${r.correction.num}`} className="link">
        Tossup {roundLabel(r.correction.round)}-{r.correction.num}
      </Link>{" "}
      · <span className="muted">{r.correction.team}</span>
    </>
  );
}

export function Requests() {
  const { slug = "" } = useParams();
  const { isOwner, allowRequests } = useSetCtx();
  const [reqs, setReqs] = useState<CorrectionRequest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await fetch(`/api/requests?slug=${encodeURIComponent(slug)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      setReqs(d.requests as CorrectionRequest[]);
    } catch (e) {
      setErr(String((e as Error).message || e));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [slug]);

  async function act(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setErr(null);
    try {
      await postJson("/api/requests", { slug, id, action });
      if (action === "approve") clearSetCache(slug);
      await load();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusyId(null);
    }
  }

  if (!isOwner)
    return <p className="caveat">Only the set owner can review correction requests.</p>;
  if (reqs === null && !err) return <Loading />;

  const pending = (reqs || []).filter((r) => r.status === "pending");
  const handled = (reqs || []).filter((r) => r.status !== "pending");

  return (
    <div className="detail">
      <h1>Correction requests</h1>
      {err && <div className="error-box">{err}</div>}
      {!allowRequests && (
        <p className="caveat">
          You've turned off correction requests for this tournament, so viewers can't submit new ones. Anything already
          submitted is still below, and you can still edit buzzes directly.{" "}
          <Link className="link" to={`/set/${slug}/settings`}>Change this in Settings</Link>.
        </p>
      )}

      <h2>Pending ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="muted">No pending requests.</p>
      ) : (
        <div className="req-list">
          {pending.map((r) => (
            <div key={r.id} className="req-card">
              <div className="req-main">
                <div className="req-title"><Title slug={slug} r={r} /></div>
                <div className="req-desc">{describe(r)}</div>
                {r.desc && <div className="req-note">“{r.desc}”</div>}
                <div className="req-meta">by {r.by} · {new Date(r.at).toLocaleString()}</div>
              </div>
              <div className="req-actions">
                <button className="btn-primary btn-sm" disabled={busyId === r.id} onClick={() => act(r.id, "approve")}>
                  {busyId === r.id ? "…" : "Approve"}
                </button>
                <button className="btn-link" disabled={busyId === r.id} onClick={() => act(r.id, "reject")}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {handled.length > 0 && (
        <>
          <h2>History ({handled.length})</h2>
          <div className="req-list">
            {handled.map((r) => (
              <div key={r.id} className="req-card req-handled">
                <div className="req-main">
                  <div className="req-title">
                    <Title slug={slug} r={r} />
                    <span className={`pill ${r.status === "approved" ? "buzz-get" : "buzz-neg"}`} style={{ marginLeft: 8 }}>
                      {r.status}
                    </span>
                  </div>
                  <div className="req-desc">{describe(r)}</div>
                  <div className="req-meta">by {r.by} · {new Date(r.at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
