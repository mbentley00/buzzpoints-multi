// Export helpers for "results" tournaments: round-trip corrections back into the
// raw YellowFruit JSON, render HTML stat reports, and bundle everything into a zip
// (no external deps — a minimal store-only ZIP writer).
import { ResultsCorrection, matchKeyOf } from "./resultsAggregate.js";
import { YfTournament } from "./yellowfruit.js";

/* ----------------------------- minimal ZIP (store) ----------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function buildZip(files: { name: string; data: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf-8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf-8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ----------------------------- YF round-trip ----------------------------- */
const refOf = (o: any): string | null => (o && typeof o === "object" && typeof o.$ref === "string" ? o.$ref : null);

// Apply corrections to a deep clone of the raw YF JSON: adjust per-player
// answer_counts and recompute each touched team's points. Returns the updated JSON.
export function applyCorrectionsToRawYf(raw: any, corrections: ResultsCorrection[]): any {
  const root = (Array.isArray(raw?.objects) ? raw.objects[0] : raw);
  const clone = JSON.parse(JSON.stringify(raw));
  const croot = Array.isArray(clone?.objects) ? clone.objects[0] : clone;
  if (!corrections.length) return clone;

  const valueById = new Map<string, number>();
  const idByValue = new Map<number, string>();
  for (const a of croot.scoring_rules?.answer_types || []) {
    if (a?.id != null && typeof a.value === "number") { valueById.set(a.id, a.value); idByValue.set(a.value, a.id); }
  }
  const teamName = new Map<string, string>();
  const playerName = new Map<string, string>();
  for (const reg of croot.registrations || [])
    for (const tm of reg.teams || []) {
      if (tm.id) teamName.set(tm.id, tm.name);
      for (const p of tm.players || []) if (p.id) playerName.set(p.id, p.name);
    }
  const resolveTeam = (mt: any) => { const r = refOf(mt.team); return r ? teamName.get(r) ?? r.replace(/^Team_/, "") : mt.team?.name; };
  const resolvePlayer = (mp: any) => { const r = refOf(mp.player); return r ? playerName.get(r) ?? r.replace(/^Player_/, "").replace(/_\d+$/, "") : mp.player?.name; };

  const byKey = new Map<string, ResultsCorrection[]>();
  for (const c of corrections) { const a = byKey.get(c.matchKey) || []; a.push(c); byKey.set(c.matchKey, a); }

  const bump = (mp: any, value: number, delta: number) => {
    const id = idByValue.get(value);
    if (id == null) return;
    let ac = (mp.answer_counts || []).find((x: any) => refOf(x.answer_type) === id || valueById.get(refOf(x.answer_type) || "") === value);
    if (!ac) { ac = { number: 0, answer_type: { $ref: id } }; (mp.answer_counts = mp.answer_counts || []).push(ac); }
    ac.number = Math.max(0, (ac.number || 0) + delta);
  };
  const findOrAddPlayer = (mt: any, name: string) => {
    let mp = (mt.match_players || []).find((x: any) => resolvePlayer(x) === name);
    if (!mp) {
      // create a ref-less player line; YF can still read name via player.name
      mp = { player: { name }, tossups_heard: 0, answer_counts: [] };
      (mt.match_players = mt.match_players || []).push(mp);
    }
    return mp;
  };
  const recomputePoints = (mt: any) => {
    let tu = 0;
    for (const mp of mt.match_players || [])
      for (const ac of mp.answer_counts || []) {
        const v = valueById.get(refOf(ac.answer_type) || "");
        if (typeof v === "number") tu += v * (ac.number || 0);
      }
    mt.points = tu + (mt.bonus_points || 0);
  };

  for (const ph of croot.phases || [])
    for (const rnd of ph.rounds || [])
      for (const m of rnd.matches || []) {
        const roundNum = rnd.YfData?.number ?? Number(String(rnd.name).match(/\d+/)?.[0] ?? 0);
        const names = (m.match_teams || []).map(resolveTeam).filter(Boolean) as string[];
        const key = `${ph.name || ph.YfData?.code || "Phase"}|${roundNum}|${[...names].sort().join("|")}`;
        const cs = byKey.get(key);
        if (!cs) continue;
        const touched = new Set<any>();
        for (const c of cs) {
          const fromMt = (m.match_teams || []).find((mt: any) => resolveTeam(mt) === c.fromTeam);
          if (!fromMt) continue;
          const fromMp = findOrAddPlayer(fromMt, c.fromPlayer);
          bump(fromMp, c.fromValue, -1); touched.add(fromMt);
          if (c.remove) continue;
          const toMt = (m.match_teams || []).find((mt: any) => resolveTeam(mt) === (c.toTeam || c.fromTeam)) || fromMt;
          const toMp = findOrAddPlayer(toMt, c.toPlayer || c.fromPlayer);
          bump(toMp, c.toValue ?? c.fromValue, +1); touched.add(toMt);
        }
        for (const mt of touched) recomputePoints(mt);
      }
  void root;
  return clone;
}

