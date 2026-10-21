import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { AuthNav } from "../components/Common";

// The long explanations behind each tournament Settings section. Settings itself
// shows one line per section and links here (in a new tab, so an upload or a
// repair in progress isn't lost) by the section's id.

const SECTIONS: { tab: string; items: { id: string; title: string; body: JSX.Element }[] }[] = [
  {
    tab: "General",
    items: [
      { id: "details", title: "Tournament details", body: <>
        <p>Names go year first: “2026 PACE NSC”. Links survive a rename.</p>
        <p>The <strong>date</strong> is the earliest mirror.</p>
        <p><strong>Difficulty</strong> uses the high school tiers, or the <a href="https://collegequizbowlcalendar.com/difficulty-scale/" target="_blank" rel="noreferrer">College Quizbowl Calendar scale</a> for college and open sets.</p>
        <p>An <strong>individual shootout</strong> (like IPNCT) ranks players and ignores scoresheet teams. Changing it rebuilds the stats.</p>
      </> },
      { id: "visibility", title: "Visibility", body: <>
        <p>Public sets show every question's full text. Make a set public only once it's clear.</p>
        <p>Sets uploaded under three months ago need a moderator's approval to go public. A first set posted Private without review needs approval to be listed. Practice sets can't be public.</p>
        <p>Suggested corrections wait on the Corrections page for your approval.</p>
      </> },
      { id: "delete", title: "Deleting a tournament", body: <>
        <p>Deleting can't be undone. <strong>Rebuild stats</strong> picks up new stats pages and site fixes.</p>
      </> },
    ],
  },
  {
    tab: "Access & sharing",
    items: [
      { id: "people", title: "People", body: <>
        <p>Only the creator can delete the set or change who co-owns it. Public sets list co-owners only.</p>
        <p>Someone without an account gets an emailed invitation and becomes a co-owner on signing up with that address.</p>
      </> },
      { id: "links", title: "Invite links", body: <>
        <p>An “Ask me first” link sends you an access request instead. Requests appear at the top of the tab.</p>
      </> },
      { id: "discussion", title: "Discussion", body: <>
        <p>You get an email when someone asks to post. Everyone in a thread is emailed on replies. Posts are stored as BBCode for a future phpBB sync.</p>
      </> },
      { id: "revoke", title: "Revoke all access", body: <>
        <p>Pending requests are declined without email. Any auto-publish date or pending public request is cancelled.</p>
      </> },
    ],
  },
  {
    tab: "Questions & categories",
    items: [
      { id: "phases", title: "Round phases", body: <>
        <p>A round can have more than one phase. Each edition can have its own schedule.</p>
      </> },
      { id: "categories", title: "Category fields", body: <>
        <p>Sets order metadata fields differently. A wrong mapping files questions under writers' initials. Saving re-reads every question. <strong>Tag</strong> fields become filters.</p>
      </> },
      { id: "questionedits", title: "Edit questions", body: <>
        <p>Edits survive re-uploads and remaps. “Reset to packet's” undoes one.</p>
      </> },
      { id: "bonusdiff", title: "Bonus difficulty marks", body: <>
        <p>Saving rebuilds the stats. The packet file isn't changed.</p>
      </> },
      { id: "bonustext", title: "Fill bonus text", body: <>
        <p>For sets imported from another Buzzpoints site with blank bonus text. Use a fill file made from this set's packets. Each bonus is checked against its stored answer lines first.</p>
      </> },
    ],
  },
  {
    tab: "Rounds & files",
    items: [
      { id: "addrounds", title: "Add rounds or games", body: <>
        <p>Without Replace, a re-uploaded round is stored beside the old copy.</p>
      </> },
      { id: "rounds", title: "Rounds & games", body: <>
        <p>A packet's round comes from its <strong>filename</strong> (“Round_3.json” is round 3, no number is round 0). A game's comes from the QBJ, or else its filename. A mismatch shows 0 heard on the packet while player stats look normal. Fix it under <strong>Round numbers</strong>.</p>
        <p>Uploading <strong>appends</strong>. The same files uploaded twice are stored twice. <strong>Remove rounds</strong> keeps the set's address, settings, invites and corrections. <strong>Remove by team</strong> is for another tournament's games uploaded here.</p>
        <p>Duplicate games inflate games played, tossups heard and totals. A team in more than one edition usually means games went into the wrong edition.</p>
      </> },
      { id: "replacements", title: "Tiebreakers & replacements", body: <>
        <p>Game files record only the question <em>number</em>. A tiebreaker or replacement the packet lacks counts toward no question. An uploaded tiebreaker packet gets its own round, whatever its filename. Game files aren't changed. Undo restores everything.</p>
      </> },
      { id: "klaxon", title: "Klaxon buzz logs", body: <>
        <p>A <a href="https://klaxonbuzz.com" target="_blank" rel="noreferrer">Klaxon</a> log has every press, not only the buzz that got the floor. Download each room's <code>klaxon_ROOM_full_buzz.json</code> from its buzz panel. Add it after that room's QBJs.</p>
        <p>Cleared accidental buzzes are dropped. Adding a log again replaces it.</p>
        <p>A race is an opponent press within one second. Slower ones count as late presses. QBJ stats don't change.</p>
      </> },
      { id: "replace", title: "Replace all data", body: <>
        <p>Takes a buzzpoint-migrator <code>.db</code>, its data folder, or a .zip of it. A replaced edition keeps its name, phases and replacement mappings. Editions nothing replaces are removed. Corrections for buzzes or games missing from the new file stop showing. No undo.</p>
      </> },
    ],
  },
  {
    tab: "Players & teams",
    items: [
      { id: "renames", title: "Rename players and teams", body: <>
        <p>You can also rename from a player or team page. Viewer suggestions go to the Corrections page. Every rename can be undone.</p>
      </> },
      { id: "dupes", title: "Possible duplicates", body: <>
        <p>Teams that met or shared a round, and players in the same game, are never suggested. Each merge is an undoable rename.</p>
      </> },
    ],
  },
];

export function SettingsHelp() {
  const loc = useLocation();
  useEffect(() => {
    const el = loc.hash ? document.getElementById(loc.hash.slice(1)) : null;
    if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
  }, [loc.hash]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">Buzzpoints</Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Tournaments</Link>
            <Link to="/about" className="nav-link">About</Link>
          </nav>
          <div className="topbar-auth"><AuthNav /></div>
        </div>
      </header>
      <main className="about-doc">
        <article>
          <h1>Tournament settings help</h1>
          {SECTIONS.map((t) => (
            <section key={t.tab}>
              <hr />
              <h2>{t.tab}</h2>
              {t.items.map((it) => (
                <div key={it.id} id={it.id} className="help-item">
                  <h3>{it.title}</h3>
                  {it.body}
                </div>
              ))}
            </section>
          ))}
        </article>
      </main>
    </div>
  );
}
