import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { clearSetCache, useSetJson } from "../data";
import { useSetCtx } from "../components/Layout";
import { TossupDetail, Buzz, Rosters, EditionSummary } from "../types";
import { Html, pct, num, roundLabel } from "../util";
import { Loading, ErrorBox, EditionBadges, TeamName } from "../components/Common";
import { QuestionNav, useQuestionNav } from "../components/QuestionNav";
import { Segs, plainTokens, tokenizeQuestion } from "../questionText";
import { QuestionTags } from "../components/QuestionTags";
import { BuzzCurve } from "../components/BuzzCurve";

function tier(v: number): "power" | "get" | "neg" | "zero" {
  if (v > 10) return "power";
  if (v > 0) return "get";
  if (v < 0) return "neg";
  return "zero";
}
const rowCls: Record<string, string> = { power: "buzz-row-power", get: "buzz-row-get", neg: "buzz-row-neg", zero: "buzz-row-zero" };
function annotClass(v: number): string {
  if (v > 10) return "an-power";
  if (v > 0) return "an-pos";
  if (v < 0) return "an-neg";
  return "an-zero";
}

// Effective buzz position. An imprecise buzz — a get the scorekeeper recorded
// before the power mark — is only known to have come after power, so it collapses
// to the first word past the mark. (The mark itself is never a buzz position: it
// isn't read aloud.)
const effIdx = (d: TossupDetail, b: Buzz) =>
  b.imprecise && d.powerIndex !== null ? Math.min(d.powerIndex + 1, d.words.length - 1) : b.wordIndex;

// Who buzzed at one word, shown on hover (and pinned on click) over the chip.
function BuzzPop({ bz, slug }: { bz: Buzz[]; slug: string }) {
  const sorted = [...bz].sort((a, b) => b.value - a.value || (a.player || "").localeCompare(b.player || ""));
  return (
    <span className="q-pop" role="tooltip">
      <span className="q-pop-head">{bz.length} buzz{bz.length === 1 ? "" : "es"} here</span>
      {sorted.map((b, i) => (
        <span key={i} className="q-pop-row">
          <span className={`q-pop-val ${annotClass(b.value)}`}>{b.value > 0 ? `+${b.value}` : b.value}</span>
          <span className="q-pop-who">
            {b.playerId ? <Link className="link" to={`/set/${slug}/player/${b.playerId}`}>{b.player}</Link> : b.player}
            <span className="q-pop-team">{b.team}</span>
          </span>
        </span>
      ))}
    </span>
  );
}

/** Question text: each buzzed word becomes a blue chip with value[count]
 *  annotations above it; an orange dashed line marks the average buzz. Hovering
 *  any word reveals its 1-based index (handy for corrections) and, via
 *  onHoverWord, highlights the buzzers at that word in the buzz list. Hovering a
 *  buzzed word also pops up everyone who buzzed there; clicking pins that popup
 *  so you can follow the player/team links inside it. */
