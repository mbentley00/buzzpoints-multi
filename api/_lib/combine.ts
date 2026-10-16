// Combine several tournaments the caller owns into a NEW one, leaving the
// originals untouched. Unlike the Settings "merge" (which folds mirrors of the
// SAME questions into one tournament as editions, and consumes them), these are
// different question sets — MRNA IV and MRNA V practice stats as one "Level 7"
// page — so their questions must stay distinct while their players and teams
// pool together.
//
// How: each source is reduced to one edition on its own canonical numbering
// (replacements applied, mirrors aligned), then its packets are renumbered to
// follow the previous source's, so packet 1 of the second set becomes packet
// N+1. Every owner edit keyed by round — buzz and bonus corrections, category
// and tag fixes, bonus difficulty marks, phases — is carried over on the new
// numbering, and each source's rounds are tagged with its name, so the phase
// filter still splits the combined page back into its parts.
//
// It's a snapshot: later edits to a source don't flow into the combination.
import {
  readIndex, writeIndex, readSource, writeSource, writeCorrections, writeRequests, readCorrections,
  readBonusCorrections, writeBonusCorrections, readRenames, writeRenames, renameKey, readMetaMap, writeMetaMap,
  readTagEdits, writeTagEdits, readBonusDiffs, writeBonusDiffs, readVirtualCats, writeVirtualCats,
  readRoundTags, writeRoundTags, roundTagsFor, readReplacements, editionsOf, canonicalizeEditions,
  aggregateAndWrite, isSetOwner, practiceVisibility, corrKey, bnCorrKey,
  Edition, SetSource, SetEntry, RoundTags,
} from "./sets.js";
import { applyReplacements } from "./replacements.js";
import { PacketFile, GameFile, Correction, BonusCorrection, Rename, TagEdits, TagEdit, BonusDiffs, VirtualCategory, MetaMap, resolveMeta } from "./aggregate.js";
import { validLevel, cleanDifficulty, slugify, CreateError } from "./publish.js";

export const MAX_COMBINE = 12;

// One packet per round out of a source's (already aligned) editions. Mirrors of
// one set share their questions, so a slot is taken from the latest edition that
// has it — the wording the combined view of that set showed — and earlier ones
// fill what it lacks (a replacement only one mirror read). Games from every
// mirror are kept: they're all hearings of these questions.
function flatten(eds: Edition[]): { packets: PacketFile[]; games: GameFile[] } {
  const byRound = new Map<number, PacketFile[]>();
  for (const e of [...eds].reverse())
    for (const p of e.packets || []) byRound.set(p.round, [...(byRound.get(p.round) || []), p]);
  const slots = <T,>(lists: (T[] | undefined)[], blank: T): T[] => {
    const n = Math.max(0, ...lists.map((l) => (l || []).length));
    return Array.from({ length: n }, (_, i) => lists.map((l) => l?.[i]).find((x) => x != null) ?? blank);
  };
  const packets = [...byRound.entries()].map(([round, ps]) => ({
    ...ps[0], round,
    tossups: slots(ps.map((p) => p.tossups), { question: "", answer: "" }),
    bonuses: slots(ps.map((p) => p.bonuses), {}),
  }));
  const games = eds.flatMap((e) => (e.games || []).map((g) => { const { editionId: _drop, ...rest } = g; return rest as GameFile; }));
  return { packets, games };
}

// `${round}-${num}` keys onto the new numbering; anything for a round that
// didn't make it across is dropped.
function remapKeyed<T>(rec: Record<string, T> | undefined, map: Map<number, number>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec || {})) {
    const m = k.match(/^(\d+)-(\d+)$/);
    const r = m ? map.get(Number(m[1])) : undefined;
    if (r !== undefined) out[`${r}-${m![2]}`] = v;
  }
  return out;
}

export interface CombineBody {
  sources?: unknown; name?: unknown; level?: unknown; difficulty?: unknown; visibility?: unknown;
}

