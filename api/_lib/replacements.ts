// Tiebreakers and replacement questions the packets don't contain.
//
// A game file only ever says "this room read tossup 22 of round 7" (or bonus
// 22) — QBJ keeps question text out of game files on purpose, and we don't
// change that. So a buzz or bonus result meets its question by (round, number)
// in that round's packet, and when a room read a tiebreaker or a replacement
// that isn't in the packet JSON, it has nothing to land on. Worse, two rooms
// can both call different questions "#21".
//
// scanMissingQuestions() finds every tossup and bonus a game read that its
// packet lacks. The owner then maps each one — for a whole round, or one game
// at a time — to a question in any uploaded packet (typically a tiebreaker
// packet uploaded on its own round). applyReplacements() runs before anything
// else in aggregation: it copies the mapped question into the round the game
// was played in, at a slot of its own, and points the game at that slot. The
// game files themselves are never rewritten, so a re-upload doesn't fight an
// old mapping and removing a mapping puts everything back.
import { GameFile, PacketFile, tokenize } from "./aggregate.js";
import type { Edition } from "./sets.js";

export type QuestionKind = "tossups" | "bonuses";
export interface ReplacementTarget { editionId: string; round: number; num: number }
export interface QuestionReplacement {
  // Absent on rules saved before bonuses could be mapped: those are tossups.
  kind?: QuestionKind;
  editionId: string;
  round: number;        // the round the game was played in, as uploaded
  num: number;          // the question number the game file recorded
  game: string | null;  // gameKeyOf() one game, or null for every game in that round
  target: ReplacementTarget;
  by?: string;
  at?: string;
}

type MQ = NonNullable<GameFile["match_questions"]>[number];
const kindOf = (r: { kind?: QuestionKind }): QuestionKind => r.kind ?? "tossups";
// Where each kind's number lives in a game's question record, and how to move it.
const numOf = (kind: QuestionKind, mq: MQ) =>
  kind === "tossups" ? mq.tossup_question?.question_number : mq.bonus?.question?.question_number;
const withNum = (kind: QuestionKind, mq: MQ, n: number): MQ =>
  kind === "tossups"
    ? { ...mq, tossup_question: { ...mq.tossup_question, question_number: n } }
    : { ...mq, bonus: { ...mq.bonus, question: { ...mq.bonus!.question, question_number: n } } };
const KINDS: QuestionKind[] = ["tossups", "bonuses"];

const teamsOf = (g: GameFile) => (g.match_teams || []).map((t) => t?.team?.name).filter(Boolean) as string[];
// A game's identity that survives other games being removed (source indexes
// shift): its round and who played. Two copies of one matchup are the same game.
export const gameKeyOf = (g: GameFile) => `${g.round}:${[...teamsOf(g)].sort().join(" | ")}`;
export const replacementKey = (r: Pick<QuestionReplacement, "kind" | "editionId" | "round" | "num" | "game">) =>
  `${kindOf(r)}|${r.editionId}|${r.round}|${r.num}|${r.game ?? "*"}`;
const targetKey = (t: ReplacementTarget) => `${t.editionId}|${t.round}|${t.num}`;

// The packet a round's games are matched against. Two files on one round
// overwrite each other downstream with the later one winning, so do the same.
function packetOn(e: Edition, round: number): PacketFile | undefined {
  let found: PacketFile | undefined;
  for (const p of e.packets || []) if (p.round === round) found = p;
  return found;
}
const questionsOf = (p: PacketFile | undefined, kind: QuestionKind): any[] => (p?.[kind] as any[]) || [];

