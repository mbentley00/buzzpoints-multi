// Regression tests for bugs that reached the live site. Each builds a tiny
// tournament by hand, aggregates it the way a rebuild does, and checks both the
// specific numbers and the general integrity checks.   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { aggregate, VirtualCategory } from "../api/_lib/aggregate.ts";
import { getScoring } from "../api/_lib/scoring.ts";
import { checkIntegrity } from "../api/_lib/integrity.ts";
import { settleSiteGames } from "../src/migratorFolder.ts";

const cfg = { name: "t", slug: "t", scoring: getScoring("ACF"), hasBonuses: false } as any;
const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

// A packet whose tossups have the given categories, answers unique per round.
const packet = (round: number, cats: string[]) => ({
  round,
  tossups: cats.map((c, i) => ({ question: words(40, `r${round}q${i}w`), answer: `answer ${round} ${i} ${c}`, metadata: `<Writer, ${c}>` })),
  bonuses: [],
});

type Buzz = { q: number; player: string; team: string; value: number };
// One game: two teams of listed players, every player hearing every tossup.
function game(round: number, nTu: number, teams: Record<string, string[]>, buzzes: Buzz[], heard: Record<string, number> = {}) {
  return {
    round,
    match_teams: Object.entries(teams).map(([name, ps]) => ({
      team: { name, players: ps.map((p) => ({ name: p })) },
      // answer_counts marks the lineup as complete (as MODAQ's are): anyone not
      // listed didn't play.
      match_players: ps.map((p) => ({ player: { name: p }, tossups_heard: heard[p] ?? nTu, answer_counts: [] })),
      bonus_points: 0,
    })),
    match_questions: Array.from({ length: nTu }, (_, i) => ({
      question_number: i + 1,
      tossup_question: { question_number: i + 1 },
      buzzes: buzzes.filter((b) => b.q === i + 1).map((b) => ({
        player: { name: b.player }, team: { name: b.team }, buzz_position: { word_index: 20 }, result: { value: b.value },
      })),
    })),
  };
}

const catRow = (out: any, label: string, player: string) => {
  const c = Object.values<any>(out["categories_players.json"]).find((x) => x.category === label);
  return c?.players.find((p: any) => p.name === player);
};

test("category TUH counts subcategories the player never buzzed in (merged category)", () => {
  // 4 Current Events + 4 Geography per round; Ari only ever buzzes on Geography.
  const cats = [...Array(4).fill("Current Events"), ...Array(4).fill("Geography")];
  const packets = [packet(1, cats), packet(2, cats)];
  const g = (r: number) => game(r, 8, { A: ["Ari", "Bea"], B: ["Cy"] }, [{ q: 5, player: "Ari", team: "A", value: 10 }]);
  const merged: VirtualCategory[] = [{ name: "Other", members: ["Current Events", "Geography"] }];
  const out: any = aggregate(packets as any, [g(1), g(2)] as any, cfg, [], merged);
  assert.equal(catRow(out, "Other", "Ari").tuh, 16, "Other = 2 games x 8 tossups");
  assert.equal(catRow(out, "Geography", "Ari").tuh, 8);
  assert.deepEqual(checkIntegrity(out), []);
});

test("a part-time player's category TUH follows the games they played", () => {
  // Round 1 is all Current Events, round 2 all Geography. Sub plays round 1 only.
  const packets = [packet(1, Array(6).fill("Current Events")), packet(2, Array(6).fill("Geography"))];
  const g1 = game(1, 6, { A: ["Sub", "Reg"], B: ["Cy"] }, [{ q: 1, player: "Sub", team: "A", value: 10 }, { q: 2, player: "Sub", team: "A", value: 10 }]);
  const g2 = game(2, 6, { A: ["Reg"], B: ["Cy"] }, [{ q: 1, player: "Reg", team: "A", value: 10 }]);
  const out: any = aggregate(packets as any, [g1, g2] as any, cfg);
  assert.equal(catRow(out, "Current Events", "Sub").tuh, 6, "heard all 6 CE tossups, none of the Geography");
  assert.deepEqual(checkIntegrity(out), []);
});

test("a sub's partial-game category TUH is never below the tossups they buzzed on", () => {
  // 4 Current Events of 20; Sub played 10 of them and got all 4 CE tossups.
  const cats = [...Array(4).fill("Current Events"), ...Array(16).fill("Geography")];
  const g = game(1, 20, { A: ["Sub", "Reg"], B: ["Cy"] }, [1, 2, 3, 4].map((q) => ({ q, player: "Sub", team: "A", value: 10 })), { Sub: 10 });
  const out: any = aggregate([packet(1, cats)] as any, [g] as any, cfg);
  const row = catRow(out, "Current Events", "Sub");
  assert.ok(row.tuh >= row.gets, `${row.gets} gets in ${row.tuh} TUH`);
  assert.deepEqual(checkIntegrity(out), []);
});

