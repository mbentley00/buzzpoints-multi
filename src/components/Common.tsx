import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { EditionSummary } from "../types";
import { Feedback } from "./Feedback";
import { ThemeToggle } from "./ThemeToggle";

// Small labels naming which edition(s) a team/player appeared in. Rendered only
// in the combined view of a multi-edition set; rows without editionIds (older
// aggregations, single-edition sets) render nothing.
export function EditionBadges({ ids, editions }: { ids?: string[]; editions: EditionSummary[] }) {
  if (!ids?.length || editions.length < 2) return null;
  return (
    <>
      {ids.map((id) => (
        <span key={id} className="edition-badge">{editions.find((e) => e.id === id)?.label ?? id}</span>
      ))}
    </>
  );
}

// Shows the signed-in user + logout, or a link to log in. Used in every topbar.
export function AuthNav() {
  const { user, name, isAdmin, isModerator, loading, logout } = useAuth();
  const loc = useLocation();
  if (loading) return null;
  if (!user) {
    const next = encodeURIComponent(loc.pathname + loc.search);
    return (
      <span className="auth-nav">
        <ThemeToggle />
        <Feedback />
        <Link to={`/login?mode=signup&next=${next}`} className="nav-link">
          Sign up
        </Link>
        <Link to={`/login?next=${next}`} className="nav-link">
          Log in
        </Link>
      </span>
    );
  }
  return (
    <span className="auth-nav">
      <ThemeToggle />
      <Feedback />
      {isModerator && <Link to="/admin" className="nav-link">{isAdmin ? "Admin" : "Moderation"}</Link>}
      <span className="auth-user" title={user}>{name || user}</span>
      <button className="btn-link" onClick={() => logout()}>Log out</button>
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {children && <div className="page-header-actions">{children}</div>}
    </div>
  );
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

export function ErrorBox({ error }: { error: string }) {
  return <div className="error-box">Error: {error}</div>;
}

export function RoundFilter({
  rounds,
  value,
  onChange,
}: {
  rounds: number[];
  value: number | "all";
  onChange: (v: number | "all") => void;
}) {
  return (
    <label className="filter">
      Round:{" "}
      <select
        value={String(value)}
        onChange={(e) =>
          onChange(e.target.value === "all" ? "all" : Number(e.target.value))
        }
      >
        <option value="all">All</option>
        {rounds.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </label>
  );
}

export function MinHeardFilter({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="filter">
      Min heard:{" "}
      <input
        className="num-input"
        type="number"
        min={0}
        value={value === 0 ? "" : value}
        placeholder="0"
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
      />
    </label>
  );
}

export function ActiveFilterChip({
  label,
  clearTo,
}: {
  label: ReactNode;
  clearTo: string;
}) {
  return (
    <Link to={clearTo} className="active-chip" title="Clear filter">
      {label} <span className="chip-x">✕</span>
    </Link>
  );
}

/** A team name that lists its roster on hover — "Belmont A" doesn't say who was
 *  actually playing. Renders as a plain name (still linked, when there's a team
 *  page to link to) whenever no roster is loaded for it.
 *
 *  The card is positioned fixed, measured off the name: the buzz list is its own
 *  scroll box, and an absolutely positioned card would be clipped by it. That
 *  also means the coordinates go stale on scroll, so it closes instead. */
export function TeamName({
  name,
  id,
  slug,
  roster,
}: {
  name: string;
  id?: string | null;
  slug: string;
  roster?: string[];
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const label = id ? (
    <Link className="link" to={`/set/${slug}/team/${id}`}>{name}</Link>
  ) : (
    name
  );

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [at]);

  if (!roster?.length) return <>{label}</>;

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const W = 220;
    // Head + a row per player, but no taller than the card's own max-height —
    // a long roster scrolls inside it rather than growing.
    const H = Math.min(300, 34 + roster.length * 19);
    setAt({
      left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
      // Flip above the name when there isn't room under it.
      top: r.bottom + H + 8 > window.innerHeight ? Math.max(8, r.top - H - 4) : r.bottom + 4,
    });
  };

  return (
    <span
      ref={ref}
      className="team-hov"
      onMouseEnter={show}
      onMouseLeave={() => setAt(null)}
    >
      {label}
      {/* Portaled to <body> on purpose. The cells this sits in are faded with
          `opacity` (.buzz-team, .buzz-opp), and any opacity below 1 creates a
          stacking context — which would both trap the card's z-index behind the
          rows underneath it and fade the card itself. Rendering outside those
          cells keeps it opaque and on top. */}
      {at &&
        createPortal(
          <span className="q-pop q-pop-fixed" role="tooltip" style={{ left: at.left, top: at.top }}>
            <span className="q-pop-head">{name} roster</span>
            {roster.map((p) => (
              <span key={p} className="q-pop-row"><span className="q-pop-who">{p}</span></span>
            ))}
          </span>,
          document.body
        )}
    </span>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="search"
      type="search"
      value={value}
      placeholder={placeholder ?? "Search…"}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
