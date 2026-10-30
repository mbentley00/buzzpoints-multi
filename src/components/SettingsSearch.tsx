import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

// Search across every setting, the way a phone's settings search works: type
// what you want to change ("co-owner", "date", "typo in a name") and jump
// straight to that field, on whichever tab holds it. Each entry is one place on
// the Settings page, by the id of the element it lands on.

export type SettingsTabId = "general" | "access" | "questions" | "files" | "renames" | "maintenance";

export interface SearchCtx {
  isResults: boolean;   // a box-score-only set: no packets, so no question/file tools
  hasYf: boolean;
  isPrimary: boolean;   // the creator (deletes, edits co-owners)
  isPublic: boolean;
  hasBonuses: boolean;
  hasRounds: boolean;
}

interface Entry {
  id: string;
  tab: SettingsTabId;
  title: string;
  section?: string;    // the section a field sits in, when the title is a field
  words: string;       // other ways people say it
  when?: (c: SearchCtx) => boolean;
}

const TAB_LABEL: Record<SettingsTabId, string> = {
  general: "General", access: "Access & sharing", questions: "Questions & categories",
  files: "Rounds & files", renames: "Players & teams", maintenance: "Maintenance",
};

const src = (c: SearchCtx) => !c.isResults;

export const SETTINGS_INDEX: Entry[] = [
  // General
  { id: "rename", tab: "general", title: "Tournament name", section: "Tournament", words: "rename title call change name year" },
  { id: "f-editions", tab: "general", title: "Edition names", section: "Tournament", words: "mirror site rename edition label version" },
  { id: "f-type", tab: "general", title: "Tournament type", section: "Tournament", words: "level high school college open middle school practice trash kind" },
  { id: "f-difficulty", tab: "general", title: "Difficulty", section: "Tournament", words: "hard easy regular nationals tier cqbc scale dots" },
  { id: "f-date", tab: "general", title: "Date first played", section: "Tournament", words: "when day calendar played held tournament date" },
  { id: "f-tdlink", tab: "general", title: "Tournament Database link", section: "Tournament", words: "td hsquizbowl url website results page" },
  { id: "f-individual", tab: "general", title: "Individual shootout", section: "Tournament", words: "ipnct players solo rank players not teams team of one" },
  // Access & sharing
  { id: "f-visibility", tab: "access", title: "Who can see it", section: "Visibility", words: "public private listed visibility hide share publish open unlist" },
  { id: "f-autopublish", tab: "access", title: "Make public on a date", section: "Visibility", words: "auto publish automatically schedule later release", when: (c) => !c.isPublic },
  { id: "f-suggest", tab: "access", title: "Let viewers suggest corrections", section: "Visibility", words: "requests corrections fixes proposals allow viewers edits" },
  { id: "requests", tab: "access", title: "Access requests", words: "approve deny pending ask join requests" },
  { id: "people", tab: "access", title: "People", words: "invite viewer co-owner coowner owner add email share collaborator role remove person" },
  { id: "links", tab: "access", title: "Invite links", words: "share link url join key approval revoke link", when: (c) => !c.isPublic },
  { id: "discussion", tab: "access", title: "Discussion", words: "forum comments threads posts talk bbcode" },
  { id: "revoke", tab: "access", title: "Revoke all access", words: "remove everyone kick lock down take back" },
  // Questions & categories
  { id: "phases", tab: "questions", title: "Round phases", words: "prelims playoffs finals tag rounds bracket stage phase filter", when: (c) => src(c) && c.hasRounds },
  { id: "categories", tab: "questions", title: "Category fields", words: "metadata subcategory author writer category mapping fields tags", when: src },
  { id: "questionedits", tab: "questions", title: "Edit questions", words: "recategorize category wrong subject question category tag bulk", when: src },
  { id: "bonusdiff", tab: "questions", title: "Bonus difficulty marks", words: "easy medium hard parts e m h difficulty modifiers", when: (c) => src(c) && c.hasBonuses },
  { id: "bonustext", tab: "questions", title: "Fill bonus text", words: "missing bonus leadin lead-in parts blank text", when: (c) => src(c) && c.hasBonuses },
  // Rounds & files
  { id: "addrounds", tab: "files", title: "Add rounds or games", words: "upload more packets qbj files replace round redo", when: src },
  { id: "rounds", tab: "files", title: "Round numbers", section: "Rounds & games", words: "packet round wrong mismatch align renumber 0 heard", when: src },
  { id: "games", tab: "files", title: "Games", section: "Rounds & games", words: "duplicate games move game wrong round matchup qbj", when: src },
  { id: "uploads", tab: "files", title: "Remove rounds", section: "Rounds & games", words: "delete round clear edition remove by team wrong upload", when: src },
  { id: "klaxon", tab: "files", title: "Klaxon buzz logs", words: "buzzer presses races klaxon log", when: src },
  { id: "replacements", tab: "files", title: "Tiebreakers & replacements", words: "tiebreaker replacement question missing packet extra tossup", when: src },
  { id: "replace", tab: "files", title: "Replace all data", words: "migrator data folder zip qbj swap reupload new export", when: src },
  // Players & teams
  { id: "renames", tab: "renames", title: "Rename players and teams", words: "typo spelling merge player team name combine school", when: src },
  { id: "f-appliedrenames", tab: "renames", title: "Applied renames", section: "Rename players and teams", words: "undo rename list history", when: src },
  { id: "dupes", tab: "renames", title: "Possible duplicates", words: "duplicate same player team merge spelling", when: src },
  // Maintenance
  { id: "maintenance", tab: "maintenance", title: "Rebuild stats", words: "recompute reaggregate refresh recalculate" },
  { id: "yf", tab: "maintenance", title: "YellowFruit export", words: "yft download yellowfruit stats file html report standings individuals scoreboard" },
  { id: "exportall", tab: "maintenance", title: "Export all data", words: "download backup zip qbj json packets roster klaxon yellowfruit everything archive" },
  { id: "delete", tab: "maintenance", title: "Delete this tournament", words: "remove erase destroy delete set", when: (c) => c.isPrimary },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Every query word has to show up somewhere — as the start of a word, or (for
// three letters or more) anywhere inside one. Hits in the title count most.
function score(e: Entry, q: string[]): number {
  const title = norm(e.title).split(" ");
  const rest = norm(`${e.section ?? ""} ${TAB_LABEL[e.tab]} ${e.words}`).split(" ");
  let total = 0;
  for (const t of q) {
    const inTitle = title.some((w) => w.startsWith(t)) ? 3 : t.length >= 3 && title.some((w) => w.includes(t)) ? 2 : 0;
    const inRest = rest.some((w) => w.startsWith(t)) ? 1 : t.length >= 3 && rest.some((w) => w.includes(t)) ? 0.5 : 0;
    if (!inTitle && !inRest) return 0;
    total += inTitle || inRest;
  }
  return total;
}

export function SettingsSearch({ slug, ctx }: { slug: string; ctx: SearchCtx }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const words = norm(q).split(" ").filter(Boolean);
    if (!words.length) return [];
    return SETTINGS_INDEX
      .filter((e) => !e.when || e.when(ctx))
      .map((e) => ({ e, s: score(e, words) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((r) => r.e);
  }, [q, ctx]);
  useEffect(() => setSel(0), [q]);

  // "/" jumps to the search box from anywhere on the page.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      ev.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function go(e: Entry) {
    setOpen(false);
    setQ("");
    input.current?.blur();
    navigate(`/set/${slug}/settings${e.tab === "general" ? "" : `/${e.tab}`}#${e.id}`);
  }

  return (
    <div className="set-search" onBlur={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setOpen(false); }}>
      <input
        ref={input}
        type="search"
        className="set-search-input"
        placeholder="Search settings"
        aria-label="Search settings"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="set-search-results"
        value={q}
        onChange={(ev) => { setQ(ev.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(ev) => {
          if (ev.key === "ArrowDown") { ev.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
          else if (ev.key === "ArrowUp") { ev.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          else if (ev.key === "Enter" && results[sel]) { ev.preventDefault(); go(results[sel]); }
          else if (ev.key === "Escape") { setOpen(false); setQ(""); }
        }}
      />
      {open && q.trim() && (
        <ul className="set-search-results" id="set-search-results" role="listbox">
          {results.length === 0 ? (
            <li className="set-search-none muted">No matches.</li>
          ) : results.map((e, i) => (
            <li key={e.id} role="option" aria-selected={i === sel}>
              <button type="button" className={"set-search-hit" + (i === sel ? " sel" : "")}
                onMouseEnter={() => setSel(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => go(e)}>
                <span className="set-search-title">{e.title}</span>
                <span className="set-search-path muted">{[TAB_LABEL[e.tab], e.section].filter(Boolean).join(" › ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
