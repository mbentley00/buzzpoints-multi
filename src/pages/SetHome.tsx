import { Link, useParams } from "react-router-dom";
import { useSetCtx, setTabs } from "../components/Layout";
import { levelLabel, difficultyLabel } from "../types";

export function SetHome() {
  const { meta, level, tdLink, difficulty, combinedFrom, editions, isOwner, forum, forumUnread, pendingAccess } = useSetCtx();
  const { slug = "" } = useParams();
  const base = `/set/${slug}`;
  // Every page the header offers, as a card — the same list, so nothing the
  // header links to is missing from here.
  const links = setTabs(meta, base, { hasEditions: editions.length > 1, isOwner, forum, forumUnread, pendingAccess });
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{meta.setName}</h1>
          <p className="subtitle">
            {level && <>{levelLabel(level)} · </>}
            {difficultyLabel(level, difficulty) && <>{difficultyLabel(level, difficulty)} · </>}
            {meta.individual
              ? <>{meta.numGames} rooms · {meta.numPlayers} players · {meta.rounds.length} rounds · individual shootout · </>
              : <>{meta.numGames} games · {meta.numTeams} teams · {meta.numPlayers} players · {meta.rounds.length} rounds · </>}
            {meta.scoringLabel}
            {meta.hasBonuses ? " · with bonuses" : " · no bonuses"}
          </p>
          {combinedFrom && combinedFrom.length > 0 && (
            <p className="subtitle">
              Combined from{" "}
              {combinedFrom.map((c, i) => (
                <span key={c.slug}>
                  {i > 0 && " · "}
                  <Link className="link" to={`/set/${c.slug}`}>{c.name}</Link>{" "}
                  <span className="muted">(packets {c.from}–{c.to})</span>
                </span>
              ))}
            </p>
          )}
          {tdLink && (
            <p className="subtitle">
              <a className="link" href={tdLink} target="_blank" rel="noreferrer">Tournament Database entry →</a>
            </p>
          )}
        </div>
      </div>
      <div className="card-grid">
        {links.map((l) => (
          <Link key={l.to} to={l.to} className="nav-card">
            <div className="nav-card-title">{l.label}{!!l.badge && <span className="badge-new">{l.badge}</span>}</div>
            <div className="nav-card-desc">{l.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
