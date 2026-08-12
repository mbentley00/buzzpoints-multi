export function CategoryTag({ cat }: { cat: string }) {
  return <span className="cat-tag">{cat}</span>;
}

// Generic round label (no tournament-specific finals/tiebreaker naming). Rounds
// above LETTER_ROUND_BASE came from lettered packets — "Round A" — and are shown
// as the letter. Keep in sync with roundFromName in api/_lib/publish.ts.
const LETTER_ROUND_BASE = 1000;
export function roundLabel(r: number): string {
  return r > LETTER_ROUND_BASE && r <= LETTER_ROUND_BASE + 26
    ? String.fromCharCode(64 + r - LETTER_ROUND_BASE)
    : String(r);
}

// What the owner typed into a round box: a number, or a letter for a lettered
// packet ("A"). Null if it's neither.
export function parseRoundInput(raw: string): number | null {
  const s = (raw || "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^[A-Za-z]$/.test(s)) return LETTER_ROUND_BASE + (s.toUpperCase().charCodeAt(0) - 64);
  return null;
}

// The round a packet/game filename refers to, mirroring the server's parsing so
// the upload form can say which rounds it's about to replace. The server's answer
// is the one that counts.
export function roundFromFileName(name: string): number | null {
  const m = (name || "").match(/(?:Round[_ ])?0*(\d+)(?:[_ .]|$)/i);
  if (m) return Number(m[1]);
  const l = (name || "").match(/(?:round|rd|packet)[ _-]*([a-z])(?:[ _.)\-]|$)/i);
  return l ? LETTER_ROUND_BASE + (l[1].toUpperCase().charCodeAt(0) - 64) : null;
}

// Pronunciation guides — a parenthetical opening with a quote, e.g. (“BEE-muh”)
// — are an aside to the reader, so they're greyed the way MODAQ greys them. The
// match stops at any tag so wrapping never crosses markup it doesn't own.
const PRON_GUIDE = /\([“"][^)<]*\)/g;
export const markPronGuides = (html: string) =>
  (html || "").replace(PRON_GUIDE, (m) => `<span class="q-pg">${m}</span>`);

// Question/answer markup is trusted, locally-aggregated HTML (<b>, <u>, <em>).
export function Html({ html, className }: { html: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: markPronGuides(html) }} />;
}

const hasText = (html: string) => html.replace(/<[^>]*>/g, "").trim().length > 0;

// Just the answer itself, for list views: everything the answer line carries in
// brackets or parentheses — acceptable and promptable answers, notes to the
// reader, pronunciation guides — is dropped, so a row reads "Elizabeth" instead
// of "Elizabeth [accept Elizabeth Gaskell or …]". Question pages still show the
// whole line. Innermost groups go first, so nesting unwinds; markup inside a
// group goes with it. An answer that is somehow all brackets is left alone.
export function primaryAnswer(html: string): string {
  let s = html || "";
  for (let prev = ""; s !== prev; ) {
    prev = s;
    s = s.replace(/\[[^[\]]*\]/g, "").replace(/\([^()]*\)/g, "");
  }
  s = s
    .replace(/\s{2,}/g, " ")
    // A separator left dangling by the cut, before any trailing closing tags.
    .replace(/[\s;,:]+((?:<\/[a-z]+>\s*)*)$/i, "$1")
    .trim();
  return hasText(s) ? s : html;
}

// Does a full subcategory path belong to a category filter value? Matches the
// value itself or any descendant ("Science" matches "Science - Biology - …").
export function catMatches(fullSub: string, value: string): boolean {
  return fullSub === value || fullSub.startsWith(value + " - ");
}

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(1)}%`;
}
export function num(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? "—" : v.toFixed(digits);
}
export function plain(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || "").trim();
}

// Absolute short date, e.g. "Jun 15, 2026". Empty string for missing/invalid input.
export function formatDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Compact relative age, e.g. "today", "3d ago", "5mo ago". Empty if invalid.
export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const day = 864e5;
  const days = Math.floor((Date.now() - t) / day);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
