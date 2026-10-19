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
        <p>Renaming changes what the tournament is called everywhere its stats are published. Links keep working. Tournaments here are named year first: “2026 PACE NSC”, not “PACE NSC 2026”.</p>
        <p>The <strong>date</strong> is when it was first played: the earliest mirror.</p>
        <p>The <strong>difficulty</strong> uses the high school tiers, or for college and open sets the <a href="https://collegequizbowlcalendar.com/difficulty-scale/" target="_blank" rel="noreferrer">College Quizbowl Calendar scale</a> in half steps.</p>
        <p>An <strong>individual shootout</strong> (like IPNCT) reads every player as their own competitor, whatever “teams” the scoresheets were filed under, and ranks players rather than teams. Changing it rebuilds the stats.</p>
      </> },
      { id: "visibility", title: "Visibility", body: <>
        <p><strong>Public</strong> tournaments are listed and open to everyone. <strong>Listed</strong> ones appear in the list, but only invited, signed-in people can open them. <strong>Private</strong> ones are hidden from the list too. Buzzpoints show every question's full text, so make a set public only once it's clear.</p>
        <p>A tournament uploaded less than three months ago needs a moderator's approval to go public. A first tournament posted Private without review needs approval to be listed, too. Practice tournaments stay listed or private.</p>
        <p><strong>Automatically make public</strong> flips it to public on the date you pick. <strong>Let viewers suggest corrections</strong> lets anyone who can view it propose a buzz fix, a bonus-parts fix or a rename, which you approve on the Corrections page.</p>
      </> },
      { id: "delete", title: "Deleting a tournament", body: <>
        <p>Deleting removes every stat page, buzz correction and uploaded packet and game file. Links to it stop working, and there's no undo. <strong>Rebuild stats</strong> recomputes everything from the uploaded files, which picks up new stats pages and fixes.</p>
      </> },
    ],
  },
  {
    tab: "Access & sharing",
    items: [
      { id: "people", title: "People", body: <>
        <p><strong>Viewers</strong> can open a listed or private tournament and submit correction requests. <strong>Co-owners</strong> manage it with you: uploading files, fixing buzzes, approving edit and access requests and changing settings. Only the creator can delete the tournament or change who co-owns it.</p>
        <p>Someone without a Buzzpoints account is emailed an invitation, and becomes a co-owner as soon as they sign up with that address. A public tournament needs no viewers, so only co-owners are listed.</p>
      </> },
      { id: "links", title: "Invite links", body: <>
        <p>Anyone with an account who opens an active link gets access. For a link that needs your approval, opening it sends you an access request instead, which you approve or deny at the top of the tab. Revoke a link to stop it working.</p>
      </> },
      { id: "discussion", title: "Discussion", body: <>
        <p>Off by default. When it's on, signed-in viewers with access can read the threads, and can post once you've approved them; you get an email when someone asks. Everyone who has written in a thread is emailed when it gets a reply. Posts are stored as BBCode, phpBB's own markup, so the discussion can later be synced to a phpBB forum.</p>
      </> },
      { id: "revoke", title: "Revoke all access", body: <>
        <p>Takes the tournament back to its owners. Everyone you've invited is removed, every invite link stops working, and pending access requests are declined without emailing anyone. Any auto-publish date or pending request to go public is cancelled. A public tournament becomes listed or private, whichever you pick.</p>
      </> },
    ],
  },
  {
    tab: "Questions & categories",
    items: [
      { id: "phases", title: "Round phases", body: <>
        <p>Tag rounds with phases such as Prelims, Playoffs or Finals, and viewers can filter every page to a phase. A round can carry more than one tag. Mirrors / editions that ran different schedules (different packets in the playoffs, say) can each have their own, so a phase only ever collects the games actually played in it.</p>
      </> },
      { id: "categories", title: "Category fields", body: <>
        <p>Each question's metadata is a comma-separated line, but sets order it differently: some lead with the writer, some with the category. A set can then end up filed under a writer's initials. Say what each field means and every question is re-read. Fields marked <strong>Tag</strong> become extra dimensions you can filter and compare on, like the writer.</p>
      </> },
      { id: "questionedits", title: "Edit questions", body: <>
        <p>When a set tags its rounds inconsistently, the same subject lands under several categories. This setting lets you manually fix them. Edits sit on top of the packet's metadata, so re-uploading or remapping keeps them. “Reset to packet's” undoes one.</p>
      </> },
      { id: "bonusdiff", title: "Bonus difficulty marks", body: <>
        <p>This setting lets you fix bonuses that have incorrect easy/medium/hard difficulty marks, for instance two parts listed as an easy part. Re-mark the parts and the stats are rebuilt. The packet file itself is left alone.</p>
      </> },
      { id: "bonustext", title: "Fill bonus text", body: <>
        <p>A tournament imported from another Buzzpoints site (e.g. one hosted on Vercel) can arrive with bonus answers and conversion but blank lead-ins and parts. If that site no longer has the text, pick a fill file made from this tournament's packets. Only lead-ins and part text change, and each bonus is checked against its stored answer lines first.</p>
      </> },
    ],
  },
  {
    tab: "Rounds & files",
    items: [
      { id: "addrounds", title: "Add rounds or games", body: <>
        <p>A tournament played over several days or weeks doesn't have to arrive in one upload: add each round's packets and games as they're played and stats get recalculated. To redo a round, upload the corrected files and tick Replace, so the fix replaces the old copy instead of sitting beside it.</p>
      </> },
      { id: "rounds", title: "Rounds & games", body: <>
        <p>Each packet's round comes from its <strong>filename</strong> (“Round_3.json” is round 3; a file with no number falls back to round 0). Games carry their own round from inside the QBJ, or else their filename. When the two don't match, the buzzes never reach the questions: the packet shows 0 heard everywhere while player and team stats look normal. Fix it by typing the right round under <strong>Round numbers</strong>. “Use suggested rounds” fills in the pairings the site can work out.</p>
        <p>Uploading <strong>appends</strong> to an edition, so uploading the same files twice stores them twice, and a wrong upload lands beside the right one. <strong>Remove rounds</strong> clears a round, an edition or everything; the tournament keeps its address, settings, invites and corrections, so you can upload replacements into it. <strong>Remove by team</strong> is for games from a different tournament uploaded into this one, where only the teams tell them apart.</p>
        <p><strong>Games</strong> lists every stored game. A duplicate is the same matchup stored twice in one round, usually from uploading the same files again; each extra copy inflates games played, tossups heard and totals. A team that played in more than one edition usually means games went into the wrong edition, or into two. You can also move a single game filed under the wrong round.</p>
      </> },
      { id: "replacements", title: "Tiebreakers & replacements", body: <>
        <p>Game files record only <em>which number</em> a room read (“round 7, tossup 22”), and the question itself is looked up in that round's packet. (Although this is changing in a future version of yapp to include a hash of each question.) When a room read a tiebreaker or a replacement the packet doesn't have, its buzzes and bonus results don't count toward any question. Drop the tiebreaker packet into the upload box (it's filed on a round of its own, whatever it's called), then pick the question each one really was. Where rooms read different questions under the same number, map them game by game. The game files are never changed, so Undo puts everything back.</p>
      </> },
      { id: "klaxon", title: "Klaxon buzz logs", body: <>
        <p>A QBJ records only the buzz that got the floor. A <a href="https://klaxonbuzz.com" target="_blank" rel="noreferrer">Klaxon</a> room also logs every press behind it: the player who knew it too and lost the race by 40 ms, or pressed while the winner was answering. Download each room's log from its buzz panel (<code>klaxon_ROOM_full_buzz.json</code>) and add it here once that room's QBJs are uploaded.</p>
        <p>A room plays several games, so each log is split into games where the round changes or the tossup numbers start over, and each game is matched to the QBJ game whose buzzes agree with it most. Buzzes the moderator cleared as accidental are dropped. The preview shows every match before anything is saved; adding the same log again replaces it.</p>
        <p>The results go on a separate Klaxon page and in their own sections on player and tossup pages. A race is an opponent pressing within one second of the buzz; slower presses are counted as late presses. Viewers can switch Klaxon stats off, and the QBJ stats never change.</p>
      </> },
      { id: "replace", title: "Replace all data", body: <>
        <p>Swaps every edition's packets and games for a new export: a buzzpoint-migrator <code>.db</code>, its data folder, or a .zip of that folder. Use it when a better copy of the data turns up, such as one with every team's bonus results. For each site in the file, pick the edition it replaces: it keeps that edition's name and per-edition settings (phases, replacement mappings). Editions nothing replaces are removed. Corrections and renames are kept and re-applied; any that pointed at a buzz or game the new file doesn't have stop showing. It can't be undone.</p>
      </> },
    ],
  },
  {
    tab: "Players & teams",
    items: [
      { id: "renames", title: "Rename players and teams", body: <>
        <p>A rename combines all data for a player or team into one spelling, fixing a typo or joining two spellings of the same person or school that split their stats. You can also rename from a player's or team's page. Viewers can suggest a rename too; it lands on the Corrections page for approval. Every applied rename can be undone.</p>
      </> },
      { id: "dupes", title: "Possible duplicates", body: <>
        <p>Hand-entered scoresheets spell the same team or person slightly differently from room to room, and each spelling gets its own row. These pairs look like the same one. Two teams that met or played the same round, or two players who appeared in one game, are never suggested. Tick the real ones and merge; each merge is a rename you can undo.</p>
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
          <p className="lead">What each section of a tournament's Settings page does, and when to use it.</p>
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
