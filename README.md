# The B2B SaaS Positioning Index

A tracker that reads the homepage and pricing page of 60 well-known B2B SaaS
companies, records how they describe themselves, and detects when that
description changes. It runs on demand — locally or from a button on GitHub —
and every crawl lands as a public, timestamped commit.

The value is not the snapshot. It is the time series. You can ask any model what
Linear's homepage says today; no model can tell you what it said in March,
whether the word "platform" replaced "tool" in June, or which twelve companies
quietly dropped their free tier last quarter. That record has to be kept
deliberately, starting before you need it.

**The record is this repository's git history.** The product is change over
time; git is a diff store. So every crawl is a commit, every observation is a
line of newline-delimited JSON, and the history of the data is the history of
the repository:

```
$ git log -p data/companies/linear.ndjson
```

...is a chronological list of every time Linear's positioning moved, with the
before and the after side by side, in a commit nobody can backdate. Nothing is
stored as a binary. A SQLite file would hold exactly the same information and
none of the legibility: an opaque blob rewritten whole on every write, so every
commit is a full-file replacement and `git log -p` says nothing at all.

There is no server, no database and no always-on anything. A crawl is a command
you run — on your laptop, or by pressing a button on GitHub — and the result is
a commit.

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
week. That is true of a crawler nobody remembered to run, too, which is why
`data/runs.ndjson` gets a line whether or not anything happened.

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
36 hours, or when any signal is flagged suspect, and it says in the same breath
that this index advances only when a crawl is triggered. "No changes detected",
"we have not successfully read this page in nine days" and "nobody has run the
crawler since March" never look the same.

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
  treated as permission. `Crawl-delay` is honoured. Cached 24 hours, and never
  fetched more than once per host per run — so on a cold CI runner robots.txt
  costs exactly one request per host, and locally it usually costs none.

- **Fails closed.** 4xx means no restrictions. 401/403 is an explicit refusal.
  5xx, a timeout, or any fetch error means we do not crawl at all. Given the
  choice, the crawler stays home.

- **Content Signals honoured.** `vercel.com` already publishes
  `Content-Signal: search=yes, ai-input=yes, ai-train=no`. That declaration is
  parsed, and `search=no` is treated as an opt-out even where `Allow: /` is
  present. This crawler indexes; it does not train models and does not feed a
  generative system, so the other two cost nothing to respect.

- **One request per host at a time, spaced by a real delay.** Not by convention
  — by construction. There is no concurrency anywhere in the runner: requests are
  strictly serial, and before it touches a host it has already touched, the
  runner sleeps until at least `MIN_HOST_INTERVAL_MS` (60 seconds) or that host's
  `Crawl-delay` has passed, whichever is longer. Target order interleaves hosts
  so the wait is usually already spent. A run physically cannot burst against
  anyone, and `--all` is slower than it could be for exactly that reason.

  This is also why `npm run crawl -- --company linear` takes about a minute: two
  pages on one host means one 60-second pause, and the crawler does not have a
  flag to skip it.

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

The published site serves the same policy in plain text at `/crawler.txt`,
generated from `bin/build-site.js` so it cannot drift from the code.

One more thing worth stating, because it came up in the seed list: page content
is *data we display*, never *instructions we follow*. `ramp.com` publishes a
page addressed to automated agents offering them a signup incentive. The
extractor treats every byte of every page as inert text.

## How it works

```
npm run crawl            ──▶  fold data/runs.ndjson into the crawl queue
                              select the most overdue batch
                              │
                              ├─▶ robots.txt check (once per host, fails closed)
                              ├─▶ one conditional GET per page, strictly serial
                              ├─▶ extract 12 signals  (bounded regex, no DOM parser)
                              ├─▶ gate + diff against the last stored observation
                              ├─▶ append to data/companies/<slug>.ndjson, data/events.ndjson
                              └─▶ append ONE run record to data/runs.ndjson, always

npm run build            ──▶  regenerate docs/ from data/, deterministically

git commit && git push   ──▶  the archive advances in public
```

Local and CI run the identical code path. The GitHub Actions workflow shells out
to `node bin/crawl.js` with the same arguments you would type. There is no
emulator, no `wrangler dev`, and no "production" build that behaves differently
from the one you tested.

### Three files, three jobs

```
data/companies/<slug>.ndjson   the series  — one line per observation
data/events.ndjson             the feed    — one line per published change
data/runs.ndjson               the ledger  — one line per run, always
```

Everything mutable is a fold over those logs. The crawl queue — when each page is
next due, its ETag, its content hash, its consecutive failure count — is the last
result recorded for each target in the ledger. The current state of each signal
is the last line of the company's own file. There is no file that can disagree
with the history, because there is no file besides the history.

