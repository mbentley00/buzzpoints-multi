import { roundFromFileName } from "./util";
import { unzipFiles } from "./zip";

// Reading a buzzpoint-migrator / quizbowlstats data folder:
//   question_sets/<set>/index.json                       (name, bonuses)
//   question_sets/<set>/[editions/<ed>/]packet_files/*.json
//   question_sets/<set>/editions/<ed>/index.json         (name, slug)
//   tournaments/<mirror>/index.json                      (name, set, edition)
//   tournaments/<mirror>/game_files/*.qbj
// Each mirror becomes one edition of its set, with that edition's packets
// numbered by the round the mirror actually played them (from the QBJ
// `packets` field), so mirrors that read packets in different orders line up.

// Normalize a packet name for matching: drop a trailing "(2)" duplicate-read
// marker the source adds, then keep only alphanumerics (so "Packet-J_McGill-A…"
// and "Packet J - McGill A, …" collapse to the same key).
export const normPacket = (s: string) => s.toLowerCase().replace(/\(\d+\)\s*$/, "").replace(/[^a-z0-9]/g, "");

// macOS zips carry a parallel __MACOSX tree of "._name" AppleDouble stubs whose
// names normalize to the real files'. Ignore them (and .DS_Store) entirely.
const isJunk = (parts: string[]) =>
  parts.some((p) => p === "__MACOSX" || p === ".DS_Store" || p.startsWith("._"));

// Scoring format from the distinct buzz values (mirrors src/detectScoring).
export function scoringFromValues(vals: Set<number>): string | null {
  if (!vals.size) return null;
  const has = (n: number) => vals.has(n);
  const hasNeg = [...vals].some((v) => v < 0);
  const maxPos = Math.max(0, ...[...vals].filter((v) => v > 0));
  if (has(20) && has(15)) return "SUPERPOWER";
  if (has(20) && hasNeg) return "SUPERPOWER";
  if (has(20)) return "PACE";
  if (has(15) || maxPos === 15) return "mACF";
  if (maxPos === 10) return "ACF";
  return null;
}

export interface PathFile { path: string; file: File }

export function filesFromPicker(list: FileList | File[]): PathFile[] {
  return Array.from(list).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
}
export async function filesFromZip(zip: File): Promise<PathFile[]> {
  const entries = await unzipFiles(await zip.arrayBuffer());
  return entries
    .filter((e) => !e.name.endsWith("/"))
    .map((e) => {
      const leaf = e.name.split("/").pop() || e.name;
      return { path: e.name, file: new File([e.data as BlobPart], leaf, { type: "application/json" }) };
    });
}

export interface Mirror {
  name: string;        // folder name under tournaments/
  label: string;       // display name (its index.json name, else the folder)
  edKey: string;       // which packet edition it played ("" = the set's flat packet_files)
  games: File[];
  roundPacket: Map<number, string>; // round played -> packet name from the QBJ
}
export interface SetGroup {
  key: string; name: string; hasBonuses: boolean; scoring: string | null;
  mirrors: Mirror[];
  editionNames: Map<string, string>; // edKey -> display name ("" -> "")
}
export interface FolderScan {
  sets: SetGroup[];
  mirrorCount: number; packetCount: number; noGames: number; unmatched: number;
  packetFile: Map<string, File>;   // `${setKey}|${edKey}|${normPacket}` -> packet File
  anyEdPacket: Map<string, File>;  // `${setKey}|${normPacket}` -> packet File (any edition)
}

// Segment list after `anchor` in a "/"-split path, or null.
function afterAnchor(parts: string[], anchor: string): string[] | null {
  const i = parts.indexOf(anchor);
  return i >= 0 ? parts.slice(i + 1) : null;
}

