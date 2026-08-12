import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSetJson } from "../data";
import { useSetCtx } from "../components/Layout";
import { QuestionTags } from "../components/QuestionTags";
import { BonusDetail, BonusResult, PartConv } from "../types";
import { CategoryTag, Html, pct, num, roundLabel } from "../util";
import { Loading, ErrorBox, EditionBadges } from "../components/Common";
import { DataTable, Column } from "../components/DataTable";
import { QuestionNav, useQuestionNav } from "../components/QuestionNav";

// Points a team earned on one part (direct + bounceback).
const partGot = (r: BonusResult, p: PartConv) => (r.partPts[p.idx] || 0) + (r.bbPts[p.idx] || 0);
const diffInitial = (p: PartConv) => (p.difficulty || "").charAt(0).toUpperCase() || "•";

// Every team that earned a part, shown on hover / click next to its answer line.
// A team that got it on the bounceback is marked, since that's a different feat
// from converting the part it controlled.
function PartTeams({ part, results }: { part: PartConv; results: BonusResult[] }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!pinned) return;
    const onDoc = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.(".bn-got")) setPinned(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [pinned]);

  const got = results
    .filter((r) => partGot(r, part) > 0)
    .map((r) => ({ team: r.team, bounceback: (r.partPts[part.idx] || 0) === 0 }))
    .sort((a, b) => a.team.localeCompare(b.team));

  return (
    <span
      className={"bn-got" + (pinned ? " bn-got-pinned" : "")}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => { e.stopPropagation(); setPinned((p) => !p); }}
      title="Teams that converted this part"
    >
      {got.length}/{results.length} teams
      {(open || pinned) && (
        <span className="q-pop" role="tooltip">
          <span className="q-pop-head">
            {got.length === 0 ? "No team converted this part" : `Converted by ${got.length} of ${results.length}`}
          </span>
          {got.map((g) => (
            <span key={g.team} className="q-pop-row">
              <span className="q-pop-who">
                {g.team}
                {g.bounceback && <span className="q-pop-team">bounceback</span>}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

// Row color by how much of the bonus a team converted.
function rowClass(r: BonusResult, parts: PartConv[]): string {
  const converted = parts.filter((p) => partGot(r, p) > 0).length;
  const ratio = parts.length ? converted / parts.length : 0;
  const tier = ratio >= 1 ? "full" : ratio >= 0.5 ? "part" : ratio > 0 ? "low" : "zero";
  return `bonus-row bonus-row-${tier}`;
}

export function BonusDetailPage() {
  const { slug, scope, isOwner, editions } = useSetCtx();
  const { id = "" } = useParams();
  // A tag (phase) scope has no per-edition file; fall back to combined for it.
  const [version, setVersion] = useState(scope.startsWith("tag:") ? "all" : scope);
  const combinedFile = "bonuses_detail.json";
  const dispFile = version !== "all" ? `editions/${version}/bonuses_detail.json` : combinedFile;
  const { data: comb } = useSetJson<Record<string, BonusDetail>>(slug, combinedFile);
  const { data, error, loading } = useSetJson<Record<string, BonusDetail>>(slug, dispFile);
  const nav = useQuestionNav(data, id);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data?.[id];
  if (!d) return <ErrorBox error={version === "all" ? "Bonus not found." : "This edition doesn't have this bonus."} />;
  const versions = comb?.[id]?.versions ?? [];
  const parts = d.partConv;

  // Which mirror heard each bonus. Only meaningful in the combined view, and only
  // present once a multi-edition set has been re-aggregated.
  const showEdition = version === "all" && editions.length > 1 && d.results.some((r) => r.editionId);
  const edLabel = (id?: string) => editions.find((e) => e.id === id)?.label ?? id ?? "";

  const columns: Column<BonusResult>[] = [
    { key: "team", label: "Team", sortVal: (r) => r.team.toLowerCase(), render: (r) => r.team },
    ...(showEdition
      ? [{
          key: "edition", label: "Edition", title: "Edition (mirror) this team heard the bonus in",
          sortVal: (r: BonusResult) => edLabel(r.editionId).toLowerCase(),
          render: (r: BonusResult) => (r.editionId ? <EditionBadges ids={[r.editionId]} editions={editions} /> : <span className="muted">—</span>),
        } as Column<BonusResult>]
      : []),
    ...parts.map((p, i): Column<BonusResult> => ({
      key: `p${p.idx}`,
      label: `Part ${i + 1}`,
      align: "right",
      title: p.difficultyName,
      sortVal: (r) => partGot(r, p),
      render: (r) => <span className="mono">{partGot(r, p)}</span>,
    })),
    { key: "total", label: "Total", align: "right", sortVal: (r) => r.total, render: (r) => <span className="mono strong">{r.total}</span> },
    {
      key: "parts", label: "Parts", align: "right",
      sortVal: (r) => parts.filter((p) => partGot(r, p) > 0).length,
      render: (r) => <span className="mono">{parts.filter((p) => partGot(r, p) > 0).map(diffInitial).join("") || "—"}</span>,
    },
  ];

  return (
    <div className="detail">
      <div className="breadcrumb breadcrumb-nav">
        <Link to={`/set/${slug}/bonus`} className="link">← Bonuses</Link>
        <QuestionNav nav={nav} label="Bonus" hrefOf={(q) => `/set/${slug}/bonus/${q}`} />
      </div>
      {versions.length > 1 && (
        <div className="version-bar">
          <span className="muted">Bonus version:</span>
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="all">All editions (latest)</option>
            {versions.map((v) => <option key={v.editionId} value={v.editionId}>{v.label}{v.differs ? " — revised" : ""}</option>)}
          </select>
        </div>
      )}

      <div className="tu-grid">
        <div className="tu-left">
          <h1>Packet {roundLabel(d.round)}: Bonus {d.num}</h1>
          <p className="bonus-leadin"><Html html={d.leadin} /></p>
          <ol className="bonus-parts-list">
            {parts.map((p) => (
              <li key={p.idx}>
                <p className="bonus-part-line">
                  <span className="bonus-part-tag">[10{(p.difficulty || "").charAt(0)}]</span>{" "}
                  <Html html={p.part} />
                </p>
                <p className="bonus-answer">
                  ANSWER: <Html html={p.answer} />
                  {d.results.length > 0 && <PartTeams part={p} results={d.results} />}
                </p>
              </li>
            ))}
          </ol>
          <p className="subtitle"><CategoryTag cat={d.category} /> · <span className="muted">{d.subcategory}</span></p>
          <QuestionTags slug={slug} id={d.id} kind="bonuses" tags={d.tags || []} isOwner={isOwner} />

          <div className="table-wrap" style={{ maxWidth: 460, marginTop: 8 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th className="right">Heard</th>
                  <th className="right">PPB</th>
                  {parts.map((p) => <th key={p.idx} className="right" title={p.difficultyName}>{diffInitial(p)}%</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="right mono">{d.heard}</td>
                  <td className="right mono">{num(d.ppb, 2)}</td>
                  {parts.map((p) => <td key={p.idx} className="right mono">{pct(p.convPct)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {d.results.length > 0 && (
          <div className="tu-right">
            <h2 style={{ marginTop: 0 }}>Conversion ({d.results.length})</h2>
            <DataTable
              rows={d.results}
              columns={columns}
              initialSort="total"
              initialDir="desc"
              rowKey={(r, i) => `${r.team}-${i}`}
              rowClass={(r) => rowClass(r, parts)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