### "Ran and found nothing" is not "did not run"

This is the single most important integrity property in the system, and it is the
reason `data/runs.ndjson` exists.

An archive whose value is *"nothing moved last month"* is worthless unless it can
also prove it looked. In the series those two situations produce identical
silence. So **a run record is written unconditionally** — including a run that
found nothing due, crawled nothing, and changed nothing. It costs one line and it
means a gap in the ledger has exactly one interpretation: nobody ran it.

The site reads the same ledger, which is why it can say *"no successful read in
nine days"* instead of showing a calm, plausible, stale index.

### Why an unchanged observation is not appended

A company that has not touched its homepage in four months would otherwise
contribute 120 byte-identical lines, and `git log -p` on its file — the way you
are meant to read the series — would be 120 repetitions with the signal buried in
them. So an observation is appended only when it differs from the previous
observation of the same page.

Nothing is lost: "we looked and it was the same" is in the run ledger, which
names every target it touched and what happened. The series says what was true;
the ledger says when we checked. When a value does change, `previous_seen_at` is
taken from the ledger, so the event reports when the old value was last
confirmed rather than when it first appeared.

### No DOM parser

Building a DOM over a megabyte of marketing HTML costs tens of milliseconds.
Extraction is bounded, non-backtracking regex over a size-capped string, with one
shared plain-text pass. The first version called `toLowerCase()` once per element
while looking for closing tags, which made a 1.2MB page cost 168ms on its own;
fixing that took it to 5ms warm.

That optimisation was originally forced by a 10ms CPU ceiling that no longer
applies. It is kept because it is still the difference between a full sweep that
spends its time waiting politely on the network and one that spends it burning
CPU, and because a fast extractor is what makes `--dry-run` a usable way to check
a selector against sixty live pages.

Measured against live pages with `npm run probe`:

```
$ npm run probe -- linear notion vercel figma supabase posthog

summary  12/12 pages extracted  signal yield 52/72 (72%)
         extract cpu warm p50 7.4ms  p95 12.87ms  max 12.87ms
         cold p50 18.78ms  max 42.51ms  |  largest page 2216kB
```

Warm is the steady state, since one process sweeps many pages; cold is the first
call in a fresh process. Both are reported because quoting only the warm number
would be flattering and only the cold one would be wrong.

### What it costs to run

Nothing, and there is no account that can start billing.

| Resource | Limit | Used |
|---|---|---|
| GitHub Actions | 2,000 min/month on a free account, unlimited on a public repository | a full sweep is dominated by politeness delays, not compute |
| GitHub Pages | 1GB site, 100GB/month bandwidth | `docs/` is under 1MB |
| Repository size | soft warning at 1GB | the append-only NDJSON grows by roughly a megabyte a year, and git deltas it well |
| Database | — | there isn't one |

The previous version of this project ran on Cloudflare Workers and D1, and the
free plan there was also genuinely free. The reason for moving was not cost. It
was that the deployment was a *place the data lived* — a database you had to be
logged in to inspect, whose history was invisible, and whose contents nobody
downstream could verify. Putting the data in git makes the archive itself the
artefact, and makes every claim in it independently checkable by anyone with a
clone.

## Repository

```
bin/
  crawl.js            the CLI runner: batch, one company, full sweep, dry run
  build-site.js       generates docs/ from data/, deterministically
src/
  runner.js           select targets, crawl them politely, write what they mean
  report.js           read models: health, stats, feed, per-company detail
  diff.js             change detection, gates, parser-failure discrimination
  hash.js             FNV-1a
  store/
    files.js          the append-only NDJSON store
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
data/
  companies/*.ndjson  the series, append-only
  events.ndjson       published change events, append-only
  runs.ndjson         one record per run, always
docs/                 the generated site, served by GitHub Pages
public/               the site's source: HTML, CSS, one JS file, no dependencies
tests/                139 tests, node:test, no runner dependency
scripts/
  probe.js            run the extractor against live URLs, report timings
  check-seed.js       validate seed URLs, structurally or live
seed/companies.json   60 companies, 120 URLs
METHODOLOGY.md        how each signal is measured, v1.1
.github/workflows/crawl.yml   the button
```

**Zero dependencies.** `npm install` installs nothing, `node_modules/` never
appears, and there is no lockfile to audit or renovate. The test runner is
`node:test`, the HTTP client is `fetch`, the storage engine is
`fs.appendFile`. A project whose entire purpose is to still be running in three
years should not have a supply chain.

## Running it

Node 20 or newer. Nothing to install.

