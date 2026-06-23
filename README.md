# Buzzpoints (multi-tournament)

A self-serve fork of the Buzzpoints stats site. Upload packet JSONs + QBJ
scoresheets, pick a scoring format, and it generates a hosted stats site for
that tournament. No tournament-specific logic — scoring is configurable and
bonuses are optional. Designed to run entirely on Vercel.

## How it works

- **Static frontend** (Vite/React) — slug-dynamic, reads precomputed JSON for a
  set directly from Vercel Blob (`{base}/sets/{slug}/...`).
- **`/api/blob-upload`** — issues client-upload tokens so the browser uploads raw
  files straight to Blob (bypassing the 4.5 MB function body limit).
- **`/api/ingest`** — fetches the uploaded files, runs the generic aggregation
  (`api/lib/aggregate.ts`), writes the computed JSON for the set to Blob, and
  updates `sets/index.json`.
- **`/api/index`** — returns the tournament list + the Blob base URL.

The precompute-then-serve-static-JSON model is preserved; only the precompute
moved into a function and the output moved into Blob.

## Scoring formats

Chosen per tournament on upload (`api/lib/scoring.ts`):

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

## Deploy to Vercel

1. `npm install`
2. Create a Vercel project from this directory (Vite is auto-detected; `/api/*`
   deploy as Node functions).
3. **Add a Vercel Blob store** to the project (Storage tab, or
   `vercel blob store add buzzpoints`). This sets `BLOB_READ_WRITE_TOKEN` on the
   project automatically.
4. Deploy (`vercel deploy --prod`). Open the site and create a tournament.

No other env vars are required; the frontend discovers the Blob base via
`/api/index`.

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
  ingest to ~9 Blob writes so it finishes well within the function time limit.
- Uploads go directly to Blob from the browser, so large tournaments are fine.
- There is currently no auth — anyone who can reach the deployment can create a
  tournament. Add a gate (e.g. Vercel password protection or an auth provider)
  before exposing it publicly.