// Read the folder: index packet files, then read every mirror's games to build
// its round -> packet map and detect scoring. A mirror is matched to its set +
// edition by its own index.json when it has one, else by voting the edition
// whose packet files cover the most of its packets.
export async function scanDataFolder(files: PathFile[], onProgress?: (msg: string) => void): Promise<FolderScan> {
  const packetFile = new Map<string, File>();
  const anyEdPacket = new Map<string, File>();
  const pkt2ed = new Map<string, Set<string>>();   // normPkt -> `${setKey}|${edKey}`
  const setName = new Map<string, string>();
  const setBonuses = new Map<string, boolean>();
  const setByName = new Map<string, string>();     // norm(set display name) -> setKey
  const edByName = new Map<string, string>();      // `${setKey}|${norm(edition name)}` -> edKey
  const edDisplay = new Map<string, string>();     // `${setKey}|${edKey}` -> display name
  const mirrorFiles = new Map<string, File[]>();
  const mirrorIndex = new Map<string, File>();
  const setIndexFiles: { setKey: string; f: File }[] = [];
  const edIndexFiles: { setKey: string; edKey: string; f: File }[] = [];

  onProgress?.("Scanning files…");
  for (const { path, file: f } of files) {
    const parts = path.split("/");
    if (isJunk(parts)) continue;
    const leaf = parts[parts.length - 1];
    const qs = afterAnchor(parts, "question_sets");
    if (qs) {
      const setKey = qs[0];
      const pi = qs.indexOf("packet_files");
      if (qs.length === 2 && leaf === "index.json") setIndexFiles.push({ setKey, f });
      else if (pi > 0 && pi === qs.length - 2 && leaf.toLowerCase().endsWith(".json")) {
        const edKey = qs.slice(1, pi).join("/"); // "" (flat) or "editions/<edition>"
        const n = normPacket(leaf.replace(/\.json$/i, ""));
        packetFile.set(`${setKey}|${edKey}|${n}`, f);
        if (!anyEdPacket.has(`${setKey}|${n}`)) anyEdPacket.set(`${setKey}|${n}`, f);
        const pair = `${setKey}|${edKey}`;
        if (!pkt2ed.has(n)) pkt2ed.set(n, new Set());
        pkt2ed.get(n)!.add(pair);
        if (!edDisplay.has(pair)) edDisplay.set(pair, edKey.split("/").pop() || "");
      } else if (qs.length > 2 && leaf === "index.json") {
        edIndexFiles.push({ setKey, edKey: qs.slice(1, -1).join("/"), f });
      }
      continue;
    }
    const tj = afterAnchor(parts, "tournaments");
    if (!tj) continue;
    if (tj.length === 2 && leaf === "index.json") mirrorIndex.set(tj[0], f);
    else if (tj[1] === "game_files" && leaf.toLowerCase().endsWith(".qbj")) {
      const mirror = tj[0];
      if (!mirrorFiles.has(mirror)) mirrorFiles.set(mirror, []);
      mirrorFiles.get(mirror)!.push(f);
    }
  }
  for (const { setKey, f } of setIndexFiles) {
    let name = setKey;
    try { const j = JSON.parse(await f.text()); name = j.name || setKey; setBonuses.set(setKey, j.bonuses !== false); } catch { /* keep folder name */ }
    setName.set(setKey, name);
    setByName.set(normPacket(name), setKey);
  }
  // sets with no index.json are still matchable by their folder name
  for (const key of packetFile.keys()) {
    const sk = key.slice(0, key.indexOf("|"));
    if (!setByName.has(normPacket(sk))) setByName.set(normPacket(sk), sk);
  }
  for (const { setKey, edKey, f } of edIndexFiles) {
    const last = edKey.split("/").pop() || edKey;
    edByName.set(`${setKey}|${normPacket(last)}`, edKey);
    try {
      const j = JSON.parse(await f.text());
      for (const v of [j.name, j.slug]) if (v) edByName.set(`${setKey}|${normPacket(String(v))}`, edKey);
      if (j.name) edDisplay.set(`${setKey}|${edKey}`, String(j.name));
    } catch { /* folder name only */ }
  }
  if (!mirrorFiles.size)
    throw new Error("No tournaments/<site>/game_files/*.qbj found. Choose the data folder that holds question_sets/ and tournaments/.");

  const groups = new Map<string, SetGroup>();
  const setValues = new Map<string, Set<number>>();
  let mi = 0, noGames = 0, unmatched = 0;
  for (const [mirror, games] of mirrorFiles) {
    onProgress?.(`Reading games… ${++mi}/${mirrorFiles.size} sites`);
    const roundPacket = new Map<number, string>();
    const vals = new Set<number>();
    for (const gf of games) {
      let g: any;
      try { g = JSON.parse(await gf.text()); } catch { continue; }
      // Most exports stamp `_round` inside the QBJ, but some only put it in the
      // file name ("Round_10_…qbj"). The server falls back to the file name
      // when it files the game, so the packet has to be keyed the same way —
      // otherwise every round without `_round` gets its games but no packet.
      const r = g._round != null && Number.isInteger(Number(g._round)) ? Number(g._round) : roundFromFileName(gf.name);
      if (r != null && Number.isInteger(r) && g.packets && !roundPacket.has(r)) roundPacket.set(r, String(g.packets));
      for (const mq of g.match_questions || []) for (const bz of mq.buzzes || []) { const v = bz?.result?.value; if (typeof v === "number") vals.add(v); }
    }
    if (!roundPacket.size) { noGames++; continue; } // no games / no round info

    // Prefer the mirror's own index.json, which names its set and edition.
    let label = mirror, setKey: string | undefined, edKey: string | undefined;
    const mf = mirrorIndex.get(mirror);
    if (mf) {
      try {
        const j = JSON.parse(await mf.text());
        if (j.name) label = String(j.name);
        if (j.set) setKey = setByName.get(normPacket(String(j.set)));
        if (setKey && j.edition) edKey = edByName.get(`${setKey}|${normPacket(String(j.edition))}`);
      } catch { /* fall through to packet voting */ }
    }
    // Otherwise (or for the edition), pick the set/edition whose packet files
    // match the most of this mirror's packets.
    if (!setKey || edKey === undefined) {
      const votes = new Map<string, number>();
      for (const pk of roundPacket.values()) {
        for (const pair of pkt2ed.get(normPacket(pk)) || []) {
          if (setKey && !pair.startsWith(`${setKey}|`)) continue;
          votes.set(pair, (votes.get(pair) || 0) + 1);
        }
      }
      let bestPair: string | undefined, best = 0;
      for (const [pair, c] of votes) if (c > best) { best = c; bestPair = pair; }
      if (bestPair) {
        const cut = bestPair.indexOf("|");
        setKey = setKey || bestPair.slice(0, cut);
        if (edKey === undefined) edKey = bestPair.slice(cut + 1);
      }
    }
    if (!setKey) { unmatched++; continue; }
    if (!groups.has(setKey)) groups.set(setKey, { key: setKey, name: setName.get(setKey) || setKey, hasBonuses: setBonuses.get(setKey) !== false, scoring: null, mirrors: [], editionNames: new Map() });
    groups.get(setKey)!.mirrors.push({ name: mirror, label, edKey: edKey ?? "", games, roundPacket });
    if (!setValues.has(setKey)) setValues.set(setKey, new Set());
    for (const v of vals) setValues.get(setKey)!.add(v);
  }
  for (const g of groups.values()) {
    g.scoring = scoringFromValues(setValues.get(g.key) || new Set());
    g.mirrors.sort((a, b) => a.label.localeCompare(b.label));
    for (const m of g.mirrors) g.editionNames.set(m.edKey, edDisplay.get(`${g.key}|${m.edKey}`) || m.edKey.split("/").pop() || "");
  }
  return {
    sets: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mirrorCount: mirrorFiles.size, packetCount: packetFile.size, noGames, unmatched,
    packetFile, anyEdPacket,
  };
}

