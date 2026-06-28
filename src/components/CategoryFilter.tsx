import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

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

export function CategoryFilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="cat-filter-chip">
      <span>Filtered to <strong>{label}</strong></span>
      <button className="btn-link" onClick={onClear}>Clear</button>
    </div>
  );
}
