import { CatBonusRow, CatTeamTossupRow } from "./types";

// team_rounds.json: each team's category tallies split by round and left raw, so
// the team page can re-total them over whichever rounds a reader picks. Written
// by api/_lib/aggregate.ts; the array layouts are documented there.
type TuRaw = [number, number, number, number, number, number, number | null, number, number];
type BnRaw = [number, number, Record<string, [number, number]>];
export interface TeamRoundLine { g: number; th: number; u: number; tu: Record<string, TuRaw>; bn?: Record<string, BnRaw> }
export interface TeamRounds {
  tuMain: Record<string, string>;
  bnMain: Record<string, string>;
  teams: Record<string, Record<string, TeamRoundLine>>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number, d: number) => (d ? round1((100 * n) / d) : 0);
const bpaOf = (unread: number, tuh: number) => (tuh > 0 ? round1((100 * unread) / tuh) : null);

type TuAcc = { powers: number; gets: number; incorrect: number; points: number; posSum: number; posN: number; earliest: number | null; unread: number; tuh: number };
type BnAcc = { heard: number; pts: number; parts: Map<string, [number, number]> };
const tuNew = (): TuAcc => ({ powers: 0, gets: 0, incorrect: 0, points: 0, posSum: 0, posN: 0, earliest: null, unread: 0, tuh: 0 });
const tuAdd = (a: TuAcc, s: TuAcc) => {
  a.powers += s.powers; a.gets += s.gets; a.incorrect += s.incorrect; a.points += s.points;
  a.posSum += s.posSum; a.posN += s.posN; a.unread += s.unread; a.tuh += s.tuh;
  if (s.earliest !== null) a.earliest = a.earliest === null ? s.earliest : Math.min(a.earliest, s.earliest);
};
const tuFin = (totalPts: number) => (a: TuAcc) => ({
  heard: a.powers + a.gets + a.incorrect, powers: a.powers, gets: a.gets, incorrect: a.incorrect, points: a.points,
  earliest: a.earliest === null ? null : a.earliest + 1, avgBuzz: a.posN ? round1(a.posSum / a.posN + 1) : null,
  pctPoints: totalPts ? round1((100 * a.points) / totalPts) : 0,
  bpa: bpaOf(a.unread, a.tuh),
});
const bnNew = (): BnAcc => ({ heard: 0, pts: 0, parts: new Map() });
const bnAdd = (a: BnAcc, s: BnAcc) => {
  a.heard += s.heard; a.pts += s.pts;
  for (const [d, gt] of s.parts) { const slot = a.parts.get(d) || [0, 0]; slot[0] += gt[0]; slot[1] += gt[1]; a.parts.set(d, slot); }
};
const diffPct = (parts: Map<string, [number, number]>, d: string) => { const [g, t] = parts.get(d) || [0, 0]; return t ? pct(g, t) : null; };
const bnFin = (a: BnAcc) => ({ heard: a.heard, ppb: a.heard ? Math.round((100 * a.pts) / a.heard) / 100 : 0, easyPct: diffPct(a.parts, "e"), medPct: diffPct(a.parts, "m"), hardPct: diffPct(a.parts, "h") });

// Main → "Main - Mid" → full path, mirroring buildCategoryTree in the aggregator
// so a filtered table has exactly the rows the season table does.
function levels(full: string): [string | null, string | null] {
  const parts = full.split(" - ").map((p) => p.trim());
  if (parts.length <= 1) return [null, null];
  return [`${parts[0]} - ${parts[1]}`, parts.length >= 3 ? full : null];
}
function buildTree<A>(subStats: Map<string, A>, mainOf: (sub: string) => string, newAcc: () => A, add: (a: A, s: A) => void, fin: (a: A) => Record<string, unknown>) {
  type Mid = { acc: A; gen: A; genHas: boolean; leaves: Map<string, A>; label: string };
  type Node = { acc: A; gen: A; genHas: boolean; mids: Map<string, Mid> };
  const mains = new Map<string, Node>();
  for (const [full, s] of subStats) {
    const m = mainOf(full);
    let node = mains.get(m);
    if (!node) { node = { acc: newAcc(), gen: newAcc(), genHas: false, mids: new Map() }; mains.set(m, node); }
    add(node.acc, s);
    const [mid, leaf] = levels(full);
    if (mid === null) { add(node.gen, s); node.genHas = true; continue; }
    let mnode = node.mids.get(mid);
    if (!mnode) { mnode = { acc: newAcc(), gen: newAcc(), genHas: false, leaves: new Map(), label: mid.split(" - ").slice(1).join(" - ") }; node.mids.set(mid, mnode); }
    add(mnode.acc, s);
    if (leaf === null) { add(mnode.gen, s); mnode.genHas = true; }
    else { let l = mnode.leaves.get(leaf); if (!l) { l = newAcc(); mnode.leaves.set(leaf, l); } add(l, s); }
  }
  const byLabel = (a: Record<string, any>, b: Record<string, any>) => a.subLabel.toLowerCase().localeCompare(b.subLabel.toLowerCase());
  const out: Record<string, any>[] = [];
  for (const [m, node] of mains) {
    const subs: Record<string, any>[] = [];
    for (const [mid, mnode] of node.mids) {
      const leaves: Record<string, any>[] = [];
      for (const [leaf, l] of mnode.leaves) leaves.push({ subcategory: leaf, subLabel: leaf.split(" - ").slice(-1)[0], ...fin(l) });
      if (mnode.genHas && leaves.length) leaves.push({ subcategory: mid, subLabel: "(general)", ...fin(mnode.gen) });
      leaves.sort(byLabel);
      subs.push({ subcategory: mid, subLabel: mnode.label, ...fin(mnode.acc), leaves });
    }
    if (node.genHas) subs.push({ subcategory: m, subLabel: "(general)", ...fin(node.gen), leaves: [] });
    subs.sort(byLabel);
    out.push({ category: m, ...fin(node.acc), subs });
  }
  out.sort((a, b) => b.heard - a.heard);
  return out;
}

