import { Link } from "react-router-dom";
import { AuthNav } from "../components/Common";

const FEATURES: [string, string][] = [
  ["Self-serve hosting", "No local setup or deployment."],
  ["Editions and versions", "Combine mirrors of a set and compare question wording."],
  ["Merged categories", "Group categories into custom buckets."],
  ["Round phases", "Filter by prelims, playoffs or tiebreakers."],
  ["Buzz analysis", "Buzzer races, first-sentence buzzes, and first and top-3 tracking."],
  ["Corrections", "Players submit stat corrections. Hosts export corrected stats to YellowFruit."],
  ["Access control", "Public, invite-only or private, with scheduled auto-publish. Buzz points expose full question text, so make a set public only once it's clear."],
];

export function About() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Tournaments</Link>
            <Link to="/search" className="nav-link">Search across tournaments</Link>
            <Link to="/new" className="nav-link">+ New tournament</Link>
          </nav>
          <div className="topbar-auth"><AuthNav /></div>
        </div>
      </header>

      <main className="about-doc">
        <article>
          <h1>About Buzzpoints</h1>
          <p className="lead">
            Buzz points and bonus conversions for quizbowl tournaments run on{" "}
            <a href="https://www.qbwiki.com/wiki/MODAQ">MODAQ</a>.
          </p>

          <hr />

          <h2>How it works</h2>
          <p>
            Upload packets (one per round) and MODAQ game files (.qbj or .json), then choose a scoring format.
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

          <h2>BPA</h2>
          <p>
            <strong>BPA</strong> (buzz point area-under-the-curve) is Ryan Rosenberg's measure of how early a player
            buzzes correctly. Negs don't count.
          </p>
          <p className="about-formula">BPA = 100 × Σ (1 − buzz position ÷ question length) ÷ tossups heard</p>
          <p className="about-foot">
            See <a href="https://www.qbwiki.com/wiki/BPA" target="_blank" rel="noreferrer">BPA on QBWiki</a> and the
            original <a href="https://github.com/dhoth/Quizbowl-BPA" target="_blank" rel="noreferrer">Quizbowl-BPA</a>{" "}
            notebook.
          </p>

          <h2>Credit</h2>
          <p className="about-foot">
            Buzzpoints is maintained by <a href="mailto:bentley.michael.j@gmail.com">Mike Bentley</a>.
            It builds on the open-source{" "}
            <a href="https://github.com/JemCasey/buzzpoints" target="_blank" rel="noreferrer">BuzzPoints</a>{" "}
            project by Jordan Brownstein and other contributors.
          </p>

          <p className="about-links">
            <Link to="/new">Create a tournament</Link> &nbsp;·&nbsp; <Link to="/">Browse tournaments</Link>
          </p>
        </article>
      </main>
    </div>
  );
}
