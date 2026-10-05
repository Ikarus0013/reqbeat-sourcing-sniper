# Sourcing Sniper

A small demo built on the [Reqbeat](https://reqbeat.com) API: fresh job openings in, recruiter outreach out.

It searches Reqbeat for newly opened hard-to-fill tech roles (AI Engineer, GTM Engineer, Infrastructure Architect) in six European countries, matches each opening to the best-fit recruiter from a sample directory, and drafts the outreach email. Emails are simulated: nothing is ever sent.

## Run it

Needs Node 22+. No dependencies.

```bash
cp .env.example .env    # then paste your key: REQBEAT_API_KEY=...
npm start
```

Open http://localhost:4321 and press **Run check now**. Without a key it falls back to Reqbeat's keyless sandbox. A usage guide is at http://localhost:4321/guide.

## How it works

1. **Trigger** — `GET /v1/reqs/search` once per role per country, filtered to reqs first seen in the last 7 days, agencies excluded.
2. **Enrich** — `GET /v1/companies/{id}/enrichment` for company names; the hiring pulse comes with the search result.
3. **Match** — rule-based score of each req against `data/recruiters.json` (role type, country, title keywords, seniority).
4. **Action** — a templated email to the top-scoring recruiter, shown in the dashboard only.

## What is real

| Piece | Status |
|---|---|
| Openings, dates, boards, company names, hiring pulse | Live from Reqbeat |
| Recruiter directory | Fictional sample data |
| Emails | Drafted from a template, never sent |

## Configure

- `config.json` — roles, countries, lookback window, sender name.
- `data/recruiters.json` — the recruiter directory.

A run with the default config makes about 70 Reqbeat API calls.

## Feedback

Notes on the API from building this are in [FEEDBACK.md](FEEDBACK.md).
