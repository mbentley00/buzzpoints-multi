export type Visibility = "public" | "listed" | "private";

// Tournament type/level options (ids match the server's TOURNAMENT_LEVELS).
export const TOURNAMENT_LEVELS: { id: string; label: string }[] = [
  { id: "hs", label: "High school" },
  { id: "college", label: "College" },
  { id: "open", label: "Open" },
  { id: "popculture", label: "Pop culture" },
  { id: "side", label: "Side event" },
];
export const levelLabel = (id?: string): string => TOURNAMENT_LEVELS.find((l) => l.id === id)?.label ?? "";

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
  rounds: number[];
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
  editions?: EditionSummary[];
  visibility?: Visibility;
  inviteCount?: number;
  hasAccess?: boolean; // viewer can already open this set (owned, invited, or public)
  invites?: string[]; // only present for the owner
  autoPublicAt?: string | null;
  tags?: TagSummary[]; // round-tag phases, if the owner has tagged rounds
  hasYf?: boolean; // owner uploaded a companion YellowFruit file (corrected export available)
  level?: string; // tournament type (see TOURNAMENT_LEVELS)
  tdLink?: string; // optional hsquizbowl Tournament Database link
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
  level?: string;
  tdLink?: string;
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

export interface CorrectionRequest {
  id: string;
  correction: Correction & { by?: string; at?: string };
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

export interface Meta {
  setName: string;
  setSlug: string;
  scoring: string;
  scoringLabel: string;
  hasPower: boolean;
  hasNeg: boolean;
  hasBonuses: boolean;
  kind?: "buzz" | "results";
  numGames: number;
  numTeams: number;
  numPlayers: number;
  numTossups: number;
  numBonuses: number;
  rounds: number[];
  phases?: string[];
  editions?: EditionSummary[];
  generatedAt: string;
}

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
export interface BonusResult {
  team: string;
  partPts: number[];
  bbPts: number[];
  total: number;
}
export interface BonusDetail {
  id: string;
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
  games: number;
  tuh: number;
  powers: number;
  gets: number;
  incorrect: number;
  pts: number;
  firstBuzzes: number;
  top3Buzzes: number;
  ppg: number;
  pPerTuh: number;
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
  firstBuzzes: number;
  top3Buzzes: number;
  bonusesHeard: number;
  ppb: number;
  pp20tuh: number;
}

export interface RosterPlayer {
  id: string;
  name: string;
  games: number;
  pts: number;
  ppg: number;
  powers: number;
  gets: number;
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
  easyPct: number;
  medPct: number;
  hardPct: number;
  leaves?: CatBonusSub[];
}
export interface CatBonusRow extends Omit<CatBonusSub, "subcategory" | "subLabel" | "leaves"> {
  category: string;
  subs: CatBonusSub[];
  virtual?: boolean; // owner-defined merged category
}
