import { Fragment, ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { CategoryTag } from "../util";

interface SubBase {
  subcategory: string;
  subLabel: string;
  leaves?: SubBase[];
}
interface GroupBase<S> {
  category: string;
  subs: S[];
  virtual?: boolean;
}

export interface CatColumn<G, S> {
  label: string;
  align?: "right" | "center";
  main: (g: G) => ReactNode;
  sub: (s: S) => ReactNode;
  title?: string;
  /** Value to sort a category row by. Defaults to the rendered cell when that
   *  is a plain number or string — which is wrong for a cell rendered as "—" or
   *  "12.3%", so any column that formats its value should say so here. */
  sortMain?: (g: G) => number | string | null;
  /** The same for subcategory and leaf rows. */
  sortSub?: (s: S) => number | string | null;
}

interface Props<G extends GroupBase<S>, S extends SubBase> {
  groups: G[];
  columns: CatColumn<G, S>[];
  linkBase: string; // e.g. /set/pace-nsc-2026/tossup
  mainParam: string; // "category"
  subParam: string; // "subcategory"
}

function alignClass(a?: "right" | "center") {
  return a === "right" ? "right" : a === "center" ? "center" : "";
}

// A cell's sort value, falling back to what it renders when that's already a
// primitive. Anything else (a link, a badge) can't be ordered, so it sorts last.
const primitive = (v: ReactNode): number | string | null =>
  typeof v === "number" || typeof v === "string" ? v : null;

// Nulls last in both directions, so "no data" never displaces a real value at
// the top of the table.
function cmp(a: number | string | null, b: number | string | null): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}
// `dir` flips the comparison rather than reversing the array, so nulls stay at
// the bottom either way instead of being carried to the top.
const dirCmp = (dir: "asc" | "desc") => (a: number | string | null, b: number | string | null) => {
  const n = cmp(a, b);
  return dir === "asc" ? n : -n;
};

