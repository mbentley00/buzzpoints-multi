import { useMemo, useState, Fragment, ReactNode } from "react";
import { useNameOrder, setNameOrder, nameKey, NameOrder } from "../nameOrder";

export interface Column<T> {
  key: string;
  label: string;
  /** value used for sorting; defaults to the rendered cell when it is a primitive */
  sortVal?: (row: T) => number | string | null;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  title?: string;
  /** The column a table is mostly read for (PPG on the players list): set off in bold on a light band. */
  emphasis?: boolean;
  /** A person's name: sorts by first name or surname, with a toggle in the header. */
  personName?: (row: T) => string;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  initialSort?: string;
  initialDir?: "asc" | "desc";
  rowKey: (row: T, i: number) => string;
  rowClass?: (row: T) => string;
  /** An extra row rendered directly under this one — an inline editor, say.
   *  Return null for rows that have none. It supplies its own <td>, so it can
   *  span the table however it likes. */
  expanded?: (row: T, i: number) => ReactNode;
}

export function DataTable<T>({
  rows,
  columns,
  initialSort,
  initialDir = "desc",
  rowKey,
  rowClass,
  expanded,
}: Props<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(initialSort);
  const [dir, setDir] = useState<"asc" | "desc">(initialDir);
  const order = useNameOrder();
  const valOf = (col: Column<T>) =>
    col.personName ? (r: T) => nameKey(col.personName!(r), order) : col.sortVal;

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    const sv = col && valOf(col);
    if (!sv) return rows;
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = sv(a);
      const vb = sv(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "number" && typeof vb === "number") return va - vb;
      return String(va).localeCompare(String(vb));
    });
    if (dir === "desc") arr.reverse();
    return arr;
  }, [rows, columns, sortKey, dir, order]);

  function clickHeader(col: Column<T>) {
    if (!valOf(col)) return;
    if (sortKey === col.key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setDir("desc");
    }
  }

  function pickOrder(col: Column<T>, o: NameOrder) {
    setNameOrder(o);
    if (sortKey !== col.key) { setSortKey(col.key); setDir("asc"); }
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                title={col.title}
                onClick={() => clickHeader(col)}
                className={`${valOf(col) ? "sortable" : ""} ${
                  col.align === "right" ? "right" : col.align === "center" ? "center" : ""
                }${col.emphasis ? " col-emph" : ""}`}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="sort-arrow">{dir === "asc" ? " ▲" : " ▼"}</span>
                )}
                {col.personName && (
                  <span className="name-order" onClick={(e) => e.stopPropagation()}>
                    {(["first", "last"] as const).map((o, i) => (
                      <Fragment key={o}>
                        {i > 0 && " · "}
                        <button type="button" className={order === o ? "on" : ""} onClick={() => pickOrder(col, o)}>
                          {o === "first" ? "First" : "Last"}
                        </button>
                      </Fragment>
                    ))}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const extra = expanded?.(row, i);
            return (
              <Fragment key={rowKey(row, i)}>
                <tr className={rowClass ? rowClass(row) : undefined}>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={
                        (col.align === "right" ? "right" : col.align === "center" ? "center" : "") + (col.emphasis ? " col-emph" : "")
                      }
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
                {extra && <tr className="buzz-edit-row">{extra}</tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="empty">No rows.</p>}
    </div>
  );
}
