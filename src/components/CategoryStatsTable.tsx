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
    { key: "gets", label: "Get", align: "right", sortVal: (c) => c.gets, render: (c) => c.gets, title: "Correct (non-power)" },
    { key: "inc", label: incLabel, align: "right", sortVal: (c) => c.incorrect, render: (c) => c.incorrect, title: "Incorrect buzzes" },
    { key: "pts", label: "Points", align: "right", sortVal: (c) => c.points, render: (c) => c.points },
    {
      key: "earliest",
      label: "Earliest Buzz",
      align: "right",
      sortVal: (c) => c.earliest ?? 1e9,
      render: (c) => (c.earliest === null ? "—" : c.earliest),
      title: "Earliest word position of a correct buzz in this category",
    },
    {
      key: "avg",
      label: "Avg Buzz",
      align: "right",
      sortVal: (c) => c.avgBuzz ?? 1e9,
      render: (c) => (c.avgBuzz === null ? "—" : num(c.avgBuzz)),
      title: "Average word position of correct buzzes",
    },
    {
      key: "bpa",
      label: "BPA",
      align: "right",
      sortVal: (c) => c.bpa ?? -1,
      render: (c) => num(c.bpa),
      title: "Buzz point area-under-the-curve, over the tossups heard in this category — so it compares with the overall figure rather than being diluted by everything else read",
    },
    {
      key: "pct",
      label: "% of Points",
      align: "right",
      sortVal: (c) => c.pctPoints,
      render: (c) => num(c.pctPoints, 1),
      title: "Share of this player's tossup points from this category",
    },
  ];

  return <DataTable rows={rows} columns={columns} initialSort="pts" initialDir="desc" rowKey={(c) => c.category} />;
}
