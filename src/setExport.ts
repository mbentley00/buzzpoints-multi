// "Export all data": everything stored for a tournament, as one zip an owner
// can keep or re-upload elsewhere. The server hands over the raw state
// (/api/yf-export?op=all); the files are laid out here, reusing the MODAQ
// export for the packets, game QBJs and rosters.
import { zipFiles, type ZipEntry } from "./zip";
import { modaqEntries, type SetSourceLike } from "./modaqExport";

interface ExportPayload {
  slug: string;
  at: string;
  tournament: Record<string, unknown>;
  source: SetSourceLike | null;
  yf: { original: unknown; corrected: unknown } | null;
  klaxonStats: unknown;
  edits: Record<string, unknown>;
}

const enc = new TextEncoder();
const json = (o: unknown) => enc.encode(JSON.stringify(o, null, 2));

function readme(p: ExportPayload, hasKlaxon: boolean): string {
  const lines = [
    `${String(p.tournament.name || p.slug)}: every file stored on Buzzpoints, exported ${p.at.slice(0, 10)}.`,
    "",
    "packets/       one packet JSON per round (Round_01.json ...), the same files that were uploaded",
    "games/         one QBJ per game, as uploaded",
    "roster.qbj     every team and player, in the tournament shape MODAQ loads",
  ];
  if (hasKlaxon) lines.push("klaxon/        every Klaxon press behind each game's buzzes, named after its game");
  lines.push("(A tournament with several mirrors has one folder per mirror holding the above.)", "");
  if (p.yf) lines.push(`${p.slug}.yft      the YellowFruit file with buzz corrections applied`, "yellowfruit-original.yft  the YellowFruit file as uploaded");
  if (p.klaxonStats) lines.push("klaxon-stats.json  the Klaxon page's race and press stats");
  lines.push(
    "buzzpoints/    the tournament's details and every edit made on the site (buzz corrections,",
    "               renames, category fields, question edits, phases, replacements ...).",
    "               The files above are the raw uploads; these are layered on top of them.",
    "",
  );
  return lines.join("\r\n");
}

export async function buildSetExport(slug: string): Promise<Blob> {
  const r = await fetch(`/api/yf-export?slug=${encodeURIComponent(slug)}&op=all`);
  const p = (await r.json().catch(() => ({}))) as ExportPayload & { error?: string };
  if (!r.ok) throw new Error(p.error || `Export failed (${r.status})`);

  const entries: ZipEntry[] = [];
  if (p.source) entries.push(...modaqEntries(p.source, slug, { klaxon: true }));
  const hasKlaxon = entries.some((e) => /(^|\/)klaxon\//.test(e.name));
  if (p.yf) {
    entries.push({ name: `${slug}.yft`, data: enc.encode(JSON.stringify(p.yf.corrected)) });
    entries.push({ name: "yellowfruit-original.yft", data: enc.encode(JSON.stringify(p.yf.original)) });
  }
  if (p.klaxonStats) entries.push({ name: "klaxon-stats.json", data: json(p.klaxonStats) });
  entries.push({ name: "buzzpoints/tournament.json", data: json({ slug, ...p.tournament }) });
  for (const [name, v] of Object.entries(p.edits || {})) entries.push({ name: `buzzpoints/${name}`, data: json(v) });
  entries.push({ name: "README.txt", data: enc.encode(readme(p, hasKlaxon)) });
  return zipFiles(entries);
}

export function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
