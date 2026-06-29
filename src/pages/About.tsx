import { Link } from "react-router-dom";
import { AuthNav } from "../components/Common";

// Short title + one-liner per feature — no boxes, no badges.
const FEATURES: [string, string][] = [
  ["Self-serve hosting", "Upload packets and QBJ files; one site hosts every tournament."],
  ["Any scoring format", "ACF, mACF, PACE, or Super-power, bonuses optional."],
  ["Editions & versions", "Combine mirrors and see how questions changed."],
  ["Merged categories", "Group categories into your own custom buckets."],
  ["Round phases", "Tag rounds and filter every page to a phase."],
  ["Deep buzz analysis", "Buzzer races, first-sentence, and first / top-3 tracking."],
  ["Corrections", "Fix buzzes directly; stats rebuild instantly."],
  ["Access control", "Public, invite-only, or private, with scheduled auto-publish."],
  ["YellowFruit export", "Attach your .yft and download a corrected copy."],
];

export function About() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Tournaments</Link>
            <Link to="/new" className="nav-link">+ New tournament</Link>
            <Link to="/about" className="nav-link active">About</Link>
          </nav>
          <div className="topbar-auth"><AuthNav /></div>
        </div>
      </header>

      <main className="about-llm">
        <div className="about-inner">
          <p className="about-eyebrow">✨ Quizbowl stats, reimagined</p>
          <h1 className="about-title">Every buzz, beautifully tracked.</h1>
          <p className="about-sub">
            Upload your packets and scoresheets — Buzzpoints turns them into a fast, shareable
            stats site for any tournament.
          </p>
          <div className="about-actions">
            <Link to="/new" className="about-btn primary">Create a tournament</Link>
            <Link to="/" className="about-btn ghost">Browse tournaments</Link>
          </div>

          <div className="about-features">
            {FEATURES.map(([title, desc]) => (
              <div className="about-feature" key={title}>
                <span className="about-check">✓</span>
                <div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="about-foot">
            Built on the open-source{" "}
            <a className="about-link" href="https://github.com/JemCasey/buzzpoints" target="_blank" rel="noreferrer">BuzzPoints</a>{" "}
            project, reimagined as a self-serve app.
          </p>
        </div>
      </main>
    </div>
  );
}
