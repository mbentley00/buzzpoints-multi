// Runs the integrity checks against every set the live site serves publicly.
//   npm run check:sets                 all public sets
//   npm run check:sets -- 2024-argos   just these slugs
// BASE overrides the site (e.g. BASE=http://localhost:5173 through the dev proxy).
// Exits 1 when any set has an issue, so it can gate a deploy.
import { checkIntegrity } from "../api/_lib/integrity.ts";

const BASE = (process.env.BASE || "https://www.buzzpoints.org").replace(/\/+$/, "");
const FILES = ["players.json", "tossups.json", "games.json", "categories_tossup.json", "categories_players.json", "categories_tossup_overall.json", "meta.json"];

async function json(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) return undefined;
  return r.json().catch(() => undefined);
}

const index = await json("/api/index");
if (!index?.sets) { console.error(`Couldn't read ${BASE}/api/index`); process.exit(2); }
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const sets = (index.sets as any[]).filter((s) => (only.length ? only.includes(s.slug) : s.visibility === "public"));

let bad = 0;
for (const s of sets) {
  const files: Record<string, unknown> = {};
  await Promise.all(FILES.map(async (f) => { files[f] = await json(`/api/data?path=${encodeURIComponent(`sets/${s.slug}/${f}`)}`); }));
  if (!files["players.json"]) { console.log(`?  ${s.slug}: no readable data`); continue; }
  const issues = checkIntegrity(files, { individual: !!(files["meta.json"] as any)?.individual });
  if (!issues.length) { console.log(`ok ${s.slug}`); continue; }
  bad++;
  console.log(`!! ${s.slug}`);
  for (const i of issues) {
    console.log(`     ${i.check}: ${i.message} (${i.count})`);
    for (const e of i.examples) console.log(`        - ${e}`);
  }
}
console.log(`\n${sets.length - bad}/${sets.length} sets clean.`);
process.exit(bad ? 1 : 0);
