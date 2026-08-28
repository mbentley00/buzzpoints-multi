export type Visibility = "public" | "listed" | "private";

// Tournament type/level options (ids match the server's TOURNAMENT_LEVELS).
export const TOURNAMENT_LEVELS: { id: string; label: string }[] = [
  { id: "hs", label: "High school" },
  { id: "college", label: "College" },
  { id: "open", label: "Open" },
  { id: "popculture", label: "Pop culture" },
  { id: "side", label: "Side event" },
  { id: "practice", label: "Practice" },
];
export const levelLabel = (id?: string): string => TOURNAMENT_LEVELS.find((l) => l.id === id)?.label ?? "";

// Question difficulty, on the level's own scale (ids match the server's
// difficultiesFor). High school has four tiers. College and open use the
// College Quizbowl Calendar dot scale — https://collegequizbowlcalendar.com/difficulty-scale/
// — from 1 to 5 in half steps; the names on the whole numbers are the
// calendar's own. Other levels have no scale.
const HS_DIFFICULTIES = [
  { id: "novice", label: "Novice" },
  { id: "regs", label: "Regs" },
  { id: "regs+", label: "Regs+" },
  { id: "nationals", label: "Nationals" },
];
const DOT_NAMES: Record<string, string> = { "1": "Easy", "2": "Medium", "3": "Regionals", "4": "Nationals" };
const dots = (n: number) => "●".repeat(Math.floor(n)) + (n % 1 ? "◐" : "");
const DOT_DIFFICULTIES = ["1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5"].map((id) => ({
  id,
  label: `${dots(Number(id))} ${id}${DOT_NAMES[id] ? ` — ${DOT_NAMES[id]}` : ""}`,
}));
export function difficultyOptions(level?: string): { id: string; label: string }[] {
  if (level === "hs") return HS_DIFFICULTIES;
  if (level === "college" || level === "open") return DOT_DIFFICULTIES;
  return [];
}
// Short form for badges: "Regs+", or "●●●◐ 3.5".
export function difficultyLabel(level?: string, id?: string): string {
  if (!id) return "";
  if (level === "hs") return HS_DIFFICULTIES.find((d) => d.id === id)?.label ?? id;
  if (level === "college" || level === "open") return `${dots(Number(id))} ${id}`;
  return "";
}

export interface EditionSummary {
  id: string;
  label: string;
  numGames: number;
  numTeams: number;
  numPlayers: number;
  numTossups: number;
  rounds: number;
}

// A round-tag ("phase") summary with its scoped stat files under tags/<slug>/.
export interface TagSummary {
  name: string;
  slug: string;
  // Union of the rounds carrying this phase across editions; editionRounds breaks
  // it back out per mirror (multi-edition sets only).
  rounds: number[];
  editionRounds?: Record<string, number[]>;
  numGames: number;
  numTeams: number;
  numPlayers: number;
}

export interface SetEntry {
  slug: string;
  name: string;
  scoring: string;
  hasBonuses: boolean;
  kind?: "buzz" | "results";
  owner?: string;
  // Accounts the creator added as co-owners; only sent to owners. They manage the
  // set alongside the creator, who alone edits this list and deletes the set.
  coOwners?: string[];
  editions?: EditionSummary[];
  visibility?: Visibility;
  inviteCount?: number;
  hasAccess?: boolean; // viewer can already open this set (owned, invited, or public)
  invites?: string[]; // only present for the owner
  autoPublicAt?: string | null;
  // Whether viewers may propose buzz corrections / renames. The server
  // normalizes the absent default to true.
  allowRequests?: boolean;
  tags?: TagSummary[]; // round-tag phases, if the owner has tagged rounds
  hasYf?: boolean; // owner uploaded a companion YellowFruit file (corrected export available)
  level?: string; // tournament type (see TOURNAMENT_LEVELS)
  tdLink?: string; // optional hsquizbowl Tournament Database link
  difficulty?: string; // question difficulty on the level's scale (see difficultyOptions)
  // An individual shootout (IPNCT-style): players compete for themselves, so
  // "teams" here are players. Absent means a team tournament.
  individual?: boolean;
  numGames: number;
  numTeams: number;
  numPlayers: number;
  numTossups: number;
  rounds: number;
  createdAt: string;
}

