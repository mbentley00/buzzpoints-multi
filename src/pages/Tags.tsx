import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { TagGroup, BonusTagGroup } from "../types";
import { pct, num } from "../util";
import { PageHeader, Loading, ErrorBox } from "../components/Common";

// How each tag value played, one section per dimension. Tags come from whichever
// metadata field the owner marked as a tag in Settings (plus any hand edits), so
// a set that records its writer can compare writers the way it compares subjects.
export function Tags() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const tu = useScopedJson<TagGroup[]>("tags_tossup.json");
  // Bonus tags only exist for sets with bonuses; a 404 there isn't an error.
  const bn = useScopedJson<BonusTagGroup[]>("tags_bonus.json");

  if (tu.loading) return <Loading />;
  if (tu.error) return <ErrorBox error={tu.error} />;

  const tuGroups = (tu.data ?? []).filter((g) => g.values.length);
  const bnGroups = (bn.data ?? []).filter((g) => g.values.length);
  const dims = [...new Set([...tuGroups.map((g) => g.dim), ...bnGroups.map((g) => g.dim)])].sort();

  if (!dims.length)
    return (
      <>
        <PageHeader title="Tags" subtitle="Conversion & buzz speed by tag" />
        <p className="caveat">
          No tags yet. A tournament's metadata often carries more than the category — the writer, say — and marking
          that field as a <strong>Tag</strong> under{" "}
          <Link to={`/set/${slug}/settings#categories`} className="link">Settings → Question categories &amp; tags</Link>{" "}
          turns it into a dimension you can compare on here.
        </p>
      </>
    );

  return (
    <>
      <PageHeader title="Tags" subtitle="Conversion & buzz speed by tag" />
      {dims.map((dim) => {
        const t = tuGroups.find((g) => g.dim === dim);
        const b = bnGroups.find((g) => g.dim === dim);
        return (
          <div key={dim} style={{ marginBottom: 30 }}>
            <h2>{dim}</h2>
            {t && (
              <div className="table-wrap">
                <table className="data-table cat-table">
                  <thead>
                    <tr>
                      <th>Tossups by {dim.toLowerCase()}</th>
                      <th className="right">Heard</th>
                      <th className="right">Conv%</th>
                      {meta.hasPower && <th className="right">Pwr%</th>}
                      <th className="right" title="Rate of interrupting incorrect buzzes per play">Inc%</th>
                      <th className="right" title="Converted within the first sentence">1st Sent%</th>
                      <th className="right">Avg Buzz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.values.map((v) => (
                      <tr key={v.tag}>
                        <td><Link className="link" to={`/set/${slug}/tossup?tag=${encodeURIComponent(v.tag)}`}>{v.value}</Link></td>
                        <td className="right mono">{v.heard}</td>
                        <td className="right mono">{pct(v.convPct)}</td>
                        {meta.hasPower && <td className="right mono">{pct(v.powerPct)}</td>}
                        <td className="right mono">{pct(v.incorrectPct)}</td>
                        <td className="right mono">{pct(v.firstSentConvPct)}</td>
                        <td className="right mono">{v.avgBuzzPct === null ? "—" : `${num(v.avgBuzzPct)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {b && (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table className="data-table cat-table">
                  <thead>
                    <tr>
                      <th>Bonuses by {dim.toLowerCase()}</th>
                      <th className="right">Heard</th>
                      <th className="right">PPB</th>
                      <th className="right">Easy%</th>
                      <th className="right">Medium%</th>
                      <th className="right">Hard%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.values.map((v) => (
                      <tr key={v.tag}>
                        <td><Link className="link" to={`/set/${slug}/bonus?tag=${encodeURIComponent(v.tag)}`}>{v.value}</Link></td>
                        <td className="right mono">{v.heard}</td>
                        <td className="right mono">{num(v.ppb, 2)}</td>
                        <td className="right mono">{pct(v.easyPct)}</td>
                        <td className="right mono">{pct(v.medPct)}</td>
                        <td className="right mono">{pct(v.hardPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
