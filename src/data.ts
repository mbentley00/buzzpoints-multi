import { useEffect, useState, useSyncExternalStore } from "react";
import { IndexData } from "./types";

let indexPromise: Promise<IndexData> | null = null;

export function loadIndex(): Promise<IndexData> {
  if (!indexPromise) {
    indexPromise = fetch("/api/index")
      .then(async (r) => {
        if (!r.ok) return { base: null, sets: [], needsSetup: true };
        const d = await r.json().catch(() => null);
        if (!d || !Array.isArray(d.sets)) return { base: null, sets: [], needsSetup: true };
        return d as IndexData;
      })
      .catch(() => ({ base: null, sets: [], needsSetup: true }));
  }
  return indexPromise;
}

export function refreshIndex() {
  indexPromise = null;
}

const cache = new Map<string, Promise<unknown>>();

// Admin "reveal hidden content" is remembered per-slug for the browser session.
export function isRevealed(slug: string): boolean {
  try { return sessionStorage.getItem(`reveal:${slug}`) === "1"; } catch { return false; }
}
export function setRevealed(slug: string) {
  try { sessionStorage.setItem(`reveal:${slug}`, "1"); } catch { /* ignore */ }
}

// Whether the server is withholding question content from us, per slug, as
// reported by the last /api/data response. The server decides this — the client
// guessing at it from the set index is how a "content is hidden" notice ended up
// outliving the access that made it true.
const redacted = new Map<string, boolean>();
export const isContentRedacted = (slug: string): boolean => redacted.get(slug) === true;

export function loadSetJson<T>(slug: string, file: string, bust = 0): Promise<T> {
  const reveal = isRevealed(slug);
  const key = `${slug}/${file}#${bust}${reveal ? "#r" : ""}`;
  if (!cache.has(key)) {
    const url =
      `/api/data?path=${encodeURIComponent(`sets/${slug}/${file}`)}` + (bust ? `&v=${bust}` : "") + (reveal ? "&reveal=1" : "");
    cache.set(
      key,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${file}: ${r.status}`);
        // Recorded before the JSON resolves to the caller, so a component
        // rendering on the data has the answer by the time it renders.
        const state = r.headers.get("x-bp-content");
        if (state) redacted.set(slug, state === "redacted");
        return r.json();
      })
    );
  }
  return cache.get(key) as Promise<T>;
}

// Bumped whenever a set's cached JSON is dropped. Dropping the cache is not
// enough on its own: a component that already holds the old data — the set
// layout above every page, most of all — has no reason to ask again, so an
// owner's repair left its own warning banner on screen until a full reload.
// Anything that should follow a repair reads this and refetches.
let cacheEpoch = 0;
const epochSubs = new Set<() => void>();
export function useSetEpoch(): number {
  return useSyncExternalStore(
    (cb) => { epochSubs.add(cb); return () => { epochSubs.delete(cb); }; },
    () => cacheEpoch,
    () => cacheEpoch
  );
}

export function clearSetCache(slug: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${slug}/`)) cache.delete(k);
  // Access may be exactly what changed, so the old answer can't be carried over.
  redacted.delete(slug);
  cacheEpoch++;
  for (const f of [...epochSubs]) f();
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    setError(null);
    fn()
      .then((d) => alive && (setData(d), setLoading(false)))
      .catch((e) => alive && (setError(String(e.message || e)), setLoading(false)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading };
}

export function useIndex() {
  return useAsync<IndexData>(() => loadIndex(), []);
}

export function useSetJson<T>(slug: string, file: string, nonce = 0) {
  return useAsync<T>(() => loadSetJson<T>(slug, file, nonce), [slug, file, nonce]);
}
