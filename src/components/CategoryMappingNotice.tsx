import { Link } from "react-router-dom";

// Shown to the owner when a set's categories are still coming from a guess: its
// metadata has more than one comma-separated field and nobody has said which one
// is the category. That guess is what files a set under its writers' initials, and
// nothing else surfaces it — a rebuild happily reproduces the same wrong answer.
export function CategoryMappingNotice({ slug, show }: { slug: string; show: boolean }) {
  if (!show) return null;
  return (
    <div className="caveat">
      <strong>These categories are a guess.</strong> Each question's metadata has more than one field (typically the
      category and the writer) and nothing here says which is which — so a set written <span className="mono">
      &lt;Poetry, JL&gt;</span> ends up filed under <span className="mono">JL</span>.{" "}
      <Link className="link" to={`/set/${slug}/settings#categories`}>Confirm what the fields mean →</Link>
    </div>
  );
}