// The packet files one mirror needs, each renamed for the round the mirror
// played it so the server files it under that round.
export async function mirrorPackets(scan: FolderScan, setKey: string, m: Mirror): Promise<{ files: File[]; missing: number }> {
  const files: File[] = [];
  let missing = 0;
  for (const [rnd, pktName] of m.roundPacket) {
    const pn = normPacket(pktName);
    const pf = scan.packetFile.get(`${setKey}|${m.edKey}|${pn}`) || scan.anyEdPacket.get(`${setKey}|${pn}`);
    if (pf) files.push(new File([await pf.text()], `Round_${rnd}.json`, { type: "application/json" }));
    else missing++;
  }
  return { files, missing };
}

// How many of a mirror's rounds have a packet file, without reading any.
export function mirrorCoverage(scan: FolderScan, setKey: string, m: Mirror): { rounds: number; matched: number } {
  let matched = 0;
  for (const pktName of m.roundPacket.values()) {
    const pn = normPacket(pktName);
    if (scan.packetFile.has(`${setKey}|${m.edKey}|${pn}`) || scan.anyEdPacket.has(`${setKey}|${pn}`)) matched++;
  }
  return { rounds: m.roundPacket.size, matched };
}

// ---- manual multi-site upload (New Tournament wizard) ----

