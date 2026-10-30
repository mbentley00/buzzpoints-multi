// The six-page HTML stat report quizbowl tournaments post (standings,
// individuals, scoreboard, team detail, player detail, round report), built
// from a set's box scores and handed over as a zip of linked pages.
import { loadSetJson } from "./data";
import { scopedPath } from "./components/Layout";
import { zipFiles } from "./zip";
import { ANSWER_VALUES, counts, phasesOf } from "./yftBuild";
import type { GameRow, GameTeamLine, TagSummary } from "./types";

export interface StatReportOptions {
  slug: string;
  scope: string;
  name: string;
  scoring: string;
  hasBonuses: boolean;
  tags?: TagSummary[];
  editionId?: string;
  date?: string; // YYYY-MM-DD
}

const PAGES = [
  ["standings", "Standings", "Team Standings"],
  ["individuals", "Individuals", "Individual Statistics"],
  ["games", "Scoreboard", "Scoreboard"],
  ["teamdetail", "Team Detail", "Team Detail"],
  ["playerdetail", "Player Detail", "Individual Statistics Detail"],
  ["rounds", "Round Report", "Round Report"],
] as const;
type Page = (typeof PAGES)[number][0];

const STYLE = `HTML{font-family: Roboto, sans-serif;}
table{font-size: 11pt; border-spacing: 0; border-collapse: collapse;}
td{padding: 5px;}
tr:nth-child(even){background-color: #f2f2f2;}
.headerAndDivider{display: flex; flex-direction: row; margin: 18px 0;}
.headerAndDivider h2{margin: 0;}
.inlineDivider{flex-grow: 1; height: 1px; background-color: #9f9f9f; align-self: center;}
.scoreboardRoundHeader{width: 71%; position: sticky; top: 0; background-color: white; padding-bottom: 10px; margin-bottom: -10px;}
.boxScoreAnchor{padding-top: 30px;}
.boxScoreTitle{width: 71%;}
.boxScoreTable{display: flex; gap: 15px; align-items: flex-start;}
.pseudoTFoot{border-top: 1px solid #909090; background-color: #ffffff !important;}
.floatingTOC{top: 150px; right: 35px; position: fixed; padding-right: 5px; background-color: #cccccc; box-shadow: 4px 4px 7px #999999; line-height: 1.5; z-index: 99;}
.floatingTOC ul{list-style-type: none; padding-inline-start: 20px;}
@media screen and (min-width: 800px) {.fwBelow800px{width: 60%;}}
@media screen and (min-width: 1000px) {.fwBelow1000px{width: 80%;}}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const anchorText = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");
const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const pct = (n: number) => n.toFixed(3);
const per20 = (pts: number, tuh: number, digits: number) => (tuh && pts ? (pts * 20 / tuh).toFixed(digits) : "-");
const per20p = (pts: number, tuh: number) => (tuh ? (pts * 20 / tuh).toFixed(2) : "-");
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);
const scoreText = (a: number, b: number) => `${a < 0 ? `(${a})` : a} - ${b < 0 ? `(${b})` : b}`;

type Cell = { v: string | number; right?: boolean; b?: boolean; w?: string; title?: string };
const td = (c: Cell) =>
  `<td${c.right ? ' align="right"' : ""}${c.w ? ` width="${c.w}"` : ""}>${c.b ? "<b>" : ""}${c.title ? `<abbr title="${esc(c.title)}">${c.v}</abbr>` : c.v}${c.b ? "</b>" : ""}</td>`;
const row = (cells: Cell[], foot = false) => `<tr${foot ? " class=pseudoTFoot" : ""}>\n${cells.map(td).join("\n")}\n</tr>`;
const table = (rows: string[], cls = "", width = "") => `<table${cls ? ` class=${cls}` : ""}${width ? ` width=${width}` : ""}>\n${rows.join("\n")}\n</table>`;
const header = (title: string, extra = "") => `<div class="headerAndDivider${extra}">\n<h2>\n${esc(title)}&nbsp;\n</h2>\n<div class="inlineDivider"></div>\n</div>`;

// One team's line in one game, with tossup counts by answer value.
interface TeamGame {
  g: GameRow;
  phase: string;
  team: GameTeamLine;
  opp: GameTeamLine;
  tuh: number;
  counts: Map<number, number>;
  players: { name: string; tuh: number; counts: Map<number, number>; pts: number }[];
}

export async function buildStatReport(o: StatReportOptions): Promise<Blob> {
  const all = await loadSetJson<GameRow[]>(o.slug, scopedPath(o.scope, "games.json"));
  const games = (all ?? []).filter((g) => g.teams.length === 2);
  if (!games.length) throw new Error(all?.length ? "This report only covers two-team games, and this tournament has none." : "No games to report. Try Settings → Rebuild stats first.");

  const values = ANSWER_VALUES[o.scoring] ?? ANSWER_VALUES.PACE;
  const neg = values.find((v) => v < 0);
  const bonuses = o.hasBonuses;
  const { phaseNames, byPhase } = phasesOf(games, o.tags, o.editionId);
  const phaseOf = new Map<GameRow, string>();
  for (const [ph, gs] of byPhase) for (const g of gs) phaseOf.set(g, ph);
  const multiPhase = phaseNames.length > 1;

  const prefix = o.slug.replace(/[^A-Za-z0-9_-]+/g, "_");
  const href = (p: Page, anchor = "") => `${prefix}_${p}.html${anchor ? "#" + anchor : ""}`;

  // Unique anchors for teams, players and games.
  const used = new Set<string>();
  const uniq = (base: string) => { let a = base || "x", i = 2; while (used.has(a)) a = `${base}${i++}`; used.add(a); return a; };
  const teamAnchor = new Map<string, string>();
  const playerAnchor = new Map<string, string>();
  const pkey = (team: string, p: string) => `${team}\u0000${p}`;
  const gameAnchor = new Map<GameRow, string>();

  const lines: TeamGame[] = [];
  games.forEach((g, i) => {
    gameAnchor.set(g, uniq(`Match_${1000 + i}`));
    for (const [a, b] of [[g.teams[0], g.teams[1]], [g.teams[1], g.teams[0]]]) {
      const players = a.players.map((p) => {
        const c = counts(values, p);
        return { name: p.name, tuh: p.tuh || g.tuh, counts: c, pts: values.reduce((s, v) => s + v * (c.get(v) || 0), 0) };
      });
      const c = new Map<number, number>(values.map((v) => [v, players.reduce((s, p) => s + (p.counts.get(v) || 0), 0)]));
      lines.push({ g, phase: phaseOf.get(g)!, team: a, opp: b, tuh: g.tuh, counts: c, players });
    }
  });
  for (const t of [...new Set(lines.map((l) => l.team.name))].sort((a, b) => a.localeCompare(b))) teamAnchor.set(t, uniq(anchorText(t)));
  for (const l of lines) for (const p of l.players) {
    const k = pkey(l.team.name, p.name);
    if (!playerAnchor.has(k)) playerAnchor.set(k, uniq(anchorText(`${p.name}${l.team.name}`)));
  }

  const resultOf = (l: TeamGame) => (l.team.score > l.opp.score ? "W" : l.team.score < l.opp.score ? "L" : "T");
  const teamLink = (t: string, n = 0) => `<a HREF=${href("teamdetail", teamAnchor.get(t))}>${esc(n ? trunc(t, n) : t)}</a>`;
  const playerLink = (team: string, p: string) => `<a HREF=${href("playerdetail", playerAnchor.get(pkey(team, p)))}>${esc(p)}</a>`;
  const valueHeads = (w?: string): Cell[] => values.map((v) => ({ v, right: true, b: true, w }));
  const valueCells = (c: Map<number, number>): Cell[] => values.map((v) => ({ v: c.get(v) || 0, right: true }));
  const sumCounts = (cs: Map<number, number>[]) => new Map<number, number>(values.map((v) => [v, cs.reduce((s, c) => s + (c.get(v) || 0), 0)]));
  const tuPts = (c: Map<number, number>) => values.reduce((s, v) => s + v * (c.get(v) || 0), 0);

  // Season (or phase) totals per team and per player.
  const teamTotals = (ls: TeamGame[]) => {
    const m = new Map<string, { name: string; w: number; l: number; t: number; pts: number; tuh: number; counts: Map<number, number>[]; bh: number; bp: number }>();
    for (const l of ls) {
      let s = m.get(l.team.name);
      if (!s) m.set(l.team.name, (s = { name: l.team.name, w: 0, l: 0, t: 0, pts: 0, tuh: 0, counts: [], bh: 0, bp: 0 }));
      const r = resultOf(l);
      if (r === "W") s.w++; else if (r === "L") s.l++; else s.t++;
      s.pts += l.team.score; s.tuh += l.tuh; s.counts.push(l.counts); s.bh += l.team.bonusesHeard; s.bp += l.team.bonusPts;
    }
    return [...m.values()].map((s) => {
      const gp = s.w + s.l + s.t;
      return { ...s, c: sumCounts(s.counts), pct: gp ? (s.w + s.t / 2) / gp : 0, pp: s.tuh ? s.pts / s.tuh : 0 };
    });
  };
  const playerTotals = (ls: TeamGame[]) => {
    const m = new Map<string, { team: string; name: string; tuh: number; gp: number; pts: number; counts: Map<number, number>[] }>();
    for (const l of ls) for (const p of l.players) {
      const k = pkey(l.team.name, p.name);
      let s = m.get(k);
      if (!s) m.set(k, (s = { team: l.team.name, name: p.name, tuh: 0, gp: 0, pts: 0, counts: [] }));
      s.tuh += p.tuh; s.gp += l.tuh ? p.tuh / l.tuh : 0; s.pts += p.pts; s.counts.push(p.counts);
    }
    return [...m.values()].map((s) => ({ ...s, c: sumCounts(s.counts), pp: s.tuh ? s.pts / s.tuh : 0 }))
      .sort((a, b) => b.pp - a.pp || b.tuh - a.tuh || a.name.localeCompare(b.name));
  };
  const anyTies = lines.some((l) => resultOf(l) === "T");

  const page = (p: Page, body: string) => {
    const title = PAGES.find((x) => x[0] === p)![2];
    const nav = table([`<tr>\n${PAGES.map(([id, label]) => `<td><a HREF=${href(id)}>${label}</a></td>`).join("\n")}\n</tr>`], "", "100%");
    const info = [esc(o.name), o.date ? new Date(`${o.date}T12:00:00`).toDateString() : "", `Question set: ${esc(o.name)}`].filter(Boolean)
      .map((s) => `<span>${s}</span>`).join("<span>&emsp;|&emsp;</span>");
    return `<HTML>\n<HEAD>\n<meta charset="utf-8">\n<title>${title}</title>\n</HEAD>\n<BODY>\n${nav}\n<h1 id=top>${title}</h1>\n<style>\n${STYLE}\n</style>\n<div style="font-size: 11pt; text-size-adjust: none;">\n${info}\n${body}\n</div>\n</BODY>\n</HTML>\n`;
  };

  // Rank with ties shown as "5=", by a displayed key.
  const rankOf = (keys: string[], i: number) => {
    const first = keys.indexOf(keys[i]);
    return `${first + 1}${keys.filter((k) => k === keys[i]).length > 1 ? "=" : ""}`;
  };

  /* ---------------- standings ---------------- */
  // advancedTo: for an earlier phase, the next phase a team went on to play in.
  const standingsTable = (ls: TeamGame[], advancedTo?: (team: string) => string) => {
    const ts = teamTotals(ls).sort((a, b) => b.pct - a.pct || b.pp - a.pp);
    const head: Cell[] = [
      { v: "Rank", b: true, w: "3%" }, { v: "Team", b: true, w: "25%" }, { v: "W", right: true, b: true, w: "4%" }, { v: "L", right: true, b: true, w: "3%" },
      ...(anyTies ? [{ v: "T", right: true, b: true, w: "3%" }] : []),
      { v: "Pct", right: true, b: true, w: "7%", title: "Win percentage" },
      { v: "PP20TUH", right: true, b: true, w: "8%", title: "Points scored per 20 tossups heard" },
      ...valueHeads("5%"),
      { v: "TUH", right: true, b: true, w: "6%", title: "Tossups heard" },
      ...(bonuses ? [{ v: "PPB", right: true, b: true, w: "7%", title: "Points per bonus" }] : []),
      ...(advancedTo ? [{ v: "Advanced To", b: true, w: "10%" }] : []),
    ];
    const pctKeys = ts.map((t) => pct(t.pct));
    return table([row(head), ...ts.map((t, i) => row([
      { v: rankOf(pctKeys, i) }, { v: teamLink(t.name) }, { v: t.w, right: true }, { v: t.l, right: true },
      ...(anyTies ? [{ v: t.t, right: true }] : []),
      { v: pct(t.pct), right: true }, { v: per20(t.pts, t.tuh, 1), right: true }, ...valueCells(t.c), { v: t.tuh, right: true },
      ...(bonuses ? [{ v: t.bh ? f2(t.bp / t.bh) : "-", right: true }] : []),
      ...(advancedTo ? [{ v: esc(advancedTo(t.name)) }] : []),
    ]))], "fwBelow1000px");
  };
  const inPhase = (ph: string) => lines.filter((l) => l.phase === ph);
  // With several phases: the last one cumulative and on its own, then the
  // earlier ones, latest first, each saying where its teams went next.
  const standingsBody = !multiPhase ? [header(phaseNames[0]), standingsTable(lines)] : (() => {
    const last = phaseNames[phaseNames.length - 1];
    const out = [header(`${last}: Total`), standingsTable(lines), header(`${last} Only`), standingsTable(inPhase(last))];
    for (let i = phaseNames.length - 2; i >= 0; i--) {
      const next = new Set(inPhase(phaseNames[i + 1]).map((l) => l.team.name));
      out.push(header(phaseNames[i]), standingsTable(inPhase(phaseNames[i]), (t) => (next.has(t) ? phaseNames[i + 1] : "")));
    }
    return out;
  })();
  const standings = page("standings", standingsBody.join("\n"));

  /* ---------------- individuals ---------------- */
  const individualsTable = (ls: TeamGame[], ranked = true) => {
    const ps = playerTotals(ls);
    const keys = ps.map((x) => String(x.pp));
    return table([
      row([...(ranked ? [{ v: "Rank", b: true, w: "3%" }] : []), { v: "Player", b: true, w: "20%" }, { v: "Team", b: true, w: "20%" },
        { v: "GP", right: true, b: true, w: "5%", title: "Games played" }, ...valueHeads("5%"),
        { v: "TUH", right: true, b: true, w: "6%", title: "Tossups heard" },
        { v: "PP20TUH", right: true, b: true, w: "8%", title: "Points per 20 tossups heard" }]),
      ...ps.map((p, i) => row([...(ranked ? [{ v: rankOf(keys, i) }] : []), { v: playerLink(p.team, p.name) }, { v: teamLink(p.team, 35) },
        { v: f1(p.gp), right: true }, ...valueCells(p.c), { v: p.tuh, right: true }, { v: per20p(p.pts, p.tuh), right: true }])),
    ], "fwBelow1000px");
  };
  const individuals = page("individuals", (multiPhase
    ? [header(phaseNames[0]), individualsTable(inPhase(phaseNames[0])), header("All Games"), individualsTable(lines, false)]
    : [header(phaseNames[0]), individualsTable(lines)]).join("\n"));

  /* ---------------- scoreboard ---------------- */
  const rounds = [...new Set(games.map((g) => g.round))].sort((a, b) => a - b);
  const roundPhase = (r: number) => phaseOf.get(games.find((g) => g.round === r)!)!;
  const toc = `<div class="floatingTOC">\n<ul>\n${phaseNames.map((ph) => `<li>${esc(ph)}</li>\n${rounds.filter((r) => roundPhase(r) === ph)
    .map((r) => `<li>&nbsp;&nbsp;<a HREF=${href("games", `Round-${r}`)}>Round ${r}</a></li>`).join("\n")}`).join("\n")}\n</ul>\n</div>`;
  const boxTable = (l: TeamGame) => table([
    row([{ v: esc(trunc(l.team.name, 25)), b: true }, { v: "TUH", right: true, b: true }, ...valueHeads("5%"), { v: "Tot", right: true, b: true, w: "8%" }]),
    ...l.players.map((p) => row([{ v: esc(p.name) }, { v: p.tuh, right: true }, ...valueCells(p.counts), { v: p.pts, right: true }])),
    row([{ v: "Total", b: true }, { v: "" }, ...values.map((v) => ({ v: l.counts.get(v) || 0, right: true, b: true })), { v: tuPts(l.counts), right: true, b: true }], true),
  ], "", "35%");
  const scoreboardBody = rounds.map((r) => {
    const rl = games.filter((g) => g.round === r);
    return [`<div id=Round-${r}></div>`, header(`Round ${r} - ${roundPhase(r)}`, " scoreboardRoundHeader"),
      ...rl.map((g) => {
        const [a, b] = [...g.teams].sort((x, y) => y.score - x.score);
        const la = lines.find((l) => l.g === g && l.team === g.teams[0])!, lb = lines.find((l) => l.g === g && l.team === g.teams[1])!;
        const [left, right] = [la, lb];
        return [`<div id=${gameAnchor.get(g)} class="boxScoreAnchor"></div>`,
          `<h3 class="boxScoreTitle">${esc(a.name)} ${a.score}, ${esc(b.name)} ${b.score}</h3>`,
          `<p>Tossups read: ${g.tuh}</p>`,
          `<div class="boxScoreTable">\n${boxTable(left)}\n${boxTable(right)}\n</div>`,
          ...(bonuses ? ["<br />", table([
            row([{ v: "Bonuses", b: true, w: "40%" }, { v: "Heard", right: true, b: true, w: "20%" }, { v: "Pts", right: true, b: true, w: "20%" }, { v: "PPB", right: true, b: true, w: "20%" }]),
            ...[left, right].map((l) => row([{ v: esc(l.team.name) }, { v: l.team.bonusesHeard, right: true }, { v: l.team.bonusPts, right: true },
              { v: l.team.bonusesHeard ? f2(l.team.bonusPts / l.team.bonusesHeard) : "-", right: true }])),
          ])] : []),
        ].join("\n");
      })].join("\n");
  }).join("\n");
  const scoreboard = page("games", `${toc}\n<div>\n${scoreboardBody}\n</div>`);

  /* ---------------- team detail ---------------- */
  const stageHead: Cell[] = multiPhase ? [{ v: "Stage", b: true, w: "10%" }] : [];
  const stageCell = (l: TeamGame): Cell[] => (multiPhase ? [{ v: esc(l.phase) }] : []);
  const stageBlank: Cell[] = multiPhase ? [{ v: "" }] : [];
  const teamDetail = page("teamdetail", [...teamAnchor.keys()].map((t) => {
    const ls = lines.filter((l) => l.team.name === t).sort((a, b) => a.g.round - b.g.round);
    const tot = teamTotals(ls)[0];
    const log = table([
      row([{ v: "Round", b: true, w: "7%" }, ...stageHead, { v: "Opponent", b: true, w: "20%" }, { v: "", b: true, w: "3%" }, { v: "Score", b: true, w: "10%" },
        ...valueHeads("5%"), { v: "TUH", right: true, b: true, w: "5%", title: "Tossups heard" },
        ...(bonuses ? [{ v: "BHrd", right: true, b: true, w: "5%", title: "Bonuses heard" }, { v: "BPts", right: true, b: true, w: "5%", title: "Bonus points" }, { v: "PPB", right: true, b: true, w: "5%", title: "Points per bonus" }] : [])]),
      ...ls.map((l) => row([{ v: `<a HREF=${href("games", gameAnchor.get(l.g))}>${l.g.round}</a>` }, ...stageCell(l), { v: teamLink(l.opp.name, 35) }, { v: resultOf(l) },
        { v: scoreText(l.team.score, l.opp.score) }, ...valueCells(l.counts), { v: l.tuh, right: true },
        ...(bonuses ? [{ v: l.team.bonusesHeard, right: true }, { v: l.team.bonusPts, right: true }, { v: l.team.bonusesHeard ? f2(l.team.bonusPts / l.team.bonusesHeard) : "-", right: true }] : [])])),
      row([{ v: "" }, ...stageBlank, { v: "Total", b: true }, { v: `${tot.w}-${tot.l}${tot.t ? `-${tot.t}` : ""}`, b: true }, { v: "" }, ...values.map((v) => ({ v: tot.c.get(v) || 0, right: true, b: true })), { v: tot.tuh, right: true, b: true },
        ...(bonuses ? [{ v: tot.bh, right: true, b: true }, { v: tot.bp, right: true, b: true }, { v: tot.bh ? f2(tot.bp / tot.bh) : "-", right: true, b: true }] : [])], true),
    ], "fwBelow1000px");
    const ps = playerTotals(ls);
    const roster = table([
      row([{ v: "Player", b: true, w: "30%" }, { v: "GP", right: true, b: true, w: "5%", title: "Games played" }, ...valueHeads("5%"),
        { v: "TUH", right: true, b: true, w: "5%", title: "Tossups heard" }, { v: "PP20TUH", right: true, b: true, w: "8%", title: "Points per 20 tossups heard" }]),
      ...ps.map((p) => row([{ v: playerLink(t, p.name) }, { v: f1(p.gp), right: true }, ...valueCells(p.c), { v: p.tuh, right: true }, { v: per20p(p.pts, p.tuh), right: true }])),
    ], "fwBelow800px");
    return `<div id=${teamAnchor.get(t)}></div>\n${header(t)}\n${log}\n<br />\n${roster}`;
  }).join("\n"));

  /* ---------------- player detail ---------------- */
  const playerKeys = [...playerAnchor.keys()].sort((a, b) => {
    const [ta, pa] = a.split("\u0000"), [tb, pb] = b.split("\u0000");
    return ta.localeCompare(tb) || pa.localeCompare(pb);
  });
  const playerDetail = page("playerdetail", playerKeys.map((k) => {
    const [t, name] = k.split("\u0000");
    const ls = lines.filter((l) => l.team.name === t && l.players.some((p) => p.name === name)).sort((a, b) => a.g.round - b.g.round);
    const rows = ls.map((l) => ({ l, p: l.players.find((p) => p.name === name)! }));
    const c = sumCounts(rows.map((r) => r.p.counts));
    const tuh = rows.reduce((s, r) => s + r.p.tuh, 0), pts = rows.reduce((s, r) => s + r.p.pts, 0);
    return `<div id=${playerAnchor.get(k)}></div>\n${header(`${name}, ${t}`)}\n` + table([
      row([{ v: "Round", b: true, w: "7%" }, ...stageHead, { v: "Opponent", b: true, w: "20%" }, { v: "", b: true, w: "3%" }, { v: "Score", b: true, w: "10%" },
        { v: "GP", right: true, b: true, w: "5%", title: "Games played" }, ...valueHeads("5%"), { v: "TUH", right: true, b: true, w: "5%", title: "Tossups heard" }, { v: "Pts", right: true, b: true, w: "5%" }]),
      ...rows.map(({ l, p }) => row([{ v: `<a HREF=${href("games", gameAnchor.get(l.g))}>${l.g.round}</a>` }, ...stageCell(l), { v: teamLink(l.opp.name, 35) }, { v: resultOf(l) },
        { v: scoreText(l.team.score, l.opp.score) }, { v: f1(p.tuh / l.tuh), right: true }, ...valueCells(p.counts), { v: p.tuh, right: true }, { v: p.pts, right: true }])),
      row([{ v: "" }, ...stageBlank, { v: "Total", b: true }, { v: "" }, { v: "" }, { v: f1(rows.reduce((s, r) => s + (r.l.tuh ? r.p.tuh / r.l.tuh : 0), 0)), right: true, b: true }, ...values.map((v) => ({ v: c.get(v) || 0, right: true, b: true })),
        { v: tuh, right: true, b: true }, { v: pts, right: true, b: true }], true),
    ], "fwBelow1000px");
  }).join("\n"));

  /* ---------------- round report ---------------- */
  const powerVals = values.filter((v) => v > 10);
  const roundRow = (label: string, stage: string, ls: TeamGame[], foot = false) => {
    const gs = [...new Set(ls.map((l) => l.g))];
    const tuh = ls.reduce((s, l) => s + l.tuh, 0);
    const pts = ls.reduce((s, l) => s + l.team.score, 0);
    const read = gs.reduce((s, g) => s + g.tuh, 0);
    const n = (vs: number[]) => ls.reduce((s, l) => s + vs.reduce((a, v) => a + (l.counts.get(v) || 0), 0), 0);
    const share = (k: number) => (read ? `${Math.round((100 * k) / read)}%` : "-");
    const bh = ls.reduce((s, l) => s + l.team.bonusesHeard, 0), bp = ls.reduce((s, l) => s + l.team.bonusPts, 0);
    return row([{ v: label, b: foot }, ...(multiPhase ? [{ v: esc(stage) }] : []), { v: gs.length, right: true, b: foot }, { v: per20(pts, tuh, 1), right: true, b: foot },
      ...(powerVals.length ? [{ v: share(n(powerVals)), right: true, b: foot }] : []),
      { v: share(n(values.filter((v) => v > 0))), right: true, b: foot },
      ...(neg !== undefined ? [{ v: tuh ? f1((n([neg]) * 20) / tuh) : "-", right: true, b: foot }] : []),
      ...(bonuses ? [{ v: bh ? f2(bp / bh) : "-", right: true, b: foot }] : [])], foot);
  };
  const roundsPage = page("rounds", table([
    row([{ v: "Round", b: true, w: "10%" }, ...(multiPhase ? [{ v: "Stage", b: true, w: "15%" }] : []), { v: "Games", right: true, b: true, w: "10%" },
      { v: "Pts/Tm/20TUH", right: true, b: true, w: "15%", title: "Points per team per 20 tossups heard" },
      ...(powerVals.length ? [{ v: "TU Powered", right: true, b: true, w: "12%", title: "Share of tossups answered for power" }] : []),
      { v: "TU Converted", right: true, b: true, w: "12%", title: "Share of tossups answered correctly" },
      ...(neg !== undefined ? [{ v: "Negs/Tm/20TUH", right: true, b: true, w: "15%", title: "Negs per team per 20 tossups heard" }] : []),
      ...(bonuses ? [{ v: "PPB", right: true, b: true, w: "10%", title: "Points per bonus" }] : [])]),
    ...rounds.map((r) => roundRow(`<a HREF=${href("games", `Round-${r}`)}>${r}</a>`, roundPhase(r), lines.filter((l) => l.g.round === r))),
    roundRow("Total", "", lines, true),
  ], "fwBelow800px"));

  const enc = new TextEncoder();
  return zipFiles([
    [standings, "standings"], [individuals, "individuals"], [scoreboard, "games"],
    [teamDetail, "teamdetail"], [playerDetail, "playerdetail"], [roundsPage, "rounds"],
  ].map(([html, id]) => ({ name: `${prefix}_${id}.html`, data: enc.encode(html) })));
}