test("a buzz naming a team outside the game goes to the game's team with that player", () => {
  const packets = [packet(1, Array(5).fill("History"))];
  const g = game(1, 5, { "Auburn D": ["Olive", "Brooks"], "Bruin A": ["Jack"] }, [
    { q: 1, player: "Olive", team: "Auburn D (UG)", value: 10 },
    { q: 2, player: "Jack", team: "Bruin A", value: 10 },
  ]);
  const out: any = aggregate(packets as any, [g] as any, cfg);
  assert.ok(!out["teams.json"].some((t: any) => t.name === "Auburn D (UG)"), "no phantom team");
  const olive = out["players.json"].find((p: any) => p.name === "Olive");
  assert.equal(olive.tuh, 5);
  assert.equal(olive.team, "Auburn D");
  assert.deepEqual(checkIntegrity(out), []);
});

test("a mislabeled _round doesn't hand its round the wrong packet", async () => {
  // Round 3's games read packet D; one round-3 game is stamped _round 4. Round 4
  // reads packet E. The stray game must not make round 4 packet D.
  const qbj = (name: string, round: number, pk: string) =>
    new File([JSON.stringify({ _round: round, packets: pk, match_teams: [], match_questions: [] })], name);
  const games = [
    qbj("Round_3_A_B.qbj", 3, "Packet D"), qbj("Round_3_C_D.qbj", 3, "Packet D"),
    qbj("Round_3_E_F.qbj", 4, "Packet D"), // the stray
    qbj("Round_4_A_C.qbj", 4, "Packet E"), qbj("Round_4_B_D.qbj", 4, "Packet E"),
  ];
  const { roundPacket, games: settled } = await settleSiteGames(games);
  assert.equal(roundPacket.get(3), "Packet D");
  assert.equal(roundPacket.get(4), "Packet E");
  const stray = JSON.parse(await settled[2].text());
  assert.equal(stray._round, 3, "moved back to the round its packet was read in");
});

test("integrity checks catch each known failure", () => {
  const ids = (issues: { check: string }[]) => issues.map((i) => i.check).sort();
  const tossups = [1, 2].flatMap((r) => Array.from({ length: 6 }, (_, i) => ({ round: r, num: i + 1, answer: `same answer ${i}`, heard: 1, category: "X", subcategory: "X" })));
  assert.deepEqual(ids(checkIntegrity({ "tossups.json": tossups })), ["duplicate-packet"]);
  const players = [{ id: "p0", name: "A", team: "T", games: 1, tuh: 2, gets: 3, powers: 0, incorrect: 0 }, { id: "p1", name: "B", team: "U", games: 1, tuh: 0, gets: 1, powers: 0, incorrect: 0 }];
  assert.deepEqual(ids(checkIntegrity({ "players.json": players })), ["buzzes-without-tuh", "player-gets-over-tuh"]);
  // Category TUH 4 for a player whose team heard 20 tossups in that category.
  const files = {
    "players.json": [{ id: "p0", name: "A", team: "T", teamId: "t0", games: 1, tuh: 20, gets: 1, powers: 0, incorrect: 0 }],
    "tossups.json": Array.from({ length: 20 }, (_, i) => ({ round: 1, num: i + 1, answer: `a${i}`, heard: 1, category: "X", subcategory: "X" })),
    "games.json": [{ round: 1, tuh: 20, teams: [{ id: "t0", name: "T" }, { id: "t1", name: "U" }] }],
    "categories_tossup.json": [{ category: "X", playersId: "c0", subs: [] }],
    "categories_players.json": { c0: { category: "X", players: [{ playerId: "p0", name: "A", team: "T", teamId: "t0", tuh: 4, gets: 1, powers: 0 }] } },
  };
  assert.deepEqual(ids(checkIntegrity(files)), ["category-tuh-mismatch"]);
});

// The real 2026 ACF Winter data, when it's on this machine: the whole import and
// rebuild must come out clean.
const WINTER = process.env.WINTER_ZIP || "C:/Users/mbent/Downloads/2026-acf-winter-data.zip";
test("2026 ACF Winter rebuilds clean", { skip: !existsSync(WINTER) && "data zip not present" }, async () => {
  const { buildFromZip } = await import("./build-local.ts");
  const { issues, editions } = await buildFromZip(WINTER, [
    { name: "Other", members: ["Current Events", "Geography", "Other Academic", "Popular Culture"] },
    { name: "Fine Arts", members: ["Classical Music", "Other Fine Arts", "Painting and Sculpture"] },
  ]);
  assert.equal(editions.length, 17);
  assert.deepEqual(issues, []);
});
