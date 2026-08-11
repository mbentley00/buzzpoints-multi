import { Link, useParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { TagGroup } from "../types";
import { pct, num } from "../util";
import { PageHeader, Loading, ErrorBox } from "../components/Common";

// How each tag value played, one table per dimension. Tags come from whichever
// metadata field the owner marked as a tag in Settings (plus any hand edits), so
// a set that records its writer can compare writers the way it compares subjects.
export function Tags() {
  const { meta } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<TagGroup[]>("tags_tossup.json");

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const groups = (data ?? []).filter((g) => g.values.length);
  if (!groups.length)
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
      {groups.map((g) => (
        <div key={g.dim} style={{ marginBottom: 28 }}>
          <h2>{g.dim}</h2>
          <div className="table-wrap">
            <table className="data-table cat-table">
              <thead>
                <tr>
                  <th>{g.dim}</th>
                  <th className="right">Heard</th>
                  <th className="right">Conv%</th>
                  {meta.hasPower && <th className="right">Pwr%</th>}
                  <th className="right" title="Rate of interrupting incorrect buzzes per play">Inc%</th>
                  <th className="right" title="Converted within the first sentence">1st Sent%</th>
                  <th className="right">Avg Buzz</th>
                </tr>
              </thead>
              <tbody>
                {g.values.map((v) => (
                  <tr key={v.tag}>
                    <td>
                      <Link className="link" to={`/set/${slug}/tossup?tag=${encodeURIComponent(v.tag)}`}>{v.value}</Link>
                    </td>
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
        </div>
      ))}
    </>
  );
}
