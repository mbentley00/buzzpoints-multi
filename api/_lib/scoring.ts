// Scoring formats. The aggregation classifies each buzz value generically:
//   value > getValue  -> "power"
//   value === getValue (or 0 < value <= getValue) -> "get" (correct)
//   value < 0 -> "neg"
//   value === 0 -> "zero" (incorrect, no penalty)
// The format only changes which tiers are *meaningful* (whether powers / negs
// exist) so the UI can show the right columns. There is NO hard-coded behavior
// tied to a specific tournament.

export type ScoringId = "ACF" | "mACF" | "PACE" | "SUPERPOWER";

export interface Scoring {
  id: ScoringId;
  label: string;
  getValue: number; // base value of a correct, non-power buzz
  hasPower: boolean; // are there above-base "power" values?
  hasNeg: boolean; // can a wrong buzz score below 0?
  description: string;
}

export const SCORINGS: Record<ScoringId, Scoring> = {
  ACF: {
    id: "ACF",
    label: "ACF (10 / -5)",
    getValue: 10,
    hasPower: false,
    hasNeg: true,
    description: "10 for a correct answer, -5 for an early incorrect buzz, no powers.",
  },
  mACF: {
    id: "mACF",
    label: "mACF (15 / 10 / -5)",
    getValue: 10,
    hasPower: true,
    hasNeg: true,
    description: "15 power, 10 correct, -5 neg.",
  },
  PACE: {
    id: "PACE",
    label: "PACE (20 / 10 / 0)",
    getValue: 10,
    hasPower: true,
    hasNeg: false,
    description: "20 power, 10 correct, 0 for an incorrect buzz (no negs).",
  },
  SUPERPOWER: {
    id: "SUPERPOWER",
    label: "Super-power (20 / 15 / 10 / -5)",
    getValue: 10,
    hasPower: true,
    hasNeg: true,
    description: "20 super-power, 15 power, 10 correct, -5 neg.",
  },
};

export function getScoring(id: string | undefined): Scoring {
  return SCORINGS[(id as ScoringId)] ?? SCORINGS.PACE;
}

export type Tier = "power" | "get" | "neg" | "zero";

export function classify(value: number, scoring: Scoring): Tier {
  if (value > scoring.getValue) return "power";
  if (value > 0) return "get";
  if (value < 0) return "neg";
  return "zero";
}