const inRounds = (lines: Record<string, TeamRoundLine> | undefined, rounds: Set<number>) =>
  Object.entries(lines ?? {}).filter(([r]) => rounds.has(Number(r))).map(([, l]) => l);

function tuSubs(lines: TeamRoundLine[]) {
  const m = new Map<string, TuAcc>();
  for (const l of lines) for (const [sub, v] of Object.entries(l.tu)) {
    const a = m.get(sub) ?? tuNew();
    tuAdd(a, { powers: v[0], gets: v[1], incorrect: v[2], points: v[3], posSum: v[4], posN: v[5], earliest: v[6], unread: v[7], tuh: v[8] });
    m.set(sub, a);
  }
  return m;
}
function tossupTree(tr: TeamRounds, lines: TeamRoundLine[]) {
  const subs = tuSubs(lines);
  const total = [...subs.values()].reduce((a, s) => a + s.points, 0);
  return buildTree(subs, (s) => tr.tuMain[s] ?? s, tuNew, tuAdd, tuFin(total)) as CatTeamTossupRow[];
}

// Rank by points within each category node, against every team's tallies over
// the same rounds — the same rule the season table's rank uses.
function rankTrees(trees: Map<string, CatTeamTossupRow[]>) {
  const groups = new Map<string, { tid: string; points: number }[]>();
  const push = (k: string, tid: string, points: number) => { let a = groups.get(k); if (!a) groups.set(k, (a = [])); a.push({ tid, points }); };
  const walk = (cats: CatTeamTossupRow[], fn: (k: string, node: any) => void) => {
    for (const m of cats) {
      fn(`0|${m.category}`, m);
      for (const s of m.subs) { fn(`1|${s.subcategory}`, s); for (const lf of s.leaves ?? []) fn(`2|${lf.subcategory}`, lf); }
    }
  };
  for (const [tid, cats] of trees) walk(cats, (k, n) => push(k, tid, n.points));
  const ranks = new Map<string, { r: Map<string, number>; n: number }>();
  for (const [k, arr] of groups) {
    arr.sort((a, b) => b.points - a.points);
    const r = new Map<string, number>();
    let rank = 0, seen = 0, prev = NaN;
    for (const e of arr) { seen++; if (e.points !== prev) { rank = seen; prev = e.points; } r.set(e.tid, rank); }
    ranks.set(k, { r, n: arr.length });
  }
  return (tid: string, cats: CatTeamTossupRow[]) =>
    walk(cats, (k, n) => { const g = ranks.get(k); n.rank = g?.r.get(tid) ?? null; n.rankOf = g?.n ?? null; });
}

export interface TeamRoundView {
  games: number;
  tuh: number;
  bpa: number | null;
  categories: CatTeamTossupRow[];
  bonusCategories: CatBonusRow[];
}

export function teamRoundView(tr: TeamRounds, tid: string, rounds: Set<number>): TeamRoundView {
  const lines = inRounds(tr.teams[tid], rounds);
  const categories = tossupTree(tr, lines);
  // Ranks need every team's tree over these rounds, not just this one.
  const trees = new Map<string, CatTeamTossupRow[]>();
  for (const other of Object.keys(tr.teams)) trees.set(other, other === tid ? categories : tossupTree(tr, inRounds(tr.teams[other], rounds)));
  rankTrees(trees)(tid, categories);

  const bn = new Map<string, BnAcc>();
  for (const l of lines) for (const [sub, v] of Object.entries(l.bn ?? {})) {
    const a = bn.get(sub) ?? bnNew();
    bnAdd(a, { heard: v[0], pts: v[1], parts: new Map(Object.entries(v[2])) });
    bn.set(sub, a);
  }
  const bonusCategories = buildTree(bn, (s) => tr.bnMain[s] ?? s, bnNew, bnAdd, bnFin) as CatBonusRow[];
  const games = lines.reduce((a, l) => a + l.g, 0);
  const tuh = lines.reduce((a, l) => a + l.th, 0);
  return { games, tuh, bpa: bpaOf(lines.reduce((a, l) => a + l.u, 0), tuh), categories, bonusCategories };
}
