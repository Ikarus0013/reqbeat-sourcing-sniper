# Feedback on the Reqbeat API

Notes from building this demo. Everything here was checked on 5 October 2026 against the docs page, the OpenAPI spec and live calls on a Trial-tier key. It is a first-integration impression from one small project.

## What worked well

- The keyless sandbox, OpenAPI spec and `llms.txt` got us to a working pipeline in minutes.
- Validation errors explain themselves. `geo=Europe` returns a 422 naming the problem, and a bad criteria field returns the list of valid fields.
- Data is fresh: reqs first seen under 30 minutes earlier were already served.
- `/v1/reqs/search` returns each company's hiring pulse with the search result, with no extra call.

## Suggestions

1. **Point people to `/v1/reqs/qualified` earlier.** The homepage example, sandbox and `llms.txt` all lead to `/v1/reqs/search`, so the demo was built on it and needed one enrichment call per company for names. `qualified` takes several countries in one call and returns the company name, posting URL, seniority, skills and salary.
2. **Publish the `qualified` schema.** In the OpenAPI spec, `criteria` and most of the response row are untyped. We found the criteria fields only by sending an invalid one and reading the error.
3. **A repeated `geo` is silently ignored on `/v1/reqs/search`.** `geo=United Kingdom&geo=Germany` returns exactly the Germany-only result, and reversing the order returns UK-only. The other list filters accept repeats, so this should either work or return a 422.
4. **Document rate limits.** We received one 429 (`{"reason":"rate_limited"}`) on an enrichment call during back-to-back runs. Neither the spec nor the docs mention 429, a limit or a retry header. We could not reproduce it later with 69 consecutive calls, so the threshold is unknown to us.
5. **`role` means different things on the two search endpoints.** On `/v1/reqs/search` it is title text; on `/v1/jobs/search` it is a function taxonomy ID and title text goes in `q`. Sending `q` to `/v1/reqs/search` is a 422.
6. **Title matching on `/v1/reqs/search` has no stemming.** "ai engineer" returned a full page for the UK; "ai engineers" returned zero. This is documented, but the semantic `q` is only on the jobs endpoint.
7. **`/v1/companies/{id}/open-reqs` has no `raw_title`.** The docs say to fall back to it when `title` is null, but this endpoint does not return it. For ClickHouse, 15 of 37 open reqs had neither a title nor a function.
8. **Normalised titles and functions look lossy.** In the same ClickHouse list: "Architect" is classed as Construction, "Customer service technician" as Skilled Trades & Maintenance, and several titles read "Engineer _". Across 25 companies in a German search, 46% of pulse role counts were `unspecified`.
9. **"ATS-only" is confusing.** The endpoint docs use that label, but in a sample of 209 reqs, 84 came from Himalayas and 35 from Experteer, against about 68 from ATS platforms. The method page says most of the corpus arrives via boards and aggregators. A short definition would help, plus a note on what `first_seen` means for aggregator-sourced reqs.
10. **`source_board` was null on every pulse field** (666 of 666 in our sample). If that is by design for aggregates, the docs could say so.
11. **Small things.** `/v1/whoami` returns `tier: "tier_1"` with `plan: null` and is untyped in the spec; the sandbox rejects `exclude_agencies`.

## Product observations

- We found no people or contact fields anywhere in the spec, so outreach use cases need a second data source.
- "GTM Engineer" returned zero reqs in our six European countries over 7 days (12 worldwide, mostly US). That is market volume rather than an API issue, but it limits this particular use case in Europe.
- The demo polls. Watches and webhooks, the real path to "the hour it's posted", are untested here.

## Known limitation of this demo

The dashboard still uses `/v1/reqs/search` plus per-company enrichment (about 70 calls per run). Rebuilding it on `/v1/reqs/qualified` would cut that to a handful, with one trade-off: that endpoint does not return the hiring pulse the emails currently quote.
