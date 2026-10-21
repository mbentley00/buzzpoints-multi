import type { PathFile } from "./migratorFolder";

// Turn a buzzpoint-migrator SQLite database back into the data folder it was
// built from (question_sets/… packet JSON + tournaments/… QBJ), so it takes
// exactly the path an uploaded folder does. Pure: it only needs something that
// runs a query, so it works on sql.js in the browser and in tests alike.

export interface SqlDb { exec(sql: string): { columns: string[]; values: unknown[][] }[] }

export interface DbConvertReport {
  games: number;
  // Bonuses the database records as heard but that no converted tossup in that
  // game could be matched to (they'd be credited to nobody). Normally 0.
  unpairedBonuses: number;
  // Games moved onto the round where their site first read that packet, so a
  // packet read twice (a tiebreak, a replayed round) is one set of questions.
  movedGames: number;
}

type Row = Record<string, any>;
function rows(db: SqlDb, sql: string): Row[] {
  const res = db.exec(sql)[0];
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}
function hasTable(db: SqlDb, name: string) {
  return rows(db, `select name from sqlite_master where type='table' and name='${name}'`).length > 0;
}
const group = <T,>(list: T[], key: (x: T) => string | number) => {
  const m = new Map<string | number, T[]>();
  for (const x of list) { const k = key(x); const a = m.get(k); if (a) a.push(x); else m.set(k, [x]); }
  return m;
};
// A name safe as one path segment. Matching on the other side normalizes away
// punctuation, so this only has to avoid separators and reserved characters.
const seg = (s: string) => String(s || "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "x";
const jsonFile = (path: string, obj: unknown): PathFile => {
  const leaf = path.split("/").pop()!;
  return { path, file: new File([JSON.stringify(obj)], leaf, { type: "application/json" }) };
};

const REQUIRED = ["question_set", "question_set_edition", "packet", "packet_question", "question", "tossup", "bonus", "bonus_part", "tournament", "round", "game", "team", "player", "buzz"];

export function migratorDbToFiles(db: SqlDb): { files: PathFile[]; report: DbConvertReport } {
  const missing = REQUIRED.filter((t) => !hasTable(db, t));
  if (missing.length)
    throw new Error(`Not a buzzpoint-migrator database (no${missing.slice(0, 3).join(", ")} table${missing.length > 1 ? "s" : ""}).`);

  const files: PathFile[] = [];
  const report: DbConvertReport = { games: 0, unpairedBonuses: 0, movedGames: 0 };

  const sets = rows(db, "select id, name, slug, bonuses from question_set");
  const editions = rows(db, "select id, question_set_id, name, slug from question_set_edition");
  const packets = rows(db, "select id, question_set_edition_id, name, number from packet order by question_set_edition_id, number, id");
  const pq = rows(db, "select packet_id, question_number, question_id from packet_question");
  const questions = new Map(rows(db, "select id, author, category_full from question").map((q) => [q.id, q]));
  const tossupByQ = new Map(rows(db, "select id, question_id, question, answer from tossup").map((t) => [t.question_id, t]));
  const bonusByQ = new Map(rows(db, "select id, question_id, leadin from bonus").map((b) => [b.question_id, b]));
  const partsByBonus = group(rows(db, "select id, bonus_id, part_number, part, answer, value, difficulty_modifier from bonus_part order by bonus_id, part_number"), (p) => p.bonus_id);
  const tournaments = rows(db, "select id, name, slug, question_set_edition_id, start_date from tournament order by id");
  const roundsByT = group(rows(db, "select id, tournament_id, number, packet_id from round"), (r) => r.tournament_id);
  const gamesByRound = group(rows(db, "select id, round_id, tossups_read, team_one_id, team_two_id from game order by id"), (g) => g.round_id);
  const teams = new Map(rows(db, "select id, name from team").map((t) => [t.id, t]));
  const players = new Map(rows(db, "select id, team_id, name from player").map((p) => [p.id, p]));
  const buzzByGame = group(rows(db, "select id, player_id, game_id, tossup_id, buzz_position, value from buzz order by game_id, buzz_position, id"), (b) => b.game_id);
  const bpdByGame = hasTable(db, "bonus_part_direct")
    ? group(rows(db, "select team_id, game_id, bonus_part_id, value from bonus_part_direct"), (d) => d.game_id)
    : new Map<string | number, Row[]>();
  const partById = new Map<number, Row>();
  for (const list of partsByBonus.values()) for (const p of list) partById.set(p.id, p);
  const tossupById = new Map<number, Row>();
  for (const t of tossupByQ.values()) tossupById.set(t.id, t);

  const metadata = (qid: number) => {
    const q = questions.get(qid);
    const cat = (q?.category_full || "").trim();
    const author = (q?.author || "").trim();
    return author ? `${author}, ${cat || "Other"}` : cat || "Other";
  };

  // Per packet: its file name (also what each game's `packets` field says) and
  // question numbering, for turning question ids back into numbers.
  const setById = new Map(sets.map((s) => [s.id, s]));
  const edById = new Map(editions.map((e) => [e.id, e]));
  const edPath = (edId: number) => {
    const ed = edById.get(edId)!;
    const set = setById.get(ed.question_set_id)!;
    return `data/question_sets/${seg(set.slug || set.name)}/editions/${seg(ed.slug || ed.name)}`;
  };
  const pqByPacket = group(pq, (r) => r.packet_id);
  const packetInfo = new Map<number, { name: string; tossupNum: Map<number, number>; bonusNum: Map<number, number>; tossups: number }>();
  const usedNames = new Map<number, Set<string>>();
  for (const p of packets) {
    const taken = usedNames.get(p.question_set_edition_id) || new Set<string>();
    usedNames.set(p.question_set_edition_id, taken);
    let name = seg(p.name || `Packet ${p.number}`);
    if (taken.has(name.toLowerCase())) name = `${name} (${p.id})`;
    taken.add(name.toLowerCase());

    const items = [...(pqByPacket.get(p.id) || [])].sort((a, b) => a.question_number - b.question_number);
    const tossupNum = new Map<number, number>(), bonusNum = new Map<number, number>();
    const tus: unknown[] = [], bns: unknown[] = [];
    for (const it of items) {
      const tu = tossupByQ.get(it.question_id);
      const bn = bonusByQ.get(it.question_id);
      if (tu) {
        tossupNum.set(tu.id, it.question_number);
        tus[it.question_number - 1] = { question: tu.question || "", answer: tu.answer || "", metadata: metadata(it.question_id) };
      } else if (bn) {
        bonusNum.set(bn.id, it.question_number);
        const parts = partsByBonus.get(bn.id) || [];
        bns[it.question_number - 1] = {
          leadin: bn.leadin || "",
          parts: parts.map((x) => x.part || ""),
          answers: parts.map((x) => x.answer || ""),
          values: parts.map((x) => Number(x.value) || 10),
          difficultyModifiers: parts.map((x) => x.difficulty_modifier || ""),
          metadata: metadata(it.question_id),
        };
      }
    }
    // A gap in the numbering would leave a hole; fill it so later numbers keep
    // their place (an empty question just never collects stats).
    for (let i = 0; i < tus.length; i++) if (!tus[i]) tus[i] = { question: "", answer: "", metadata: "Other" };
    for (let i = 0; i < bns.length; i++) if (!bns[i]) bns[i] = { leadin: "", parts: [], answers: [], values: [], difficultyModifiers: [], metadata: "Other" };
    packetInfo.set(p.id, { name, tossupNum, bonusNum, tossups: tus.length });
    if (tus.length || bns.length) files.push(jsonFile(`${edPath(p.question_set_edition_id)}/packet_files/${name}.json`, { tossups: tus, bonuses: bns }));
  }

  for (const s of sets) files.push(jsonFile(`data/question_sets/${seg(s.slug || s.name)}/index.json`, { name: s.name, slug: s.slug, bonuses: s.bonuses == null ? true : !!Number(s.bonuses) }));
  for (const e of editions) files.push(jsonFile(`${edPath(e.id)}/index.json`, { name: e.name, slug: e.slug }));

  for (const t of tournaments) {
    const ed = edById.get(t.question_set_edition_id);
    const set = ed && setById.get(ed.question_set_id);
    if (!ed || !set) continue;
    const dir = `data/tournaments/${seg(`${t.id}-${t.slug || t.name}`)}`;
    files.push(jsonFile(`${dir}/index.json`, { name: t.name, slug: t.slug, set: set.name, edition: ed.slug || ed.name, start_date: t.start_date || undefined }));

    const rounds = roundsByT.get(t.id) || [];
    // Each packet is filed under the first (lowest) round this site read it in.
    const packetRound = new Map<number, number>();
    for (const r of [...rounds].sort((a, b) => a.number - b.number)) if (!packetRound.has(r.packet_id)) packetRound.set(r.packet_id, r.number);

    for (const r of rounds) {
      const info = packetInfo.get(r.packet_id);
      if (!info) continue;
      const round = packetRound.get(r.packet_id)!;
      for (const g of gamesByRound.get(r.id) || []) {
        if (round !== r.number) report.movedGames++;
        files.push(jsonFile(`${dir}/game_files/${seg(`Round_${round}_g${g.id}`)}.qbj`, buildGame(g, round, info)));
        report.games++;
      }
    }
  }
  return { files, report };

  function buildGame(g: Row, round: number, info: { name: string; tossupNum: Map<number, number>; bonusNum: Map<number, number>; tossups: number }) {
    const teamName = (id: number) => teams.get(id)?.name || `Team ${id}`;
    const sides = [g.team_one_id, g.team_two_id];
    const buzzes = buzzByGame.get(g.id) || [];
    const byNum = new Map<number, Row[]>();
    let maxNum = 0;
    for (const b of buzzes) {
      const tu = tossupById.get(b.tossup_id);
      const n = tu ? info.tossupNum.get(tu.id) : undefined;
      if (!n) continue;
      maxNum = Math.max(maxNum, n);
      const a = byNum.get(n); if (a) a.push(b); else byNum.set(n, [b]);
    }
    const n = Math.max(maxNum, Math.min(Number(g.tossups_read) || info.tossups, info.tossups));

    // Rosters: who buzzed in this game, by team (the database keeps no lineups).
    const roster = new Map<number, Map<number, { name: string; counts: Map<number, number> }>>(sides.map((s) => [s, new Map()]));
    const teamOfPlayer = (pid: number) => players.get(pid)?.team_id;
    for (const b of buzzes) {
      const tid = teamOfPlayer(b.player_id);
      if (tid == null || !roster.has(tid)) continue;
      const m = roster.get(tid)!;
      if (!m.has(b.player_id)) m.set(b.player_id, { name: players.get(b.player_id)?.name || `Player ${b.player_id}`, counts: new Map() });
      const c = m.get(b.player_id)!.counts;
      c.set(Number(b.value), (c.get(Number(b.value)) || 0) + 1);
    }
    const teamObj = (tid: number) => ({ name: teamName(tid), players: [...(roster.get(tid)?.values() || [])].map((p) => ({ name: p.name })) });

    // Bonuses heard: per (team, bonus) the parts it earned.
    const heard = new Map<string, { team: number; num: number; parts: Map<number, number> }>();
    for (const d of bpdByGame.get(g.id) || []) {
      const part = partById.get(d.bonus_part_id);
      if (!part) continue;
      const bn = info.bonusNum.get(part.bonus_id);
      if (!bn) continue;
      const key = `${d.team_id}|${bn}`;
      if (!heard.has(key)) heard.set(key, { team: d.team_id, num: bn, parts: new Map() });
      heard.get(key)!.parts.set(part.part_number, Number(d.value) || 0);
    }
    const heardList = [...heard.values()].sort((a, b) => a.num - b.num);
    // Who converted each tossup.
    const converted: { num: number; team: number }[] = [];
    for (let i = 1; i <= n; i++) {
      const win = (byNum.get(i) || []).find((b) => Number(b.value) > 0);
      const tid = win ? teamOfPlayer(win.player_id) : undefined;
      if (tid != null) converted.push({ num: i, team: tid });
    }
    // A bonus goes with the tossup that earned it. In order is the norm (the
    // k-th converted tossup earns the k-th bonus read); when the teams don't line
    // up that way, pair within each team instead.
    const bonusAt = new Map<number, (typeof heardList)[number]>();
    const inOrder = heardList.length === converted.length && heardList.every((h, i) => h.team === converted[i].team);
    if (inOrder) heardList.forEach((h, i) => bonusAt.set(converted[i].num, h));
    else {
      for (const tid of sides) {
        const conv = converted.filter((c) => c.team === tid);
        const hb = heardList.filter((h) => h.team === tid);
        hb.forEach((h, i) => { if (conv[i]) bonusAt.set(conv[i].num, h); else report.unpairedBonuses++; });
      }
    }

    const bonusPoints = new Map<number, number>(sides.map((s) => [s, 0]));
    const match_questions = [];
    for (let i = 1; i <= n; i++) {
      const mq: any = {
        question_number: i,
        tossup_question: { parts: 1, type: "tossup", question_number: i },
        buzzes: (byNum.get(i) || []).map((b) => {
          const tid = teamOfPlayer(b.player_id)!;
          return {
            buzz_position: { word_index: Number(b.buzz_position) || 0 },
            player: { name: players.get(b.player_id)?.name || `Player ${b.player_id}` },
            team: teamObj(tid),
            result: { value: Number(b.value) || 0 },
          };
        }),
      };
      const h = bonusAt.get(i);
      if (h) {
        const partNums = [...h.parts.keys()];
        const count = Math.max(3, ...partNums);
        const parts = Array.from({ length: count }, (_, k) => ({ controlled_points: h.parts.get(k + 1) || 0 }));
        bonusPoints.set(h.team, (bonusPoints.get(h.team) || 0) + parts.reduce((a, p) => a + p.controlled_points, 0));
        mq.bonus = { question: { parts: count, type: "bonus", question_number: h.num }, parts };
      }
      match_questions.push(mq);
    }

    return {
      _round: round,
      packets: info.name,
      tossups_read: n,
      match_teams: sides.map((tid) => ({
        team: teamObj(tid),
        bonus_points: bonusPoints.get(tid) || 0,
        lineups: [{ first_question: 1, players: teamObj(tid).players }],
        match_players: [...(roster.get(tid)?.values() || [])].map((p) => ({
          player: { name: p.name },
          tossups_heard: n,
          answer_counts: [...p.counts].map(([value, number]) => ({ answer: { value }, number })),
        })),
      })),
      match_questions,
    };
  }
}
