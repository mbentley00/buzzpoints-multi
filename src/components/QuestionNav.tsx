import { useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";

// Previous/next links between adjacent questions, so you can read a packet
// straight through instead of bouncing back to the list for every question.
// Order is packet order (round, then number) and it runs across round
// boundaries: the last question of round 1 is followed by the first of round 2.
// Left/right arrows and p/n do the same thing.

interface Positioned { round: number; num: number }

export interface QuestionNavState {
  prev: { id: string; round: number; num: number } | null;
  next: { id: string; round: number; num: number } | null;
  round: number; // the current question's round
  pos: number;   // 1-based position in the whole set
  total: number;
}

export function useQuestionNav(
  all: Record<string, Positioned> | null | undefined,
  id: string
): QuestionNavState {
  return useMemo(() => {
    const empty: QuestionNavState = { prev: null, next: null, round: 0, pos: 0, total: 0 };
    if (!all) return empty;
    const ids = Object.entries(all)
      .map(([k, v]) => ({ id: k, round: v.round, num: v.num }))
      .sort((a, b) => a.round - b.round || a.num - b.num);
    const i = ids.findIndex((x) => x.id === id);
    if (i < 0) return { ...empty, total: ids.length };
    return { prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null, round: ids[i].round, pos: i + 1, total: ids.length };
  }, [all, id]);
}

// Shortcut keys shouldn't hijack typing (the buzz editor has number/text inputs)
// or stomp on a browser shortcut.
const typingIn = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable;
};

export function QuestionNav({ nav, hrefOf, label }: {
  nav: QuestionNavState;
  hrefOf: (id: string) => string;
  label: string; // "Tossup" | "Bonus"
}) {
  const navigate = useNavigate();
  const { prev, next } = nav;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if ((k === "ArrowLeft" || k === "p") && prev) { e.preventDefault(); navigate(hrefOf(prev.id)); }
      if ((k === "ArrowRight" || k === "n") && next) { e.preventDefault(); navigate(hrefOf(next.id)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, navigate, hrefOf]);

  if (!prev && !next) return null;
  // Only spell out the round when stepping across a packet boundary.
  const name = (q: { round: number; num: number }) =>
    q.round === nav.round ? `${label} ${q.num}` : `Rd ${q.round} · ${label} ${q.num}`;

  return (
    <div className="qnav" role="navigation" aria-label={`Adjacent ${label.toLowerCase()}s`}>
      {prev ? (
        <Link className="qnav-link" to={hrefOf(prev.id)} title="Previous question (← or p)">← {name(prev)}</Link>
      ) : (
        <span className="qnav-link qnav-off">← {label}</span>
      )}
      {nav.total > 0 && <span className="qnav-pos muted">{nav.pos} of {nav.total}</span>}
      {next ? (
        <Link className="qnav-link" to={hrefOf(next.id)} title="Next question (→ or n)">{name(next)} →</Link>
      ) : (
        <span className="qnav-link qnav-off">{label} →</span>
      )}
    </div>
  );
}
