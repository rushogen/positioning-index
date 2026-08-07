# Methodology

**Version 1.2** — corresponds to extractor version `1.0.0`.

This document states exactly how each signal is measured, what counts as a
change, and what the index will refuse to claim. It is versioned because the
measurement is part of the data: a value recorded under v1.0 and a value
recorded under v2.0 are not necessarily comparable, and every stored
observation carries the extractor version that produced it.

If you disagree with a definition here, you can check it. Every rule below
corresponds to code in `src/` and to a test in `tests/`.

---

## 1. What is observed

Two pages per company, both public, both linked from the company's own
navigation:

| Page | Purpose |
|---|---|
| Homepage | the positioning claim as presented to a first-time visitor |
| Pricing page | the commercial model as published |

Nothing behind a login. No app subdomains. No APIs. No search engines. No
third-party data. The full list of URLs is `seed/companies.json`, and it is
part of the repository, so the input set is auditable.

Each page is fetched at most once per day. Observation is **on demand**: a crawl
happens when a person or a manually triggered workflow asks for one, and then
the process exits. There is no hosted scheduler and nothing runs continuously.
That has one consequence a reader has to know about, and §3.2 states it in full:
the record advances only when somebody advances it, and the archive says
explicitly when it last did.

### 1.1 How the page is requested

Content negotiation is a variable, so it is held still. Every request from every
machine sends exactly the same language preference:

```
Accept-Language: en-US,en;q=0.9
```

`en-US` rather than a bare `en` because it is explicit about the region as well
as the language, and because it matches the origin this index treats as canonical
(§1.2). `en;q=0.9` keeps any English variant acceptable rather than risking a 406
or a fallback locale from a site that only publishes `en-GB`.

**This reduces one source of variance. It does not eliminate geo-routing.** Sites
that choose a currency or a locale from the client's IP address ignore
`Accept-Language` entirely — `notion.com/pricing` is one of them, and finding
that out cost this index two false change events (see `CORRECTIONS.md`). What is
left after pinning the header is handled by §1.2 and §4.9.

### 1.2 Where the page is requested from

**Every observation and every run records the crawl origin.** Two fields:

| Field | How it is obtained | Can it be unknown? |
|---|---|---|
| `environment` | `local` or `github-actions`, from the variables GitHub Actions sets | no |
| `country` / `region` | one Cloudflare edge trace per run — no key, no account, no quota — reporting the ISO 3166-1 country the request egressed from | yes |

The country lookup is best-effort by design. It has its own short timeout, it
never throws, and it never delays or cancels a crawl. When it fails, the origin
is recorded as `unknown`, and `unknown` is treated downstream as *cannot rule out
a shift*, never as *no shift*.

The country is **never** inferred from a system timezone, a system locale or an
environment variable naming a region. A laptop configured in one place and
connected through another would then produce a confident lie, and this index
prefers a stated gap to an unstated guess.

**GitHub Actions is the canonical origin.** It is reproducible, it is documented
in `.github/workflows/crawl.yml`, and anybody can re-run it. A laptop is none of
those things. Local runs remain fully supported and are the right way to develop
against live pages, but a local run against a page last read from CI produces an
`origin-shift` record (§4.9) rather than a change event — which is the correct,
visible outcome rather than a silent one.

Observations recorded before 2026-08-07 carry no origin field at all, because the
field did not exist. They read as `unknown` and are **not** backfilled with a
guess. §4.10 is what protects that stretch of the archive, because it needs no
origin.

---

## 2. Signals

Twelve signals. Each is extracted by a chain of strategies tried in order; the
first that produces a plausible value wins, and the winning strategy is stored
alongside the value as `method`, together with a `confidence` between 0 and 1.

A low `confidence` is not a hedge for presentation. The diff engine uses it: a
value that changes at the same time as the method degrades is suppressed rather
than published (§4.4).

### 2.1 `headline` — hero headline

