import { Fragment, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { BonusOrderRow, BonusOrderCat, BonusOrderStats } from "../types";
import { num, pct } from "../util";
import { PageHeader, Loading, ErrorBox } from "../components/Common";

// Conversion by the ORDER a bonus presents its difficulties in — "hem" for
// hard-easy-medium against "meh" for medium-easy-hard. The comparison worth
// making is one difficulty read DOWN a column: whether a set's hard parts
// converted differently depending on where in the bonus they sat. Every row
// therefore reports the same easy/medium/hard figures however they're ordered,
// with the per-position columns alongside to show what that order actually was.
//
// Each row opens into its categories and then subcategories, because a format
// rarely plays the same way across subjects — the hard part of a hem science
// bonus is not the hard part of a hem literature bonus.

const cell = (v: number | null) => (v === null ? <span className="muted">—</span> : pct(v));

// The order as coloured initials, so the shape of a format is readable at a
// glance next to its name.
function OrderMarks({ order }: { order: string }) {
  return (
    <span className="ord-marks">
      {[...order].map((c, i) => (
        <span key={i} className={`ord-mark ord-mark-${c === "?" ? "u" : c}`}>{c === "?" ? "?" : c.toUpperCase()}</span>
      ))}
    </span>
  );
}

// The conversion figures always read easy, then medium, then hard — never the
// order's own sequence. These are the numbers you compare BETWEEN orders, and
// they only compare if they sit in the same place in every one of them; listing
// an MEH bonus as medium-easy-hard and an HEM one as hard-easy-medium meant
// reading two rows in different directions to compare one difficulty. The
// sequence itself is still right there in the marks beside the name, and the
// numbered columns below say exactly where each part sat.
const DIFF_SLOTS = [
  { key: "e", mark: "E", label: "Easy" },
  { key: "m", mark: "M", label: "Medium" },
  { key: "h", mark: "H", label: "Hard" },
  { key: "u", mark: "?", label: "Unmarked" },
] as const;
const slotPct = (s: BonusOrderStats, key: string) =>
  key === "e" ? s.easyPct : key === "m" ? s.medPct : key === "h" ? s.hardPct : s.unmarkedPct ?? null;

function DiffPcts({ s }: { s: BonusOrderStats }) {
  return (
    <span className="ord-parts">
      {DIFF_SLOTS.filter((d) => slotPct(s, d.key) !== null).map((d) => (
        <span className="ord-part" key={d.key} title={`${d.label} part${d.key === "u" ? "s with no mark" : "s"} of this order`}>
          <span className={`ord-mark ord-mark-${d.key}`}>{d.mark}</span>
          <span className="ord-part-pct">{cell(slotPct(s, d.key))}</span>
        </span>
      ))}
    </span>
  );
}

function StatCells({ s, unmarked }: { s: BonusOrderStats; unmarked: boolean }) {
  return (
    <>
      <td className="right mono">{s.bonuses}</td>
      <td className="right mono">{s.heard}</td>
      <td className="right mono">{num(s.ppb, 2)}</td>
      <td className="right mono">{cell(s.easyPct)}</td>
      <td className="right mono">{cell(s.medPct)}</td>
      <td className="right mono">{cell(s.hardPct)}</td>
      {unmarked && <td className="right mono">{cell(s.unmarkedPct ?? null)}</td>}
      {s.parts.map((p) => (
        <td key={p.idx} className="right mono" title={`Part ${p.idx + 1} — ${p.difficultyName}`}>{cell(p.convPct)}</td>
      ))}
    </>
  );
}

// One order, with its categories folded away until asked for.
function OrderTable({ row }: { row: BonusOrderRow }) {
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  const maxParts = row.parts.length;
  // Only orders that actually contain an unmarked part get the column for it.
  const unmarked = row.order.includes("?");
  return (
    <div className="table-wrap">
      <table className="data-table ord-table">
        <thead>
          <tr>
            <th>Category</th>
            <th className="right">Bonuses</th>
            <th className="right">Heard</th>
            <th className="right">PPB</th>
            <th className="right" title="Conversion of this order's easy part(s)">Easy%</th>
            <th className="right" title="Conversion of this order's medium part(s)">Med%</th>
            <th className="right" title="Conversion of this order's hard part(s)">Hard%</th>
            {unmarked && <th className="right" title="Conversion of the part(s) this order leaves unmarked">?%</th>}
            {row.parts.map((p) => (
              <th key={p.idx} className="right" title={`Part ${p.idx + 1} of the bonus — ${p.difficultyName} in this order`}>
                {p.idx + 1}. {p.difficultyName.charAt(0) || "?"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="ord-total">
            <td><strong>All categories</strong></td>
            <StatCells s={row} unmarked={unmarked} />
          </tr>
          {row.categories.map((c: BonusOrderCat) => {
            const open = !!openCats[c.category];
            return (
              <Fragment key={c.category}>
                <tr className="ord-cat">
                  <td>
                    <button className="btn-link" onClick={() => setOpenCats((o) => ({ ...o, [c.category]: !open }))}>
                      {open ? "▾" : "▸"} {c.category}
                    </button>
                  </td>
                  <StatCells s={c} unmarked={unmarked} />
                </tr>
                {open &&
                  c.subs.map((sub) => (
                    <tr key={`${c.category}|${sub.subcategory}`} className="ord-sub">
                      <td className="ord-sub-name">{sub.subLabel}</td>
                      <StatCells s={sub} unmarked={unmarked} />
                    </tr>
                  ))}
              </Fragment>
            );
          })}
          {row.categories.length === 0 && (
            <tr><td colSpan={7 + (unmarked ? 1 : 0) + maxParts} className="muted">No categories.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function BonusOrders() {
  const { meta, isOwner } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<BonusOrderRow[]>("bonus_orders.json");
  const [open, setOpen] = useState<string | null>(null);

  if (loading) return <Loading />;
  // This file only exists once a set has been rebuilt since the view was added,
  // so a missing one means "not built yet", not "something went wrong".
  if (error && /404/.test(error))
    return (
      <div className="detail">
        <div className="breadcrumb"><Link to={`/set/${slug}/bonus`} className="link">← Bonuses</Link></div>
        <PageHeader title="Bonuses — Difficulty order" subtitle="How each bonus format converted" />
        <p className="caveat">
          This tournament hasn't been rebuilt since this view was added.{" "}
          {isOwner
            ? <>Run <Link to={`/set/${slug}/settings`} className="link">Rebuild stats</Link> in Settings and it will appear.</>
            : "Its owner can rebuild its stats to add it."}
        </p>
      </div>
    );
  if (error) return <ErrorBox error={error} />;
  const rows = data ?? [];
  // Only worth comparing orders when the set actually used more than one.
  const single = rows.length === 1;

  return (
    <div className="detail">
      <div className="breadcrumb"><Link to={`/set/${slug}/bonus`} className="link">← Bonuses</Link></div>
      <PageHeader
        title="Bonuses — Difficulty order"
        subtitle="How each bonus format converted, and whether a part played to its billing"
      />
      <p className="explainer">
        Bonuses grouped by the order they present their difficulties in — <strong>HEM</strong> is hard, easy, medium.
        Every percentage reads <strong>easy, then medium, then hard</strong>, whichever order the format itself uses, so
        the same billing lines up down the page: whether the hard part of an <strong>HEM</strong> bonus really played
        harder than the hard part of an <strong>MEH</strong> one. The marks beside each name are the order's own
        sequence, and the numbered columns are the positions in the bonus, so you can still see where each difficulty
        actually sat. Open an order to break it down by category, and a category to reach its subcategories.
        {meta.hasTeamBonuses === false && " Conversion here comes from the imported per-part totals."}
      </p>
      {rows.length === 0 && (
        <p className="muted">
          No bonus difficulty marks in this tournament, so there are no orders to compare.{" "}
          <Link to={`/set/${slug}/bonus`} className="link">Bonuses →</Link>
        </p>
      )}
      {single && (
        <p className="caveat">
          Every bonus here uses the same order, so there's nothing to compare it against — the breakdown by category is
          still below.
        </p>
      )}
      {rows.map((row) => {
        const isOpen = open === row.order || rows.length === 1;
        return (
          <section className="ord-section" key={row.order}>
            <h2 className="ord-head">
              <button className="btn-link" onClick={() => setOpen(isOpen && rows.length > 1 ? null : row.order)}>
                {rows.length > 1 ? (isOpen ? "▾ " : "▸ ") : ""}
                <OrderMarks order={row.order} /> {row.label}
              </button>
              <span className="muted ord-sum">
                {row.bonuses} bonus{row.bonuses === 1 ? "" : "es"} · {row.heard} heard · {num(row.ppb, 2)} PPB
              </span>
              {/* Easy, medium, hard — in that order in every section, so the
                  collapsed list can be read straight down one difficulty. */}
              <DiffPcts s={row} />
            </h2>
            {isOpen && <OrderTable row={row} />}
          </section>
        );
      })}
    </div>
  );
}
