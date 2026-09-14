// MODAQ's saved game (the .json it keeps as game state) holds everything a QBJ
// does — every buzz, bonus part and substitution — but as MODAQ's internal
// "cycles" rather than a QB Schema match. Uploaded as-is it became a game with no
// teams and no questions, counted in Settings yet adding nothing to any stat.
//
// So it's converted into the QBJ MODAQ itself would have exported. This is a
// port of MODAQ's toQBJ (src/qbj/QBJ.ts) and the GameState / Tossup logic it
// leans on, so a saved game and its QBJ export give the same stats: buzz values
// are recomputed from the buzz position and the packet's power mark (MODAQ
// doesn't trust the saved `points` either), overtime past a decided game is
// dropped, and lineups decide who heard each tossup.

type Fmt = {
  powers: { marker: string; points: number }[];
  negValue: number;
  regulationTossupCount: number;
  minimumOvertimeQuestionCount: number;
  pronunciationGuideMarkers: [string, string];
  bonusesBounceBack: boolean;
  pairTossupsBonuses: boolean;
};
const DEFAULT_FMT: Fmt = {
  powers: [], negValue: -5, regulationTossupCount: 20, minimumOvertimeQuestionCount: 1,
  pronunciationGuideMarkers: ["(", ")"], bonusesBounceBack: false, pairTossupsBonuses: false,
};

export function isModaqGame(d: unknown): boolean {
  const g = d as any;
  return !!g && typeof g === "object" && Array.isArray(g.cycles) && Array.isArray(g.players) && !Array.isArray(g.match_questions);
}

/* ---------------- word numbering (MODAQ FormattedTextParser) ---------------- */
// Buzz positions index MODAQ's word list, so power and "end of question" have to
// be judged against that same list: pronunciation guides, reader directives and
// power marks aren't words, and a final END slot is.

const READER_DIRECTIVES = ["(emphasize)", "(emphasise)", "(pause)", "(read slowly)", "[emphasize]", "[emphasise]", "[pause]", "[read slowly]"];
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Seg = { text: string; pron: boolean };

function parseFormatted(text: string, guide: [string, string]): Seg[] {
  const out: Seg[] = [];
  const guides: [string, string][] = [guide];
  if (guide[0].includes('"') || guide[1].includes('"')) guides.push([guide[0].replace(/"/g, "“"), guide[1].replace(/"/g, "”")]);
  if (guide[0].includes("“") || guide[1].includes("”")) guides.push([guide[0].replace(/“/g, '"'), guide[1].replace(/”/g, '"')]);
  let extra = "";
  for (const g of guides) extra += `|${esc(g[0])}|${esc(g[1])}`;
  extra += `|${READER_DIRECTIVES.map(esc).join("|")}`;

  let pron = false;
  let start = 0;
  for (const m of text.matchAll(new RegExp(`<\\/?em>|<\\/?req>|<\\/?b>|<\\/?u>|<\\/?sub>|<\\/?sup>${extra}`, "gi"))) {
    const tag = m[0];
    const norm = tag.toLowerCase();
    const at = m.index ?? 0;
    // A guide's closing mark stays with the guide's text.
    let closeLen = 0;
    for (const g of guides) if (norm === g[1].toLowerCase()) { closeLen = g[1].length; break; }
    const slice = text.substring(start, at + closeLen);
    if (slice.length > 0) out.push({ text: slice, pron });

    let skip = true;
    if (!/^<\/?(em|req|b|u|sub|sup)>$/.test(norm)) {
      let matched = false;
      for (const g of guides) {
        if (norm === g[0].toLowerCase()) { skip = false; pron = true; matched = true; }
        else if (norm === g[1].toLowerCase()) { pron = false; matched = true; }
      }
      if (!matched && READER_DIRECTIVES.some((d) => d.trim().toLowerCase() === norm)) out.push({ text: tag, pron: true });
    }
    start = skip ? at + tag.length : at;
  }
  if (start < text.length) out.push({ text: text.substring(start), pron });
  return out;
}

function splitWords(text: string, guide: [string, string]): Seg[][] {
  const words: Seg[][] = [];
  let prev: Seg[] = [];
  for (const v of parseFormatted(text, guide)) {
    const parts = v.text.split(/\s+/g);
    if (parts.length === 1) { prev.push(v); continue; }
    if (parts[0].length > 0) prev.push({ text: parts[0], pron: v.pron });
    words.push(prev);
    prev = [];
    const last = parts.length - 1;
    for (let i = 1; i < last; i++) if (parts[i].length > 0) words.push([{ text: parts[i], pron: v.pron }]);
    if (parts[last].length > 0) prev.push({ text: parts[last], pron: v.pron });
  }
  if (prev.length > 0) words.push(prev);
  return words;
}

