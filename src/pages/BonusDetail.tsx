import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSetJson } from "../data";
import { useSetCtx } from "../components/Layout";
import { BonusDetail, BonusResult, PartConv } from "../types";
import { CategoryTag, Html, pct, num } from "../util";
import { Loading, ErrorBox } from "../components/Common";
import { DataTable, Column } from "../components/DataTable";

// Points a team earned on one part (direct + bounceback).
const partGot = (r: BonusResult, p: PartConv) => (r.partPts[p.idx] || 0) + (r.bbPts[p.idx] || 0);
const diffInitial = (p: PartConv) => (p.difficulty || "").charAt(0).toUpperCase() || "•";

// Row color by how much of the bonus a team converted.
function rowClass(r: BonusResult, parts: PartConv[]): string {
  const converted = parts.filter((p) => partGot(r, p) > 0).length;
  const ratio = parts.length ? converted / parts.length : 0;
  const tier = ratio >= 1 ? "full" : ratio >= 0.5 ? "part" : ratio > 0 ? "low" : "zero";
  return `bonus-row bonus-row-${tier}`;
}

export function BonusDetailPage() {
  const { slug, scope } = useSetCtx();
  const { id = "" } = useParams();
  const [version, setVersion] = useState(scope);
  const combinedFile = "bonuses_detail.json";
  const dispFile = version !== "all" ? `editions/${version}/bonuses_detail.json` : combinedFile;
  const { data: comb } = useSetJson<Record<string, BonusDetail>>(slug, combinedFile);
  const { data, error, loading } = useSetJson<Record<string, BonusDetail>>(slug, dispFile);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data?.[id];
  if (!d) return <ErrorBox error={version === "all" ? "Bonus not found." : "This edition doesn't have this bonus."} />;
  const versions = comb?.[id]?.versions ?? [];
  const parts = d.partConv;

  const columns: Column<BonusResult>[] = [
    { key: "team", label: "Team", sortVal: (r) => r.team.toLowerCase(), render: (r) => r.team },
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
      <div className="breadcrumb">
        <Link to={`/set/${slug}/bonus`} className="link">← Bonuses</Link>
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
          <h1>Packet {d.round}: Bonus {d.num}</h1>
          <p className="bonus-leadin"><Html html={d.leadin} /></p>
          <ol className="bonus-parts-list">
            {parts.map((p) => (
              <li key={p.idx}>
                <p className="bonus-part-line">
                  <span className="bonus-part-tag">[10{(p.difficulty || "").charAt(0)}]</span>{" "}
                  <Html html={p.part} />
                </p>
                <p className="bonus-answer">ANSWER: <Html html={p.answer} /></p>
              </li>
            ))}
          </ol>
          <p className="subtitle"><CategoryTag cat={d.category} /> · <span className="muted">{d.subcategory}</span></p>

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
      </div>
    </div>
  );
}
