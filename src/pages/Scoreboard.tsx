import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useSetCtx, scopedPath } from "../components/Layout";
import { useSetJson } from "../data";
import { BonusDetail, BonusRow, GameRow, GameTeamLine, Meta, ReplayTossup, TossupDetail, TossupRow } from "../types";
import { Html, num, roundLabel } from "../util";
import { PageHeader, Loading, ErrorBox } from "../components/Common";
import { Segs, plainTokens, tokenizeQuestion } from "../questionText";
import { TuhEditor, TuhEditCtx } from "./StandardStats";

// Scoreboard: every game's box score, round by round, each one a door into its
// replay — the game tossup by tossup, with where everyone buzzed and what the
// bonus that followed went for.

const POWER_HEAD: Record<string, string> = { mACF: "15", PACE: "20", SUPERPOWER: "Pwr" };
const powerHead = (m: Meta) => POWER_HEAD[m.scoring] ?? "Pwr";
const negHead = (m: Meta) => (m.hasNeg ? "-5" : "Inc");
const showBonuses = (m: Meta) => m.hasBonuses && m.hasTeamBonuses !== false;
const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0");
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
  const { meta, slug, scope, editions, isOwner, user, allowRequests } = useSetCtx();
  const { data: games, error, loading } = useSetJson<GameRow[]>(slug, scopedPath(scope, "games.json"));
  const { data: rosters } = useSetJson<Record<string, string[]>>(slug, user && (isOwner || allowRequests) ? scopedPath(scope, "rosters.json") : "");
  // Box-score tossups heard can be corrected (owners) or suggested (anyone signed in).
  const tuhEdit: TuhEditCtx | null = user && (isOwner || allowRequests)
    ? { isOwner, rosters: rosters ?? {}, editionId: scope !== "all" && !scope.startsWith("tag:") ? scope : undefined }
    : null;
  // The line open for a tossups-heard edit: "<game>|<team>|<player>", or "<game>|<team>|" to add one.
  const [editing, setEditing] = useState<string | null>(null);
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
                    {g.teams.map((t) => <BoxTable key={t.name} t={t} g={g} meta={meta} slug={slug} gk={g.id ?? `${g.round}-${i}`} tuhEdit={tuhEdit} editing={editing} setEditing={setEditing} />)}
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

