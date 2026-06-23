import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { clearSetCache } from "../data";
import { CorrectionRequest } from "../types";
import { Loading } from "../components/Common";

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}

function describe(c: CorrectionRequest["correction"]) {
  const parts: string[] = [];
  const from = c.fromPlayer ?? "(unknown)";
  if (c.toPlayer !== undefined && c.toPlayer !== null && c.toPlayer !== c.fromPlayer)
    parts.push(`reassign from ${from} to ${c.toPlayer}`);
  if (c.toWordIndex !== undefined && c.toWordIndex !== null)
    parts.push(`move buzz to word #${c.toWordIndex + 1}`);
  return parts.join("; ") || "no change";
}

export function Requests() {
  const { slug = "" } = useParams();
  const { isOwner } = useSetCtx();
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

      <h2>Pending ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="muted">No pending requests.</p>
      ) : (
        <div className="req-list">
          {pending.map((r) => (
            <div key={r.id} className="req-card">
              <div className="req-main">
                <div className="req-title">
                  <Link to={`/set/${slug}/tossup/${r.correction.round}-${r.correction.num}`} className="link">
                    Tossup {r.correction.round}-{r.correction.num}
                  </Link>{" "}
                  · <span className="muted">{r.correction.team}</span>
                </div>
                <div className="req-desc">{describe(r.correction)}</div>
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
                    <Link to={`/set/${slug}/tossup/${r.correction.round}-${r.correction.num}`} className="link">
                      Tossup {r.correction.round}-{r.correction.num}
                    </Link>{" "}
                    · <span className="muted">{r.correction.team}</span>
                    <span className={`pill ${r.status === "approved" ? "buzz-get" : "buzz-neg"}`} style={{ marginLeft: 8 }}>
                      {r.status}
                    </span>
                  </div>
                  <div className="req-desc">{describe(r.correction)}</div>
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