type TWord = { text: string; textIndex: number; canBuzzOn: boolean; wordIndex: number; nonWordIndex: number };

function tossupWords(question: string, f: Fmt): TWord[] {
  const texts = splitWords(question, f.pronunciationGuideMarkers).concat([[{ text: "■END■", pron: false }]]);
  const out: TWord[] = [];
  let wi = 0;
  let nwi = 0;
  texts.forEach((word, i) => {
    const full = word.map((s) => s.text).join("");
    const trimmed = full.trim();
    if (i === texts.length - 1) {
      out.push({ text: full, textIndex: i, canBuzzOn: true, wordIndex: wi++, nonWordIndex: -1 });
    } else if (f.powers.some((p) => trimmed.startsWith(p.marker)) || (word.length > 0 && word[0].pron)) {
      out.push({ text: full, textIndex: i, canBuzzOn: false, wordIndex: -1, nonWordIndex: nwi++ });
    } else {
      out.push({ text: full, textIndex: i, canBuzzOn: true, wordIndex: wi++, nonWordIndex: -1 });
    }
  });
  return out;
}

// Tossup.getPointsAtPosition
function pointsAt(words: TWord[], f: Fmt, wordIndex: number, isCorrect: boolean): number {
  if (f.powers.length === 0 && isCorrect) return 10;
  const texts = words.map((w) => w.text.trim());
  const lastIndex = texts.length - 1;
  let pmi = 0;
  for (const power of f.powers) {
    const marker = power.marker.trim();
    const cur = texts.findIndex((v, idx) => idx >= pmi && v.startsWith(marker));
    if (cur === -1) continue;
    pmi = cur;
    const w = words[pmi];
    if (isCorrect && pmi !== lastIndex && !w.canBuzzOn && wordIndex < w.textIndex - w.nonWordIndex) return power.points;
  }
  // A wrong answer at the very end of the question isn't a neg.
  if (!isCorrect) return wordIndex >= words[words.length - 1].wordIndex ? 0 : f.negValue;
  return 10;
}

/* ---------------------------- conversion ---------------------------- */

type BonusPart = { teamName: string; points: number };

