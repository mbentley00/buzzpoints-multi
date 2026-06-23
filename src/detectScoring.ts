// Best-effort scoring-format detection from the distinct buzz values in the
// uploaded QBJ game files. Returns a format id or null if it can't tell.
export function detectScoring(games: { json: any }[]): string | null {
  const vals = new Set<number>();
  for (const g of games) {
    for (const mq of g.json?.match_questions || []) {
      for (const bz of mq.buzzes || []) {
        const v = bz?.result?.value;
        if (typeof v === "number") vals.add(v);
      }
    }
  }
  if (vals.size === 0) return null;
  const has = (n: number) => vals.has(n);
  const hasNeg = [...vals].some((v) => v < 0);
  const maxPos = Math.max(0, ...[...vals].filter((v) => v > 0));

  if (has(20) && has(15)) return "SUPERPOWER"; // 20 / 15 / 10 / -5
  if (has(20) && hasNeg) return "SUPERPOWER"; // powers at 20 with negs but 15 unseen
  if (has(20)) return "PACE"; // 20 / 10 / 0, no negs
  if (has(15) || maxPos === 15) return "mACF"; // 15 / 10 / -5
  if (maxPos === 10) return "ACF"; // 10 / -5
  return null;
}
