import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { BonusRow, CatBonusRow, CatBonusSub, CatTossupRow, CatTossupSub, TossupRow } from "../types";
import { pct, num } from "../util";
import { CategoryGroups, CatColumn } from "../components/CategoryGroups";
import { MergeCategoriesEditor } from "../components/MergeCategoriesEditor";
import { PageHeader, Loading, ErrorBox } from "../components/Common";
import { CategoryMappingNotice } from "../components/CategoryMappingNotice";

// Tossups and bonuses side by side, one row per category. The two trees are
// built separately on the server, so they're joined here by name at every level.
interface Sub { subcategory: string; subLabel: string; leaves?: Sub[]; tu?: CatTossupSub; bn?: CatBonusSub }
interface Group { category: string; subs: Sub[]; virtual?: boolean; tu?: CatTossupRow; bn?: CatBonusRow }

function joinSubs(tu: CatTossupSub[] = [], bn: CatBonusSub[] = []): Sub[] {
  const out: Sub[] = [];
  const at = new Map<string, Sub>();
  const get = (subcategory: string, subLabel: string) => {
    let s = at.get(subcategory);
    if (!s) { s = { subcategory, subLabel }; at.set(subcategory, s); out.push(s); }
    return s;
  };
  for (const t of tu) get(t.subcategory, t.subLabel).tu = t;
  for (const b of bn) get(b.subcategory, b.subLabel).bn = b;
  for (const s of out) {
    const leaves = joinSubs(s.tu?.leaves, s.bn?.leaves);
    if (leaves.length) s.leaves = leaves;
  }
  return out;
}

function joinGroups(tu: CatTossupRow[], bn: CatBonusRow[]): Group[] {
  const out: Group[] = [];
  const at = new Map<string, Group>();
  const get = (category: string) => {
    let g = at.get(category);
    if (!g) { g = { category, subs: [] }; at.set(category, g); out.push(g); }
    return g;
  };
  for (const t of tu) { const g = get(t.category); g.tu = t; g.virtual ||= t.virtual; }
  for (const b of bn) { const g = get(b.category); g.bn = b; g.virtual ||= b.virtual; }
  for (const g of out) g.subs = joinSubs(g.tu?.subs, g.bn?.subs);
  return out;
}

// Distinct questions per category, from the question lists. A key counts the
// questions filed under it or anything beneath it.
type Q = { category: string; subcategory?: string };
function counter(qs: Q[] | null | undefined) {
  if (!qs) return null;
  const n = new Map<string, number>();
  const add = (k: string) => n.set(k, (n.get(k) ?? 0) + 1);
  for (const q of qs) {
    add(q.category);
    const parts = (q.subcategory || "").split(" - ");
    for (let i = 2; i <= parts.length; i++) add(parts.slice(0, i).join(" - "));
  }
  return { total: qs.length, of: (k: string) => n.get(k) ?? 0 };
}
type Count = ReturnType<typeof counter>;
const subCount = (c: Count, s: Sub) => (c ? c.of(s.subcategory) : null);
// A merged category isn't on the questions themselves; it holds what its parts hold.
const groupCount = (c: Count, g: Group): number | null =>
  !c ? null : g.category === "Overall" ? c.total : c.of(g.category) || g.subs.reduce((a, s) => a + c.of(s.subcategory), 0);

