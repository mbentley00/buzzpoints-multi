import { useEffect, useState } from "react";

// Whether player names sort by first name (the default) or surname. Kept in
// this browser and shared by every player table.
export type NameOrder = "first" | "last";
const KEY = "bp-name-order";
const EVT = "bp-name-order-pref";
function read(): NameOrder {
  try { return localStorage.getItem(KEY) === "last" ? "last" : "first"; } catch { return "first"; }
}
export function setNameOrder(o: NameOrder) {
  try { if (o === "first") localStorage.removeItem(KEY); else localStorage.setItem(KEY, o); } catch { /* private window */ }
  window.dispatchEvent(new Event(EVT));
}
export function useNameOrder(): NameOrder {
  const [o, setO] = useState(read);
  useEffect(() => {
    const sync = () => setO(read());
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return o;
}

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
// "Anna Smith Jr." → "smith anna": surname first, then the rest, so ties fall
// back to first name.
export function surnameKey(name: string): string {
  const w = (name || "").trim().split(/\s+/).map((t) => t.replace(/,$/, ""));
  while (w.length > 1 && SUFFIX.test(w[w.length - 1])) w.pop();
  const last = w.pop() ?? "";
  return `${last} ${w.join(" ")}`.trim().toLowerCase();
}

export const nameKey = (name: string, order: NameOrder) =>
  order === "last" ? surnameKey(name) : (name || "").toLowerCase();

export const compareNames = (a: string, b: string, order: NameOrder) =>
  nameKey(a, order).localeCompare(nameKey(b, order));
