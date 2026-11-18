// Cross-checks a built set's stat files against each other. Every check here
// is a bug that reached the live site: each file was internally fine, but two
// files disagreed about the same tossups. The checks read only the published
// JSON, so the same code runs at rebuild (results land in meta.integrity), in
// the regression tests, and against the live site (npm run check:sets).

export interface IntegrityIssue {
  check: string;
  message: string;
  count: number;
  examples: string[];
}

type Json = Record<string, any>;
const MAX_EXAMPLES = 5;

// Same matching as the aggregator's merged categories (vmatchSub).
const vmatch = (fs: string, m: string) => fs === m || fs.startsWith(m + " - ") || fs.endsWith(" - " + m);

const stripHtml = (s: string) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
const answerKey = (ans: string) =>
  stripHtml(ans).toLowerCase().split(/\[|\(/)[0].replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 8).join(" ");

export function checkIntegrity(files: Json, opts: { individual?: boolean } = {}): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const add = (check: string, message: string, found: string[]) => {
    if (found.length) issues.push({ check, message, count: found.length, examples: found.slice(0, MAX_EXAMPLES) });
  };

  const players: Json[] = Array.isArray(files["players.json"]) ? files["players.json"] : [];
  const tossups: Json[] = Array.isArray(files["tossups.json"]) ? files["tossups.json"] : [];
  const games: Json[] | null = Array.isArray(files["games.json"]) ? files["games.json"] : null;
  const catTree: Json[] = Array.isArray(files["categories_tossup.json"]) ? files["categories_tossup.json"] : [];
  const catPlayers: Json = files["categories_players.json"] && typeof files["categories_players.json"] === "object" ? files["categories_players.json"] : {};
  const playerById = new Map(players.map((p) => [p.id, p]));

  // 1. Nobody converts more tossups than they heard.
  add("player-gets-over-tuh", "Player converted more tossups than they heard",
    players.filter((p) => (p.gets || 0) + (p.powers || 0) > (p.tuh || 0)).map((p) => `${p.name} (${p.team}): ${(p.gets || 0) + (p.powers || 0)} gets, ${p.tuh || 0} TUH`));
  const catRowsOver: string[] = [];
  for (const c of Object.values<Json>(catPlayers))
    for (const r of c.players || [])
      if ((r.gets || 0) + (r.powers || 0) > (r.tuh || 0)) catRowsOver.push(`${c.category}: ${r.name} (${r.team}) ${(r.gets || 0) + (r.powers || 0)} gets, ${r.tuh || 0} TUH`);
  add("category-gets-over-tuh", "Category leaderboard row with more gets than TUH", catRowsOver);

  // 2. Anyone who buzzed was in a game: buzzes with no TUH mean the buzz went to
  //    a team that isn't in the game's lineup (a phantom team).
  add("buzzes-without-tuh", "Player has buzzes but heard no tossups",
    players.filter((p) => !p.tuh && (p.gets || 0) + (p.powers || 0) + (p.incorrect || 0) > 0).map((p) => `${p.name} (${p.team})`));
  // A phantom team: one of three or more in a game whose players all heard
  // nothing (buzzes filed under a team name the lineup doesn't have). A
  // free-for-all room, where every player is their own team, is fine.
  if (games && !opts.individual)
    add("game-phantom-team", "Game has a team whose players heard no tossups",
      games.filter((g) => (g.teams || []).length > 2 && (g.teams || []).some((t: Json) => (t.players || []).length && (t.players || []).every((p: Json) => !p.tuh)))
        .map((g) => `round ${g.round}: ${(g.teams || []).map((t: Json) => t.name).join(" / ")}`));

  // 2b. A tossup is converted at most once in a game. Two correct buzzes on
  //     one tossup means copied buzzes (an import that repeated rows).
  const replaysAll: Json = files["replays.json"] && typeof files["replays.json"] === "object" ? files["replays.json"] : {};
  const twice: string[] = [];
  for (const [id, rp] of Object.entries<Json>(replaysAll))
    for (const q of Array.isArray(rp) ? rp : [])
      if ((q.b || []).filter((x: unknown[]) => Number(x[2]) > 0).length > 1) twice.push(`game ${id}, tossup ${q.r ? `${q.r}-` : ""}${q.n}`);
  add("tossup-converted-twice", "A tossup was converted more than once in one game", twice);

  // 3. A category's TUH is what the player heard in it: each game they were in
  //    (from the box score), scaled by how much of it they played. Sources that
  //    list only the players who buzzed leave that undercounted, so the team's
  //    season share is accepted too. The tossups a game read are taken as the
  //    game's replay (exact, including replacement questions in extra slots), or
  //    failing that the packet's first `tuh` — close enough to tell 16 from 40.
  if (games && tossups.length && catTree.length) {
    const byRound = new Map<number, Json[]>();
    for (const t of tossups) byRound.set(t.round, [...(byRound.get(t.round) || []), t]);
    for (const list of byRound.values()) list.sort((a, b) => a.num - b.num);
    const teamSub = new Map<string, Map<string, number>>();
    const playerSub = new Map<string, Map<string, number>>();
    const teamFull = new Map<string, number>();
    const replays: Json = files["replays.json"] && typeof files["replays.json"] === "object" ? files["replays.json"] : {};
    const byId = new Map(tossups.map((t) => [`${t.round}-${t.num}`, t]));
    for (const g of games) {
      const rp: Json[] | undefined = Array.isArray(replays[g.id]) ? replays[g.id] : undefined;
      const read = rp
        ? rp.map((q) => byId.get(`${q.r ?? g.round}-${q.n}`)).filter((t): t is Json => !!t)
        : (byRound.get(g.round) || []).filter((t) => t.num <= (g.tuh || 0));
      for (const tm of g.teams || []) {
        if (!tm.id) continue;
        teamFull.set(tm.id, (teamFull.get(tm.id) || 0) + (g.tuh || 0));
        const m = teamSub.get(tm.id) || new Map<string, number>();
        for (const t of read) m.set(t.subcategory, (m.get(t.subcategory) || 0) + 1);
        teamSub.set(tm.id, m);
        for (const gp of tm.players || []) {
          if (!gp.id || !g.tuh) continue;
          const f = Math.min(1, (gp.tuh || 0) / g.tuh), pm = playerSub.get(gp.id) || new Map<string, number>();
          for (const t of read) pm.set(t.subcategory, (pm.get(t.subcategory) || 0) + f);
          playerSub.set(gp.id, pm);
        }
      }
    }
    const nodes: { id: string; label: string; match: (fs: string) => boolean }[] = [];
    for (const g of catTree) {
      if (g.virtual) {
        const members = [...new Set([g.category, ...(g.subs || []).map((s: Json) => s.subcategory)])];
        if (g.playersId) nodes.push({ id: g.playersId, label: g.category, match: (fs) => members.some((m) => vmatch(fs, m)) });
        for (const s of g.subs || []) if (s.playersId) nodes.push({ id: s.playersId, label: s.subcategory, match: (fs) => vmatch(fs, s.subcategory) });
        continue;
      }
      if (g.playersId) nodes.push({ id: g.playersId, label: g.category, match: (fs) => fs.split(" - ")[0].trim() === g.category });
      for (const s of [...(g.subs || []), ...(g.subs || []).flatMap((x: Json) => x.leaves || [])])
        if (s.playersId) nodes.push({ id: s.playersId, label: s.subcategory, match: (fs) => fs === s.subcategory || fs.startsWith(s.subcategory + " - ") });
    }
    const off: string[] = [];
    for (const n of nodes) {
      const heard = new Map<string, number>();
      const expectedFor = (teamId: string) => {
        if (!heard.has(teamId)) {
          let k = 0;
          for (const [fs, c] of teamSub.get(teamId) || []) if (n.match(fs)) k += c;
          heard.set(teamId, k);
        }
        return heard.get(teamId)!;
      };
      const ownFor = (pid: string) => {
        let k = 0;
        for (const [fs, c] of playerSub.get(pid) || []) if (n.match(fs)) k += c;
        return k;
      };
      const near = (got: number, exp: number) => got >= exp * 0.75 - 2 && got <= exp * 1.25 + 2;
      for (const r of catPlayers[n.id]?.players || []) {
        const p = playerById.get(r.playerId);
        if (!p || !r.teamId || !teamFull.get(r.teamId)) continue;
        const exp = expectedFor(r.teamId) * Math.min(1, (p.tuh || 0) / teamFull.get(r.teamId)!);
        const own = playerSub.has(r.playerId) ? ownFor(r.playerId) : null;
        const got = r.tuh || 0;
        if (!near(got, exp) && (own === null || !near(got, own)))
          off.push(`${n.label}: ${r.name} (${r.team}) shows ${got} TUH, expected ~${Math.round(own ?? exp)}`);
      }
    }
    add("category-tuh-mismatch", "Category leaderboard TUH disagrees with the tossups the team heard", off);
  }

  // 4. One packet, one round: the same answers in two rounds that both had
  //    games means one round's games are scored against the wrong packet. (A
  //    stray copy in a round nobody played changes no stats, so it's skipped.)
  const sets = new Map<number, Set<string>>();
  for (const t of tossups) {
    const k = answerKey(t.answer);
    if (!k) continue;
    const s = sets.get(t.round) || new Set<string>();
    s.add(k);
    sets.set(t.round, s);
  }
  const played = games ? new Set(games.map((g) => g.round)) : null;
  const rounds = [...sets.keys()].filter((r) => !played || played.has(r)).sort((a, b) => a - b);
  const dup: string[] = [];
  for (let i = 0; i < rounds.length; i++)
    for (let j = i + 1; j < rounds.length; j++) {
      const a = sets.get(rounds[i])!, b = sets.get(rounds[j])!;
      let n = 0;
      for (const x of a) if (b.has(x)) n++;
      if (n >= 5 && n / Math.min(a.size, b.size) >= 0.8) dup.push(`rounds ${rounds[i]} and ${rounds[j]} share ${n} answers`);
    }
  add("duplicate-packet", "The same packet was played in two rounds", dup);

  // 5. Totals that must agree across files.
  const overall = files["categories_tossup_overall.json"];
  if (overall && typeof overall.heard === "number" && tossups.length) {
    const sum = tossups.reduce((a, t) => a + (t.heard || 0), 0);
    if (sum !== overall.heard) add("category-heard-total", "Category total heard differs from the tossup list", [`categories ${overall.heard}, tossups ${sum}`]);
  }
  add("tuh-without-games", "Player heard tossups but played no games",
    players.filter((p) => (p.tuh || 0) > 0 && !p.games).map((p) => `${p.name} (${p.team}): ${p.tuh} TUH`));

  return issues;
}
