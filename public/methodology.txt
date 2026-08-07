# Methodology

**Version 1.0** — corresponds to extractor version `1.0.0`.

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

Each page is fetched at most once per day.

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

Every run writes one `observations` row per signal, **including the null ones**.
The series is a record of what we measured, not only of what we found; a gap in
the data and a null measurement are different facts and are stored differently.

`observations` is append-only. No code path issues `UPDATE` or `DELETE` against
it.

Each observation stores the value, its structured form where applicable, the
method that produced it, the confidence, and the extractor version.

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

---

## 5. What this index does not claim

- **Not intent.** It records what was published and when. Whether a change was
  strategic, a copy test, a CMS migration or an intern is outside what a crawler
  can know.
- **Not completeness.** Pricing tables rendered entirely client-side are
  invisible to us; `vercel.com/pricing` is one such page and reports null tiers
  rather than a guess. Sites that refuse identified automated clients are
  recorded as `blocked` and contribute no data.
- **Not a single global view.** Pages are fetched from wherever the Worker runs.
  Companies that geo-route or split-test serve different content to different
  requests, and the index sees one of those.
- **Not causal.** Two companies adopting the same category noun in the same
  month is an observation, not an influence.

---

## 6. Version history

**v1.0** — 2026-08-07. Initial release. 12 signals, 60 companies, extractor
`1.0.0`.

Any future change to extraction that could alter the value produced for an
unchanged page bumps the extractor version. When that version changes, the first
run against each page re-baselines and emits nothing, so that our own revision is
never attributed to a company.