// What SetLayout passes to child pages via Outlet context.
export interface SetCtx {
  meta: Meta;
  slug: string;
  scope: string; // "all" (combined), an edition id, or "tag:<slug>" (a phase)
  editions: EditionSummary[];
  owner: string | null;
  isOwner: boolean;
  user: string | null;
  // Whether non-owners may propose corrections. Owners always can edit directly.
  allowRequests: boolean;
  level?: string;
  tdLink?: string;
  difficulty?: string;
}

// A buzz reassignment / move, as sent to /api/correct or /api/request.
export interface Correction {
  round: number;
  num: number;
  team: string;
  fromPlayer: string | null;
  fromWordIndex: number | null;
  toPlayer?: string | null;
  toWordIndex?: number | null;
}

// A set-wide rename of one player or one team (see Rename in
// api/_lib/aggregate.ts). Absent `kind` means "player", the only kind the
// earliest stored renames had. `team` scopes a player rename to one roster; null
// renames them on every team, and a team rename is always set-wide.
export interface Rename {
  kind?: "player" | "team";
  from: string;
  to: string;
  team: string | null;
  by?: string;
  at?: string;
}
export const renameKind = (r: { kind?: string }): "player" | "team" => (r.kind === "team" ? "team" : "player");

// Exactly one of `correction` (one buzz) or `rename` (a player or team across the
// whole tournament) is present.
export interface CorrectionRequest {
  id: string;
  correction?: Correction & { by?: string; at?: string };
  bonus?: BonusCorrection;
  rename?: Rename;
  by: string;
  at: string;
  status: "pending" | "approved" | "rejected";
  desc?: string;
}

export type Rosters = Record<string, string[]>;

export interface IndexData {
  base: string | null;
  sets: SetEntry[];
  needsSetup?: boolean;
}

// One game's box score, from games.json. The standard (YellowFruit-style)
// reports are built on these: a season total is just the sum of a team's or a
// player's lines here.
export interface GamePlayerLine {
  id: string | null;
  name: string;
  // What the source said this player heard. 0 means the file didn't say, which
  // is common — many sources list only the players who buzzed.
  tuh: number;
  powers: number;
  gets: number;
  incorrect: number;
  pts: number;
}
export interface GameTeamLine {
  id: string | null;
  name: string;
  score: number;
  tuPts: number;
  bonusPts: number;
  bonusesHeard: number;
  ppb: number;
  powers: number;
  gets: number;
  incorrect: number;
  // Null when the file didn't describe a two-team game, so nothing is guessed.
  // In an individual shootout it says whether this player won their room.
  result: "W" | "L" | "T" | null;
  // Finishing place in the room (ties share one). Individual shootouts only.
  place?: number;
  players: GamePlayerLine[];
}
export interface GameRow {
  round: number;
  editionId?: string;
  // Tossups read in the room, which every team in it heard.
  tuh: number;
  teams: GameTeamLine[];
}

export interface Meta {
  setName: string;
  setSlug: string;
  scoring: string;
  scoringLabel: string;
  hasPower: boolean;
  hasNeg: boolean;
  hasBonuses: boolean;
  // An individual shootout: every "team" in the data is one player, so the
  // team views are hidden and results are places in a room. Absent => teams.
  individual?: boolean;
  // Whether per-team/per-player bonus data exists. Absent on older sets => treat
  // as true. False for imports that only carry aggregate bonus conversion.
  hasTeamBonuses?: boolean;
  hasTags?: boolean;
  needsCategoryMapping?: boolean;
  kind?: "buzz" | "results";
  numGames: number;
  numTeams: number;
  numPlayers: number;
  numTossups: number;
  numBonuses: number;
  rounds: number[];
  phases?: string[];
  editions?: EditionSummary[];
  // Packet rounds that don't line up with the rounds games were played in, so
  // their questions can never pick up buzzes. Owner-facing; absent on older sets.
  roundWarnings?: RoundWarning[];
  // Bonuses whose difficulty marks can't be right ("medium, easy, easy"), which
  // corrupt every easy/medium/hard figure built on them. Owner-facing; absent on
  // sets that haven't been rebuilt since this check was added.
  bonusDiffWarnings?: BonusDiffWarning[];
  generatedAt: string;
}

