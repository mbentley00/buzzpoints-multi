import { CategoryStat } from "../types";
import { num } from "../util";
import { DataTable, Column } from "./DataTable";

// Per-category tossup breakdown for a player. `hasPower` hides the power column
// for formats without powers; `incLabel` adapts the incorrect column (neg vs 0).
export function CategoryStatsTable({
  rows,
  hasPower = true,
  incLabel = "Inc",
}: {
  rows: CategoryStat[];
  hasPower?: boolean;
  incLabel?: string;
}) {
  const columns: Column<CategoryStat>[] = [
    {
      key: "cat",
      label: "Category",
      sortVal: (c) => c.category.toLowerCase(),
      render: (c) => <span className="cat-tag">{c.category}</span>,
    },
    ...(hasPower
      ? [{ key: "powers", label: "Pwr", align: "right" as const, sortVal: (c: CategoryStat) => c.powers, render: (c: CategoryStat) => c.powers, title: "Powers" }]
      : []),
    { key: "gets", label: "Get", align: "right", sortVal: (c) => c.gets, render: (c) => c.gets },
    { key: "inc", label: incLabel, align: "right", sortVal: (c) => c.incorrect, render: (c) => c.incorrect, title: "Incorrect buzzes" },
    { key: "pts", label: "Points", align: "right", sortVal: (c) => c.points, render: (c) => c.points },
    {
      key: "earliest",
      label: "Earliest Buzz",
      align: "right",
      sortVal: (c) => c.earliest ?? 1e9,
      render: (c) => (c.earliest === null ? "—" : c.earliest),
      title: "Word #",
    },
    {
      key: "avg",
      label: "Avg Buzz",
      align: "right",
      sortVal: (c) => c.avgBuzz ?? 1e9,
      render: (c) => (c.avgBuzz === null ? "—" : num(c.avgBuzz)),
      title: "Word #",
    },
    {
      key: "bpa",
      label: "BPA",
      align: "right",
      sortVal: (c) => c.bpa ?? -1,
      render: (c) => num(c.bpa),
      title: "Buzz point area under the curve",
    },
    {
      key: "pct",
      label: "% of Points",
      align: "right",
      sortVal: (c) => c.pctPoints,
      render: (c) => num(c.pctPoints, 1),
    },
  ];

  return <DataTable rows={rows} columns={columns} initialSort="pts" initialDir="desc" rowKey={(c) => c.category} />;
}