```bash
npm test                              # 139 tests, no network
npm run crawl                         # the most overdue batch (12 pages)
npm run crawl -- --company linear     # one company, both its pages
npm run crawl -- --all                # every target in the seed list
npm run crawl -- --dry-run            # fetch and extract, write nothing
npm run crawl -- --limit 30           # a bigger batch
npm run build                         # regenerate docs/ from data/
npm run probe -- linear notion vercel # extract from live pages, print everything
```

A crawl writes to `data/`, and `npm run build` regenerates `docs/`. Then commit
both. The commit subject the crawler suggests is printed at the end of the run:

```
$ npm run crawl -- --company linear

    1  ok                linear/home                5/7
    2  ok                linear/pricing             4/5

  2 target(s): 2 ok, 0 unchanged, 0 blocked, 0 error, 0 restructured
  0 change event(s), 0 parser fault(s), 2 observation line(s) written
  data: no changes across 2 targets
```

Nothing is due more often than once a day per page, so a second `npm run crawl`
straight afterwards will correctly do nothing — and still write a run record
saying so. `--company` and `--all` override the batch selection but never the
politeness delays.

### On GitHub

**Actions → crawl → Run workflow.** Pick a scope (`batch`, `all`, or `company`
plus a slug), press the green button. The workflow runs the tests, runs the same
`bin/crawl.js`, rebuilds `docs/`, and commits the result with a message
describing what actually moved:

```
data: 3 changes across 12 targets (linear, notion, figma), 2 blocked
```

`dry_run` is available as an input if you want to see what a sweep would find
without committing anything.

The site is `docs/` on the default branch: enable it once under **Settings →
Pages → Deploy from a branch → main → /docs** and every crawl commit publishes
itself. Nothing else deploys, because there is nothing else to deploy.

### The 60-day problem, stated plainly

**GitHub disables scheduled workflows in a repository that has had no activity
for 60 days.** It emails the owner and stops. It does not fail. Nothing in the
data says anything happened.

For this project specifically, that is the worst available failure mode. Months
later the history would look like a market that went quiet rather than a crawler
that did — which is precisely the confusion the whole diff engine exists to
prevent, arriving through the back door of a platform default.

So `workflow_dispatch` is the primary trigger and the `schedule:` block ships
commented out in `.github/workflows/crawl.yml`. Uncomment it if you want to, but
know two things first: it will be disabled after 60 quiet days, and a bot commit
pushed by the workflow itself **does not** count as the activity that keeps it
alive. Treat a schedule as a convenience that decays, not as the mechanism.

The defence that actually works is `data/runs.ndjson`. Whatever else fails, the
ledger records every run that happened, so the archive can always distinguish a
quiet market from a stopped crawler — and the site says which.

### How the tests exercise all of this

`tests/pipeline.test.js` runs the real runner against a real file store in a
temporary directory, with only the network mocked. The NDJSON that lands on disk
is the NDJSON a real crawl would commit — a mock store would happily agree with a
broken writer. It walks five days: baseline publishes nothing, an unchanged body
short-circuits, a rewritten hero produces exactly one headline change and one
category change, a redesign that breaks every selector produces zero events while
still recording observations, and recovery is not a change.

`tests/store.test.js` pins the storage contract itself: files are only ever
appended to, a run always leaves a receipt, an identical re-observation is not
appended, and a moving parser-health counter always is.

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

3. **Geography, and it now varies by operator.** Pages are fetched from wherever
   the crawl runs. Sites that geo-route serve a locale-specific page and the
   index sees one of them. The language gate prevents false change events; it
   does not give a global view. A crawl from a laptop in Germany and a crawl from
   a GitHub runner in a US cloud region do not necessarily see the same page, so
   the `trigger` field on every run record says which produced it.

4. **Bot walls, and a higher `blocked` rate from GitHub.** Some sites refuse
   identified crawlers outright. Two are kept in the seed list deliberately —
   `pipedrive.com/pricing` returns 403 while its homepage returns 200 — because
   dropping them would make the index look healthier than the open web actually
   is.

   **Expect more of them from Actions than from a laptop.** GitHub runners use
   published cloud IP ranges, and a large share of commercial WAF configurations
   treat those ranges as presumptively hostile regardless of what the User-Agent
   says or what robots.txt allows. A sweep from a residential connection and the
   same sweep from CI will not produce the same number of `blocked` results, and
   the CI number will be worse.

   This is not breakage and the system does not treat it as breakage. `blocked`
   is a distinct status from `error` precisely because it means *the origin saw
   who we are and declined*, which is information. It backs the target off hard,
   it shows on the health page in its own colour, it never becomes a change
   event, and it never becomes silence. If a run from Actions reports a third of
   the index blocked, that is the honest measurement of what an identified
   crawler can reach from a cloud IP — not a bug to hide by pretending to be a
   browser.

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
