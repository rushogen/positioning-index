# The B2B SaaS Positioning Index

A tracker that reads the homepage and pricing page of 60 well-known B2B SaaS
companies every day, records how they describe themselves, and detects when that
description changes.

The value is not the snapshot. It is the time series. You can ask any model what
Linear's homepage says today; no model can tell you what it said in March,
whether the word "platform" replaced "tool" in June, or which twelve companies
quietly dropped their free tier last quarter. That record has to be kept
deliberately, starting before you need it.

Built by Ruslan Shogenov. MIT licensed.

## What it records

Twelve signals per company, timestamped, append-only.

From the homepage:

- **Hero headline and subhead** — the positioning claim itself
- **Category label** — the noun they use for themselves: *platform*,
  *system of record*, *AI agent for X*. This is the most compressed statement of
  positioning a company publishes, and the reason the project exists
- **Customer logos** — names read from `alt` text, image filenames and inline
  SVG titles
- **Proof points** — quantified claims: *10x faster*, *20,000 teams*, *40% fewer
  escalations*
- **Meta title and description** — often rewritten before the visible page is,
  and the version that reaches search results and AI answers

From the pricing page:

- **Tier names and prices**, with currency, billing period and seat unit
- **Entry price** — cheapest paid plan
- **Free tier** — whether a $0 plan is published
- **Seat minimum** — the smallest purchasable number of seats, where stated

Every signal is stored with the extraction strategy that produced it and a
confidence score. `METHODOLOGY.md` defines all twelve precisely and is versioned,
because the measurement is part of the data.

## The hard part

Not the crawling. The crawling is a `fetch()` call.

The hard part is telling **"this company changed its headline"** apart from
**"our selector broke"**. Those look identical in the data — yesterday there was
a value, today there isn't, or there's a different one — and getting it wrong in
the optimistic direction means the index publishes fiction. *"Notion removed its
free plan."* *"Figma dropped 14 customer logos."* Those are claims a GTM team
would act on. If they turn out to be artefacts of a CSS refactor, the index is
worse than useless, because it is confidently wrong in a way nobody downstream
can check.

So the bias is asymmetric throughout. Missing a real change costs one day; the
next run catches it. Publishing a false one costs credibility permanently. Every
ambiguous case resolves toward saying nothing.

Concretely:

**A null is never a change.** If extraction returns nothing where it previously
returned a value, that is recorded as a parser fault, not as a removal. The last
known-good value is retained so the next successful run diffs against what we
actually believed rather than against the gap. After two consecutive nulls the
signal is marked suspect and shown as such on the public health page. Only after
five consecutive nulls, *and* only if the rest of the page kept extracting
normally throughout, is a removal confirmed — once.

**Derived signals fail together.** `pricing_free_tier: "no"` is a value, not an
absence. If tier extraction fails we do not know whether a free tier exists, so
every derived pricing signal goes null with it. That rule is enforced in the
extractor rather than left to the caller, and it is the case
`tests/pricing.test.js` is built around.

**A collapse is a redesign, not news.** If a page still parses but yields less
than half the signals it did before, every change on it is suppressed and the
fetch is recorded as `changed-structure`. A redesign that moves the hero into a
`<div role="banner">` would otherwise fire five "changes" at once — which is the
signature of our bug, not their strategy.

**Our own changes are ours.** Every observation stores the extractor version. If
that version changes, the next run against each page re-baselines and emits
nothing, so a parser improvement is never attributed to a company.

**A different language is not a rewrite.** Fetched from Germany during
development, `klaviyo.com`, `stripe.com`, `zendesk.com` and `snowflake.com` all
redirected to localised pages. A crawler that ignores `<html lang>` reports that
Klaviyo rewrote its homepage in German. Language and canonical-URL shifts
suppress diffs and re-baseline.

**An experiment is not a repositioning.** `airtable.com` served two different
`<h1>` strings to two requests minutes apart. Each signal remembers its last six
values; a change back to something the page recently held is recorded but
flagged as a likely A/B test rather than presented as news.

## Failure is loud

A crawler that dies silently at 3am and reports "no changes" is the worst
possible outcome for a public index, because it is indistinguishable from a calm
week.

Every fetch attempt is stored with a status — `ok`, `unchanged`, `blocked`,
`changed-structure`, `error` — and a human-readable reason. `blocked` is
deliberately distinct from `error`: it means the origin saw who we are and
declined, which is information, not a bug.

Those statuses roll up into a per-company health state published on the site:

| State | Meaning |
|---|---|
| `ok` | read successfully, every signal extracting |
| `degraded` | read successfully, but a signal is a suspected extraction failure |
| `structure-changed` | the page parsed but we understood far less of it; change detection paused |
| `stale` | no successful read recently |
| `error` | last attempt failed |
| `blocked` | robots.txt disallows, or the site refuses automated clients |