/* ----------------------------- HTML reports ----------------------------- */
const esc = (s: any) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
const pageTpl = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>` +
  `body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#1c2530}h1,h2{margin:0 0 10px}` +
  `table{border-collapse:collapse;width:100%;margin-bottom:24px;font-size:13px}` +
  `th,td{border:1px solid #d9e0ea;padding:4px 8px;text-align:left}th{background:#f1f4f9}` +
  `td.r,th.r{text-align:right}</style></head><body>${body}` +
  `<p style="color:#888;font-size:12px">Generated by Buzzpoints from YellowFruit data.</p></body></html>`;

export function renderReports(out: Record<string, any>, meta: any): { name: string; data: string }[] {
  const teams = (out["results_teams.json"] as any[]) || [];
  const players = (out["results_players.json"] as any[]) || [];
  const games = (out["results_games.json"] as any[]) || [];
  const hp = meta.hasPower, hn = meta.hasNeg, hb = meta.hasBonuses;

  const stHead = `<tr><th>#</th><th>Team</th><th class=r>W</th><th class=r>L</th><th class=r>Pct</th><th class=r>PP20TUH</th>${hp ? "<th class=r>Pwr</th>" : ""}<th class=r>Correct</th>${hn ? "<th class=r>Neg</th>" : ""}<th class=r>TUH</th>${hb ? "<th class=r>PPB</th>" : ""}<th class=r>PPG</th></tr>`;
  const stRows = teams.map((t) => `<tr><td>${t.rank}</td><td>${esc(t.name)}</td><td class=r>${t.wins}</td><td class=r>${t.losses}</td><td class=r>${t.pct.toFixed(3)}</td><td class=r>${t.pp20tuh}</td>${hp ? `<td class=r>${t.powers}</td>` : ""}<td class=r>${t.gets}</td>${hn ? `<td class=r>${t.negs}</td>` : ""}<td class=r>${t.tuh}</td>${hb ? `<td class=r>${t.ppb == null ? "—" : t.ppb.toFixed(2)}</td>` : ""}<td class=r>${t.ppg}</td></tr>`).join("");
  const standings = pageTpl(`${meta.setName} — Standings`, `<h1>${esc(meta.setName)}</h1><h2>Standings</h2><table>${stHead}${stRows}</table>`);

  const inHead = `<tr><th>Player</th><th>Team</th><th class=r>G</th><th class=r>TUH</th>${hp ? "<th class=r>Pwr</th>" : ""}<th class=r>Correct</th>${hn ? "<th class=r>Neg</th>" : ""}<th class=r>Pts</th><th class=r>PPG</th><th class=r>P/TUH</th></tr>`;
  const inRows = players.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.team)}</td><td class=r>${p.games}</td><td class=r>${p.tuh}</td>${hp ? `<td class=r>${p.powers}</td>` : ""}<td class=r>${p.gets}</td>${hn ? `<td class=r>${p.negs}</td>` : ""}<td class=r>${p.pts}</td><td class=r>${p.ppg}</td><td class=r>${p.ptsPerTuh.toFixed(2)}</td></tr>`).join("");
  const individuals = pageTpl(`${meta.setName} — Individuals`, `<h1>${esc(meta.setName)}</h1><h2>Individuals</h2><table>${inHead}${inRows}</table>`);

  const gameBlocks = games.map((g) => {
    const boxes = g.teams.map((t: any) => {
      const rows = t.players.map((p: any) => `<tr><td>${esc(p.name)}</td><td class=r>${p.tuh}</td>${hp ? `<td class=r>${p.powers}</td>` : ""}<td class=r>${p.gets}</td>${hn ? `<td class=r>${p.negs}</td>` : ""}<td class=r>${p.pts}</td></tr>`).join("");
      return `<table><tr><th>${esc(t.team)} (${t.points})</th><th class=r>TUH</th>${hp ? "<th class=r>Pwr</th>" : ""}<th class=r>Cor</th>${hn ? "<th class=r>Neg</th>" : ""}<th class=r>Pts</th></tr>${rows}<tr><td>Bonus ${t.bonusPoints}</td><td colspan="${2 + (hp ? 1 : 0) + (hn ? 1 : 0)}" class=r>Total</td><td class=r>${t.points}</td></tr></table>`;
    }).join("");
    return `<h2>Round ${g.round}${g.tiebreaker ? " (TB)" : ""}: ${esc(g.teams.map((t: any) => t.team).join(" vs "))}</h2>${boxes}`;
  }).join("");
  const gamesHtml = pageTpl(`${meta.setName} — Games`, `<h1>${esc(meta.setName)}</h1>${gameBlocks}`);

  return [
    { name: "standings.html", data: standings },
    { name: "individuals.html", data: individuals },
    { name: "games.html", data: gamesHtml },
  ];
}
