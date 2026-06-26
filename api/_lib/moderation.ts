// Content moderation state: the first-post review queue and the name blocklist.
// Pending submissions are stored unaggregated and unlisted until a moderator
// approves them. Each submission keeps lightweight metadata in pending/index.json
// and its full upload payload (packets + games) in pending/<id>.json.
import { put, del } from "@vercel/blob";
import { readBlobJson } from "./blob.js";

export interface PendingSubmission {
  id: string;
  by: string;        // submitter email (becomes the owner on approval)
  byName: string;
  name: string;      // tournament name
  scoring: string;
  at: string;        // ISO submitted-at
}
// The full upload, replayed through the normal create path on approval. For a
// "results" submission, `yf` holds the raw YellowFruit/QBJ JSON and packets/games
// are unused.
export interface PendingPayload {
  name: string;
  scoring: string;
  hasBonuses?: boolean;
  visibility?: string;
  autoPublicAt?: string | null;
  edition?: string;
  kind?: "buzz" | "results";
  yf?: any;
  packets?: { name: string; json: any }[];
  games?: { name: string; json: any }[];
}

async function writeJson(path: string, obj: unknown) {
  await put(path, JSON.stringify(obj), {
    access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
  });
}

export const readPending = () =>
  readBlobJson<PendingSubmission[]>("pending/index.json", false).then((p) => p || []);
export const writePending = (list: PendingSubmission[]) => writeJson("pending/index.json", list);

export const readPendingPayload = (id: string) =>
  readBlobJson<PendingPayload>(`pending/${id}.json`, false);
export const writePendingPayload = (id: string, p: PendingPayload) => writeJson(`pending/${id}.json`, p);
export const delPendingPayload = (id: string) => del(`pending/${id}.json`).catch(() => {});

// ---- blocklist ----
export interface ModConfig { blocklist: string[]; }
export const readModConfig = () =>
  readBlobJson<ModConfig>("moderation.json", false).then((c) => ({ blocklist: c?.blocklist ?? [] }));
export const writeModConfig = (c: ModConfig) => writeJson("moderation.json", c);

// Return the first blocked word found in `text` (case-insensitive, whole-word),
// or null if clean. An empty blocklist never matches.
export function findBlocked(text: string, blocklist: string[]): string | null {
  const hay = ` ${(text || "").toLowerCase()} `;
  for (const raw of blocklist) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    // word-boundary-ish match so "scunthorpe" problems are reduced
    if (new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay)) return raw.trim();
  }
  return null;
}