const buzz = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${num(v)}%`);
const blank = (v: unknown) => v === undefined;

export function Categories() {
  const { meta, isOwner } = useSetCtx();
  const { slug = "" } = useParams();
  const { data: tuCats, error, loading } = useScopedJson<CatTossupRow[]>("categories_tossup.json");
  const bnFile = meta.hasBonuses ? "categories_bonus.json" : "";
  const { data: bnCats, loading: bnLoading } = useScopedJson<CatBonusRow[]>(bnFile);
  const { data: tuTotals } = useScopedJson<CatTossupRow>("categories_tossup_overall.json");
  const { data: bnTotals } = useScopedJson<CatBonusRow>(meta.hasBonuses ? "categories_bonus_overall.json" : "");

  const { data: tossups } = useScopedJson<TossupRow[]>("tossups.json");
  const { data: bonuses } = useScopedJson<BonusRow[]>(meta.hasBonuses ? "bonuses.json" : "");
  const tuCount = useMemo(() => counter(tossups), [tossups]);
  const bnCount = useMemo(() => counter(bonuses), [bonuses]);

  const groups = useMemo(() => (tuCats ? joinGroups(tuCats, bnCats ?? []) : null), [tuCats, bnCats]);
  const overall = useMemo<Group | null>(
    () => (tuTotals ? { category: "Overall", subs: [], tu: { ...tuTotals, category: "Overall", subs: [], playersId: "" }, bn: bnTotals ? { ...bnTotals, category: "Overall", subs: [] } : undefined } : null),
    [tuTotals, bnTotals]
  );

  const playersLink = (id?: string) =>
    id ? <Link className="link" to={`/set/${slug}/category/tossup/${id}/players`}>players</Link> : null;

  const T = "Tossups", B = "Bonuses";
  const columns: CatColumn<Group, Sub>[] = [
    { key: "t-count", group: T, label: "Count", align: "right", title: "Tossups in this category",
      main: (g) => groupCount(tuCount, g) ?? "", sub: (s) => subCount(tuCount, s) ?? "", sortMain: (g) => groupCount(tuCount, g), sortSub: (s) => subCount(tuCount, s) },
    { key: "t-conv", group: T, label: "Conv%", align: "right", main: (g) => (blank(g.tu) ? "" : pct(g.tu!.convPct)), sub: (s) => (blank(s.tu) ? "" : pct(s.tu!.convPct)), sortMain: (g) => g.tu?.convPct ?? null, sortSub: (s) => s.tu?.convPct ?? null },
    ...(meta.hasPower
      ? [{ key: "t-pwr", group: T, label: "Pwr%", align: "right" as const, main: (g: Group) => (blank(g.tu) ? "" : pct(g.tu!.powerPct)), sub: (s: Sub) => (blank(s.tu) ? "" : pct(s.tu!.powerPct)), sortMain: (g: Group) => g.tu?.powerPct ?? null, sortSub: (s: Sub) => s.tu?.powerPct ?? null }]
      : []),
    { key: "t-inc", group: T, label: "Inc%", align: "right", main: (g) => (blank(g.tu) ? "" : pct(g.tu!.incorrectPct)), sub: (s) => (blank(s.tu) ? "" : pct(s.tu!.incorrectPct)), sortMain: (g) => g.tu?.incorrectPct ?? null, sortSub: (s) => s.tu?.incorrectPct ?? null },
    { key: "t-1st", group: T, label: "1st Sent%", align: "right", main: (g) => (blank(g.tu) ? "" : pct(g.tu!.firstSentConvPct)), sub: (s) => (blank(s.tu) ? "" : pct(s.tu!.firstSentConvPct)), sortMain: (g) => g.tu?.firstSentConvPct ?? null, sortSub: (s) => s.tu?.firstSentConvPct ?? null },
    { key: "t-2nd", group: T, label: "2nd Sent%", align: "right", main: (g) => (blank(g.tu) ? "" : pct(g.tu!.secondSentConvPct)), sub: (s) => (blank(s.tu) ? "" : pct(s.tu!.secondSentConvPct)), sortMain: (g) => g.tu?.secondSentConvPct ?? null, sortSub: (s) => s.tu?.secondSentConvPct ?? null },
    { key: "t-buzz", group: T, label: "Avg Buzz", align: "right", main: (g) => (blank(g.tu) ? "" : buzz(g.tu!.avgBuzzPct)), sub: (s) => (blank(s.tu) ? "" : buzz(s.tu!.avgBuzzPct)), sortMain: (g) => g.tu?.avgBuzzPct ?? null, sortSub: (s) => s.tu?.avgBuzzPct ?? null },
    { key: "t-players", group: T, label: "Players", align: "center", main: (g) => playersLink(g.tu?.playersId), sub: (s) => playersLink(s.tu?.playersId), overall: () => null },
    ...(meta.hasBonuses
      ? ([
          { key: "b-count", group: B, label: "Count", align: "right", title: "Bonuses in this category",
            main: (g) => groupCount(bnCount, g) ?? "", sub: (s) => subCount(bnCount, s) ?? "", sortMain: (g) => groupCount(bnCount, g), sortSub: (s) => subCount(bnCount, s) },
          { key: "b-ppb", group: B, label: "PPB", align: "right", main: (g) => (blank(g.bn) ? "" : num(g.bn!.ppb, 2)), sub: (s) => (blank(s.bn) ? "" : num(s.bn!.ppb, 2)), sortMain: (g) => g.bn?.ppb ?? null, sortSub: (s) => s.bn?.ppb ?? null },
          { key: "b-e", group: B, label: "Easy%", align: "right", main: (g) => (blank(g.bn) ? "" : pct(g.bn!.easyPct)), sub: (s) => (blank(s.bn) ? "" : pct(s.bn!.easyPct)), sortMain: (g) => g.bn?.easyPct ?? null, sortSub: (s) => s.bn?.easyPct ?? null },
          { key: "b-m", group: B, label: "Medium%", align: "right", main: (g) => (blank(g.bn) ? "" : pct(g.bn!.medPct)), sub: (s) => (blank(s.bn) ? "" : pct(s.bn!.medPct)), sortMain: (g) => g.bn?.medPct ?? null, sortSub: (s) => s.bn?.medPct ?? null },
          { key: "b-h", group: B, label: "Hard%", align: "right", main: (g) => (blank(g.bn) ? "" : pct(g.bn!.hardPct)), sub: (s) => (blank(s.bn) ? "" : pct(s.bn!.hardPct)), sortMain: (g) => g.bn?.hardPct ?? null, sortSub: (s) => s.bn?.hardPct ?? null },
        ] as CatColumn<Group, Sub>[])
      : []),
  ];

  return (
    <div>
      <PageHeader title="Categories" />
      <CategoryMappingNotice slug={slug} show={!!isOwner && !!meta.needsCategoryMapping} />
      {(loading || bnLoading) && <Loading />}
      {error && <ErrorBox error={error} />}
      {tuCats && !bnLoading && isOwner && <MergeCategoriesEditor slug={slug} groups={[...tuCats, ...(bnCats ?? [])]} />}
      {groups && !bnLoading && (
        <CategoryGroups groups={groups} columns={columns} linkBase={`/set/${slug}/tossup`} mainParam="category" subParam="subcategory" overall={overall} />
      )}
    </div>
  );
}
