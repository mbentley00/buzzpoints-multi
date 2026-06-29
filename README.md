# Buzzpoints (multi-tournament)

A self-serve evolution of the [BuzzPoints](https://github.com/JemCasey/buzzpoints)
stats site. Sign in, upload packet JSONs + QBJ scoresheets, pick a scoring
format, and it generates a hosted, interactive stats site for that tournament —
buzz-point analysis, category breakdowns, and player/team pages. One deployment
hosts many tournaments; there's no tournament-specific logic (scoring is
configurable, bonuses optional). Designed to run entirely on Vercel.

See the in-app **/about** page for a feature overview.

## Features

- **Self-serve & multi-tournament** — accounts create and own tournaments; the
  site lists them all.
- **Configurable scoring, optional bonuses** — ACF / mACF / PACE / Super-power,
  classified generically; bonuses toggled per tournament.
- **Editions & versions** — combine mirrors of a set, switch between editions,
  and see which questions were revised/replaced (per-edition wording).
- **Merged categories** — owners group existing categories into custom virtual
  categories (e.g. "Fine Arts – Other" = Opera + Jazz) with aggregated stats.
- **Round phases / tags** — tag rounds (Prelims, Playoffs, Finals, …) and filter
  every page to a phase (stats re-aggregated per phase).
- **Per-category team rank**, buzzer races, first-sentence buzzes, first/top-3
  buzz tracking.
- **Corrections** — owners reassign buzzes directly; viewers submit correction
  requests for approval; the set re-aggregates automatically.
- **Visibility & access control** — public / listed / private, invites, invite
  links, access requests, and scheduled auto-publish.
- **YellowFruit companion export** — optionally attach the `.yft` you scored from
  when creating a tournament; download a copy with your buzz corrections applied,
  ready to re-import into YellowFruit.

## How it works

- **Static frontend** (Vite/React) — slug-dynamic, reads precomputed JSON for a
  set through `/api/data` (which streams from the private Vercel Blob store and
  enforces per-set visibility).
- **`/api/blob-upload`** — issues client-upload tokens so the browser uploads raw
  files straight to Blob (bypassing the 4.5 MB function body limit).
- **`/api/ingest`** — fetches the uploaded files, runs the generic aggregation
  (`api/_lib/aggregate.ts`), writes the computed JSON for the set to Blob, and
  updates `sets/index.json`. Owner edits (corrections, merged categories, round
  tags) re-run the same aggregation via `aggregateAndWrite`.
- **`/api/index`** — returns the tournament list visible to the caller.
- **`/api/auth`, `/api/manage`, …** — accounts, access control, and owner
  configuration (settings, invites, merged categories, round tags, delete).

The precompute-then-serve-static-JSON model is preserved; the precompute lives in
a function and the output (plus source files, the user store, and the set index)
lives in a private Blob store.

## Accounts & access

Email + password sign-up with email verification (magic link). Sessions are
HMAC-signed tokens in an HttpOnly cookie. Each tournament is owned by its creator
and can be **public** (anyone), **listed** (login + invite), or **private**
(invite only); owners manage invites, invite links, and access requests. Platform
**admins** (set via `ADMIN_EMAILS`) and moderators can manage/hide tournaments and
review the first-post queue.

## Scoring formats

Chosen per tournament on upload (`api/_lib/scoring.ts`):

| Format | Values | Powers | Negs |
|---|---|---|---|
| ACF | 10 / -5 | no | yes |
| mACF | 15 / 10 / -5 | yes | yes |
| PACE | 20 / 10 / 0 | yes | no |
| Super-power | 20 / 15 / 10 / -5 | yes | yes |

Classification is generic: `value > 10` → power, `value > 0` → correct,
`value < 0` → neg, `0` → incorrect (no penalty). The format only controls which
columns appear (power / neg). Bonuses are toggled per tournament.

## Inputs

- **Packets**: standard packet-parser JSON, one file per round (`{ tossups: [...],
  bonuses: [...] }`); round taken from the filename.
- **Games**: QBJ match files (`.json` / `.qbj`); round taken from `_round` or the
  filename.
- **YellowFruit (optional)**: the `.yft` you scored from, stored alongside the
  packets/games so a corrections-applied copy can be re-exported.

## Deploy to Vercel

1. `npm install`
2. Create a Vercel project from this directory (Vite is auto-detected; `/api/*`
   deploy as Node functions).
3. **Add a Vercel Blob store** to the project (Storage tab, or
   `vercel blob store add buzzpoints`). This sets `BLOB_READ_WRITE_TOKEN`
   automatically.
4. Set the environment variables below.
5. Deploy (`vercel deploy --prod`). Open the site, sign up, and create a
   tournament.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | yes | Private Blob store (set automatically when you connect one). |
| `SESSION_SECRET` | yes (prod) | Signs session & verification tokens. Defaults to an insecure dev value if unset. |
| `ADMIN_EMAILS` | optional | Comma-separated platform admin emails. |
| `RESEND_API_KEY` | optional | Enables transactional email (verification, access, corrections) via [Resend](https://resend.com). When unset, links are surfaced in-app instead. |
| `EMAIL_FROM` | optional | From address, e.g. `Buzzpoints <noreply@buzzpoints.buzz>`. Requires a domain verified in Resend. |
| `APP_URL` | optional | Base URL used in email links (defaults to `https://buzzpoints.buzz`). |

## Local development

```bash
npm install
npm run dev                # Vite dev server (frontend only)
npm run build && npm run preview
```

To run the `/api/*` functions and Blob store locally, use the Vercel CLI
(`vercel dev`) with the project's Blob credentials in the environment.
`public/sets` and `public/api` are gitignored and must NOT be deployed (a static
`/api/index` file would shadow the serverless function).

## Notes / limits

- Bundled detail files (`tossups_detail.json`, `bonuses_detail.json`) keep the
  ingest to a small number of Blob writes so it finishes within the function time
  limit.
- Uploads go directly to Blob from the browser, so large tournaments are fine.
- The Blob store is private; computed JSON is served through `/api/data`, which
  redacts question content for sets the caller isn't entitled to see.
