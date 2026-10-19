import { useEffect, useState } from "react";

// klaxon.json: every press behind each buzz, from Klaxon full buzz logs. Kept
// apart from the QBJ stats; see api/_lib/klaxon.ts for how it's built.
export interface KlaxonOther { player: string; team: string | null; ms: number | null; late: boolean; id?: string; sameTeam: boolean }
export interface KlaxonRace {
  id: string; round: number; num: number; editionId?: string;
  word: number | null; pct: number | null; value: number; rebound: boolean;
  winner: string | null; team: string | null; winnerId?: string;
  others: KlaxonOther[]; answer: string; category: string;
}
export interface KlaxonPlayer {
  id?: string; name: string; team: string; teamId?: string;
  races: number; won: number; lost: number; winPct: number | null;
  medianLostBy: number | null; medianWonBy: number | null; avgWordLost: number | null;
  lostToCorrect: number; alsoKnew: number; lostTo: { name: string; n: number }[];
}
export interface KlaxonFile { raceMs: number; games: number; cycles: number; racedCycles: number; races: KlaxonRace[]; players: KlaxonPlayer[] }

// A rival's press counts as a race when it's within raceMs of the winner.
export const isRace = (o: KlaxonOther, raceMs: number) => !o.sameTeam && o.ms !== null && o.ms <= raceMs;

export const fmtMs = (ms: number | null) => (ms === null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

// Viewers can switch Klaxon stats off; the choice is kept in this browser and
// applies to every tournament.
const KEY = "bp-klaxon-off";
const EVT = "bp-klaxon-pref";
function readOff(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function setKlaxonOn(on: boolean) {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "1"); } catch { /* private window */ }
  window.dispatchEvent(new Event(EVT));
}
export function useKlaxonOn(): boolean {
  const [off, setOff] = useState(readOff);
  useEffect(() => {
    const sync = () => setOff(readOff());
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return !off;
}
