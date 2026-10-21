import { Link } from "react-router-dom";

// Shown to the owner when a set's categories are still coming from a guess: its
// metadata has more than one comma-separated field and nobody has said which one
// is the category. That guess is what files a set under its writers' initials, and
// nothing else surfaces it — a rebuild happily reproduces the same wrong answer.
export function CategoryMappingNotice({ slug, show }: { slug: string; show: boolean }) {
  if (!show) return null;
  return (
    <div className="caveat">
      <strong>These categories are a guess.</strong>{" "}
      <Link className="link" to={`/set/${slug}/settings#categories`}>Pick the category field →</Link>
    </div>
  );
}