function BoxTable({ t, g, meta, slug, gk, tuhEdit, editing, setEditing }: {
  t: GameTeamLine; g: GameRow; meta: Meta; slug: string; gk: string;
  tuhEdit: TuhEditCtx | null; editing: string | null; setEditing: (k: string | null) => void;
}) {
  const cols = meta.hasPower ? 6 : 5;
  const close = () => setEditing(null);
  return (
    <div className="sb-box">
      <table className="data-table sb-table">
        <thead>
          <tr>
            <th>
              {t.name}
              {tuhEdit && <button type="button" className="btn-link tuh-edit-btn" title="Add a player" onClick={() => setEditing(`${gk}|${t.name}|`)}>+</button>}
            </th>
            {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
            <th className="right">10</th>
            <th className="right">{negHead(meta)}</th>
            <th className="right">TUH</th>
            <th className="right">Pts</th>
          </tr>
        </thead>
        <tbody>
          {editing === `${gk}|${t.name}|` && tuhEdit && (
            <TuhEditor slug={slug} g={g} team={t.name} player={null} current={null} ctx={tuhEdit} cols={cols} onClose={close} />
          )}
          {t.players.map((p) => (
            <Fragment key={p.name}>
            <tr>
              <td>{p.id ? <Link className="link" to={`/set/${slug}/player/${p.id}`}>{p.name}</Link> : p.name}</td>
              {meta.hasPower && <td className="right mono">{p.powers}</td>}
              <td className="right mono">{p.gets}</td>
              <td className="right mono">{p.incorrect}</td>
              <td className="right mono">
                {tuhEdit && <button type="button" className="btn-link tuh-edit-btn" title="Change tossups heard" onClick={() => setEditing(`${gk}|${t.name}|${p.name}`)}>{"\u270e"}</button>}
                {p.tuh || g.tuh}
              </td>
              <td className="right mono">{p.pts}</td>
            </tr>
            {editing === `${gk}|${t.name}|${p.name}` && tuhEdit && (
              <TuhEditor slug={slug} g={g} team={t.name} player={p.name} current={p.tuh || g.tuh} ctx={tuhEdit} cols={cols} onClose={close} />
            )}
            </Fragment>
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
  const bonusCol = !!meta.hasBonuses && bonusesRead > 0;
  const cols = 4 + (two ? 2 : 1) + (bonusCol ? 1 : 0) + 1;
  const byScore = g.teams.map((t, i) => ({ t, i })).sort((a, b) => b.t.score - a.t.score);
  const sum = (t: GameTeamLine, k: "powers" | "gets" | "incorrect") => t.players.reduce((a, p) => a + (p[k] ?? 0), 0);
  const scoreText = (r: Row) => r.score.join("–");

  return (
    <div className="replay">
      <div className="rp-crumbs">
        <nav className="muted" aria-label="Breadcrumb">
          <Link className="link" to={`/set/${slug}/scoreboard?round=${g.round}`}>Scoreboard</Link>
          <span aria-hidden="true"> › </span>
          <Link className="link" to={`/set/${slug}/scoreboard?round=${g.round}`}>Round {roundLabel(g.round)}</Link>
        </nav>
        <span className="rp-prevnext">
          {prev && <Link className="link" to={`/set/${slug}/scoreboard/${prev.id}`} title={gameTitle(prev)}>← Previous game</Link>}
          {prev && next && <span className="muted"> · </span>}
          {next && <Link className="link" to={`/set/${slug}/scoreboard/${next.id}`} title={gameTitle(next)}>Next game →</Link>}
        </span>
      </div>

      <PageHeader title={`Round ${roundLabel(g.round)}`} subtitle={`${replay.length} tossups heard${bonusCol ? ` · ${bonusesRead} bonuses` : ""}`} />

      <div className="table-wrap">
        <table className="data-table rp-linescore">
          <thead>
            <tr>
              <th>Team</th>
              <th className="right">Score</th>
              {meta.hasPower && <th className="right">{powerHead(meta)}</th>}
              <th className="right">10</th>
              <th className="right">{negHead(meta)}</th>
              {showBonuses(meta) && <th className="right">PPB</th>}
            </tr>
          </thead>
          <tbody>
            {byScore.map(({ t }) => (
              <tr key={t.name}>
                <td>
                  {t.id ? <Link className="link strong" to={`/set/${slug}/team/${t.id}`}>{t.name}</Link> : <span className="strong">{t.name}</span>}
                  {(t.result === "W" || t.result === "T") && <span className="muted rp-result-word"> {t.result === "W" ? "won" : "tied"}</span>}
                </td>
                <td className="right mono rp-total">{t.score}</td>
                {meta.hasPower && <td className="right mono">{sum(t, "powers")}</td>}
                <td className="right mono">{sum(t, "gets")}</td>
                <td className="right mono">{sum(t, "incorrect")}</td>
                {showBonuses(meta) && <td className="right mono">{t.bonusesHeard ? num(t.ppb, 2) : "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rp-strip-wrap">
        <table className="rp-strip" aria-label="Tossups at a glance">
          <thead>
            <tr>
              <th />
              {rows.map((r) => (
                <th key={r.key} className={r.winner < 0 ? "dead" : ""}><a href={`#tu-${r.q.n}`}>{r.q.n}</a></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {g.teams.map((t, i) => (
              <tr key={t.name}>
                <th scope="row" className="rp-strip-team" title={t.name}>{t.name}</th>
                {rows.map((r) => {
                  const mine = r.q.b.filter((b) => b[0] === i);
                  const right = mine.find((b) => b[2] > 0);
                  const wrong = mine.find((b) => b[2] <= 0);
                  const b = right ?? wrong;
                  if (!b) return <td key={r.key} />;
                  const tip = `Tossup ${r.q.n}: ${b[1] ?? ""} ${signed(b[2])}${right && r.q.bn && r.q.bn.t === i ? `, bonus ${signed(r.bonusPts)}` : ""}`;
                  return <td key={r.key}><a href={`#tu-${r.q.n}`} className={`rp-cell ${kindOf(b[2])}`} title={tip}>{signed(b[2])}</a></td>;
                })}
              </tr>
            ))}
            <tr className="rp-strip-score">
              <th scope="row">Score</th>
              {rows.map((r) => <td key={r.key} className="mono">{two ? scoreText(r) : r.score.join(" ")}</td>)}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="rp-list-head">
        <h2>Questions</h2>
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

      <div className="table-wrap">
        <table className="data-table rp-table">
          <thead>
            <tr>
              <th className="rp-n">#</th>
              <th className="rp-ans-col">Answer</th>
              <th>Category</th>
              <th className="rp-track-col">Buzz</th>
              {two ? g.teams.map((t) => <th key={t.name} className="rp-teamcol">{t.name}</th>) : <th>Buzzes</th>}
              {bonusCol && <th>Bonus</th>}
              <th className="right">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const tu = tuByKey.get(r.key);
              const bn = r.bkey ? bnByKey.get(r.bkey) : undefined;
              const isOpen = open.has(r.key);
              const dim = !!follow && !r.q.b.some((b) => b[1] === follow);
              const buzzes = (bs: ReplayTossup["b"]) => bs.map((b, k) => (
                <div key={k} className="rp-buzz">
                  <span className={follow && b[1] === follow ? "rp-followed" : undefined}>{b[1] ?? "—"}</span>{" "}
                  <span className={`pill ${pillOf(b[2])}`}>{signed(b[2])}</span>
                  {b[3] !== null && <span className="muted rp-word" title={`word ${b[3] + 1}`}> w{b[3] + 1}</span>}
                </div>
              ));
              return (
                <Fragment key={r.key}>
                  <tr id={`tu-${r.q.n}`} className={"rp-tr" + (isOpen ? " open" : "") + (dim ? " dim" : "")}>
                    <td className="rp-n">
                      <button type="button" className="rp-num" aria-expanded={isOpen}
                        aria-label={`Tossup ${r.q.n}: ${isOpen ? "hide" : "show"} the question${r.q.bn ? " and its bonus" : ""}`} onClick={() => toggle(r.key)}>
                        <span className="rp-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>{r.q.n}
                      </button>
                    </td>
                    <td>
                      {tu ? <Link className="link" to={`/set/${slug}/tossup/${tu.id}`}><Html html={shortAnswer(tu.answer)} /></Link> : <span className="muted">Tossup {r.key}</span>}
                      {r.q.r ? <span className="muted rp-word"> · packet {roundLabel(r.q.r)}</span> : null}
                    </td>
                    <td>{tu?.category}</td>
                    <td className="rp-track-col"><Track q={r.q} follow={follow} /></td>
                    {two
                      ? g.teams.map((_, i) => <td key={i}>{buzzes(r.q.b.filter((b) => b[0] === i))}</td>)
                      : <td>{r.q.b.map((b, k) => <div key={k}><span className="muted">{g.teams[b[0]]?.name}: </span>{buzzes([b])}</div>)}</td>}
                    {bonusCol && <td className="rp-bonus">{r.q.bn ? <BonusAnswers slug={slug} q={r.q} bn={bn} total={r.bonusPts} /> : null}</td>}
                    <td className="right mono rp-running">{two ? scoreText(r) : r.score.join(" · ")}</td>
                  </tr>
                  {isOpen && (
                    <tr className={"rp-detail-tr" + (dim ? " dim" : "")}>
                      <td />
                      <td colSpan={cols - 1}>
                        <div className={"rp-detail" + (r.q.bn ? "" : " solo")}>
                          <div>
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
                              <BonusParts d={r.bkey ? bnDetail?.[r.bkey] : undefined} q={r.q} />
                              {bn && (
                                <p className="muted rp-across">
                                  {bn.heard} rooms · {num(bn.ppb, 2)} PPB · <Link className="link" to={`/set/${slug}/bonus/${bn.id}`}>Bonus page →</Link>
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Power, get, wrong buzz or a no-penalty miss, in the site's buzz colors.
const kindOf = (v: number) => (v > 10 ? "power" : v > 0 ? "get" : v < 0 ? "neg" : "zero");
const pillOf = (v: number) => (v > 10 ? "buzz-power" : v > 0 ? "buzz-get" : v < 0 ? "buzz-neg" : "buzz-zero");

const DIFF_NAME: Record<string, string> = { E: "Easy", M: "Medium", H: "Hard" };

// How far into the tossup each buzz came, as a marker on a line the length of the question.
function Track({ q, follow }: { q: ReplayTossup; follow: string }) {
  const len = q.w ?? Math.max(1, ...q.b.map((b) => (b[3] ?? 0) + 1));
  return (
    <div className="rp-track" aria-hidden="true">
      {q.b.filter((b) => b[3] !== null).map((b, k) => (
        <span key={k} className={`rp-mark ${kindOf(b[2])}` + (follow && b[1] !== follow ? " faded" : "")}
          style={{ left: `${Math.min(100, (100 * ((b[3] as number) + 1)) / (len + 1))}%` }}
          title={`${b[1] ?? ""} ${signed(b[2])} at word ${(b[3] as number) + 1} of ${len}`} />
      ))}
    </div>
  );
}

// The bonus's answer lines in part order on one line, the parts the team got in
// the normal ink and the misses muted. Cut off with an ellipsis rather than wrapping.
const plainAnswer = (html: string | null | undefined) => (html ? shortAnswer(html.replace(/<[^>]+>/g, "")).trim() : "");
function BonusAnswers({ slug, q, bn, total }: { slug: string; q: ReplayTossup; bn: BonusRow | undefined; total: number }) {
  const b = q.bn!;
  const byDiff: Record<string, string> = { E: plainAnswer(bn?.easyAnswer), M: plainAnswer(bn?.medAnswer), H: plainAnswer(bn?.hardAnswer) };
  const parts = b.p.map((p, k) => { const d = (b.d?.[k] ?? "").toUpperCase(); return { got: p + (b.bb?.[k] ?? 0) > 0, ans: byDiff[d] || "", d }; });
  const pts = <span className={"mono rp-bonus-tot" + (total > 0 ? "" : " muted")}>{signed(total)}</span>;
  if (!parts.some((x) => x.ans))
    return <div className="rp-bn-line">{pts}{bn && <> <Link className="link" to={`/set/${slug}/bonus/${bn.id}`}>{bn.category}</Link></>}</div>;
  return (
    <div className="rp-bn-line" title={parts.map((x) => `${x.got ? "✓" : "✗"} ${x.ans}`).join("   ")}>
      {pts}
      {parts.map((x, k) => (
        <Fragment key={k}>
          <span className="muted">{k ? " · " : " "}</span>
          {x.d && <span className="rp-d" title={DIFF_NAME[x.d]}>{x.d}</span>}
          <span className={x.got ? "rp-bn-got" : "muted rp-bn-miss"}>{x.ans || "—"}</span>
        </Fragment>
      ))}
    </div>
  );
}

// The question as read, set like the tossup page: power in bold, each buzzed word
// highlighted and followed by who buzzed there.
function QuestionWithBuzzes({ d, q, loading }: { d: TossupDetail | undefined; q: ReplayTossup; loading: boolean }) {
  const tokens = useMemo(() => (d ? tokenizeQuestion(d.questionHtml, d.words) ?? plainTokens(d.words) : []), [d]);
  if (!d) return loading ? <Loading /> : <p className="muted">Question text isn't available.</p>;
  const at = new Map<number, ReplayTossup["b"]>();
  for (const b of q.b) if (b[3] !== null) at.set(b[3], [...(at.get(b[3]) ?? []), b]);
  const tags = (i: number) => (at.get(i) ?? []).map((b, k) => (
    <span key={k} className={`rp-tag ${kindOf(b[2])}`}>{b[1] ?? "—"} {signed(b[2])}</span>
  ));
  let last: number | null = null;
  return (
    <>
      <p className="q-text rp-question">
        {tokens.map((t, k) => {
          if (t.index !== null) last = t.index;
          const power = d.powerIndex !== null && last !== null && last <= d.powerIndex;
          const hit = t.index !== null && at.has(t.index);
          return (
            <span key={k} className={power ? "q-power" : undefined}>
              {hit ? <span className="q-chip"><Segs segs={t.segs} /></span> : <Segs segs={t.segs} />}
              {t.index !== null && tags(t.index)}{t.spaceAfter ? " " : null}
            </span>
          );
        })}
        {tags(d.words.length)}
      </p>
      <p className="rp-answer"><b>ANSWER:</b> <Html html={d.answer} /></p>
    </>
  );
}

function BonusParts({ d, q }: { d: BonusDetail | undefined; q: ReplayTossup }) {
  const bn = q.bn!;
  if (!d) return <Loading />;
  return (
    <>
      {d.leadin && <p className="rp-leadin"><Html html={d.leadin} /></p>}
      <ol className="rp-bn-parts">
        {d.answers.map((a, k) => {
          const got = (bn.p[k] ?? 0) + (bn.bb?.[k] ?? 0) > 0;
          const letter = (bn.d?.[k] ?? "").toUpperCase();
          return (
            <li key={k}>
              {d.parts[k] && <div className="rp-bn-text">{letter && <span className="muted rp-diff">[{letter}] </span>}<Html html={d.parts[k]} /></div>}
              <div className="rp-bn-ans">
                <b>ANSWER:</b> <Html html={a} />{" "}
                <span className={`pill ${got ? "buzz-get" : "rp-missed"}`}>
                  · {got ? `correct${(bn.bb?.[k] ?? 0) > 0 ? " on the bounceback" : ""}` : "missed"}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
