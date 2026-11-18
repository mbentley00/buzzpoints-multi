// Builds a set's stat files from a data folder zip (question_sets/ + tournaments/)
// entirely in memory — the same import the site does (scan, settle each site's
// games, attach packets) and the same combined aggregation, with no blob store.
//   npx tsx tests/build-local.ts <data.zip> [--merge "Other=Current Events,Geography"]...
// Prints the integrity report; exits 1 if there are issues.
import { readFileSync } from "node:fs";
import { filesFromZip, scanDataFolder, mirrorPackets } from "../src/migratorFolder.ts";
import { parseFiles } from "../api/_lib/publish.ts";
import { aggregate, VirtualCategory } from "../api/_lib/aggregate.ts";
import { getScoring } from "../api/_lib/scoring.ts";
import { canonicalizeEditions, combinedPackets, Edition } from "../api/_lib/sets.ts";
import { checkIntegrity } from "../api/_lib/integrity.ts";

export async function buildFromZip(zipPath: string, virtualCats: VirtualCategory[] = []) {
  const scan = await scanDataFolder(await filesFromZip(new File([readFileSync(zipPath)], "data.zip")));
  const set = scan.sets[0];
  if (!set) throw new Error("No question set with games in that zip.");
  const asRefs = (fs: File[]) => Promise.all(fs.map(async (f) => ({ name: f.name, json: JSON.parse(await f.text()) })));
  const editions: Edition[] = [];
  for (const m of set.mirrors) {
    const { files } = await mirrorPackets(scan, set.key, m);
    const parsed = parseFiles({ packets: await asRefs(files), games: await asRefs(m.games) });
    editions.push({ id: `e${editions.length}`, label: m.label, packets: parsed.packets, games: parsed.games });
  }
  const eds = canonicalizeEditions(editions);
  const games = eds.flatMap((e) => (e.games || []).map((g) => ({ ...g, editionId: e.id })));
  const editionPackets = eds.length > 1 ? new Map(eds.map((e) => [e.id, e.packets || []])) : undefined;
  const cfg = { name: set.name, slug: "local", scoring: getScoring(set.scoring || "ACF"), hasBonuses: set.hasBonuses } as any;
  const out = aggregate(combinedPackets(eds), games, cfg, [], virtualCats, [], [], editionPackets) as Record<string, any>;
  return { set, editions: eds, out, issues: checkIntegrity(out) };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/build-local.ts")) {
  const [zip, ...rest] = process.argv.slice(2);
  const merges: VirtualCategory[] = [];
  for (let i = 0; i < rest.length; i++)
    if (rest[i] === "--merge") { const [name, list] = rest[++i].split("="); merges.push({ name, members: list.split(",").map((s) => s.trim()) }); }
  const { set, editions, issues } = await buildFromZip(zip, merges);
  console.log(`${set.name}: ${editions.length} sites, ${editions.reduce((n, e) => n + (e.games || []).length, 0)} games`);
  for (const i of issues) {
    console.log(`  ${i.check}: ${i.message} (${i.count})`);
    for (const e of i.examples) console.log(`     - ${e}`);
  }
  console.log(issues.length ? "ISSUES FOUND" : "clean");
  process.exit(issues.length ? 1 : 0);
}