**Definition.** The primary heading a first-time visitor sees, as a screen
reader would announce it.

**Strategies.**

| Order | Method | Confidence | Rule |
|---|---|---|---|
| 1 | `h1` | 1.00 | first visible `<h1>` in the first 120kB of markup |
| 2 | `h1-below-fold` | 0.75 | first visible `<h1>` anywhere in the document |
| 3 | `aria-heading` | 0.70 | first `role="heading" aria-level="1"` element |
| 4 | `og:title-fallback` | 0.40 | `og:title`, only if it contains a space and is not the bare brand name |

**Normalisation, in order.**

1. Subtrees marked `aria-hidden="true"` are removed. This is not cosmetic.
   Linear's live `<h1>` contains three visually duplicated copies of the
   headline — a mobile variant, a desktop variant, and per-word animation
   spans — all inside `aria-hidden="true"`, plus one canonical copy in a
   visually-hidden span. Naive tag-stripping returns the headline three times.
2. Tags stripped, HTML entities decoded, whitespace collapsed.
3. A string that is one phrase repeated is collapsed to that phrase, which
   catches responsive markup that renders the hero twice without ARIA.

**Rejected as headlines.** Anything shorter than 8 or longer than 200
characters. A string exactly equal to the company name. Navigation strings
(`Home`, `Menu`, `Skip to main content`, `Search`, `Log in`). Elements hidden by
`class` (`sr-only`, `visually-hidden`, `screen-reader`), by `style`
(`display:none`, `visibility:hidden`), or by the `hidden` attribute.

### 2.2 `subhead` — hero subhead

The first `<p>`, `<h2>` or `<h3>` following the winning headline within 6,000
characters of markup, whose text is between 20 and 400 characters. Cookie and
consent boilerplate (`By clicking…`, `We use cookies…`) is skipped.

Falls back to `og:description` at confidence 0.35. Null if nothing qualifies.

### 2.3 `category_label` — the category noun

**Definition.** The noun phrase a company uses for the thing it sells:
*platform*, *system of record*, *AI agent for X*. This is the most compressed
statement of positioning a company publishes, and the signal this index exists
for.

**How it is derived.** A candidate is generated from each of four sources —
`<h1>`, meta title, subhead, meta description — plus any free-text JSON-LD
`applicationCategory`. Each candidate is parsed into three parts:

```
[ up to 3 modifiers ] [ category noun ] [ "for" + up to 5 words ]
        AI                 workspace
   product development       system            for teams and agents
```

The category noun is matched against a fixed vocabulary of ~90 nouns
(`CATEGORY_NOUNS` in `src/extract/hero.js`), ordered longest-first so
*system of record* beats *system*. Modifier collection walks backwards from the
noun and stops at an article, a preposition, a verb, or any clause boundary.

**Candidates are scored, not ranked by source.**

```
score = source weight + 0.12 x min(modifiers, 2) + 0.20 if an object is present
```

Source weights: JSON-LD 0.95, `<h1>` 0.85, meta title 0.70, subhead 0.60, meta
description 0.50. The highest score wins.

This matters. Notion's `<h1>` is *"Where teams and agents Think together."*,
whose only category noun is a bare *agents* — technically a match, and
meaningless. Its meta title is *"The AI workspace that works for you."* The
scoring picks **ai workspace**, which is right.

**Two exclusions.**

- A bare noun from the weak set (*agent, tool, app, software, solution, service,
  system, suite, engine, layer, stack, hub, network, framework, builder, editor,
  inbox, api, sdk, os, automation*) with no modifier and no object is rejected.
  It is a word in a sentence, not a claim.
- schema.org's `applicationCategory` vocabulary (`BusinessApplication`,
  `DeveloperApplication`, `WebApplication`) is rejected outright. It is a fixed
  SEO taxonomy that never moves when positioning does, so accepting it would
  flatten the most interesting signal in the index into a constant.

The result is lowercased. Case carries no positioning information at this level
of abstraction, and normalising it prevents title-case CSS changes reading as
category changes.

