import { Link, useParams } from "react-router-dom";
import { useSetCtx } from "../components/Layout";
import { levelLabel } from "../types";

export function SetHome() {
  const { meta, level, tdLink } = useSetCtx();
  const { slug = "" } = useParams();
  const base = `/set/${slug}`;
  const links = [
    { to: `${base}/tossup`, label: "Tossups", desc: `${meta.numTossups} questions` },
    ...(meta.hasBonuses ? [{ to: `${base}/bonus`, label: "Bonuses", desc: `${meta.numBonuses} bonuses` }] : []),
    { to: `${base}/player`, label: "Players", desc: `${meta.numPlayers} players` },
    ...(meta.individual ? [] : [{ to: `${base}/team`, label: "Teams", desc: `${meta.numTeams} teams` }]),
    { to: `${base}/category/tossup`, label: "Categories (Tossup)", desc: "By subject" },
    ...(meta.hasBonuses ? [{ to: `${base}/category/bonus`, label: "Categories (Bonus)", desc: "By subject" }] : []),
  ];
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{meta.setName}</h1>
          <p className="subtitle">
            {level && <>{levelLabel(level)} · </>}
            {meta.individual
              ? <>{meta.numGames} rooms · {meta.numPlayers} players · {meta.rounds.length} rounds · individual shootout · </>
              : <>{meta.numGames} games · {meta.numTeams} teams · {meta.numPlayers} players · {meta.rounds.length} rounds · </>}
            {meta.scoringLabel}
            {meta.hasBonuses ? " · with bonuses" : " · no bonuses"}
          </p>
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
            <div className="nav-card-title">{l.label}</div>
            <div className="nav-card-desc">{l.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
