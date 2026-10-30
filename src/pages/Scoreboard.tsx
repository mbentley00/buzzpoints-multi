import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useSetCtx, scopedPath } from "../components/Layout";
import { useSetJson } from "../data";
import { BonusDetail, BonusRow, GameRow, GameTeamLine, Meta, ReplayTossup, TossupDetail, TossupRow } from "../types";
import { Html, num, roundLabel } from "../util";
import { PageHeader, Loading, ErrorBox } from "../components/Common";
import { Segs, plainTokens, tokenizeQuestion } from "../questionText";

// Scoreboard: every game's box score, round by round, each one a door into its
// replay — the game tossup by tossup, with where everyone buzzed and what the
// bonus that followed went for.

const POWER_HEAD: Record<string, string> = { mACF: "15", PACE: "20", SUPERPOWER: "Pwr" };
const powerHead = (m: Meta) => POWER_HEAD[m.scoring] ?? "Pwr";
const negHead = (m: Meta) => (m.hasNeg ? "-5" : "Inc");
const showBonuses = (m: Meta) => m.hasBonuses && m.hasTeamBonuses !== false;
const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0");
// Team colors in the replay: the first two are the two teams of a normal game.
const teamVar = (i: number) => `var(--team-${i % 6})`;
const teamInk = (i: number) => `var(--team-${i % 6}-ink)`;
const stale404 = (e: string | null) => !!e && /\b404\b/.test(e);
// A long answer line is cut at its first bracket: the replay names the answer,
// the tossup page has the rest.
const shortAnswer = (html: string) => html.split(/\s[[(]/)[0];

function NoData({ isOwner, slug, what }: { isOwner: boolean; slug: string; what: string }) {
  return (
    <p className="empty">
      No {what} yet.{" "}
      {isOwner
        ? <>Rebuild stats in <Link className="link" to={`/set/${slug}/settings`}>Settings</Link>.</>
        : <>The owner needs to rebuild stats.</>}
    </p>
  );
}

const gameTitle = (g: GameRow) => {
  const ts = [...g.teams].sort((a, b) => b.score - a.score);
  return ts.map((t) => `${t.name} ${t.score}`).join(", ");
};

/* ----------------------------- round view ----------------------------- */

export function Scoreboard() {
  const { meta, slug, scope, editions, isOwner } = useSetCtx();
  const { data: games, error, loading } = useSetJson<GameRow[]>(slug, scopedPath(scope, "games.json"));
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [compact, setCompact] = useState(false);
  const rounds = useMemo(() => [...new Set((games ?? []).map((g) => g.round))].sort((a, b) => a - b), [games]);
  const round = Number(params.get("round") ?? rounds[0] ?? 0);
  const edLabel = (id?: string) => (editions.length > 1 && id ? editions.find((e) => e.id === id)?.label : undefined);

  const q = query.trim().toLowerCase();
  const shown = (games ?? []).filter((g) =>
    q ? g.teams.some((t) => t.name.toLowerCase().includes(q)) : g.round === round,
  );

  return (
    <div>
      <PageHeader title="Scoreboard" />
      {loading && <Loading />}
      {error && !stale404(error) && <ErrorBox error={error} />}
      {!loading && (stale404(error) || (!error && !(games ?? []).length)) && <NoData isOwner={isOwner} slug={slug} what="game-by-game data" />}
      {!!(games ?? []).length && (
        <>
          <div className="sb-toolbar">
            <nav className="sb-rounds" aria-label="Rounds">
              {rounds.map((r) => (
                <button key={r} type="button" className={"sb-round" + (!q && r === round ? " on" : "")} aria-pressed={!q && r === round}
                  onClick={() => { setQuery(""); setParams({ round: String(r) }, { replace: true }); }}>
                  {roundLabel(r)}
                </button>
              ))}
            </nav>
            <div className="sb-controls">
              <input className="search" type="search" placeholder="Find a team" aria-label="Find a team" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="seg" role="group" aria-label="Detail">
                <button type="button" className={!compact ? "on" : ""} aria-pressed={!compact} onClick={() => setCompact(false)}>Box scores</button>
                <button type="button" className={compact ? "on" : ""} aria-pressed={compact} onClick={() => setCompact(true)}>Scores only</button>
              </div>
            </div>
          </div>
          <p className="muted sb-count">
            {q ? `${shown.length} game${shown.length === 1 ? "" : "s"} matching “${query.trim()}”` : `Round ${roundLabel(round)} · ${shown.length} game${shown.length === 1 ? "" : "s"}`}
          </p>
          <div className={"sb-grid" + (compact ? " compact" : "")}>
            {shown.map((g, i) => (
              <article className="sb-card" key={g.id ?? i}>
                <header className="sb-card-head">
                  <h2>
                    {q && <span className="muted">Rd {roundLabel(g.round)} · </span>}
                    {gameTitle(g)}
                    {edLabel(g.editionId) && <span className="pill sb-ed">{edLabel(g.editionId)}</span>}
                  </h2>
                  {g.id && <Link className="btn-primary btn-sm sb-replay" to={`/set/${slug}/scoreboard/${g.id}`}>Replay</Link>}
                </header>
                {!compact && (
                  <div className="sb-boxes">
                    {g.teams.map((t) => <BoxTable key={t.name} t={t} g={g} meta={meta} slug={slug} />)}
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BoxTable({ t, g, meta, slug }: { t: GameTeamLine; g: GameRow; meta: Meta; slug: string }) {
  return (
    <div className="sb-box">
      <table className="data-table sb-table">
        <thead>
          <tr>
            <th>{t.name}</th>
            {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
            <th className="right">10</th>
            <th className="right">{negHead(meta)}</th>
            <th className="right">TUH</th>
            <th className="right">Pts</th>
          </tr>
        </thead>
        <tbody>
          {t.players.map((p) => (
            <tr key={p.name}>
              <td>{p.id ? <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> : p.name}</td>
              {meta.hasPower && <td className="right mono">{p.powers}</td>}
              <td className="right mono">{p.gets}</td>
              <td className="right mono">{p.incorrect}</td>
              <td className="right mono">{p.tuh || g.tuh}</td>
              <td className="right mono">{p.pts}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {showBonuses(meta) && (
        <div className="muted sb-bonus">Bonuses {t.bonusesHeard} heard · {t.bonusPts} pts · {num(t.ppb, 2)} PPB</div>
      )}
    </div>
  );
}

/* ----------------------------- game replay ----------------------------- */

interface Row {
  q: ReplayTossup;
  key: string;            // "<round>-<num>" of the tossup
  bkey: string | null;    // of the bonus that followed
  winner: number;         // team index, -1 for a dead tossup
  cycle: number[];        // points each team scored this cycle (tossup + bonus)
  score: number[];        // running score after it
  bonusPts: number;
}

export function GameReplay() {
  const { meta, slug, scope, editions, isOwner } = useSetCtx();
  const { gameId = "" } = useParams();
  const { data: games, error, loading } = useSetJson<GameRow[]>(slug, scopedPath(scope, "games.json"));
  const { data: replays, error: rErr, loading: rLoading } = useSetJson<Record<string, ReplayTossup[]>>(slug, scopedPath(scope, "replays.json"));
  const { data: tossups } = useSetJson<TossupRow[]>(slug, scopedPath(scope, "tossups.json"));
  const { data: bonuses } = useSetJson<BonusRow[]>(slug, meta.hasBonuses ? scopedPath(scope, "bonuses.json") : "");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [follow, setFollow] = useState("");
  const { hash } = useLocation();

  const g = games?.find((x) => x.id === gameId);
  const replay = g && replays ? replays[gameId] : undefined;
  const tuByKey = useMemo(() => new Map((tossups ?? []).map((t) => [t.id, t])), [tossups]);
  const bnByKey = useMemo(() => new Map((bonuses ?? []).map((b) => [b.id, b])), [bonuses]);

  // The question text is the wording this game heard: its own mirror's on a set with several.
  const edId = g?.editionId ?? (scope !== "all" && !scope.startsWith("tag:") ? scope : undefined);
  const detailFile = (f: string) => (editions.length > 1 && edId ? `editions/${edId}/${f}` : f);
  const { data: tuDetail } = useSetJson<Record<string, TossupDetail>>(slug, open.size ? detailFile("tossups_detail.json") : "");
  const { data: bnDetail } = useSetJson<Record<string, BonusDetail>>(slug, open.size && meta.hasBonuses ? detailFile("bonuses_detail.json") : "");

  const rows: Row[] = useMemo(() => {
    if (!g || !replay) return [];
    const score = g.teams.map(() => 0);
    return replay.map((q) => {
      const cycle = g.teams.map(() => 0);
      let winner = -1;
      for (const [t, , v] of q.b) { if (t >= 0) cycle[t] += v; if (v > 0 && t >= 0) winner = t; }
      const bonusPts = q.bn ? q.bn.p.reduce((a, b) => a + b, 0) + (q.bn.bb ?? []).reduce((a, b) => a + b, 0) : 0;
      if (q.bn && q.bn.t >= 0) cycle[q.bn.t] += bonusPts;
      cycle.forEach((c, i) => (score[i] += c));
      return {
        q, key: `${q.r ?? g.round}-${q.n}`, bkey: q.bn ? `${g.round}-${q.bn.n}` : null,
        winner, cycle, score: [...score], bonusPts,
      };
    });
  }, [g, replay]);

  // Arriving at (or jumping to) #tu-<n> opens that tossup.
  useEffect(() => {
    const m = /^#tu-(\d+)$/.exec(hash);
    const r = m && rows.find((x) => x.q.n === Number(m[1]));
    if (!r) return;
    setOpen((s) => (s.has(r.key) ? s : new Set(s).add(r.key)));
    requestAnimationFrame(() => document.getElementById(`tu-${r.q.n}`)?.scrollIntoView({ block: "start" }));
  }, [hash, rows]);

  if (loading || rLoading) return <Loading />;
  if (error && !stale404(error)) return <ErrorBox error={error} />;
  if (!g) return <><PageHeader title="Game replay" /><p className="empty">That game isn't in this view. <Link className="link" to={`/set/${slug}/scoreboard`}>Back to the scoreboard</Link></p></>;
  if (!replay) return <><PageHeader title="Game replay" />{rErr && !stale404(rErr) ? <ErrorBox error={rErr} /> : <NoData isOwner={isOwner} slug={slug} what="replay for this game" />}</>;

  const inRound = (games ?? []).filter((x) => x.round === g.round && x.id);
  const at = inRound.findIndex((x) => x.id === g.id);
  const prev = at > 0 ? inRound[at - 1] : null, next = at >= 0 && at < inRound.length - 1 ? inRound[at + 1] : null;
  const two = g.teams.length === 2;
  const players = [...new Set(replay.flatMap((q) => q.b.map((b) => b[1]).filter(Boolean) as string[]))].sort((a, b) => a.localeCompare(b));
  const bonusesRead = replay.filter((q) => q.bn).length;
  const allOpen = open.size === rows.length;
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="replay">
      <nav className="muted rp-crumbs" aria-label="Breadcrumb">
        <Link className="link" to={`/set/${slug}/scoreboard?round=${g.round}`}>Scoreboard</Link>
        <span aria-hidden="true">›</span>
        <Link className="link" to={`/set/${slug}/scoreboard?round=${g.round}`}>Round {roundLabel(g.round)}</Link>
      </nav>

      <section className="rp-final" aria-label="Final score">
        {g.teams.map((t, i) => (
          <div className="rp-team" key={t.name}>
            <span className="rp-swatch" style={{ background: teamVar(i) }} aria-hidden="true" />
            <div>
              <div className="rp-team-name">{t.id ? <Link className="link" to={`/set/${slug}/team/${t.id}`}>{t.name}</Link> : t.name}</div>
              <div className="muted rp-team-sub">
                {t.result === "W" ? "Won" : t.result === "L" ? "Lost" : t.result === "T" ? "Tied" : ""}
                {showBonuses(meta) && t.bonusesHeard ? ` · ${num(t.ppb, 2)} PPB` : ""}
              </div>
            </div>
            <div className="rp-score mono">{t.score}</div>
          </div>
        ))}
        <div className="muted rp-meta">
          Round {roundLabel(g.round)} · {replay.length} tossups{meta.hasBonuses ? ` · ${bonusesRead} bonuses` : ""}
        </div>
      </section>

      <div className="rp-prevnext">
        {prev ? <Link className="link" to={`/set/${slug}/scoreboard/${prev.id}`}>← {gameTitle(prev)}</Link> : <span />}
        {next ? <Link className="link" to={`/set/${slug}/scoreboard/${next.id}`}>{gameTitle(next)} →</Link> : <span />}
      </div>

      <section className="rp-strip-wrap" aria-label="Tossup by tossup at a glance">
        <div className="rp-strip" style={{ gridTemplateColumns: `minmax(110px, 160px) repeat(${rows.length}, minmax(30px, 1fr))` }}>
          <div />
          {rows.map((r) => <a key={r.key} className="rp-strip-num" href={`#tu-${r.q.n}`}>{r.q.n}</a>)}
          {g.teams.map((t, i) => (
            <Fragment key={t.name}>
              <div className="rp-strip-team" style={{ color: teamInk(i) }}>{t.name}</div>
              {rows.map((r) => {
                const mine = r.q.b.filter((b) => b[0] === i);
                const wrong = mine.find((b) => b[2] <= 0);
                if (r.winner === i)
                  return <a key={r.key} href={`#tu-${r.q.n}`} className="rp-cell won" style={{ background: teamVar(i) }} title={`TU ${r.q.n}: ${signed(r.cycle[i])}`}>{signed(r.cycle[i])}</a>;
                if (wrong)
                  return <a key={r.key} href={`#tu-${r.q.n}`} className="rp-cell neg" style={{ borderColor: teamVar(i), color: teamInk(i) }} title={`TU ${r.q.n}: ${wrong[1] ?? ""} ${signed(wrong[2])}`}>{signed(wrong[2])}</a>;
                return <span key={r.key} className={"rp-cell" + (r.winner < 0 ? " dead" : "")} />;
              })}
            </Fragment>
          ))}
          {two && (
            <>
              <div className="muted rp-strip-team">Score</div>
              {rows.map((r) => (
                <div key={r.key} className="rp-strip-score mono">
                  <span style={{ color: teamInk(0) }}>{r.score[0]}</span>
                  <span style={{ color: teamInk(1) }}>{r.score[1]}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <div className="rp-list-head">
        <h2>Tossup by tossup</h2>
        <div className="rp-list-controls">
          <label className="filter">
            Follow{" "}
            <select value={follow} onChange={(e) => setFollow(e.target.value)}>
              <option value="">Everyone</option>
              {players.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.key)))}>
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>

      <div className="rp-list">
        {rows.map((r) => {
          const tu = tuByKey.get(r.key);
          const bn = r.bkey ? bnByKey.get(r.bkey) : undefined;
          const isOpen = open.has(r.key);
          const dim = !!follow && !r.q.b.some((b) => b[1] === follow);
          return (
            <div key={r.key} id={`tu-${r.q.n}`} className={"rp-row" + (isOpen ? " open" : "") + (dim ? " dim" : "")}>
              <div className="rp-line">
                <button type="button" className="rp-num" aria-expanded={isOpen} aria-label={`Tossup ${r.q.n}: show the question${r.q.bn ? " and its bonus" : ""}`} onClick={() => toggle(r.key)}>
                  {r.q.n}
                </button>
                <div className="rp-tu">
                  {tu ? <Link className="link rp-ans" to={`/set/${slug}/tossup/${tu.id}`}><Html html={shortAnswer(tu.answer)} /></Link> : <span className="muted">Tossup {r.key}</span>}
                  <div className="muted rp-cat">{tu?.category}{r.q.r ? ` · from packet ${roundLabel(r.q.r)}` : ""}</div>
                </div>
                <Track q={r.q} follow={follow} />
                <div className="rp-result">
                  {r.q.b.map((b, k) => (
                    <div key={k}>
                      <span className={"rp-who" + (follow && b[1] === follow ? " followed" : "")} style={{ color: teamInk(b[0]) }}>{b[1] ?? "—"}</span>{" "}
                      <span className="mono">{signed(b[2])}</span>{" "}
                      {b[3] !== null && <span className="muted rp-word">word {b[3] + 1}</span>}
                    </div>
                  ))}
                  {r.winner < 0 && <span className="muted">{r.q.b.length ? "Not converted" : "Dead"}</span>}
                </div>
                <div className="rp-bonus">
                  {r.q.bn ? (
                    <>
                      <div className="rp-parts">
                        {r.q.bn.p.map((p, k) => {
                          const got = p + (r.q.bn!.bb?.[k] ?? 0) > 0;
                          const d = (r.q.bn!.d?.[k] ?? "").toUpperCase() || String(k + 1);
                          return (
                            <span key={k} className={"rp-part" + (got ? " got" : "")} style={got ? { background: teamVar(r.q.bn!.t) } : undefined}
                              title={`${got ? "Got" : "Missed"} part ${k + 1}`}>{d}</span>
                          );
                        })}
                        <span className="mono rp-bonus-tot">{signed(r.bonusPts)}</span>
                      </div>
                      <BonusAnswers slug={slug} q={r.q} bn={bn} />
                    </>
                  ) : meta.hasBonuses ? <span className="muted">No bonus</span> : null}
                </div>
                <div className="rp-running mono">
                  {two
                    ? <><span style={{ color: teamInk(0), fontWeight: r.score[0] > r.score[1] ? 700 : 400 }}>{r.score[0]}</span><span className="muted"> – </span><span style={{ color: teamInk(1), fontWeight: r.score[1] > r.score[0] ? 700 : 400 }}>{r.score[1]}</span></>
                    : r.score.map((s, i) => <div key={i} style={{ color: teamInk(i) }}>{s}</div>)}
                </div>
              </div>
              {isOpen && (
                <div className="rp-detail">
                  <div className="rp-detail-tu">
                    <QuestionWithBuzzes d={tuDetail?.[r.key]} q={r.q} loading={!tuDetail} />
                    {tu && (
                      <p className="muted rp-across">
                        {tu.heard} rooms · {Math.round(tu.convPct)}% converted
                        {tu.avgBuzzPct !== null ? ` · avg buzz ${Math.round(tu.avgBuzzPct)}%` : ""} ·{" "}
                        <Link className="link" to={`/set/${slug}/tossup/${tu.id}`}>All buzzes →</Link>
                      </p>
                    )}
                  </div>
                  {r.q.bn && (
                    <div className="rp-detail-bn">
                      <div className="muted">Bonus {r.q.bn.n}{bn ? ` · ${bn.category}` : ""} · {g.teams[r.q.bn.t]?.name}</div>
                      <BonusParts d={r.bkey ? bnDetail?.[r.bkey] : undefined} q={r.q} team={r.q.bn.t} />
                      {bn && (
                        <p className="muted rp-across">
                          {bn.heard} rooms · {num(bn.ppb, 2)} PPB · <Link className="link" to={`/set/${slug}/bonus/${bn.id}`}>Bonus page →</Link>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The bonus's answer lines in part order on one line, the parts this team got
// in its color. Cut off with an ellipsis rather than wrapping.
const plainAnswer = (html: string | null | undefined) => (html ? shortAnswer(html.replace(/<[^>]+>/g, "")).trim() : "");
function BonusAnswers({ slug, q, bn }: { slug: string; q: ReplayTossup; bn: BonusRow | undefined }) {
  const b = q.bn!;
  const byDiff: Record<string, string> = { E: plainAnswer(bn?.easyAnswer), M: plainAnswer(bn?.medAnswer), H: plainAnswer(bn?.hardAnswer) };
  const parts = b.p.map((p, k) => ({ got: p + (b.bb?.[k] ?? 0) > 0, ans: byDiff[(b.d?.[k] ?? "").toUpperCase()] || "" }));
  const label = bn ? <Link className="link" to={`/set/${slug}/bonus/${bn.id}`}>B{b.n}</Link> : <>B{b.n}</>;
  if (!parts.some((x) => x.ans)) return <div className="muted rp-cat rp-bn-line">{label}{bn ? ` · ${bn.category}` : ""}</div>;
  return (
    <div className="rp-cat rp-bn-line" title={parts.map((x) => `${x.got ? "✓" : "✗"} ${x.ans}`).join("   ")}>
      {label}
      {parts.map((x, k) => (
        <Fragment key={k}>
          <span className="muted"> · </span>
          <span className={x.got ? "rp-bn-got" : "muted"} style={x.got ? { color: teamInk(b.t) } : undefined}>{x.ans || "—"}</span>
        </Fragment>
      ))}
    </div>
  );
}

// The length of the tossup as a track, each buzz a marker on the word it came on.
function Track({ q, follow }: { q: ReplayTossup; follow: string }) {
  const len = q.w ?? Math.max(1, ...q.b.map((b) => (b[3] ?? 0) + 1));
  return (
    <div className="rp-track" aria-hidden="true">
      <div className="rp-track-line" />
      {q.b.filter((b) => b[3] !== null).map((b, k) => {
        const left = Math.min(100, (100 * ((b[3] as number) + 1)) / (len + 1));
        const kind = b[2] > 0 ? "get" : b[2] < 0 ? "neg" : "zero";
        return (
          <span key={k} className={`rp-mark ${kind}` + (follow && b[1] !== follow ? " faded" : "")}
            style={{ left: `${left}%`, ...(kind === "get" ? { background: teamVar(b[0]) } : { borderColor: teamVar(b[0]) }) }}
            title={`${b[1] ?? ""} ${signed(b[2])} at word ${(b[3] as number) + 1}`} />
        );
      })}
    </div>
  );
}

// The question as read, a chip on each word somebody buzzed on.
function QuestionWithBuzzes({ d, q, loading }: { d: TossupDetail | undefined; q: ReplayTossup; loading: boolean }) {
  const tokens = useMemo(() => (d ? tokenizeQuestion(d.questionHtml, d.words) ?? plainTokens(d.words) : []), [d]);
  if (!d) return loading ? <Loading /> : <p className="muted">Question text isn't available.</p>;
  const at = new Map<number, ReplayTossup["b"]>();
  for (const b of q.b) if (b[3] !== null) at.set(b[3], [...(at.get(b[3]) ?? []), b]);
  const chips = (i: number) => (at.get(i) ?? []).map((b, k) => (
    <span key={k} className={"rp-chip" + (b[2] > 0 ? " get" : "")} style={b[2] > 0 ? { background: teamVar(b[0]) } : { borderColor: teamVar(b[0]), color: teamInk(b[0]) }}>
      {b[1] ?? "—"} {signed(b[2])}
    </span>
  ));
  return (
    <>
      <p className="rp-question">
        {tokens.map((t, k) => (
          <Fragment key={k}>
            <Segs segs={t.segs} />{t.index !== null && chips(t.index)}{t.spaceAfter ? " " : null}
          </Fragment>
        ))}
        {chips(d.words.length)}
      </p>
      <p className="rp-answer"><b>ANSWER:</b> <Html html={d.answer} /></p>
    </>
  );
}

function BonusParts({ d, q, team }: { d: BonusDetail | undefined; q: ReplayTossup; team: number }) {
  const bn = q.bn!;
  if (!d) return <Loading />;
  return (
    <>
      {d.leadin && <p className="rp-leadin"><Html html={d.leadin} /></p>}
      <ol className="rp-bn-parts">
        {d.answers.map((a, k) => {
          const got = (bn.p[k] ?? 0) + (bn.bb?.[k] ?? 0) > 0;
          const letter = (bn.d?.[k] ?? "").toUpperCase() || String(k + 1);
          return (
            <li key={k}>
              <span className={"rp-part" + (got ? " got" : "")} style={got ? { background: teamVar(team) } : undefined}>{letter}</span>
              <div>
                {d.parts[k] && <div className="rp-bn-text"><Html html={d.parts[k]} /></div>}
                <div className="rp-bn-ans">
                  <b>ANSWER:</b> <Html html={a} />{" "}
                  <span className={got ? "rp-bn-got" : "muted"} style={got ? { color: teamInk(team) } : undefined}>
                    · {got ? `correct${(bn.bb?.[k] ?? 0) > 0 ? " on the bounceback" : ""}` : "missed"}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
