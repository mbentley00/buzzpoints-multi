export function CategoryTag({ cat }: { cat: string }) {
  return <span className="cat-tag">{cat}</span>;
}

// Generic round label (no tournament-specific finals/tiebreaker naming).
export function roundLabel(r: number): string {
  return String(r);
}

// Question/answer markup is trusted, locally-aggregated HTML (<b>, <u>, <em>).
export function Html({ html, className }: { html: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
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
