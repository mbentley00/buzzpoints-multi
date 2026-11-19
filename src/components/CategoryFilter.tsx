import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSetCtx, useScopedJson } from "./Layout";

// Reads the active category filter from the URL. Category links use `category`
// (a main), `subcategory` (a full sub/leaf path), or `subcats` (a pipe-separated
// list of member paths, used by merged/virtual categories). All are matched
// against a row's full subcategory path via catMatches().
export function useCategoryFilter() {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => {
    const v: string[] = [];
    const cat = params.get("category");
    const sub = params.get("subcategory");
    const subcats = params.get("subcats");
    if (cat) v.push(cat);
    if (sub) v.push(sub);
    if (subcats) v.push(...subcats.split("|").map((s) => s.trim()).filter(Boolean));
    return v;
  }, [params]);

  const label = params.has("subcats") ? "merged category" : values[0] ?? "";
  const clear = () =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete("category");
        n.delete("subcategory");
        n.delete("subcats");
        return n;
      },
      { replace: true }
    );

  return { values, label, clear, active: values.length > 0 };
}

export function CategoryFilterChip({ label, onClear, children }: { label: string; onClear: () => void; children?: React.ReactNode }) {
  return (
    <div className="cat-filter-chip">
      <span>Filtered to <strong>{label}</strong></span>
      <button className="btn-link" onClick={onClear}>Clear</button>
      {children}
    </div>
  );
}

interface Node { category?: string; subcategory?: string; playersId?: string; virtual?: boolean; subs?: Node[]; leaves?: Node[] }

// Where the filtered category's leaderboards live: its players page (by the
// tree node's playersId) and the Teams list ranked in it. Found by matching the
// URL's filter against the category tree the Categories page draws.
export function CategoryLeaderLinks() {
  const { slug, meta } = useSetCtx();
  const [params] = useSearchParams();
  const { data: tree } = useScopedJson<Node[]>("categories_tossup.json");
  const found = useMemo(() => {
    if (!tree) return null;
    const cat = params.get("category"), sub = params.get("subcategory"), subcats = params.get("subcats");
    const want = subcats ? subcats.split("|").map((x) => x.trim()).filter(Boolean).sort().join("|") : null;
    for (const g of tree) {
      const gKey = g.category || "";
      if (want && g.virtual && (g.subs || []).map((x) => x.subcategory || "").sort().join("|") === want) return { node: g, key: gKey };
      if ((cat && gKey === cat) || (sub && gKey === sub)) return { node: g, key: gKey };
    }
    for (const g of tree)
      for (const s of [...(g.subs || []), ...(g.subs || []).flatMap((x) => x.leaves || [])])
        if (sub && s.subcategory === sub && s.playersId) return { node: s, key: sub };
    return null;
  }, [tree, params]);
  if (!found?.node.playersId) return null;
  // Teams are ranked by main category, second level, and merged category.
  const teamsOk = !meta.individual && found.key.split(" - ").length <= 2;
  return (
    <span className="cat-leader-links">
      <Link className="link" to={`/set/${slug}/category/tossup/${found.node.playersId}/players`}>Top players</Link>
      {teamsOk && <> · <Link className="link" to={`/set/${slug}/team?subject=${encodeURIComponent(found.key)}`}>Top teams</Link></>}
    </span>
  );
}