export interface RoundWarning {
  kind: "packet-unplayed" | "games-unmatched" | "packet-duplicate";
  round: number;
  tossups: number;
  games: number;
  files: number;
  suggested: number | null;
}

// One bonus whose difficulty marks don't describe a bonus anyone could write.
// See scanBonusDifficulty in api/_lib/aggregate.ts.
export interface BonusDiffWarning {
  kind: "duplicate" | "partial" | "unknown" | "unmarked";
  id: string;      // "<round>-<num>"
  round: number;
  num: number;
  mods: string[];  // the marks as tagged, "" for an unmarked part
  answers: string[];
  heard: number;
  convPct: (number | null)[];
  reason: string;
  // What conversion says the marks really are, or null when the bonus wasn't
  // heard often enough for that to mean anything.
  suggested: string[] | null;
}

// One bonus's corrected marks as stored, with what the packet said before.
export interface BonusDiffFix { mods: string[]; from?: string[]; by?: string; at?: string }

export interface TossupRow {
  id: string;
  round: number;
  num: number;
  answer: string;
  category: string;
  subcategory: string;
  heard: number;
  powers: number;
  gets: number;
  convPct: number;
  powerPct: number;
  incorrectPct: number;
  avgBuzzPct: number | null;
  // Average position of conversions that came while the question was still live —
  // the first buzz of a room's reading. Absent on sets aggregated before it existed.
  avgLiveBuzzPct?: number | null;
  // "Dimension: value" pairs read from the question's metadata, plus any the owner
  // added by hand. Absent on sets aggregated before tags existed.
  tags?: string[];
}

// One tag dimension ("Writer") and how each of its values played.
export interface TagGroup {
  dim: string;
  values: {
    tag: string; value: string;
    heard: number; powers: number; gets: number; convPct: number; powerPct: number;
    avgBuzzPct: number | null; firstSentConvPct: number; secondSentConvPct: number; incorrectPct: number;
  }[];
}

// The bonus half of a tag dimension.
export interface BonusTagGroup {
  dim: string;
  values: { tag: string; value: string; heard: number; ppb: number; easyPct: number | null; medPct: number | null; hardPct: number | null }[];
}

// How to read a set's question metadata: one entry per comma-separated field.
export interface MetaField { role: "category" | "tag" | "ignore"; tag?: string }
export interface MetaMap { fields: MetaField[] }
export interface MetaShape {
  fieldCount: number;
  questions: number;
  examples: string[];
  samples: string[][];
  distinct: number[];
}

export interface Buzz {
  player: string;
  team: string;
  value: number;
  wordIndex: number | null;
  imprecise?: boolean;
  opponent?: string | null;
  playerId?: string | null;
  teamId?: string | null;
  opponentId?: string | null;
  origPlayer?: string | null;
  origWordIndex?: number | null;
  // The team the source named, present only where a team rename moved it. A buzz
  // correction is addressed by the source's names, not the displayed ones.
  origTeam?: string | null;
  // Which edition (mirror) this buzz was played in. Present only on the combined
  // view of a multi-edition set, after re-aggregation.
  editionId?: string;
}

export interface QuestionVersion {
  editionId: string;
  label: string;
  id: string;
  differs: boolean;
}

export interface TossupDetail extends TossupRow {
  questionHtml: string;
  words: string[];
  powerIndex: number | null;
  wordCount: number;
  impreciseCount: number;
  buzzes: Buzz[];
  versions?: QuestionVersion[];
}

export interface BonusRow {
  id: string;
  round: number;
  num: number;
  category: string;
  subcategory: string;
  heard: number;
  ppb: number;
  easyPct: number | null;
  medPct: number | null;
  hardPct: number | null;
  easyAnswer: string | null;
  medAnswer: string | null;
  hardAnswer: string | null;
  tags?: string[];
}

