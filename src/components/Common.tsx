import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { EditionSummary } from "../types";
import { Feedback } from "./Feedback";

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
