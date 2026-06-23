import { useMemo, useState, ReactNode } from "react";

export interface Column<T> {
  key: string;
  label: string;
  /** value used for sorting; defaults to the rendered cell when it is a primitive */
  sortVal?: (row: T) => number | string | null;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  title?: string;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  initialSort?: string;
  initialDir?: "asc" | "desc";
  rowKey: (row: T, i: number) => string;
  rowClass?: (row: T) => string;
}

export function DataTable<T>({
  rows,
  columns,
  initialSort,
  initialDir = "desc",
  rowKey,
  rowClass,
}: Props<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(initialSort);
  const [dir, setDir] = useState<"asc" | "desc">(initialDir);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col || !col.sortVal) return rows;
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = col.sortVal!(a);
      const vb = col.sortVal!(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "number" && typeof vb === "number") return va - vb;
      return String(va).localeCompare(String(vb));
    });
    if (dir === "desc") arr.reverse();
    return arr;
  }, [rows, columns, sortKey, dir]);

  function clickHeader(col: Column<T>) {
    if (!col.sortVal) return;
    if (sortKey === col.key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setDir("desc");
    }
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
                className={`${col.sortVal ? "sortable" : ""} ${
                  col.align === "right" ? "right" : col.align === "center" ? "center" : ""
                }`}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="sort-arrow">{dir === "asc" ? " ▲" : " ▼"}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={rowKey(row, i)} className={rowClass ? rowClass(row) : undefined}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={
                    col.align === "right" ? "right" : col.align === "center" ? "center" : ""
                  }
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="empty">No rows.</p>}
    </div>
  );
}