export function modaqToQbj(game: any): Record<string, any> {
  const f: Fmt = { ...DEFAULT_FMT, ...(game.gameFormat || {}) };
  if (!Array.isArray(f.powers)) f.powers = [];
  if (!Array.isArray(f.pronunciationGuideMarkers) || f.pronunciationGuideMarkers.length !== 2) f.pronunciationGuideMarkers = DEFAULT_FMT.pronunciationGuideMarkers;

  const tossups: { question?: string }[] = game.packet?.tossups || [];
  const players: { name: string; teamName: string; isStarter?: boolean }[] =
    (game.players || []).filter((p: any) => p && typeof p.name === "string" && typeof p.teamName === "string");
  const cycles: any[] = (game.cycles || []).filter(Boolean);
  // GameState.teamNames: in order of first appearance on the roster.
  const teamNames = [...new Set(players.map((p) => p.teamName))];

  const wordCache = new Map<number, TWord[]>();
  const buzzValue = (b: any): number => {
    const t = tossups[b?.tossupIndex];
    if (t == null) return 0;
    let words = wordCache.get(b.tossupIndex);
    if (!words) { words = tossupWords(String(t.question ?? ""), f); wordCache.set(b.tossupIndex, words); }
    return pointsAt(words, f, Number(b.marker?.position) || 0, (b.marker?.points ?? 0) > 0);
  };

  // Old saves only list the parts that were answered (correctParts).
  const bonusParts = (ba: any): BonusPart[] => {
    if (Array.isArray(ba?.parts)) return ba.parts.map((p: any) => ({ teamName: String(p?.teamName ?? ""), points: Number(p?.points) || 0 }));
    const old: { index: number; points: number }[] = Array.isArray(ba?.correctParts) ? ba.correctParts : [];
    const n = Math.max(3, ...old.map((p) => p.index + 1));
    return Array.from({ length: n }, (_, i) => {
      const hit = old.find((p) => p.index === i);
      return hit ? { teamName: String(ba.receivingTeamName ?? ""), points: Number(hit.points) || 0 } : { teamName: "", points: 0 };
    });
  };

  // Cycle.firstWrongBuzz: the earliest wrong buzz, first-recorded on a tie.
  const firstWrong = (c: any) => {
    const w: any[] = c.wrongBuzzes || [];
    if (!w.length) return undefined;
    const earliest = Math.min(...w.map((b) => Number(b.marker?.position) || 0));
    return w.find((b) => (Number(b.marker?.position) || 0) === earliest);
  };

  // GameState.getScoreChangeFromCycle
  const scoreChange = (c: any): number[] => {
    const ch = teamNames.map(() => 0);
    if (c.correctBuzz) {
      const correctTeam = c.correctBuzz.marker?.player?.teamName;
      const ti = teamNames.indexOf(correctTeam);
      if (ti >= 0) {
        ch[ti] += buzzValue(c.correctBuzz);
        if (c.bonusAnswer) for (const p of bonusParts(c.bonusAnswer)) {
          if (p.teamName === "") continue;
          const bi = p.teamName === correctTeam ? ti : teamNames.indexOf(p.teamName);
          if (bi >= 0) ch[bi] += p.points;
        }
      }
    }
    if ((c.wrongBuzzes || []).length && f.negValue !== 0) {
      const neg = firstWrong(c);
      const ni = teamNames.indexOf(neg?.marker?.player?.teamName);
      if (ni >= 0) ch[ni] += buzzValue(neg);
    }
    return ch;
  };

  // GameState.playableCycles: past regulation, stop at the first checkpoint
  // where the game isn't tied (leftover overtime cycles were never played).
  let playable = cycles;
  if (cycles.length > f.regulationTossupCount) {
    const running = teamNames.map(() => 0);
    const scores = cycles.map((c) => { scoreChange(c).forEach((v, i) => (running[i] += v)); return [...running]; });
    for (let i = f.regulationTossupCount - 1; i < cycles.length; i += Math.max(1, f.minimumOvertimeQuestionCount)) {
      let tied = false;
      let max = -Infinity;
      for (const s of scores[i]) { if (s > max) { max = s; tied = false; } else if (s === max) tied = true; }
      if (!tied) { playable = cycles.slice(0, i + 1); break; }
    }
  }

  type QPlayer = { name: string };
  type Lineup = { first_question: number; players: QPlayer[] };
  const teams = new Map<string, { name: string; players: QPlayer[] }>();
  const lineups = new Map<string, Lineup>();
  const matchTeams = new Map<string, any>();
  for (const name of teamNames) {
    const team = { name, players: [] as QPlayer[] };
    const first: Lineup = { first_question: 1, players: [] };
    teams.set(name, team);
    lineups.set(name, first);
    matchTeams.set(name, {
      bonus_points: 0,
      ...(f.bonusesBounceBack ? { bonus_bounceback_points: 0 } : {}),
      lineups: [first], match_players: [], team,
    });
  }
  for (const p of players) {
    const qp = { name: p.name };
    if (p.isStarter) lineups.get(p.teamName)!.players.push(qp);
    const mt = matchTeams.get(p.teamName)!;
    mt.match_players.push({ player: qp, answer_counts: [], tossups_heard: 0 });
    mt.team.players.push(qp);
  }

  const matchQuestions: any[] = [];
  const notes: string[] = [];
  let tossupNumber = 1;
  let bonusNumber = 1;

  playable.forEach((c, i) => {
    // Lineup changes take effect on this question.
    if (c.playerLeaves || c.playerJoins || c.subs) {
      const changed = new Set<string>();
      for (const e of c.playerLeaves || []) {
        const t = e?.outPlayer?.teamName;
        const l = lineups.get(t);
        if (!l) continue;
        lineups.set(t, { first_question: i + 1, players: l.players.filter((p) => p.name !== e.outPlayer.name) });
        changed.add(t);
      }
      for (const e of c.playerJoins || []) {
        const t = e?.inPlayer?.teamName;
        const l = lineups.get(t);
        // An inactive join only adds someone to the roster.
        if (!l || e.isInactive) continue;
        lineups.set(t, { first_question: i + 1, players: l.players.concat({ name: e.inPlayer.name }) });
        changed.add(t);
      }
      for (const e of c.subs || []) {
        const t = e?.inPlayer?.teamName;
        const l = lineups.get(t);
        if (!l) continue;
        lineups.set(t, { first_question: i + 1, players: l.players.filter((p) => p.name !== e.outPlayer?.name).concat({ name: e.inPlayer.name }) });
        changed.add(t);
      }
      for (const t of changed) matchTeams.get(t)!.lineups.push(lineups.get(t)!);
    }
    for (const mt of matchTeams.values()) {
      const l = lineups.get(mt.team.name)!;
      for (const mp of mt.match_players) if (l.players.some((p) => p.name === mp.player.name)) mp.tossups_heard++;
    }

    let replacementTossup: any;
    for (const t of c.thrownOutTossups || []) {
      notes.push(`Tossup thrown out on question ${t.questionIndex + 1}`);
      if (t.replacementQuestionIndex == null) {
        tossupNumber++;
        replacementTossup = { parts: 1, question_number: tossupNumber, type: "tossup" };
      } else {
        replacementTossup = { parts: 1, question_number: t.replacementQuestionIndex + 1, type: "tossup" };
      }
    }
    let replacementBonusIndex: number | undefined;
    for (const t of c.thrownOutBonuses || []) {
      notes.push(`Bonus thrown out on question ${t.questionIndex + 1}`);
      if (t.replacementQuestionIndex == null) bonusNumber++;
      else replacementBonusIndex = t.replacementQuestionIndex;
    }

    const mq: any = {
      question_number: i + 1,
      buzzes: [],
      tossup_question: { parts: 1, type: "tossup", question_number: tossupNumber },
      ...(replacementTossup ? { replacement_tossup_question: replacementTossup } : {}),
    };

    // Cycle.orderedBuzzes: wrong buzzes by position, then the correct one. Only
    // the first buzz of a question can be a neg.
    const wrong = [...(c.wrongBuzzes || [])].sort((a: any, b: any) =>
      a.tossupIndex < b.tossupIndex ? -1 : (Number(a.marker?.position) || 0) - (Number(b.marker?.position) || 0));
    const ordered = c.correctBuzz ? [...wrong, c.correctBuzz] : wrong;
    ordered.forEach((b: any, j: number) => {
      const team = teams.get(b.marker?.player?.teamName);
      if (!team) return;
      let value = buzzValue(b);
      if (value === f.negValue && j > 0) value = 0;
      const name = b.marker.player.name;
      mq.buzzes.push({ buzz_position: { word_index: b.marker.position }, player: { name }, team, result: { value } });
      const mp = matchTeams.get(team.name)!.match_players.find((x: any) => x.player.name === name);
      if (mp) {
        const count = mp.answer_counts.find((a: any) => a.answer.value === value);
        if (count) count.number++;
        else mp.answer_counts.push({ answer: { value }, number: 1 });
      }
    });

    if (c.correctBuzz && c.bonusAnswer) {
      const mt = matchTeams.get(c.bonusAnswer.receivingTeamName);
      const other = [...matchTeams.values()].find((t) => t !== mt);
      const answered = bonusParts(c.bonusAnswer);
      const parts = answered.map((p) => {
        const part: any = { controlled_points: 0 };
        if (mt && p.teamName === c.correctBuzz.marker?.player?.teamName) {
          part.controlled_points = p.points;
          if (f.bonusesBounceBack) part.bounceback_points = 0;
          mt.bonus_points += p.points;
        } else if (other) {
          part.bounceback_points = p.points;
          if (other.bonus_bounceback_points != null) other.bonus_bounceback_points += p.points;
        }
        return part;
      });
      const question = { parts: answered.length, type: "bonus", question_number: bonusNumber };
      if (replacementBonusIndex != null) {
        // A protest replacement: the bonus read is the replacement, and `bonus`
        // stays a bare marker for the scheduled one.
        mq.replacement_bonus = { question: { ...question, question_number: replacementBonusIndex + 1 }, parts };
        mq.bonus = { question, parts: [] };
      } else {
        mq.bonus = { question, parts };
      }
      bonusNumber++;
    }
    if (!c.correctBuzz && f.pairTossupsBonuses) bonusNumber++;

    for (const p of c.tossupProtests || [])
      notes.push(`Tossup protest on tossup #${p.questionIndex + 1}. Team "${p.teamName}" protested because of this reason: "${p.reason}".`);
    for (const p of c.bonusProtests || [])
      notes.push(`Bonus protest on bonus #${p.questionIndex + 1}. Team "${p.teamName}" protested part ${p.partIndex + 1} because of this reason: "${p.reason}".`);

    matchQuestions.push(mq);
    tossupNumber++;
  });

  const overtime = Math.max(0, playable.length - f.regulationTossupCount);
  const match: Record<string, any> = {
    tossups_read: playable.length,
    ...(overtime > 0 ? { overtime_tossups_read: overtime } : {}),
    match_teams: [...matchTeams.values()],
    match_questions: matchQuestions,
    ...(notes.length ? { notes: notes.join("\n") } : {}),
  };
  const packetName = game.packet?.name;
  if (typeof packetName === "string" && packetName) {
    const dot = packetName.lastIndexOf(".");
    match.packets = dot > 0 ? packetName.slice(0, dot) : packetName;
  }
  return match;
}
