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
  const allOpen =
    groups.every((g) => openMains[g.category]) &&
    groups.every((g) => g.subs.every((s) => !s.leaves?.length || openSubs[s.subcategory]));

  const setAll = (v: boolean) => {
    setOpenMains(Object.fromEntries(groups.map((g) => [g.category, v])));
    const subs: Record<string, boolean> = {};
    groups.forEach((g) => g.subs.forEach((s) => (subs[s.subcategory] = v)));
    setOpenSubs(subs);
  };

  return (
    <div>
      <div className="cat-toolbar">
        <button className="mini-btn" onClick={() => setAll(!allOpen)}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
        <span className="muted">Click any category, subcategory, or sub-subcategory to see its questions.</span>
      </div>
      <div className="table-wrap">
        <table className="data-table cat-table">
          <thead>
            <tr>
              <th>Category</th>
              {columns.map((c) => (
                <th key={c.label} className={alignClass(c.align)} title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.category}>
                <tr className="cat-main-row">
                  <td>
                    <button
                      className="caret"
                      onClick={() => setOpenMains((o) => ({ ...o, [g.category]: !o[g.category] }))}
                      aria-label="toggle"
                    >
                      {openMains[g.category] ? "▾" : "▸"}
                    </button>
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