export function applyReplacements(editions: Edition[], rules: QuestionReplacement[]): Edition[] {
  if (!rules.length) return editions;
  const byId = new Map(editions.map((e) => [e.id, e]));
  const questionAt = (kind: QuestionKind, t: ReplacementTarget) => {
    const e = byId.get(t.editionId);
    return e ? questionsOf(packetOn(e, t.round), kind)[t.num - 1] : undefined;
  };
  // Packets used only as a source — a tiebreaker packet, filed on a round no
  // game in its edition was played in. Their questions are copied to where they
  // were read, so leaving the packet in place would list them a second time,
  // unheard, and raise a "packet has no games" warning about it.
  const sourceRounds = new Map<string, Set<number>>();
  for (const r of rules) {
    let s = sourceRounds.get(r.target.editionId);
    if (!s) { s = new Set(); sourceRounds.set(r.target.editionId, s); }
    s.add(r.target.round);
  }

  return editions.map((e) => {
    const mine = rules.filter((r) => r.editionId === e.id && questionAt(kindOf(r), r.target));
    const played = new Set((e.games || []).map((g) => g.round));
    const dropRounds = [...(sourceRounds.get(e.id) || [])].filter((r) => !played.has(r));
    if (!mine.length && !dropRounds.length) return e;

    // A rule for this one game wins over a rule for its whole round.
    const ruleFor = (kind: QuestionKind, g: GameFile, num: number) => {
      const k = gameKeyOf(g);
      const of = mine.filter((r) => kindOf(r) === kind && r.round === g.round && r.num === num);
      return of.find((r) => r.game === k) ?? of.find((r) => r.game === null);
    };

    // round -> kind -> new question list, and `${kind}|${round}|${num}|${target}` -> slot
    const newLists = new Map<number, Partial<Record<QuestionKind, any[]>>>();
    const slotOf = new Map<string, number>();
    for (const kind of KINDS) {
      // Which questions each recorded number stands for, round by round ("-" = no rule).
      const uses = new Map<number, Map<number, Set<string>>>();
      for (const g of e.games || [])
        for (const mq of g.match_questions || []) {
          const num = numOf(kind, mq);
          if (num == null) continue;
          const rule = ruleFor(kind, g, num);
          let byNum = uses.get(g.round);
          if (!byNum) { byNum = new Map(); uses.set(g.round, byNum); }
          let s = byNum.get(num);
          if (!s) { s = new Set(); byNum.set(num, s); }
          s.add(rule ? targetKey(rule.target) : "-");
        }

      // Give each mapped question a slot in the round it was read in. It keeps the
      // number the game recorded when that slot is free and nobody else used that
      // number for something different; otherwise it goes past every number in
      // use, so it can never swallow another room's results.
      for (const [round, byNum] of uses) {
        if (![...byNum.values()].some((s) => [...s].some((k) => k !== "-"))) continue;
        const list = [...questionsOf(packetOn(e, round), kind)];
        let next = Math.max(list.length, ...byNum.keys());
        const placed = new Map<string, number>(); // the same question read at two numbers shares one slot
        for (const num of [...byNum.keys()].sort((a, b) => a - b)) {
          const keys = byNum.get(num)!;
          for (const tk of [...keys].sort()) {
            if (tk === "-") continue;
            let slot = placed.get(tk);
            if (slot === undefined) {
              slot = keys.size === 1 && !list[num - 1] ? num : ++next;
              const r = mine.find((x) => kindOf(x) === kind && targetKey(x.target) === tk)!;
              list[slot - 1] = questionAt(kind, r.target);
              placed.set(tk, slot);
            }
            slotOf.set(`${kind}|${round}|${num}|${tk}`, slot);
          }
        }
        newLists.set(round, { ...(newLists.get(round) || {}), [kind]: list });
      }
    }

    let packets = (e.packets || []).filter((p) => !dropRounds.includes(p.round));
    for (const [round, lists] of newLists) {
      const at = packets.map((p) => p.round).lastIndexOf(round);
      if (at >= 0) packets = packets.map((p, i) => (i === at ? { ...p, ...lists } : p));
      else packets = [...packets, { round, tossups: [], bonuses: [], ...lists }];
    }
    const games = (e.games || []).map((g) => {
      if (!newLists.has(g.round)) return g;
      let changed = false;
      const match_questions = (g.match_questions || []).map((mq) => {
        for (const kind of KINDS) {
          const num = numOf(kind, mq);
          if (num == null) continue;
          const rule = ruleFor(kind, g, num);
          const slot = rule && slotOf.get(`${kind}|${g.round}|${num}|${targetKey(rule.target)}`);
          if (slot && slot !== num) { mq = withNum(kind, mq, slot); changed = true; }
        }
        return mq;
      });
      return changed ? { ...g, match_questions } : g;
    });
    return { ...e, packets, games };
  });
}

/* ------------------------------- detection ------------------------------- */
export interface MissingBuzz { player: string | null; team: string | null; word: number | null; value: number | null }
// What a game recorded on a bonus: who had it, and the points per part.
export interface MissingBonusResult { team: string | null; parts: number[] }
export interface MissingGame { key: string; teams: string[]; buzzes: MissingBuzz[]; bonuses: MissingBonusResult[] }
export interface MissingQuestion {
  kind: QuestionKind;
  editionId: string;
  round: number;
  num: number;
  packetCount: number;   // how many questions of this kind that round's packet has
  games: MissingGame[];
}