export interface PartConv {
  idx: number;
  difficulty: string;
  difficultyName: string;
  answer: string;
  part: string;
  convPct: number;
  convCount: number;
}
// A correction to which parts one team got on one bonus (see BonusCorrection in
// api/_lib/aggregate.ts). Keyed on the points the SOURCE recorded, so it
// addresses one hearing and survives a later team rename.
export interface BonusCorrection {
  round: number;
  num: number;
  team: string;
  fromPartPts: number[];
  fromBbPts: number[];
  toPartPts: number[];
  toBbPts?: number[];
  by?: string;
  at?: string;
}

// Bonus conversion grouped by the ORDER a format presents its difficulties in
// ("hem" = hard, easy, medium), so one difficulty can be compared across orders.
// See bonusOrderFile in api/_lib/aggregate.ts.
export interface BonusOrderStats {
  bonuses: number;
  heard: number;
  ppb: number;
  // null when the order has no part of that difficulty at all — which must not
  // read the same as "nobody converted them".
  easyPct: number | null;
  medPct: number | null;
  hardPct: number | null;
  // Parts the packet never marked. Absent on sets built before this was added.
  unmarkedPct?: number | null;
  // One per position, in the order's own sequence.
  parts: { idx: number; difficulty: string; difficultyName: string; convPct: number | null }[];
}
export interface BonusOrderSub extends BonusOrderStats { subcategory: string; subLabel: string }
export interface BonusOrderCat extends BonusOrderStats { category: string; subs: BonusOrderSub[] }
export interface BonusOrderRow extends BonusOrderStats {
  order: string;   // "hem", or with "?" for any unmarked part
  label: string;   // "Hard · Easy · Medium"
  categories: BonusOrderCat[];
}

export interface BonusResult {
  team: string;
  partPts: number[];
  bbPts: number[];
  total: number;
  // What the source recorded, present only where a correction changed it — the
  // key the editor addresses this hearing by.
  origPartPts?: number[];
  origBbPts?: number[];
  origTeam?: string;
  // Which edition (mirror) heard this bonus. Present only on the combined view of
  // a multi-edition set, after re-aggregation.
  editionId?: string;
}
export interface BonusDetail {
  id: string;
  tags?: string[];
  round: number;
  num: number;
  category: string;
  subcategory: string;
  leadin: string;
  parts: string[];
  answers: string[];
  difficultyModifiers: string[];
  heard: number;
  ppb: number;
  totalPts: number;
  partConv: PartConv[];
  results: BonusResult[];
  versions?: QuestionVersion[];
}

export interface PlayerRow {
  id: string;
  name: string;
  team: string;
  teamId: string;
  // Editions this player appeared in; present only on the combined rows of a
  // multi-edition set (after re-aggregation).
  editionIds?: string[];
  games: number;
  tuh: number;
  powers: number;
  gets: number;
  incorrect: number;
  pts: number;
  firstBuzzes: number;
  top3Buzzes: number;
  rebounds: number;
  ppg: number;
  pPerTuh: number;
  // BPA (buzz point area-under-the-curve): 100 x the share of each question left
  // unread by an early correct buzz, per tossup heard. null when nothing was
  // heard. See api/_lib/aggregate.ts and https://www.qbwiki.com/wiki/BPA.
  bpa: number | null;
}

export interface CategoryStat {
  category: string;
  powers: number;
  gets: number;
  incorrect: number;
  points: number;
  earliest: number | null;
  avgBuzz: number | null;
  pctPoints: number;
  // Spread over the tossups heard IN THIS CATEGORY, so it is comparable with the
  // overall figure rather than diluted by everything else that was read.
  bpa: number | null;
}

export interface PlayerBuzz {
  id: string;
  round: number;
  num: number;
  category: string;
  answer: string;
  buzzpoint: number | null;
  value: number;
  rank: number | null;
  first: boolean;
  top3: boolean;
  rebound: boolean;
}

export interface PlayerDetail extends PlayerRow {
  categories: CategoryStat[];
  buzzes: PlayerBuzz[];
}