// What one site's game files say: the packet each round was read from (the
// QBJ `packets` field, when the scoring app filled it in) and its buzz values.
export async function readSiteGames(games: File[]): Promise<{ roundPacket: Map<number, string>; rounds: Set<number> }> {
  const roundPacket = new Map<number, string>();
  const rounds = new Set<number>();
  for (const gf of games) {
    let g: any;
    try { g = JSON.parse(await gf.text()); } catch { continue; }
    const declared = g?._round;
    const r = declared != null && declared !== "" && Number.isInteger(Number(declared))
      ? Number(declared)
      : roundFromFileName(typeof declared === "string" ? declared : "") ?? roundFromFileName(gf.name);
    if (r == null || !Number.isInteger(r)) continue;
    rounds.add(r);
    if (g.packets && !roundPacket.has(r)) roundPacket.set(r, String(g.packets));
  }
  return { roundPacket, rounds };
}

const stripExt = (s: string) => s.replace(/\.(docx?|pdf|json|qbj|txt)$/i, "");

// Match each round's packet name to one of a version's packet files: by name
// first, then by the packet's number when exactly one file carries it.
export function matchPackets(roundPacket: Map<number, string>, packets: File[]): { byRound: Map<number, File>; unmatched: { round: number; packet: string }[] } {
  const byName = new Map<string, File>();
  const byNum = new Map<number, File[]>();
  for (const f of packets) {
    byName.set(normPacket(stripExt(f.name)), f);
    const n = roundFromFileName(stripExt(f.name));
    if (n != null) byNum.set(n, [...(byNum.get(n) || []), f]);
  }
  const byRound = new Map<number, File>();
  const unmatched: { round: number; packet: string }[] = [];
  for (const [r, pk] of [...roundPacket].sort((a, b) => a[0] - b[0])) {
    let f = byName.get(normPacket(stripExt(pk)));
    if (!f) {
      const n = roundFromFileName(stripExt(pk));
      const cands = n != null ? byNum.get(n) || [] : [];
      if (cands.length === 1) f = cands[0];
    }
    if (f) byRound.set(r, f); else unmatched.push({ round: r, packet: pk });
  }
  return { byRound, unmatched };
}

// How a site's packets get their rounds. "name": its games say which packet
// each round used and those names match the files, so each packet is filed
// under the round THIS site read it in. "file": they don't, so a packet's round
// comes from its filename (Round_3.json -> round 3), as in a one-site upload.
export function sitePacketPlan(roundPacket: Map<number, string>, packets: File[]) {
  const m = matchPackets(roundPacket, packets);
  const named = roundPacket.size;
  const mode: "name" | "file" = named > 0 && m.byRound.size * 2 >= named ? "name" : "file";
  return { mode, ...m, named };
}

export async function sitePacketFiles(roundPacket: Map<number, string>, packets: File[]): Promise<File[]> {
  const plan = sitePacketPlan(roundPacket, packets);
  if (plan.mode === "file") return packets;
  const out: File[] = [];
  for (const [r, f] of plan.byRound) out.push(new File([await f.text()], `Round_${r}.json`, { type: "application/json" }));
  return out;
}
