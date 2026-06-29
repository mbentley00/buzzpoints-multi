import { Link } from "react-router-dom";
import { AuthNav } from "../components/Common";

// A feature highlighted on the About page. `tag` flags the newest additions.
interface Feature { title: string; body: string; tag?: string }

const FEATURES: Feature[] = [
  {
    title: "Self-serve & multi-tournament",
    body:
      "One site hosts every tournament. Upload packet JSONs and QBJ scoresheets, pick a scoring format, and a full interactive stats site is generated, with no per-tournament deployment or code changes. Earlier BuzzPoints sites were typically stood up one tournament at a time.",
  },
  {
    title: "Configurable scoring, optional bonuses",
    body:
      "ACF, mACF, PACE, and Super-power are built in, and buzz values are classified generically (power / correct / neg / incorrect). Bonuses are toggled per tournament. Nothing is hard-coded to a specific event.",
  },
  {
    title: "Multiple editions & versions",
    body:
      "Combine mirrors of the same set into one tournament, switch between editions, and see exactly which questions were revised or replaced, with each edition's wording on the question page.",
    tag: "Enhanced",
  },
  {
    title: "Merged categories",
    body:
      "Owners can group existing categories into custom “merged” categories, e.g. a Fine Arts - Other made of Opera and Jazz, with fully aggregated stats and player views. A category can belong to several merged groups.",
    tag: "New",
  },
  {
    title: "Round phases & filtering",
    body:
      "Tag rounds with phases (Prelims, Playoffs, Finals, Superplayoffs, Tiebreakers, or your own), then filter every page (tossups, players, teams, categories) to a single phase. Stats are re-aggregated per phase, not just hidden.",
    tag: "New",
  },
  {
    title: "Buzz-level analysis",
    body:
      "Buzzer races, first-sentence buzzes, and first / top-3 buzz tracking surface who was fastest and where the pack converted, beyond plain conversion percentages.",
  },
  {
    title: "Corrections workflow",
    body:
      "Owners can reassign buzzes and fix word positions directly; viewers can submit correction requests for the owner to approve. The set re-aggregates automatically when an edit lands.",
    tag: "New",
  },
  {
    title: "Visibility & access control",
    body:
      "Each tournament can be public, listed (login + invite), or private. Invite specific people, share invite links, review access requests, and schedule a date to auto-publish.",
  }
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
      <main className="content about">
        <div className="hero">
          <h1>About Buzzpoints</h1>
          <p>
            Buzzpoints turns quizbowl packets and QBJ scoresheets into a hosted, interactive stats site: buzz-point
            analysis, category breakdowns, and player and team pages for any tournament.
          </p>
        </div>

        <section className="about-section">
          <h2>How it works</h2>
          <p className="about-lead">
            Upload your packet JSONs (one per round) and QBJ match files, choose a scoring format, and Buzzpoints
            precomputes everything: tossup conversion and buzz timing, bonus conversion, per-player and per-team
            category splits, buzzer races, and more. The result is a shareable site you control: public to everyone or
            limited to invited people.
          </p>
          <div className="about-cta">
            <Link to="/new" className="btn-primary">Create a tournament</Link>
            <Link to="/" className="btn-secondary">Browse tournaments</Link>
          </div>
        </section>

        <section className="about-section">
          <h2>What&rsquo;s new in this version</h2>
          <p className="about-lead">
            This is a self-serve evolution of the original{" "}
            <a className="link" href="https://github.com/JemCasey/buzzpoints" target="_blank" rel="noreferrer">BuzzPoints</a>{" "}
            stats site. It keeps the buzz-point analysis people know and adds multi-tournament hosting, access control,
            and several new ways to slice the data.
          </p>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <div className="feature-card" key={f.title}>
                <div className="feature-head">
                  <h3>{f.title}</h3>
                  {f.tag && <span className={`feature-tag tag-${f.tag.toLowerCase()}`}>{f.tag}</span>}
                </div>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="about-section">
          <h2>Credit &amp; lineage</h2>
          <p className="about-lead">
            Buzzpoints builds on the original{" "}
            <a className="link" href="https://github.com/JemCasey/buzzpoints" target="_blank" rel="noreferrer">JemCasey/buzzpoints</a>{" "}
            project and the broader quizbowl stats community. The precompute-then-serve-static-data model is preserved;
            this version moves hosting, ingestion, and access control into one self-serve app so anyone can publish a
            tournament without standing up their own deployment.
          </p>
        </section>
      </main>
      <footer className="footer">
        <Link to="/" className="link">&larr; All tournaments</Link>
      </footer>
    </div>
  );
}