export interface TeamRow {
  id: string;
  name: string;
  // Editions this team appeared in; present only on the combined rows of a
  // multi-edition set (after re-aggregation).
  editionIds?: string[];
  games: number;
  wins: number;
  losses: number;
  ties: number;
  pts: number;
  tuPts: number;
  bonusPts: number;
  ppg: number;
  powers: number;
  gets: number;
  incorrect: number;
  firstBuzzes: number;
  top3Buzzes: number;
  bonusesHeard: number;
  ppb: number;
  pp20tuh: number;
  // BPA (buzz point area-under-the-curve): 100 x the share of each question left
  // unread by an early correct buzz, per tossup heard. null when nothing was
  // heard. See api/_lib/aggregate.ts and https://www.qbwiki.com/wiki/BPA.
  bpa: number | null;
}

export interface RosterPlayer {
  id: string;
  name: string;
  games: number;
  pts: number;
  ppg: number;
  powers: number;
  gets: number;
  incorrect: number;
}

export interface CatTeamTossupSub {
  subcategory: string;
  subLabel: string;
  heard: number;
  powers: number;
  gets: number;
  incorrect: number;
  points: number;
  earliest: number | null;
  avgBuzz: number | null;
  pctPoints: number;
  bpa: number | null;
  rank?: number | null;   // this team's rank in this category by total points
  rankOf?: number | null; // number of teams that played this category
  leaves?: CatTeamTossupSub[];
}
export interface CatTeamTossupRow extends Omit<CatTeamTossupSub, "subcategory" | "subLabel" | "leaves"> {
  category: string;
  subs: CatTeamTossupSub[];
}

export interface TeamDetail extends TeamRow {
  categories: CatTeamTossupRow[];
  bonusCategories: CatBonusRow[];
  roster: RosterPlayer[];
}

export interface CategoryPlayerRow {
  playerId: string;
  name: string;
  team: string;
  teamId: string;
  powers: number;
  gets: number;
  incorrect: number;
  points: number;
  earliest: number | null;
  avgBuzz: number | null;
  firstBuzzes: number;
  top3Buzzes: number;
  // Over the tossups this player's team heard in the categories this row covers.
  bpa: number | null;
}
export interface CategoryPlayers {
  category: string;
  players: CategoryPlayerRow[];
}

export interface BuzzerRace {
  id: string;
  round: number;
  num: number;
  answer: string;
  category: string;
  subcategory: string;
  buzzCount: number;
  totalBuzzes: number;
  powers: number;
  gets: number;
  incorrect: number;
  wordSpan: number;
  pctThrough: number;
  leadingPct: boolean;
  before: string;
  hot: string;
  after: string;
  trailingMore: boolean;
  buzzers: Buzz[];
}

export interface FirstSentenceTossup {
  id: string;
  round: number;
  num: number;
  answer: string;
  category: string;
  subcategory: string;
  sentenceEndIndex: number;
  wordCount: number;
  sentenceWords: string[];
  buzzCount: number;
  powers: number;
  gets: number;
  incorrect: number;
  buzzers: Buzz[];
}

export interface CatTossupSub {
  subcategory: string;
  subLabel: string;
  heard: number;
  powers: number;
  gets: number;
  convPct: number;
  powerPct: number;
  avgBuzzPct: number | null;
  firstSentConvPct: number;
  secondSentConvPct: number;
  incorrectPct: number;
  playersId: string;
  leaves?: CatTossupSub[];
}
export interface CatTossupRow extends Omit<CatTossupSub, "subcategory" | "subLabel" | "leaves"> {
  category: string;
  subs: CatTossupSub[];
  virtual?: boolean; // owner-defined merged category
}

// An owner-defined merged category: a named group of existing (sub)categories.
export interface VirtualCategory {
  name: string;
  members: string[]; // subcategory path strings
}

export interface CatBonusSub {
  subcategory: string;
  subLabel: string;
  heard: number;
  ppb: number;
  // null when the packet marked no parts at that difficulty — distinct from 0,
  // which means parts were heard and nobody got them.
  easyPct: number | null;
  medPct: number | null;
  hardPct: number | null;
  leaves?: CatBonusSub[];
}
export interface CatBonusRow extends Omit<CatBonusSub, "subcategory" | "subLabel" | "leaves"> {
  category: string;
  subs: CatBonusSub[];
  virtual?: boolean; // owner-defined merged category
}