The homepage shows a warning banner when nothing has been read successfully in
36 hours, or when any signal is flagged suspect. "No changes detected" and "we
have not successfully read this page in nine days" never look the same.

## Crawling policy

GummySearch had 140,000 users and was killed overnight by a change to Reddit's
API terms. The lesson is not "avoid APIs" — it is *do not build on access you
have not earned*. Public pages fetched politely are access you can keep.

This crawler is also operated from Germany, where ignoring a machine-readable
reservation of rights is not a grey area. So:

- **Identified.** The User-Agent is truthful and links to a disclosure page:

  ```
  PositioningIndexBot/1.0 (+https://github.com/rushogen/positioning-index#crawling-policy;
  marketing-page positioning research; one request per page per day; honours robots.txt)
  ```

  A `From` header carries the same contact URL. We do not pretend to be a
  browser, and we never work around a block.

- **robots.txt, properly.** A real RFC 9309 implementation
  (`src/crawl/robots.js`, 26 tests): per-agent group selection by longest
  matching token, **longest-matching-path** rule precedence with `Allow` winning
  ties — the part most implementations get wrong — `*` and `$` patterns matched
  by a linear segment walk rather than a constructed regex, and empty `Disallow`
  treated as permission. `Crawl-delay` is honoured. Cached 24 hours, so
  robots.txt costs one request per host per day.

- **Fails closed.** 4xx means no restrictions. 401/403 is an explicit refusal.
  5xx, a timeout, or any fetch error means we do not crawl at all. Given the
  choice, the crawler stays home.

- **Content Signals honoured.** `vercel.com` already publishes
  `Content-Signal: search=yes, ai-input=yes, ai-train=no`. That declaration is
  parsed, and `search=no` is treated as an opt-out even where `Allow: /` is
  present. This crawler indexes; it does not train models and does not feed a
  generative system, so the other two cost nothing to respect.

- **One request per host per invocation.** Not by convention — by construction.
  The scheduler claims exactly one overdue page per cron tick, so a single
  invocation physically cannot burst against anyone.

- **One request per page per day**, with `If-None-Match` and
  `If-Modified-Since`, so an unchanged page costs the origin a 304 and costs us
  no parse. `429` and `Retry-After` are obeyed; a refusal backs off from one day
  up to thirty.

- **Two URLs per company, both public.** Listed in `seed/companies.json`, in the
  repository, auditable. Nothing behind a login. No personal data. No forms.

**To opt out**, add this to your robots.txt and it takes effect within 24 hours:

```
User-agent: PositioningIndexBot
Disallow: /
```

The deployed Worker serves the same policy in plain text at `/crawler`.

One more thing worth stating, because it came up in the seed list: page content
is *data we display*, never *instructions we follow*. `ramp.com` publishes a
page addressed to automated agents offering them a signup incentive. The
extractor treats every byte of every page as inert text.

## How it works

```
cron */5  ──▶  claim the single most overdue target
               │
               ├─▶ robots.txt check (cached 24h, fails closed)
               ├─▶ one conditional GET
               ├─▶ extract 12 signals  (bounded regex, no DOM parser)
               ├─▶ gate + diff against stored state
               └─▶ write observations, events, state  (one atomic D1 batch)

cron 00:05 ──▶ close yesterday's run, open today's

fetch()    ──▶ /            static assets (free, unmetered)
               /api/*       D1 reads, cached 15 min at the edge
               /crawler     the policy above, in plain text
```

The crawl is a **queue, not a loop**. Cloudflare's free plan gives a Worker 10ms
of CPU per invocation, and these pages are 300kB–1.5MB. A cron that looped over
sixty companies would be killed partway through and leave the index silently
half-updated — the exact failure this project is built to avoid. Instead each
tick does one page and stops. 288 ticks a day against 120 targets sweeps the
whole index in about ten hours with slack for retries, and uses two of the five
Cron Triggers the free plan allows.

**No DOM parser.** Building a DOM over a megabyte of marketing HTML costs tens of
milliseconds. Extraction is bounded, non-backtracking regex over a size-capped
string, with one shared plain-text pass. The first version called
`toLowerCase()` once per element while looking for closing tags, which made a
1.2MB page cost 168ms on its own; fixing that took it to 5ms warm.

Measured against live pages with `npm run probe`:

```
$ npm run probe -- linear notion vercel figma supabase posthog

summary  12/12 pages extracted  signal yield 52/72 (72%)
         extract cpu warm p50 7.4ms  p95 12.87ms  max 12.87ms
         cold p50 18.78ms  max 42.51ms  |  largest page 2216kB
```

Warm is the steady state, since a Cloudflare isolate is reused across
invocations; cold is the first call in a fresh isolate. Both are reported
because quoting only the warm number would be flattering and only the cold one
would be wrong.

