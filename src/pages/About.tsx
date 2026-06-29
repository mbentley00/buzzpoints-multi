import { Link } from "react-router-dom";
import { AuthNav } from "../components/Common";

const FEATURES: [string, string][] = [
  ["Self-serve hosting", "One site hosts every tournament; anyone can create one."],
  ["Any scoring format", "ACF, mACF, PACE, or Super-power, with optional bonuses."],
  ["Editions and versions", "Combine mirrors of a set and see how questions changed."],
  ["Merged categories", "Group categories into your own custom buckets."],
  ["Round phases", "Tag rounds and filter every page to a phase."],
  ["Buzz analysis", "Buzzer races, first-sentence buzzes, and first and top-3 tracking."],
  ["Corrections", "Fix buzzes directly or review requests; stats rebuild instantly."],
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

      <main className="about-doc">
        <article>
          <h1>About Buzzpoints</h1>
          <p className="lead">
            Buzzpoints turns quizbowl packets and QBJ scoresheets into a fast, shareable stats
            site for any tournament: buzz-point analysis, category breakdowns, and player and
            team pages.
          </p>

          <hr />

          <h2>How it works</h2>
          <p>
            Upload your packets (one per round) and QBJ match files, then choose a scoring format.
            Buzzpoints precomputes everything: tossup conversion and buzz timing, bonus conversion,
            category splits, buzzer races, and more. The result is a site you control, open to
            everyone or limited to people you invite.
          </p>

          <h2>What it does</h2>
          <dl>
            {FEATURES.map(([title, desc]) => (
              <div key={title}>
                <dt>{title}</dt>
                <dd>{desc}</dd>
              </div>
            ))}
          </dl>

          <h2>Credit</h2>
          <p className="about-foot">
            Buzzpoints builds on the open-source{" "}
            <a href="https://github.com/JemCasey/buzzpoints" target="_blank" rel="noreferrer">BuzzPoints</a>{" "}
            project, reimagined as a self-serve app.
          </p>

          <p className="about-links">
            <Link to="/new">Create a tournament</Link> &nbsp;·&nbsp; <Link to="/">Browse tournaments</Link>
          </p>
        </article>
      </main>
    </div>
  );
}