function Question({ d, slug, onHoverWord, focus }: { d: TossupDetail; slug: string; onHoverWord: (i: number | null) => void; focus: number | null }) {
  const eff = (b: Buzz) => effIdx(d, b);
  const [pinned, setPinned] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // Formatted tokens when the packet's markup lines up with the numbered words,
  // plain words when it doesn't.
  const tokens = useMemo(
    () => tokenizeQuestion(d.questionHtml, d.words) ?? plainTokens(d.words),
    [d.questionHtml, d.words]
  );

  // A pinned popup closes on the next click anywhere outside it.
  useEffect(() => {
    if (pinned === null) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".q-word")) setPinned(null);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [pinned]);

  const byWord = new Map<number, Buzz[]>();
  for (const b of d.buzzes) {
    const i = eff(b);
    if (i === null) continue;
    const arr = byWord.get(i) ?? [];
    arr.push(b);
    byWord.set(i, arr);
  }
  const correct = d.buzzes.filter((b) => b.value > 0 && b.wordIndex !== null && !b.imprecise);
  const avgIdx = correct.length
    ? Math.round(correct.reduce((a, b) => a + (b.wordIndex as number), 0) / correct.length)
    : null;
  const annotations = (bz: Buzz[]) => {
    const counts = new Map<number, number>();
    for (const b of bz) counts.set(b.value, (counts.get(b.value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[0] - a[0]);
  };
  const shown = pinned ?? hovered;
  const endBuzzes = byWord.get(d.words.length);
  // Arrived from a buzz link: bring that word into view rather than making the
  // reader hunt for the ring.
  const focusRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus]);
  let lastIndex: number | null = null; // most recent numbered word, for the marks between words

  return (
    <p className="q-text">
      {tokens.map((t, k) => {
        const i = t.index;
        // The power mark and pronunciation guides aren't read aloud, so they hold
        // no buzz slot — but they still sit inside power, hence `lastIndex`.
        if (i !== null) lastIndex = i;
        const power = d.powerIndex !== null && lastIndex !== null && lastIndex <= d.powerIndex;
        if (i === null)
          return (
            <span key={k} className={"q-tok" + (power ? " q-power" : "")}>
              <Segs segs={t.segs} />{t.spaceAfter ? " " : null}
            </span>
          );
        const bz = byWord.get(i);
        return (
          <span
            key={k}
            ref={i === focus ? focusRef : undefined}
            className={"q-tok" + (power ? " q-power" : "") + (i === focus ? " q-tok-focus" : "")}
            onMouseEnter={() => { onHoverWord(i); setHovered(i); }}
            onMouseLeave={() => { onHoverWord(null); setHovered(null); }}
          >
            <span className="q-idx" aria-hidden="true">{i + 1}</span>
            {bz ? (
              <span
                className={"q-word" + (pinned === i ? " q-word-pinned" : "")}
                onClick={(e) => { e.stopPropagation(); setPinned((p) => (p === i ? null : i)); }}
              >
                <span className="q-annots">
                  {annotations(bz).map(([v, c], j) => (
                    <span key={j} className={`q-annot ${annotClass(v)}`}>{v} [{c}]</span>
                  ))}
                </span>
                <span className="q-chip"><Segs segs={t.segs} /></span>
                {shown === i && <BuzzPop bz={bz} slug={slug} />}
              </span>
            ) : (
              <Segs segs={t.segs} />
            )}
            {avgIdx === i && <span className="q-avg" title="Average buzz position" />}
            {t.spaceAfter ? " " : null}
          </span>
        );
      })}
      {/* The slot one past the last word: nobody buzzed before the question ran out. */}
      {endBuzzes ? (
        <span
          className="q-tok"
          onMouseEnter={() => { onHoverWord(d.words.length); setHovered(d.words.length); }}
          onMouseLeave={() => { onHoverWord(null); setHovered(null); }}
        >
          <span className="q-idx" aria-hidden="true">{d.words.length + 1}</span>
          <span
            className={"q-word" + (pinned === d.words.length ? " q-word-pinned" : "")}
            onClick={(e) => { e.stopPropagation(); setPinned((p) => (p === d.words.length ? null : d.words.length)); }}
          >
            <span className="q-annots">
              {annotations(endBuzzes).map(([v, c], j) => (
                <span key={j} className={`q-annot ${annotClass(v)}`}>{v} [{c}]</span>
              ))}
            </span>
            <span className="q-chip q-end">■END■</span>
            {shown === d.words.length && <BuzzPop bz={endBuzzes} slug={slug} />}
          </span>
        </span>
      ) : (
        <span className="q-end">■END■</span>
      )}
    </p>
  );
}

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
  return d;
}

