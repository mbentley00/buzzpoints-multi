import { uploadFiles } from "./upload";

// Browser side of the staged ("local-*") ingest ops: each mirror is uploaded and
// parsed by its own request, so a tournament of many mirrors never has to fit
// in one function call.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ingestPost(b: any) {
  const r = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
}

const RETRYABLE = /\b(429|500|502|503|504)\b|timeout|network|fetch/i;
// Retry transient failures with a growing backoff. Every staged op is
// idempotent (an edition is written to a fixed slot), so a retry is safe.
export async function ingestPostRetry(b: any, onWait?: (s: number) => void, tries = 4) {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await ingestPost(b); }
    catch (e) {
      last = e;
      if (i === tries - 1 || !RETRYABLE.test(String((e as Error).message || e))) throw e;
      const s = 10 * (i + 1);
      onWait?.(s);
      await sleep(s * 1000);
    }
  }
  throw last;
}

// One edition to stage. Packet files must already be named by the round this
// mirror played them ("Round_3.json"), since the server reads a packet's round
// from its filename.
export interface StageEdition { label: string; packets: File[]; games: File[] }

// Upload and stage every edition; returns the job to finish with "local-create"
// (or "local-finish") and how many editions it holds.
export async function stageEditions(
  editions: StageEdition[],
  say: (msg: string) => void,
): Promise<{ jobId: string; editionCount: number }> {
  const wait = (s: number) => say(`The server is busy; retrying in ${s}s…`);
  const start = await ingestPostRetry({ op: "local-start" }, wait);
  let n = 0;
  for (const ed of editions) {
    if (!ed.games.length) continue;
    const tag = `${n + 1} of ${editions.length}: ${ed.label}`;
    const packetRefs = await uploadFiles(ed.packets, (d, t) => say(`Uploading ${tag} — packets ${d}/${t}`));
    const gameRefs = await uploadFiles(ed.games, (d, t) => say(`Uploading ${tag} — games ${d}/${t}`));
    say(`Reading ${tag}…`);
    await ingestPostRetry({ op: "local-edition", jobId: start.jobId, index: n, label: ed.label, packets: packetRefs, games: gameRefs }, wait);
    n++;
  }
  return { jobId: start.jobId, editionCount: n };
}