### 2.4 `meta_title` and `meta_description`

`meta_title`: `<title>` (1.00), else `og:title` (0.70).
`meta_description`: `<meta name="description">` (1.00), else `og:description`
(0.80), else `twitter:description` (0.60).

Included because they are frequently rewritten *before* the visible page is, and
because they are the version of the positioning that reaches search results and
AI answers.

### 2.5 `customer_logos` — logo wall

**Definition.** The set of customer names displayed as logos on the homepage.

**Location.** A "proof region" is any 14,000-character window of markup
following a lead phrase: *trusted by*, *powering*, *used by*, *loved by*,
*join N*, *our customers*, *customers include*, *built for teams at*, *works
with*, *the best teams*, *teams at*, *from startups to*, *backed by*.

**Names come from three places.**

1. `alt` text of `<img>` elements, with `Logo of X` / `X logo` / `X's logo`
   reduced to `X`.
2. The basename of the image `src`, with separators normalised, colour and size
   variants stripped (`-white`, `-2x`, `@3x`, `-mono`, content hashes), and the
   result title-cased. Title-casing matters: without it,
   `/logos/vercel.svg` yields `vercel` while `alt="Vercel"` yields `Vercel`, and
   a site simply adding alt text to an unchanged wall would read as replacing
   every customer at once.
3. `<title>` inside inline `<svg>`, which is how a large share of logo walls are
   built. This is why the extraction pipeline strips scripts and styles in one
   pass but keeps SVG until after logo extraction.

**Rejections.** Names under 2 or over 30 characters, or longer than four words.
Generic terms as the whole string (`icon`, `logo`, `hero`, `avatar`, …) or as
any word within a multi-word candidate (so `/hero-background.png` →
`hero background` is rejected). Call-to-action alt text — anything beginning
*read, learn, see, view, watch, get, try, start, download, explore, book,
request, join…* The company's own name.

**Threshold.** Fewer than three names is treated as noise and the signal is
null. A wall found via a lead phrase scores 0.85; names found only by the
generic logo heuristic score 0.50.

**Ordering.** The list is sorted alphabetically before storage, so shuffling a
logo carousel is not a change.

### 2.6 `proof_points` — quantified claims

Quantified marketing claims in the page's visible text, matched by seven pattern
families:

| Family | Example |
|---|---|
| multiplier | `10x faster` |
| percentage, leading | `40% fewer escalations` |
| percentage, trailing | `cut onboarding by 60%` |
| count | `20,000 teams`, `5M developers` |
| money | `$2.4M saved` |
| duration | `in under 5 minutes` |
| rank | `Fortune 500`, `#1 rated` |

A bare four-digit number in the range 1800–2199 with no separator or `+` is
treated as a year, not a quantity. Copyright and privacy boilerplate is
excluded. Claims are lowercased, de-duplicated, sorted, and capped at 25, again
so that reordering is not a change.

### 2.7 `pricing_tiers` — published plans

**Preferred source.** JSON-LD `Offer` / `priceSpecification`, confidence 0.95.
Exact when present; uncommon on marketing pricing pages.

**Heuristic source**, confidence 0.70:

1. Collect anchors: `<h2>`–`<h5>` and `<dt>` elements, plus any element whose
   class matches `(plan|tier|package|pricing)[-_]?(name|title|heading|label)`.
2. Find every price token. Both `$12` and `12 €` are matched, because a European
   locale will be served the latter.
3. Attach each price to the nearest anchor above it within 2,500 characters.
   The first price under an anchor is taken as that plan's headline price;
   monthly/annual toggles usually render both.
4. Anchors of more than three words or 28 characters are rejected. Anchors that
   do not contain a recognised plan word are rejected unless they were found by
   class.