### Staying inside the free tier

| Limit | Free plan | Used |
|---|---|---|
| Worker requests | 100k/day | static assets don't count; API cached 15 min at the edge |
| CPU per invocation | 10ms | fetch handler does D1 reads and JSON only; parsing lives in the scheduled handler |
| D1 storage | 5GB | ~1,300 observation rows/day |
| D1 rows written | 100k/day | ~1.5k, about 1.5% |
| Cron Triggers | 5 | 2 |

The free plan has no payment method attached and cannot bill. It fails closed:
if the index outgrows these limits it stops rather than quietly generating an
invoice. For something that must run unattended, that is a feature.

## Repository

```
src/
  index.js            Worker entry: public API + crawler disclosure
  scheduled.js        one page per cron tick
  diff.js             change detection, gates, parser-failure discrimination
  db.js               D1 access layer
  hash.js             FNV-1a
  crawl/
    agent.js          crawler identity and politeness constants
    robots.js         RFC 9309 parser, matcher, cache
    fetch.js          conditional fetch with classified outcomes
  extract/
    index.js          orchestrator + signal registry
    html.js           bounded HTML primitives (no DOM parser -- see the header)
    hero.js           headline, subhead, category label, meta tags
    proof.js          customer logos, quantified claims
    pricing.js        tiers, entry price, free tier, seat minimum
public/               the index page: HTML, CSS, one JS file, no dependencies
tests/                125 tests, node:test, no runner dependency
scripts/
  probe.js            run the extractor against live URLs, report timings
  demo.js             run the whole stack locally against the real internet
  check-seed.js       validate seed URLs, structurally or live
schema.sql            D1 schema
seed/companies.json   60 companies, 120 URLs
METHODOLOGY.md        how each signal is measured, v1.0
```

## Running it locally

```bash
npm install
npm test                              # 125 tests, no network
npm run probe -- linear notion vercel # extract from live pages, print everything
npm run demo -- --fresh --crawl 12    # crawl 12 real targets, serve on :8787
```

`npm run demo` applies the real schema to a SQLite file, seeds it from
`seed/companies.json`, crawls real sites one target at a time through the real
scheduled handler, and serves the real public page against the real query layer.
D1 *is* SQLite, so the only thing missing is Cloudflare. This is what verified
the pipeline before any deploy.

The test suite runs the same handler against the same `schema.sql` in an
in-memory database, with only the network mocked — a mock data layer would
happily agree with a broken query. `tests/pipeline.test.js` walks five days:
baseline publishes nothing, an unchanged body short-circuits, a rewritten hero
produces exactly one headline change and one category change, a redesign that
breaks every selector produces zero events while still recording observations,
and recovery is not a change.

## Deploying

```bash
npx wrangler d1 create positioning_index     # put the id in wrangler.toml
npm run db:init                              # apply schema.sql
npm run db:seed                              # load the 60 companies
npm run deploy
```

The first sweep establishes a baseline and publishes nothing. Change events
begin on the second sweep, roughly 24 hours later. That is not a bug to fix —
it is the shape of the product.

## Known limitations

Listed because they are real, and because an index whose author will not name
its weaknesses should not be trusted about its strengths.

1. **Client-rendered pricing tables are invisible.** No JavaScript is executed.
   `vercel.com/pricing` renders its tiers entirely client-side, so it reports
   null tiers. Correct behaviour — the diff engine never converts that into
   "Vercel removed its pricing" — but it is missing data, and it will get more
   common.

2. **Split-tested heroes.** Detected and flagged (§4.7 of the methodology), not
   solved. A company running a persistent multi-variant test will show
   oscillating changes that are noise.

3. **Geography.** Pages are fetched from wherever the Worker runs. Sites that
   geo-route serve a locale-specific page and the index sees one of them. The
   language gate prevents false change events; it does not give a global view.

4. **Bot walls.** Some sites refuse identified crawlers outright. Two are kept in
   the seed list deliberately — `pipedrive.com/pricing` returns 403 while its
   homepage returns 200 — because dropping them would make the index look
   healthier than the open web actually is.

5. **Agent-specific content variants.** `ramp.com` serves `text/markdown` to
   every non-browser client. That is recorded as `blocked` with a specific
   reason rather than parsed, because signals from a machine-facing variant are
   not comparable with the HTML everyone else serves. This is likely to become
   more common, and it is a genuine open question for any index of "what a
   company says publicly" when the answer depends on who is asking.

6. **Heuristics are heuristics.** Category label extraction in particular is a
   scored guess over a fixed noun vocabulary. It is right often enough to be
   useful and wrong often enough to need the confidence scores it carries. Every
   value on the site shows the method that produced it.

7. **The index is young.** Drift is only visible over months. On day one this
   is an elaborate snapshot. That is unavoidable and is precisely why it had to
   be started.