export async function combineSets(body: CombineBody, user: string): Promise<{ slug: string; warnings: string[] }> {
  const name = String(body.name ?? "").trim().slice(0, 120);
  if (!name) throw new CreateError(400, "Give the combined tournament a name.");
  const wanted = Array.isArray(body.sources) ? [...new Set(body.sources.map((s) => String(s)))] : [];
  if (wanted.length < 2) throw new CreateError(400, "Choose at least two tournaments to combine.");
  if (wanted.length > MAX_COMBINE) throw new CreateError(400, `Combine at most ${MAX_COMBINE} tournaments at a time.`);

  const index = await readIndex();
  const entries: SetEntry[] = [];
  for (const s of wanted) {
    const e = index.sets.find((x) => x.slug === s);
    if (!e) throw new CreateError(404, `Tournament "${s}" not found.`);
    // Owners only — no admin bypass. Combining copies a set's questions and
    // stats into a page the caller controls, so it's for their own sets.
    if (!isSetOwner(e, user)) throw new CreateError(403, `You don't own "${e.name}", so you can't combine it.`);
    if (e.kind === "results") throw new CreateError(400, `"${e.name}" has no buzz data to combine.`);
    entries.push(e);
  }
  const first = entries[0];
  for (const e of entries.slice(1)) {
    // One scoring and one format per tournament: a mismatch would silently
    // re-score one set's buzzes, or read its teams as single players.
    if ((e.scoring || "") !== (first.scoring || ""))
      throw new CreateError(400, `"${e.name}" is scored ${e.scoring} but "${first.name}" is ${first.scoring}; they can't be combined.`);
    if (!!e.individual !== !!first.individual)
      throw new CreateError(400, `"${e.name}" and "${first.name}" aren't both individual (or both team) tournaments.`);
  }

  const level = validLevel(body.level ?? (entries.every((e) => e.level === "practice") ? "practice" : first.level));
  const difficulty = cleanDifficulty(level, body.difficulty);
  // Never public straight away: a combination of fresh uploads would otherwise
  // skip the review those uploads face. The owner can ask from Settings.
  const asked = body.visibility === "listed" ? "listed" : "private";
  const visibility = level === "practice" ? practiceVisibility(asked) : asked;

  const warnings: string[] = [];
  const packets: PacketFile[] = [];
  const games: GameFile[] = [];
  let corrections: Correction[] = [], bonusCorr: BonusCorrection[] = [], renames: Rename[] = [];
  const corrSeen = new Set<string>(), bnSeen = new Set<string>(), renameSeen = new Set<string>();
  const tagEdits: Required<TagEdits> = { tossups: {}, bonuses: {} };
  let bonusDiffs: BonusDiffs = {};
  const vcats = new Map<string, Set<string>>();
  const roundTags: RoundTags = {};
  const combinedFrom: NonNullable<SetEntry["combinedFrom"]> = [];
  let hasBonuses = false;
  let metaMap: MetaMap | null | undefined; // undefined = not chosen yet
  let next = 1;

  for (const e of entries) {
    const src = await readSource(e.slug);
    if (!src) throw new CreateError(500, `Source data for "${e.name}" not found.`);
    hasBonuses = hasBonuses || !!src.hasBonuses;
    const eds = canonicalizeEditions(applyReplacements(editionsOf(src), await readReplacements(e.slug)));
    const flat = flatten(eds);
    if (!flat.packets.length && !flat.games.length) throw new CreateError(400, `"${e.name}" has nothing uploaded to combine.`);

    // Its rounds, in order, onto the next free packet numbers.
    const rounds = [...new Set([...flat.packets.map((p) => p.round), ...flat.games.map((g) => g.round)])].sort((a, b) => a - b);
    const map = new Map(rounds.map((r) => [r, next++] as const));
    const to = (r: number) => map.get(r)!;
    packets.push(...flat.packets.map((p) => ({ ...p, round: to(p.round) })));
    games.push(...flat.games.map((g) => ({ ...g, round: to(g.round) })));
    combinedFrom.push({ slug: e.slug, name: e.name, from: to(rounds[0]), to: to(rounds[rounds.length - 1]) });

    // Edits keyed by (round, question): moved onto the new numbering. A key the
    // combination already holds wins, as in the Settings merge.
    for (const c of await readCorrections(e.slug)) {
      if (!map.has(c.round)) continue;
      const m = { ...c, round: to(c.round) };
      if (!corrSeen.has(corrKey(m))) { corrSeen.add(corrKey(m)); corrections = [...corrections, m]; }
    }
    for (const c of await readBonusCorrections(e.slug)) {
      if (!map.has(c.round)) continue;
      const m = { ...c, round: to(c.round) };
      if (!bnSeen.has(bnCorrKey(m))) { bnSeen.add(bnCorrKey(m)); bonusCorr = [...bonusCorr, m]; }
    }
    // Renames are by name, set-wide. Carrying them across means a spelling fixed
    // in one set is fixed for the whole combination, which is what pooling wants.
    for (const r of await readRenames(e.slug)) if (!renameSeen.has(renameKey(r))) { renameSeen.add(renameKey(r)); renames = [...renames, r]; }

    const te = await readTagEdits(e.slug);
    const srcTu = remapKeyed(te.tossups, map), srcBn = remapKeyed(te.bonuses, map);
    bonusDiffs = { ...bonusDiffs, ...remapKeyed(await readBonusDiffs(e.slug), map) };

    // Categories: one metadata mapping serves the whole combination, taken from
    // the first set. A set mapped differently has each question's category and
    // tags pinned as it read them, so nothing moves.
    const mm = await readMetaMap(e.slug);
    if (metaMap === undefined) metaMap = mm;
    if (JSON.stringify(mm) !== JSON.stringify(metaMap)) {
      const pin = (meta: string | undefined, own: TagEdit | undefined): TagEdit => {
        const mine = resolveMeta(meta, mm), theirs = resolveMeta(meta, metaMap ?? null);
        return {
          ...own,
          category: own?.category || mine.full,
          add: [...new Set([...mine.tags, ...(own?.add || [])])],
          remove: [...new Set([...theirs.tags.filter((t) => !mine.tags.includes(t)), ...(own?.remove || [])])],
        };
      };
      for (const p of flat.packets) {
        (p.tossups || []).forEach((t, i) => { const k = `${to(p.round)}-${i + 1}`; if (t?.metadata) srcTu[k] = pin(t.metadata, srcTu[k]); });
        (p.bonuses || []).forEach((b, i) => { const k = `${to(p.round)}-${i + 1}`; if (b?.metadata) srcBn[k] = pin(b.metadata, srcBn[k]); });
      }
    }
    Object.assign(tagEdits.tossups, srcTu);
    Object.assign(tagEdits.bonuses, srcBn);

    for (const v of (await readVirtualCats(e.slug)) || []) {
      const s = vcats.get(v.name) ?? new Set<string>();
      for (const m of v.members) s.add(m);
      vcats.set(v.name, s);
    }

    // Phases: the set's own (any mirror's schedule), plus its name, so "Prelims"
    // spans every set while the name picks out one.
    const rt = await readRoundTags(e.slug);
    for (const r of rounds) {
      const names = new Set<string>([e.name]);
      for (const ed of [{ id: "all" }, ...eds]) for (const n of roundTagsFor(rt, ed.id)[String(r)] || []) names.add(n);
      roundTags[String(to(r))] = [...names];
    }
  }
  if (packets.some((p) => p.round > 999)) warnings.push("The combination has over 999 packets; later ones may be labeled oddly.");

  let slug = slugify(name);
  const taken = new Set(index.sets.map((s) => s.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  const source: SetSource = {
    name, scoring: first.scoring, hasBonuses, ...(first.individual ? { individual: true } : {}),
    editions: [{ id: "e0", label: "Original", packets, games }],
  };
  await writeSource(slug, source);
  await writeRequests(slug, []);
  await writeCorrections(slug, corrections);
  await writeBonusCorrections(slug, bonusCorr);
  await writeRenames(slug, renames);
  await writeTagEdits(slug, tagEdits);
  await writeBonusDiffs(slug, bonusDiffs);
  if (metaMap) await writeMetaMap(slug, metaMap);
  if (vcats.size) await writeVirtualCats(slug, [...vcats].map(([n, m]): VirtualCategory => ({ name: n, members: [...m] })));
  await writeRoundTags(slug, { all: roundTags });
  const { meta, editions, tags } = await aggregateAndWrite(slug, source, corrections);

  const dates = entries.map((e) => e.tournamentDate).filter((d): d is string => !!d).sort();
  const entry: SetEntry = {
    slug, name, scoring: first.scoring, hasBonuses, ...(first.individual ? { individual: true } : {}),
    owner: user, editions, tags,
    // Already-published imports stay exempt from review; anything with a fresh
    // upload in it is treated as one.
    origin: entries.every((e) => e.origin === "import") ? "import" : "upload",
    visibility, invites: [], autoPublicAt: null, level, ...(difficulty ? { difficulty } : {}),
    ...(dates.length ? { tournamentDate: dates[0] } : {}),
    combinedFrom,
    numGames: meta.numGames, numTeams: meta.numTeams, numPlayers: meta.numPlayers,
    numTossups: meta.numTossups, rounds: meta.rounds.length, createdAt: new Date().toISOString(),
  };
  // Re-read: aggregation is slow, and the index may have moved meanwhile.
  const fresh = await readIndex();
  await writeIndex({ sets: [entry, ...fresh.sets.filter((s) => s.slug !== slug)] });
  return { slug, warnings };
}