5. Anchors with no price are still recorded when the surrounding copy indicates
   a free plan (amount `0`) or an enterprise plan (amount `null`, "contact
   sales").

**Decimal handling.** `1.234,56` and `1,234.56` are both parsed correctly by
treating the last separator as the decimal point, with a lone comma followed by
exactly three digits treated as a thousands separator.

**Badges** (`Most Popular`, `Recommended`, `Best value`, `New`) are stripped from
plan names.

**Threshold.** Fewer than two tiers is not a pricing table — it is a stray
currency symbol near a heading — and the signal is null.

### 2.8 Derived pricing signals

`pricing_entry_price`, `pricing_free_tier` and the tier list all come from the
same extraction, and **when tier extraction fails, all of them are null.**

This is the most important definition in the document. `pricing_free_tier: "no"`
is a *value*, not an absence. If the parser failed and we emitted `no`, the
index would announce that a company removed its free plan on the strength of our
own bug. So the derivation is enforced in code, not left to the caller, and
tested directly in `tests/pricing.test.js`.

- `pricing_entry_price` — the cheapest tier with an amount greater than zero,
  recorded with its currency, billing period and seat unit.
- `pricing_free_tier` — `yes` if any tier has amount 0, or if the page text
  contains an explicit free-plan phrase; `no` if tiers were extracted and none
  qualify; **null if tiers were not extracted.**

### 2.9 `pricing_seat_minimum`

Matched from pricing-page copy by five phrasings: *minimum of N seats*, *N seats
minimum*, *starts at N seats*, *billed for a minimum of N*, *requires a minimum
of N*. Values outside 1–5,000 are rejected. Independent of tier extraction,
because the phrasing lives in body copy or a footnote rather than in a plan card.

Null means "no minimum found", not "no minimum exists". Most companies publish
none, so this signal is null for most of the index most of the time. The removal
rules in §4.3 apply before the index would ever claim a minimum was dropped.

### 2.10 `pricing_meta_title`

`<title>` of the pricing page. Tracked separately from the homepage title
because pricing-page titles are rewritten when the packaging changes, often
before the tiers themselves are updated.

---

## 3. Storage

### 3.1 Three append-only files

Everything is newline-delimited JSON in `data/`, versioned by git. Nothing is
stored as a binary, ever, because a binary makes `git diff` meaningless and the
diff is the point.

| File | Contents |
|---|---|
| `data/companies/<slug>.ndjson` | the series: one line per observation of one page |
| `data/events.ndjson` | the feed: one line per published change event, plus one line per retraction of an earlier event |
| `data/runs.ndjson` | the ledger: one line per crawl run, always |

Each observation line records every declared signal for that page **including
the null ones**, together with the value's structured form where applicable, the
method that produced it, the confidence, the extractor version, the document
facts (language, canonical URL, content variant), the **crawl origin** (§1.2),
and the parser-health state the diff engine derived from it. A gap in the data
and a null measurement are different facts and are stored differently.

No code path rewrites an existing line. The only write operation is append.

### 3.1.1 How a wrong claim is withdrawn

By **appending**, never by deleting and never by editing. A retraction is a line
in `data/events.ndjson` naming the `(slug, signal, detected_at)` of the event it
withdraws, with a stated reason and a link to the entry in `CORRECTIONS.md`.

The wrong claim stays in the file exactly as it was published. The public feed
excludes retracted events; `docs/api/retractions.json` and the site list them
separately, struck through. Deleting the line would be the one thing an archive
whose whole premise is *"check this against a history nobody can quietly
rewrite"* must never do — and a reader who acted on a false event deserves to
find out that it was withdrawn, not to find that it never happened.

`npm run retract` is the only supported way to write one. It refuses to retract
an event that was never published, and refuses to run without a reason.

Nothing mutable is stored separately, because there is nothing mutable to store:
the crawl queue (when each page is next due, its ETag, its content hash, its
consecutive failure count) is a fold over `data/runs.ndjson`, and the current
state of each signal is the last line of the company's own file. There is
therefore no file that can disagree with the history, because there is no file
besides the history.

### 3.2 What a run ledger is for

**A run record is written on every run, unconditionally** — including a run that
found nothing due, crawled nothing and changed nothing.

This is the single most important integrity property in the system. An archive
whose value is "nothing moved last month" is worthless unless it can also prove
it looked. "We ran and nothing had changed" and "nobody ran the crawler for six
weeks" produce identical silence in the series, and the only thing that tells
them apart is a receipt written every single time. A gap in `data/runs.ndjson`
therefore means exactly one thing, and it is never ambiguous.

The public health page reads the same ledger, which is why it can say "no
successful read in nine days" rather than showing a calm, plausible, stale
index.

### 3.3 Why an unchanged observation is not appended

An observation is appended only when it differs from the previous observation of
the same page. A company that has not touched its homepage in four months would
otherwise contribute a hundred and twenty byte-identical lines, and `git log -p`
on its file — which is how a reader is meant to inspect the series — would be a
hundred and twenty repetitions with the signal buried in them.

Nothing is lost. "We looked and it was the same" is recorded in the run ledger,
which names every target it touched and what happened to it. **The series says
what was true; the ledger says when we checked.** When a value does change, the
event's `previous_seen_at` is taken from the ledger, so it reports when the old
value was last confirmed rather than when it first appeared.

The comparison ignores timestamps and includes the parser-health counters, so an
advancing null counter is itself new information and does get its own line. That
matters: the removal rule in §4.3 counts consecutive nulls, and a
de-duplication that swallowed them would silently disable it. The one exception
is a signal that has *never* produced a value — `linear.app` publishes no logo
wall this extractor can read — where the counter can never mean anything,
because a removal cannot be confirmed for a value we never had.

---

## 4. What counts as a change

A change event is a public claim that a company changed something on a date. The
bar is deliberately high, and asymmetric: **missing a real change costs one day,
because the next run catches it. Publishing a false one costs credibility
permanently.** Every rule below resolves ambiguity toward silence.

### 4.1 Page-level gates

If any of these hold, the page's observations are still recorded but **no change
events are produced for any signal on it**:

| Gate | Recorded status | Why |
|---|---|---|
| Fetch failed | `error` | nothing was read |
| Non-HTML variant returned | `blocked` | not comparable with the HTML everyone else serves |
| `<html lang>` changed | `ok`, re-baselined | a German page is not a repositioning |
| Canonical URL changed | `ok`, re-baselined | a different page is not a changed page |
| Signal yield fell below 50% of its previous level | `changed-structure` | the page was redesigned; our selectors need review |
| Extractor version changed | `ok`, re-baselined | *we* changed, and that is not their news |

One gate does **not** suppress the whole page:

| Gate | Recorded status | Effect |
|---|---|---|
| Crawl origin changed (§1.2) | `origin-shift` | only locale-sensitive signals are withheld — see §4.9 |

A hero headline read from Virginia is still comparable with one read from
Frankfurt, and muting the whole page would discard real signal in order to
protect the price fields. It is the price fields that get protected.

The language gate is not theoretical. Fetched from Germany during development,
`klaviyo.com`, `stripe.com`, `zendesk.com` and `snowflake.com` all redirected to
localised pages. A crawler that ignores this reports that Klaviyo rewrote its
homepage in German.

### 4.2 First sighting is a baseline

The first time a signal is observed for a company, the value is recorded and
**no event is emitted**. Otherwise day one of the index would emit roughly 700
"added" events into an empty feed and mean nothing.

An `added` event is emitted only when a signal that previously had no value
acquires one — a company introducing a seat minimum, for instance.

### 4.3 A null is a parser failure, not a removal

**If extraction returns null where it previously returned a value, that is a
parser failure and it is never reported as a change.** This is the single most
important correctness property in the project.

What happens instead:

- A null counter increments. The last known-good value is retained, so the next
  successful run diffs against what we actually believed rather than against
  the gap.
- After **2** consecutive nulls the signal is marked `suspect`, shown on the
  public health page, and excluded from change detection.
- After **5** consecutive nulls, *and* only if the rest of the page kept
  extracting normally throughout, a single `removed` event is emitted. It is not
  re-emitted afterwards.

If the page itself is unhealthy — fewer than half its signals extracting — no
removal is ever confirmed, however long the absence lasts.

### 4.4 A confidence downgrade is our problem, not theirs

If the extraction method changed *and* confidence dropped by 0.30 or more *and*
the value differs, the difference is attributed to our fallback rather than to
the page. No event is emitted, the signal is marked suspect, and — importantly —
the weaker value does **not** become the new baseline.

Concretely: `h1` (1.00) degrading to `og:title-fallback` (0.40) usually means the
hero markup changed, not that the company rewrote its headline.

### 4.5 A collapsing list is a broken selector

For list signals, if the item count falls below 40% of its previous value (and
the previous list had at least four items), no event is emitted and the signal is
marked suspect.

A logo wall going from 14 names to 3 is our selector missing the wall. It is not
eleven customers churning overnight.

### 4.6 Typography is not positioning

Before comparison, values are normalised: curly quotes to straight, all dash
variants to hyphen-minus, non-breaking and zero-width spaces removed, whitespace
runs collapsed.

**Capitalisation is not normalised.** "The AI workspace" and "The AI Workspace"
are a real editorial decision and count as a change.

### 4.7 A value the page recently held is probably an experiment

Each signal remembers its last six value hashes. A change *back* to a value the
page has recently held is still recorded — it did happen — but is flagged
`oscillating` and labelled in the public feed as a likely A/B test rather than
presented as news.

During development `airtable.com` served two different `<h1>` strings to two
requests minutes apart. Split-tested heroes are the most likely source of false
positives in this index, and they are the one thing that is definitely not a
repositioning.

### 4.8 Change magnitude

For text signals, normalised Levenshtein distance over the first 200 characters,
0 to 1. For list signals, Jaccard distance over the item sets. Magnitude is
descriptive only; it never gates whether an event is emitted.

### 4.9 A value that depends on where we stood is not their news

**If the crawl origin (§1.2) differs from the origin of the previous observation
of the same page, no change event is emitted for any locale-sensitive signal on
it.** This is the sibling of §4.3: §4.3 says a value that went missing is our
parser breaking, and §4.9 says a value that moved can be our vantage point
moving.

A signal is locale-sensitive if either of these holds:

- it is one of the published-price signals — `pricing_tiers`,
  `pricing_entry_price`, `pricing_free_tier`, `pricing_seat_minimum`; or
- the value it holds, before or after, **quotes a currency at all**. This catches
  a proof point reading *"$2.4M saved"* or a headline quoting a price, without
  every such signal having to be enumerated.

What happens instead: the observation is recorded in full, the page is recorded
with status `origin-shift`, the signal is marked suspect, and **the last
known-good value is not overwritten** — exactly as in §4.4, so that the next
reading from the origin we baselined against is compared with what we actually
believed rather than with a value we only saw because we were standing somewhere
else.

Origins are compared conservatively. A difference is only asserted when it can be
proved: a different `environment`, or two known and different countries. If either
side's country is unknown, the comparison returns *indeterminate* and this rule
does not fire — muting the index every time a probe timed out would be its own
kind of dishonesty. §4.10 is what covers the indeterminate case.

This rule was added in v1.2, after `notion.com/pricing` produced two false change
events. `CORRECTIONS.md` has the full account.

### 4.10 A currency that moves while the numbers stay proportionate is routing

**If the currency changes and every comparable amount changes by the same factor,
that is a converted price list, not a repricing, and no event is emitted.**

Concretely: `EUR 9.5 → USD 10` is a ratio of 1.053; `EUR 19.5 → USD 20` is 1.026.
Nobody reprices by five per cent and switches currency in the same release. A
site that geo-routes does exactly that on every request.

The test is applied per tier, matched by tier name so a reordered pricing table
does not defeat it, and it holds only when:

- every ratio lies within 0.5–2.0 of 1, and
- the largest ratio is at most 1.35 times the smallest.

A tier that is free in one currency and free in the other carries no rate and is
ignored. A tier that is free in one and priced in the other fails the test.

**This rule needs no origin at all**, which is the point of it: it covers the two
cases where the origin is unknown — an observation recorded before v1.2, and a
probe that failed.

It requires corroboration before the new value is adopted: the same currency,
from the same origin, for **three** consecutive observations. Any change of
origin restarts the count. Even then the new value is adopted **silently**.

The consequence, stated plainly because it is a real limitation and not a
detail: **this index will never report a currency-only price change.** It cannot
distinguish one from locale routing, and the asymmetry in §4 resolves that toward
saying nothing. A currency change accompanied by a *disproportionate* price move
is a genuine repricing and is published normally.

---

## 5. What this index does not claim

- **Not intent.** It records what was published and when. Whether a change was
  strategic, a copy test, a CMS migration or an intern is outside what a crawler
  can know.
- **Not completeness.** Pricing tables rendered entirely client-side are
  invisible to us; `vercel.com/pricing` is one such page and reports null tiers
  rather than a guess. Sites that refuse identified automated clients are
  recorded as `blocked` and contribute no data.
- **Not a single global view.** Pages are fetched from one place at a time,
  because the crawler makes one request per page. Companies that geo-route serve
  different content to different addresses and the index sees one of them. From
  v1.2 the canonical origin is a GitHub Actions runner (§1.2), so the series is
  internally consistent — but where a company geo-routes, what is recorded is
  what a US-based client is shown, and that is not what a European buyer sees.
  Anyone who needs the European figure has to fetch it from Europe; this is not
  a multi-region crawler and is not going to become one. A crawl from a GitHub
  runner is also refused outright more often than one from a laptop — see the
  README's note on block rates.
- **Not continuous.** The record advances when a crawl is triggered, not on a
  clock. A quiet stretch in the data is a quiet stretch in the crawling until
  `data/runs.ndjson` says otherwise, and the site says which it was.
- **Not causal.** Two companies adopting the same category noun in the same
  month is an observation, not an influence.

---

## 6. Version history

**v1.2** — 2026-08-07. Crawl origin becomes part of the measurement. New §1.1
(pinned `Accept-Language`), §1.2 (how the origin is resolved and which one is
canonical), §3.1.1 (how a wrong claim is withdrawn), §4.9 (an origin shift is a
context fault) and §4.10 (a proportionate currency move is routing, not
repricing). §3.1, §4.1 and §5 updated accordingly.

Prompted by a real failure: two false change events about `notion.com/pricing`,
published on 2026-08-07 and retracted the same day. `CORRECTIONS.md` is the full
account.

**No signal definition changed** and the extractor version stays `1.0.0`: §2
describes the same measurements it did under v1.1, and values recorded before and
after this change are comparable *within one origin*. §4 gained two rules, both of
which only ever suppress. Nothing that was previously suppressed is now published,
so no claim this index has made becomes newly permissible under v1.2 — only fewer
claims are permissible than before.

**v1.1** — 2026-08-07. Storage moved from a hosted SQL database to append-only
NDJSON in git, and observation from a hosted cron to on-demand runs. §1, §3 and
§5 changed accordingly. **No signal definition and no change rule changed**, and
the extractor version stays `1.0.0`: §2 and §4 describe the same measurements
they did under v1.0, so values recorded before and after this change are
comparable.

**v1.0** — 2026-08-07. Initial release. 12 signals, 60 companies, extractor
`1.0.0`.

Any future change to extraction that could alter the value produced for an
unchanged page bumps the extractor version. When that version changes, the first
run against each page re-baselines and emits nothing, so that our own revision is
never attributed to a company.
