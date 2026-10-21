import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useScopedJson, useSetCtx } from "../components/Layout";
import { CatBonusRow, CatBonusSub, CatTossupRow } from "../types";
import { pct, num } from "../util";
import { CategoryGroups, CatColumn } from "../components/CategoryGroups";
import { PageHeader, Loading, ErrorBox } from "../components/Common";
import { CategoryMappingNotice } from "../components/CategoryMappingNotice";
import { MergeCategoriesEditor } from "../components/MergeCategoriesEditor";

export function CategoriesBonus() {
  const { slug = "" } = useParams();
  const { meta, isOwner } = useSetCtx();
  const { data, error, loading } = useScopedJson<CatBonusRow[]>("categories_bonus.json");
  const { data: tuCats } = useScopedJson<CatTossupRow[]>("categories_tossup.json");
  const { data: totals, loading: totalsLoading } = useScopedJson<CatBonusRow>("categories_bonus_overall.json");
  const overall = useMemo<CatBonusRow | null>(() => {
    if (totalsLoading || !data?.length) return null;
    if (totals) return { ...totals, category: "Overall", subs: [] };
    // Built before the totals file existed: the rounded rates can't be summed
    // back exactly, so only Heard. Merged categories could share members.
    if (data.some((g) => g.virtual)) return null;
    return {
      category: "Overall", subs: [], heard: data.reduce((a, g) => a + g.heard, 0),
      ppb: null, easyPct: null, medPct: null, hardPct: null,
    } as unknown as CatBonusRow;
  }, [data, totals, totalsLoading]);

  const columns: CatColumn<CatBonusRow, CatBonusSub>[] = [
    { label: "Heard", align: "right", main: (g) => g.heard, sub: (s) => s.heard },
    { label: "PPB", align: "right", main: (g) => num(g.ppb, 2), sub: (s) => num(s.ppb, 2), sortMain: (g) => g.ppb, sortSub: (s) => s.ppb },
    { label: "Easy%", align: "right", main: (g) => pct(g.easyPct), sub: (s) => pct(s.easyPct), sortMain: (g) => g.easyPct, sortSub: (s) => s.easyPct },
    { label: "Medium%", align: "right", main: (g) => pct(g.medPct), sub: (s) => pct(s.medPct), sortMain: (g) => g.medPct, sortSub: (s) => s.medPct },
    { label: "Hard%", align: "right", main: (g) => pct(g.hardPct), sub: (s) => pct(s.hardPct), sortMain: (g) => g.hardPct, sortSub: (s) => s.hardPct },
  ];

  return (
    <div>
      <PageHeader title="Categories — Bonuses" />
      <CategoryMappingNotice slug={slug} show={!!isOwner && !!meta.needsCategoryMapping} />
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && tuCats && isOwner && <MergeCategoriesEditor slug={slug} groups={[...tuCats, ...data]} />}
      {data && <CategoryGroups groups={data} columns={columns} linkBase={`/set/${slug}/bonus`} mainParam="category" subParam="subcategory" overall={overall} />}
    </div>
  );
}
