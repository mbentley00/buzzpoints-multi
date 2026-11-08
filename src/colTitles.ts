// Hover text for stat column headers, by label. A column's own `title` wins.
const TITLES: Record<string, string> = {
  GP: "Games played",
  TUH: "Tossups heard",
  PPG: "Points per game",
  PPB: "Points per bonus",
  Pwr: "Powers",
  "Pwr%": "Share of tossups powered",
  "Conv%": "Share of tossups converted",
  "Inc%": "Share of tossups with an incorrect buzz",
  PP20TUH: "Points per 20 tossups heard",
  "Pts/TUH": "Points per tossup heard",
  Get: "Correct buzzes",
  Correct: "Correct buzzes",
  "1st": "Fastest correct buzz on a tossup",
  Top3: "One of the three fastest correct buzzes on a tossup",
  "Top 3": "One of the three fastest correct buzzes on a tossup",
  BPA: "Buzz point area under the curve",
  Rebound: "Converted after an incorrect buzz",
  Reb: "Converted after an incorrect buzz",
  "Easy%": "Share of easy parts converted",
  "Medium%": "Share of medium parts converted",
  "Hard%": "Share of hard parts converted",
};

export const colTitle = (label: string, own?: string) => own ?? TITLES[label];
