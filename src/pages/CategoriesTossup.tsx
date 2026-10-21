import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useSetCtx, useScopedJson } from "../components/Layout";
import { CatBonusRow, CatTossupRow, CatTossupSub } from "../types";
import { pct, num } from "../util";
import { CategoryGroups, CatColumn } from "../components/CategoryGroups";
import { MergeCategoriesEditor } from "../components/MergeCategoriesEditor";
import { PageHeader, Loading, ErrorBox } from "../components/Common";
import { CategoryMappingNotice } from "../components/CategoryMappingNotice";

const buzz = (v: number | null) => (v === null ? "—" : `${num(v)}%`);

export function CategoriesTossup() {
  const { meta, isOwner } = useSetCtx();
  const { slug = "" } = useParams();
  const { data, error, loading } = useScopedJson<CatTossupRow[]>("categories_tossup.json");
  const { data: bnCats, loading: bnLoading } = useScopedJson<CatBonusRow[]>("categories_bonus.json");
  const { data: totals, loading: totalsLoading } = useScopedJson<CatTossupRow>("categories_tossup_overall.json");
  const overall = useMemo<CatTossupRow | null>(() => {
    if (totalsLoading || !data?.length) return null;
    if (totals) return { ...totals, category: "Overall", subs: [], playersId: "" };
    // Built before the totals file existed: only what the raw counts give
    // exactly. Merged categories could share members, so skip them then.
    if (data.some((g) => g.virtual)) return null;
    const heard = data.reduce((a, g) => a + g.heard, 0);
    const powers = data.reduce((a, g) => a + g.powers, 0);
    const gets = data.reduce((a, g) => a + g.gets, 0);
    const r = (n: number) => (heard ? Math.round((1000 * n) / heard) / 10 : 0);
    return {
      category: "Overall", subs: [], playersId: "", heard, powers, gets,
      convPct: r(powers + gets), powerPct: r(powers),
      avgBuzzPct: null, firstSentConvPct: null, secondSentConvPct: null, incorrectPct: null,
    } as unknown as CatTossupRow;
  }, [data, totals, totalsLoading]);

  const playersLink = (id: string) => (
    <Link className="link" to={`/set/${slug}/category/tossup/${id}/players`}>players</Link>
  );

  const columns: CatColumn<CatTossupRow, CatTossupSub>[] = [
    { label: "Heard", align: "right", main: (g) => g.heard, sub: (s) => s.heard },
    { label: "Conv%", align: "right", main: (g) => pct(g.convPct), sub: (s) => pct(s.convPct), sortMain: (g) => g.convPct, sortSub: (s) => s.convPct },
    ...(meta.hasPower
      ? [{ label: "Pwr%", align: "right" as const, main: (g: CatTossupRow) => pct(g.powerPct), sub: (s: CatTossupSub) => pct(s.powerPct), sortMain: (g: CatTossupRow) => g.powerPct, sortSub: (s: CatTossupSub) => s.powerPct }]
      : []),
    { label: "Inc%", align: "right", title: "Rate of interrupting incorrect buzzes per play", main: (g) => pct(g.incorrectPct), sub: (s) => pct(s.incorrectPct), sortMain: (g) => g.incorrectPct, sortSub: (s) => s.incorrectPct },
    { label: "1st Sent%", align: "right", title: "Share of plays converted by a correct buzz within the first sentence", main: (g) => pct(g.firstSentConvPct), sub: (s) => pct(s.firstSentConvPct), sortMain: (g) => g.firstSentConvPct, sortSub: (s) => s.firstSentConvPct },
    { label: "2nd Sent%", align: "right", title: "Share of plays converted by the end of the second sentence", main: (g) => pct(g.secondSentConvPct), sub: (s) => pct(s.secondSentConvPct), sortMain: (g) => g.secondSentConvPct, sortSub: (s) => s.secondSentConvPct },
    { label: "Avg Buzz", align: "right", main: (g) => buzz(g.avgBuzzPct), sub: (s) => buzz(s.avgBuzzPct), sortMain: (g) => g.avgBuzzPct, sortSub: (s) => s.avgBuzzPct },
    { label: "Players", align: "center", title: "How players did in this category", main: (g) => playersLink(g.playersId), sub: (s) => playersLink(s.playersId), overall: () => null },
  ];

  return (
    <div>
      <PageHeader title="Categories — Tossups" subtitle="Conversion & buzz speed by subject" />
      <CategoryMappingNotice slug={slug} show={!!isOwner && !!meta.needsCategoryMapping} />
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && !bnLoading && isOwner && <MergeCategoriesEditor slug={slug} groups={[...data, ...(bnCats ?? [])]} />}
      {data && <CategoryGroups groups={data} columns={columns} linkBase={`/set/${slug}/tossup`} mainParam="category" subParam="subcategory" overall={overall} />}
    </div>
  );
}