export function CategoryGroups<G extends GroupBase<S>, S extends SubBase>({
  groups,
  columns,
  linkBase,
  mainParam,
  subParam,
}: Props<G, S>) {
  const [openMains, setOpenMains] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((g) => [g.category, true]))
  );
  const [openSubs, setOpenSubs] = useState<Record<string, boolean>>({});
  // Unsorted until asked: the server's order is meaningful (categories come in
  // the set's own arrangement, merged ones first), so it stays until a header
  // is clicked. The Category column sorts by name and is keyed "".
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  // A set that files everything under a bare subject gives each category one
  // "(general)" child repeating the category's own numbers. There's nothing to
  // drill into, so the category row stands alone and is itself the link.
  const flat = (g: G) =>
    g.subs.length === 1 && g.subs[0].subcategory === g.category && !g.subs[0].leaves?.length;
  const allOpen =
    groups.every((g) => openMains[g.category]) &&
    groups.every((g) => g.subs.every((s) => !s.leaves?.length || openSubs[s.subcategory]));

  // Sorting a nested table means sorting every level by the same column, so a
  // category and the subcategories inside it are ordered on the same footing.
  const sortCol = sortKey === null ? null : columns.find((c) => c.label === sortKey);
  const byName = sortKey === "";
  const sorted = (() => {
    if (sortKey === null) return groups;
    const cmpDir = dirCmp(dir);
    const mainVal = (g: G) => (byName ? g.category : sortCol ? sortCol.sortMain?.(g) ?? primitive(sortCol.main(g)) : null);
    const subVal = (x: S) => (byName ? x.subLabel : sortCol ? sortCol.sortSub?.(x) ?? primitive(sortCol.sub(x)) : null);
    const sortSubs = (list: S[]): S[] =>
      [...list]
        .sort((a, b) => cmpDir(subVal(a), subVal(b)))
        .map((x) => (x.leaves?.length ? { ...x, leaves: sortSubs(x.leaves as S[]) } : x));
    return [...groups]
      .sort((a, b) => cmpDir(mainVal(a), mainVal(b)))
      .map((g) => ({ ...g, subs: sortSubs(g.subs) }));
  })();

  function clickHeader(key: string, sortable: boolean) {
    if (!sortable) return;
    if (sortKey === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    // A name sorts A-Z first; a measurement is far more often wanted biggest-first.
    else { setSortKey(key); setDir(key === "" ? "asc" : "desc"); }
  }
  const arrow = (key: string) =>
    sortKey === key ? <span className="sort-arrow">{dir === "asc" ? " ▲" : " ▼"}</span> : null;

  const setAll = (v: boolean) => {
    setOpenMains(Object.fromEntries(groups.map((g) => [g.category, v])));
    const subs: Record<string, boolean> = {};
    groups.forEach((g) => g.subs.forEach((s) => (subs[s.subcategory] = v)));
    setOpenSubs(subs);
  };

  return (
    <div>
      <div className="cat-toolbar">
        {/* Nothing anywhere to expand — don't offer a button that does nothing. */}
        {!groups.every(flat) && (
          <button className="mini-btn" onClick={() => setAll(!allOpen)}>
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
        <span className="muted">
          {groups.every(flat)
            ? "Click any category to see its questions."
            : "Click any category, subcategory, or sub-subcategory to see its questions."}
        </span>
      </div>
      <div className="table-wrap">
        <table className="data-table cat-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => clickHeader("", true)}>Category{arrow("")}</th>
              {columns.map((c) => {
                // A column can be sorted unless what it renders is neither a
                // number nor a string and it hasn't said how to order it.
                const sortable = !!c.sortMain || (groups.length > 0 && primitive(c.main(groups[0])) !== null);
                return (
                  <th
                    key={c.label}
                    className={`${alignClass(c.align)} ${sortable ? "sortable" : ""}`}
                    title={c.title}
                    onClick={() => clickHeader(c.label, sortable)}
                  >
                    {c.label}{arrow(c.label)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((g) => (
              <Fragment key={g.category}>
                <tr className="cat-main-row">
                  <td>
                    {flat(g) ? (
                      <span className="caret-spacer" />
                    ) : (
                      <button
                        className="caret"
                        onClick={() => setOpenMains((o) => ({ ...o, [g.category]: !o[g.category] }))}
                        aria-label="toggle"
                      >
                        {openMains[g.category] ? "▾" : "▸"}
                      </button>
                    )}
                    <Link
                      className="cat-main-link"
                      to={
                        g.virtual
                          ? `${linkBase}?subcats=${encodeURIComponent(g.subs.map((s) => s.subcategory).join("|"))}`
                          : `${linkBase}?${mainParam}=${encodeURIComponent(g.category)}`
                      }
                    >
                      <CategoryTag cat={g.category} />
                    </Link>
                    {g.virtual && <span className="cat-virtual-badge" title="Owner-defined merged category">merged</span>}
                  </td>
                  {columns.map((c) => (
                    <td key={c.label} className={alignClass(c.align) + " strong"}>
                      {c.main(g)}
                    </td>
                  ))}
                </tr>
                {openMains[g.category] &&
                  !flat(g) &&
                  g.subs.map((s) => {
                    const hasLeaves = !!s.leaves?.length;
                    const open = openSubs[s.subcategory];
                    return (
                      <Fragment key={s.subcategory}>
                        <tr className="cat-sub-row">
                          <td>
                            {hasLeaves ? (
                              <button
                                className="caret caret-sub"
                                onClick={() =>
                                  setOpenSubs((o) => ({ ...o, [s.subcategory]: !o[s.subcategory] }))
                                }
                                aria-label="toggle"
                              >
                                {open ? "▾" : "▸"}
                              </button>
                            ) : (
                              <span className="caret-spacer" />
                            )}
                            <Link
                              className="cat-sub-link"
                              to={`${linkBase}?${subParam}=${encodeURIComponent(s.subcategory)}`}
                            >
                              {s.subLabel}
                            </Link>
                          </td>
                          {columns.map((c) => (
                            <td key={c.label} className={alignClass(c.align)}>
                              {c.sub(s)}
                            </td>
                          ))}
                        </tr>
                        {hasLeaves &&
                          open &&
                          s.leaves!.map((lf) => (
                            <tr className="cat-leaf-row" key={lf.subcategory}>
                              <td>
                                <Link
                                  className="cat-leaf-link"
                                  to={`${linkBase}?${subParam}=${encodeURIComponent(lf.subcategory)}`}
                                >
                                  {lf.subLabel}
                                </Link>
                              </td>
                              {columns.map((c) => (
                                <td key={c.label} className={alignClass(c.align)}>
                                  {c.sub(lf as S)}
                                </td>
                              ))}
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
