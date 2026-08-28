// Cross-tournament category buckets, for searching. Every set files its
// questions under its own vocabulary — "Fine Arts", "Art", "Painting/Sculpture",
// "Auditory Fine Arts"; "Beliefs", "RMP", "Religion - Religion"; "Science -
// Biology" beside a flat "Biology" — so a filter that offered the raw names
// would be a list of two hundred spellings. This folds every category and
// subcategory a set uses onto the dozen top-level subjects nearly every
// tournament shares, by keyword. A question can land in more than one bucket:
// a set whose top level is "RMP" or "Beliefs" has questions that are religion
// OR mythology OR philosophy, and until the subcategory says which, it is all
// three for searching purposes. "Other" is only ever the answer when nothing
// else matched — "Science - Other" is science.
//
// Built from a survey of the site's categories (2026-08); the keyword lists are
// deliberately loose. They only decide what a search filter includes, never
// how a set's own stats are reported.

export const CATEGORY_BUCKETS = [
  { id: "lit", label: "Literature" },
  { id: "hist", label: "History" },
  { id: "sci", label: "Science" },
  { id: "arts", label: "Fine Arts" },
  { id: "rel", label: "Religion" },
  { id: "myth", label: "Mythology" },
  { id: "phil", label: "Philosophy" },
  { id: "ss", label: "Social Science" },
  { id: "geo", label: "Geography" },
  { id: "ce", label: "Current Events" },
  { id: "pop", label: "Pop Culture / Trash" },
  { id: "other", label: "Other" },
] as const;
export type CategoryBucket = (typeof CATEGORY_BUCKETS)[number]["id"];

// Order matters within a segment only where a phrase contains another bucket's
// keyword: "social science" and "political science" are not science, so they
// are tested first and end the segment.
const RULES: { id: CategoryBucket[]; re: RegExp; final?: boolean }[] = [
  { id: ["ss"], re: /\b(social (science|studies)|political science|economics|psychology|sociology|anthropology|linguistics|law)\b/, final: true },
  { id: ["pop"], re: /\b(trash|pop(ular)? culture|entertainment|sports?|rock|hip hop|pop|video games?|television|tv)\b/, final: true },
  { id: ["rel", "myth", "phil"], re: /\b(rmp|rmpss|beliefs?|thought and beliefs?)\b/ },
  { id: ["rel"], re: /\b(religions?)\b/ },
  { id: ["myth"], re: /\b(myth(ology|s)?|legends?)\b/ },
  { id: ["phil"], re: /\b(philosophy|thought)\b/ },
  { id: ["lit"], re: /\b(literature|lit|fiction|poetry|drama|novels?|plays)\b/ },
  { id: ["hist"], re: /\b(history|historiography)\b/ },
  { id: ["sci"], re: /\b(science|biology|chemistry|physics|math(ematics)?|astronomy|geology|earth science|computer science|engineering|medicine)\b/ },
  { id: ["arts"], re: /\b(fine arts?|arts?|painting|sculpture|music|opera|visual|auditory|film|architecture|photography|jazz|dance|classical)\b/ },
  { id: ["geo"], re: /\b(geography)\b/ },
  { id: ["ce"], re: /\b(current events?|modern world|news)\b/ },
];
// The bucket keyword "rmpss" also carries social science.
const RMPSS = /\brmpss\b/;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();

// The buckets one category string ("Fine Arts - Visual - Painting") falls in.
function bucketsOfString(s: string): Set<CategoryBucket> {
  const out = new Set<CategoryBucket>();
  // "Beliefs - Religion" is religion, not all three: the umbrella only stands
  // in when no segment names one of its members.
  let umbrella = false;
  for (const seg of (s || "").split(/\s*[-–—/:,(]\s*/)) {
    const n = norm(seg);
    if (!n) continue;
    if (RMPSS.test(n)) out.add("ss");
    for (const r of RULES) {
      if (!r.re.test(n)) continue;
      if (r.id.length > 1) { umbrella = true; continue; }
      for (const id of r.id) out.add(id);
      if (r.final) break;
    }
  }
  if (umbrella && !out.has("rel") && !out.has("myth") && !out.has("phil")) for (const id of ["rel", "myth", "phil"] as const) out.add(id);
  return out;
}

// The buckets a question belongs to, from its main category and full
// subcategory path. The subcategory is the more specific of the two — it is
// what turns a set's "Beliefs" into just religion — but a set's main category
// still counts, so "Beliefs" alone still finds the question under all three.
export function categoryBuckets(category: string, subcategory?: string): CategoryBucket[] {
  const fromSub = bucketsOfString(subcategory || "");
  const out = fromSub.size ? fromSub : bucketsOfString(category || "");
  // A main category resolves a subcategory that said nothing: "Science - Other"
  // → science; but a subcategory that DID resolve is the answer on its own.
  if (!out.size) out.add("other");
  return [...out];
}

export const isCategoryBucket = (s: string): s is CategoryBucket => CATEGORY_BUCKETS.some((b) => b.id === s);