const pts = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Every tossup and bonus a game read that its round's packet doesn't have. A
// round with no packet at all is left to the round-alignment warning, an
// edition uploaded without packets has nothing to look anything up in, and a
// packet with no bonuses in it means a set without bonus text, not a
// replacement.
export function scanMissingQuestions(editions: Edition[], hasBonuses = true): MissingQuestion[] {
  const out = new Map<string, MissingQuestion>();
  const kinds: QuestionKind[] = hasBonuses ? KINDS : ["tossups"];
  for (const e of editions) {
    for (const g of e.games || []) {
      const pkt = packetOn(e, g.round);
      for (const kind of kinds) {
        const list = questionsOf(pkt, kind);
        if (!list.some(Boolean)) continue;
        for (const mq of g.match_questions || []) {
          const num = numOf(kind, mq);
          if (num == null || num < 1 || list[num - 1]) continue;
          const k = `${kind}|${e.id}|${g.round}|${num}`;
          let m = out.get(k);
          if (!m) { m = { kind, editionId: e.id, round: g.round, num, packetCount: list.length, games: [] }; out.set(k, m); }
          const key = gameKeyOf(g);
          let mg = m.games.find((x) => x.key === key);
          if (!mg) { mg = { key, teams: teamsOf(g), buzzes: [], bonuses: [] }; m.games.push(mg); }
          if (kind === "tossups")
            for (const b of mq.buzzes || [])
              mg.buzzes.push({
                player: b.player?.name ?? null, team: b.team?.name ?? null,
                word: b.buzz_position?.word_index ?? null,
                value: b.result?.value == null ? null : Number(b.result.value),
              });
          else
            mg.bonuses.push({
              // The bonus belongs to whoever got the tossup.
              team: (mq.buzzes || []).find((b) => pts(b.result?.value) > 0)?.team?.name ?? null,
              parts: (mq.bonus?.parts || []).map((p) => pts(p.controlled_points)),
            });
        }
      }
    }
  }
  const kindOrder = (k: QuestionKind) => (k === "tossups" ? 0 : 1);
  return [...out.values()].sort((a, b) =>
    kindOrder(a.kind) - kindOrder(b.kind) || a.editionId.localeCompare(b.editionId) || a.round - b.round || a.num - b.num);
}

// The questions an owner can map a missing one to: every uploaded packet, with
// each tossup's answer and length (a buzz past a question's last word rules
// that question out) and each bonus's answers and part count, plus whether any
// game in the edition was played on that round — a packet nobody played from
// is most likely the tiebreakers.
export function replacementCandidates(editions: Edition[]) {
  const strip = (s: string | undefined) => (s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + "…" : s);
  const primary = (s: string | undefined) => strip(s).split(/\s*[[(]/)[0];
  return editions.map((e) => {
    const played = new Set((e.games || []).map((g) => g.round));
    const rounds = [...new Set((e.packets || []).map((p) => p.round))].sort((a, b) => a - b);
    return {
      id: e.id,
      packets: rounds.map((round) => {
        const p = packetOn(e, round);
        return {
          round,
          played: played.has(round),
          tossups: (p?.tossups || []).map((t, i) => (t
            ? { num: i + 1, answer: clip(strip(t.answer), 80), words: tokenize(t.question || "").words.length }
            : null)).filter(Boolean),
          bonuses: (p?.bonuses || []).map((b, i) => (b
            ? { num: i + 1, answer: clip((b.answers || []).map(primary).join(" / "), 90), parts: Math.max((b.parts || []).length, (b.answers || []).length) }
            : null)).filter(Boolean),
        };
      }),
    };
  });
}

// "Round 7 read #21 and #22, but its packet stops at 20" — when an edition has
// exactly one packet no game was played from, the overflow almost certainly
// came from it in order: #21 is its first question, #22 its second.
export function suggestReplacement(m: MissingQuestion, editions: Edition[]): ReplacementTarget | null {
  const e = editions.find((x) => x.id === m.editionId);
  if (!e || m.num <= m.packetCount) return null;
  const played = new Set((e.games || []).map((g) => g.round));
  const spare = [...new Set((e.packets || []).map((p) => p.round))].filter((r) => !played.has(r));
  if (spare.length !== 1) return null;
  const idx = m.num - m.packetCount;
  return questionsOf(packetOn(e, spare[0]), m.kind)[idx - 1] ? { editionId: e.id, round: spare[0], num: idx } : null;
}
