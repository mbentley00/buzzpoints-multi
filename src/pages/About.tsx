import { Link } from "react-router-dom";
import { AuthNav } from "../components/Common";

const FEATURES: [string, string][] = [
  ["Self-serve hosting", "This site hosts everything. No need for setting up local environments and vercel deployments."],
  ["Editions and versions", "Combine mirrors of a set and see how questions changed."],
  ["Merged categories", "Group categories into your own custom buckets. For instance, create a 'Fine Arts - Other - Visual' that wasn't there in the original packets."],
  ["Round phases", "Tag rounds to easily filter on playoffs, prelims, tiebreakers."],
  ["Buzz analysis", "Buzzer races, first-sentence buzzes, and first and top-3 tracking."],
  ["Corrections", "Players can submit stat corrections directly in the site. Hosts can export corrected stats to YellowFruit"],
  ["Access control", "Public, invite-only, or private, with scheduled auto-publish. Remember that buzz points expose the full question content of a set, so only should be made public once a set is clear."],
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
            Buzzpoints is an all-in-one site for showing individual buzzpoints and bonus conversions for quizbowl tournaments.
            It works with any tournament run via <a href="https://www.qbwiki.com/wiki/MODAQ">MODAQ</a>.
          </p>

          <hr />

          <h2>How it works</h2>
          <p>
            Upload your packets (one per round) and QBJ match files from MODAQ, then choose a scoring format.
            You can then manage access and invites to the tournament and upload new stats for later mirrors.
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
            Buzzpoints.buzz is maintained by <a href="mailto:bentley.michael.j@gmail.com">Mike Bentley</a>.
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