// Inline editor: reassign a buzz to a teammate and/or move the buzz word.
function BuzzEditor({ d, b, slug, isOwner, teammates, cols, onClose, onApplied }: {
  d: TossupDetail; b: Buzz; slug: string; isOwner: boolean; teammates: string[]; cols: number; onClose: () => void; onApplied: () => void;
}) {
  const curPlayer = b.player;
  const curWord = b.wordIndex;
  const [toPlayer, setToPlayer] = useState(curPlayer);
  const [toWord, setToWord] = useState(curWord === null ? "" : String(curWord + 1));
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const players = teammates.includes(curPlayer) ? teammates : [curPlayer, ...teammates];
  const newWordIdx = toWord.trim() === "" ? null : Number(toWord) - 1;
  const playerChanged = toPlayer !== curPlayer;
  const wordChanged = newWordIdx !== curWord;
  // The last valid slot is one past the last word — ■END■, i.e. the question was
  // read out before this buzz came.
  const wordValid = newWordIdx === null || (Number.isInteger(newWordIdx) && newWordIdx >= 0 && newWordIdx <= d.words.length);
  const canSubmit = (playerChanged || wordChanged) && wordValid && !busy;

  async function submit() {
    setErr(null);
    const correction: any = { round: d.round, num: d.num, team: b.team, fromPlayer: b.origPlayer ?? b.player, fromWordIndex: b.origWordIndex ?? b.wordIndex };
    if (playerChanged) correction.toPlayer = toPlayer;
    if (wordChanged) correction.toWordIndex = newWordIdx;
    setBusy(true);
    try {
      if (isOwner) { await postJson("/api/correct", { slug, correction }); clearSetCache(slug); onApplied(); }
      else { await postJson("/api/requests", { slug, action: "submit", correction, desc: desc.trim() || undefined }); setDone("Request submitted — the owner will review it."); }
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  }

  if (done)
    return (
      <td colSpan={cols} className="buzz-edit-cell">
        <div className="buzz-edit"><span className="ok-msg">{done}</span><button className="btn-link" onClick={onClose}>Close</button></div>
      </td>
    );

  return (
    <td colSpan={4} className="buzz-edit-cell">
      <div className="buzz-edit">
        <label className="field-inline"><span>Assign to</span>
          <select value={toPlayer} onChange={(e) => setToPlayer(e.target.value)}>
            {players.map((p) => <option key={p} value={p}>{p}{p === curPlayer ? " (current)" : ""}</option>)}
          </select>
        </label>
        <label className="field-inline"><span>Buzz word #</span>
          <input className="num-input" type="number" min={1} max={d.words.length + 1} value={toWord} onChange={(e) => setToWord(e.target.value)} style={{ width: 70 }} />
          {newWordIdx !== null && wordValid && (
            <span className="muted">{newWordIdx === d.words.length ? "■END■" : `“${d.words[newWordIdx]}”`}</span>
          )}
        </label>
        {!isOwner && (
          <label className="field-inline" style={{ flex: "1 1 220px" }}><span>Reason</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="optional note for the owner" style={{ flex: 1 }} />
          </label>
        )}
        <div className="buzz-edit-actions">
          <button className="btn-primary btn-sm" disabled={!canSubmit} onClick={submit}>{busy ? "Working…" : isOwner ? "Save" : "Request change"}</button>
          <button className="btn-link" onClick={onClose}>Cancel</button>
        </div>
        {!wordValid && <span className="error-inline">Word # must be 1–{d.words.length + 1} ({d.words.length + 1} = ■END■).</span>}
        {err && <span className="error-inline">{err}</span>}
      </div>
    </td>
  );
}

function BuzzRow({ d, b, slug, i, isOwner, canEdit, editing, highlight, teammates, opponents, editions, showEdition, onEdit, onClose, onApplied }: {
  d: TossupDetail; b: Buzz; slug: string; i: number; isOwner: boolean; canEdit: boolean; editing: boolean;
  highlight: boolean; teammates: string[]; opponents: string[]; editions: EditionSummary[]; showEdition: boolean;
  onEdit: () => void; onClose: () => void; onApplied: () => void;
}) {
  const t = tier(b.value);
  return (
    <>
      <tr className={`buzz-row ${rowCls[t]}${highlight ? " buzz-hl" : ""}`}>
        <td className="buzz-who">
          <span className="buzz-player">
            {b.playerId ? <Link className="link" to={`/set/${slug}/player/${b.playerId}`}>{b.player}</Link> : b.player}
            {canEdit && !editing && <button className="btn-link btn-edit" onClick={onEdit} title="Correct this buzz">Edit</button>}
          </span>
          <span className="buzz-team"><TeamName name={b.team} id={b.teamId} slug={slug} roster={teammates} /></span>
        </td>
        <td className="buzz-opp">
          {b.opponent ? <TeamName name={b.opponent} id={b.opponentId} slug={slug} roster={opponents} /> : "—"}
        </td>
        {showEdition && <td className="buzz-ed">{b.editionId ? <EditionBadges ids={[b.editionId]} editions={editions} /> : <span className="muted">—</span>}</td>}
        <td className="right mono">{b.wordIndex === null ? "—" : b.imprecise ? `≈${b.wordIndex + 1}` : b.wordIndex + 1}</td>
        <td className="right mono">{b.value}</td>
      </tr>
      {editing && (
        <tr className="buzz-edit-row">
          <BuzzEditor d={d} b={b} slug={slug} isOwner={isOwner} teammates={teammates} cols={showEdition ? 5 : 4} onClose={onClose} onApplied={onApplied} />
        </tr>
      )}
    </>
  );
}

export function TossupDetailPage() {
  const { meta, isOwner, user, slug, scope, editions, allowRequests } = useSetCtx();
  const { id = "" } = useParams();
  const [nonce, setNonce] = useState(0);
  // Question detail switches between edition wordings, not phases; a tag scope
  // has no per-edition file, so fall back to combined for it.
  const [version, setVersion] = useState(scope.startsWith("tag:") ? "all" : scope); // "all" (combined/latest) or an edition id
  const combinedFile = "tossups_detail.json";
  const dispFile = version !== "all" ? `editions/${version}/tossups_detail.json` : combinedFile;
  const { data: comb } = useSetJson<Record<string, TossupDetail>>(slug, combinedFile, nonce);
  const { data, error, loading } = useSetJson<Record<string, TossupDetail>>(slug, dispFile, nonce);
  const { data: rosters } = useSetJson<Rosters>(slug, version !== "all" ? `editions/${version}/rosters.json` : "rosters.json", nonce);
  const [editing, setEditing] = useState<number | null>(null);
  const [hoverWord, setHoverWord] = useState<number | null>(null);
  // ?w=<1-based word number> — set by the buzzpoint links on a player's page.
  const [params] = useSearchParams();
  const wParam = Number(params.get("w"));
  const focusWord = Number.isInteger(wParam) && wParam > 0 ? wParam - 1 : null;
  const nav = useQuestionNav(data, id);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data?.[id];
  if (!d) return <ErrorBox error={version === "all" ? "Tossup not found." : "This edition doesn't have this question."} />;

  const versions = comb?.[id]?.versions ?? [];
  const negs = d.buzzes.filter((b) => b.value < 0).length;
  const sorted = [...d.buzzes].sort((a, b) => (a.wordIndex ?? 1e9) - (b.wordIndex ?? 1e9));
  // Which mirror each buzz came from. Only meaningful in the combined view, and
  // only present once a multi-edition set has been re-aggregated.
  const showEdition = version === "all" && editions.length > 1 && sorted.some((b) => b.editionId);
  // Long buzz lists get their own scroll box so the question stays on screen.
  const scrollBuzzes = sorted.length > 14;

  return (
    <div className="detail">
      <div className="breadcrumb breadcrumb-nav">
        <Link to={`/set/${slug}/tossup`} className="link">← Tossups</Link>
        <QuestionNav nav={nav} label="Tossup" hrefOf={(q) => `/set/${slug}/tossup/${q}`} />
      </div>

      {versions.length > 1 && (
        <div className="version-bar">
          <span className="muted">Question version:</span>
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="all">All editions (latest)</option>
            {versions.map((v) => <option key={v.editionId} value={v.editionId}>{v.label}{v.differs ? " — revised" : ""}</option>)}
          </select>
          {version !== "all" && <span className="muted">showing this edition's wording &amp; its buzzes</span>}
        </div>
      )}

      <div className="tu-grid">
        <div className="tu-left">
          <h1>Packet {roundLabel(d.round)}: Tossup {d.num}</h1>
          <Question d={d} slug={slug} onHoverWord={setHoverWord} focus={focusWord} />
          <p className="tu-answer">ANSWER: <Html html={d.answer} /></p>
          <p className="subtitle">{d.category} · <span className="muted">{d.subcategory}</span></p>
          <QuestionTags slug={slug} id={d.id} kind="tossups" tags={d.tags || []} isOwner={isOwner} />
          {d.buzzes.length > 0 && <BuzzCurve d={d} />}
        </div>

        <div className="tu-right">
          <h2 style={{ marginTop: 0 }}>Buzzes ({d.buzzes.length})</h2>
          {!user && allowRequests && (
            <p className="muted">
              <Link to={`/login?next=${encodeURIComponent(`/set/${slug}/tossup/${id}`)}`} className="link">Log in</Link> to correct a buzz or request a change.
            </p>
          )}
          {user && !isOwner && allowRequests && <p className="muted">Spot a mistake in this data? Use <strong>Edit</strong> to send the owner a correction request.</p>}
          {!isOwner && !allowRequests && <p className="muted">This tournament's owner isn't taking correction requests.</p>}
          <div className={scrollBuzzes ? "buzz-scroll" : "table-wrap"}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Player / Team</th><th>Opponent</th>
                  {showEdition && <th title="Edition (mirror) this buzz was played in">Edition</th>}
                  <th className="right" title="Buzz position (word #)">Buzz</th><th className="right">Val</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b, i) => (
                  <BuzzRow
                    key={i} d={d} b={b} slug={slug} i={i} isOwner={isOwner} canEdit={!!user && (isOwner || allowRequests)}
                    editing={editing === i} highlight={(hoverWord !== null && effIdx(d, b) === hoverWord) || (focusWord !== null && b.wordIndex === focusWord)}
                    teammates={rosters?.[b.team] ?? []} opponents={rosters?.[b.opponent ?? ""] ?? []}
                    editions={editions} showEdition={showEdition}
                    onEdit={() => setEditing(i)} onClose={() => setEditing(null)}
                    onApplied={() => { setEditing(null); setNonce((n) => n + 1); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <h2>Summary</h2>
      <div className="table-wrap" style={{ maxWidth: 620 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Set</th>
              <th className="right">Heard</th>
              <th className="right">Conv%</th>
              {meta.hasPower && <th className="right">Power%</th>}
              {(meta.hasNeg || negs > 0) && <th className="right">Neg%</th>}
              <th className="right">Avg Buzz</th>
              <th className="right" title="Average position of conversions that came while the question was still live — the first buzz of a reading, before anyone had negged">Avg Live Buzz</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{meta.setName}</td>
              <td className="right mono">{d.heard}</td>
              <td className="right mono">{pct(d.convPct)}</td>
              {meta.hasPower && <td className="right mono">{pct(d.powerPct)}</td>}
              {(meta.hasNeg || negs > 0) && <td className="right mono">{pct((100 * negs) / (d.heard || 1))}</td>}
              <td className="right mono">{d.avgBuzzPct === null ? "—" : `${num(d.avgBuzzPct)}%`}</td>
              <td className="right mono">{d.avgLiveBuzzPct == null ? "—" : `${num(d.avgLiveBuzzPct)}%`}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
