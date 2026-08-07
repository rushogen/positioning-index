# Corrections

Every claim this index has published and then withdrawn, what was wrong with it,
and what changed so it does not happen again.

The log exists because the alternative is worse. This index publishes statements
of the form *"company X changed Y on date Z"* to an audience that often knows the
answer independently, and a single false claim of that shape costs more
credibility than a hundred true ones earn. When one gets out, the useful response
is not to quietly delete it — it is to say what happened in enough detail that a
reader can judge whether the fix is any good.

The same standard applies to claims this index makes about **itself**. A wrong
number in the README is a published claim, it is read by more people than any
individual event, and it is not exempt because it was prose rather than data.
The 2026-08-08 entry below is the first of that kind.

**Nothing here is deleted.** A retracted event stays in `data/events.ndjson`
exactly as it was published, with a later line recording that it was withdrawn,
why, and when. The public feed excludes retracted events; `docs/api/retractions.json`
lists them. Both halves of the story stay in the git history, which is the whole
premise of the project.

---

## 2026-08-08 — The README described an eight-month archive. There was one day of it. {#2026-08-08-archive-age}

**Retracted:** three claims in `README.md`, and one in this file.

| Where | What was published |
|---|---|
| `README.md`, crawling gates | *"…also protects the **eight months of archive** recorded before any origin was written down."* |
| `README.md`, cost table | *"`docs/` is **under 1MB**"* |
| `README.md`, cost table | *"the append-only NDJSON grows by roughly **a megabyte a year**"* |
| `CORRECTIONS.md`, Notion entry | *"The archive **also contains a genuinely mixed-origin stretch**: everything recorded before 2026-08-07…"* |

### What actually happened

There is no eight-month archive. There is no mixed-origin stretch. Every
`observed_at` in `data/companies/` reads `2026-08-07`, the first archive commit
landed the same day, and the corpus at the time of writing is 126 observations
across 60 companies, 6 runs and 9 events.

The other two are measurements that were true when written and were never
re-checked:

```
docs/                 claimed  under 1MB      measured  1,068 kB
data/ growth          claimed  ~1 MB/year     measured  ~400 bytes per target
                                                        crawled, so ~50 kB per
                                                        full sweep of the seed
```

The growth figure was not merely stale, it was the wrong shape. `data/` does not
grow at a rate per year; it grows at a rate per target crawled, because
`data/runs.ndjson` records one result per target on every run while the
per-company series only appends when a value actually changes. Stated as an
annual figure it hid the variable that matters, which is how many pages the seed
holds.

### Why the existing gates did not catch it

Because there are none. Every gate in this project guards the path from a fetched
page to a published event. Nothing at all guards the path from a fact about the
project to a sentence in the README.

That is the whole finding, and it is uncomfortable in proportion to how careful
the rest of the pipeline is. The extractor will not attribute its own version
bump to a company. The diff engine will not call a null a removal. The run ledger
gets a line whether or not anything happened, specifically so that silence cannot
be mistaken for calm. And a paragraph three screens above all of that described
an archive that did not exist, in a document whose argument is *the record is
this repository's git history* — a record which, at the time, said plainly that
it was one day old.

The eight-month sentence appears to be a forward-looking description written
while the origin rules were being designed, left in the present tense. Nobody
re-read it against `git log`. The two cost-table numbers were measured once and
then the thing they measured grew.

### What changed

1. **The archive-age claim is gone.** The currency rule (S9) is now described as
   protecting readings recorded before the origin gate existed *should the
   archive ever be extended backwards*, which is what it actually does. The same
   correction is applied to the "What is still not solved" section of the
   2026-08-07 Notion entry above, which asserted the same non-existent stretch.

2. **The cost table quotes measurements with their scale attached.** `docs/` is
   1.0MB at 60 companies, and the note says most of it is one generated JSON
   file, so the number moves for a legible reason. Repository growth is stated
   per target crawled rather than per year, with the ledger named as the part
   that grows on every run.

3. **This log now covers claims about the index itself**, stated in the preamble.
   The distinction between "a false event" and "a false sentence" was never
   argued for; it was just never considered.

### What is not retracted

Nothing in `data/`. No observation, event or run record was wrong, and the
crawling and diff rules the README describes are all implemented as described.
What was wrong was the prose reporting on the state of the archive, in three
places, and this is not a data correction.

### What is still not solved

The generated pages cannot drift from the data, because `bin/build-site.js`
computes them from it. `README.md`, `METHODOLOGY.md` and this file are written by
hand and can say anything. 87kB of hand-written prose currently documents 126
observations, and every claim in it about corpus size, file size or growth rate
is a number a human typed and no test reads.

The honest fix is to generate the numbers rather than type them — a small set of
build-time placeholders in the README, filled from the same fold the site uses,
so a stale figure becomes impossible rather than merely embarrassing. That is not
done. Until it is, the cost table is accurate as of 2026-08-08 and carries the
same guarantee as any other sentence somebody typed once.

---

## 2026-08-07 — Airtable did not add a logo wall. Our extractor found one. {#2026-08-07-airtable-acquisition}

**Retracted:** 1 change event, `airtable` / `home`, detected at
`2026-08-07T15:53:34Z`.

| Signal | What was published |
|---|---|
| `customer_logos` | *Customer logos first observed: "Azure, Box, ChatGPT, Claude, Dropbox, Ebay, GitHub, Google, Jira, …"* |

### What actually happened

Two observations of `airtable.com`, four hours and forty-three minutes apart, in
the index's first full sweep of all 120 targets:

```
2026-08-07T11:10:09Z   customer_logos = null
2026-08-07T15:53:34Z   customer_logos = "Azure, Box, ChatGPT, Claude, Dropbox,
                                         Ebay, GitHub, Google, Jira, Openai,
                                         Salesforce, Slack, Snowflake, Tableau,
                                         Virgin Voyages"
```

We do not know that Airtable added a logo wall in those four hours, and neither
does anything in the archive. What we know is that we could not read one at
11:10 and could at 15:53. Those are different statements, and the index
published the stronger one.

Nothing distinguishes them from the transition alone. A logo wall rendered from
CSS sprites, or from a lazy-loaded component, or from `<img>` tags whose `alt`
text was added later, produces exactly this: a null, then fifteen names, with no
announcement in between. "Our extractor finally succeeded" and "the company
finally shipped it" are one transition wearing two hats.

### Why the existing gates did not catch it

Because there was no gate. The engine had been suspicious of the *opposite*
transition since its first commit — rule S2, `value → null`, is a parser fault
and never a change event, and it is the property the whole test suite is built
around. It was never suspicious of `null → value` at all.

That asymmetry had no argument behind it. It was simply never written. The two
directions carry the same ambiguity for the same reason: a null means *we have
no value*, which is a statement about our reading, not about their page. S2
takes that seriously in one direction. Nothing took it seriously in the other,
and the first sweep large enough to contain a recovering selector published the
result as news.

The event's own summary gave the game away and nobody read it closely enough:
*"Customer logos **first observed**"*. That is an accurate description of what
happened to us. It was published under a heading that says what happened to
them.

### What changed

1. **`null → value` is a signal acquisition, not an addition.** Rule S10 in
   `src/diff.js`, the sibling of S2 and built to the same shape: the observation
   is recorded in full, the value is not published, and nothing is silently
   dropped. The outcome is classified `acquisition`, beside the existing
   `parser-fault` and `origin-shift`, and it is counted in the run ledger and in
   the commit subject, because a suppression nobody can see is indistinguishable
   from a crawler that found nothing.

2. **The value must be corroborated before it becomes a baseline.** The same
   three consecutive readings the currency rule (S9) requires, from a healthy
   page, and adopted **silently** when they arrive. A read that returns
   byte-identical content counts, because identical bytes cannot hold a
   different value — without that, a value on a page that never changes again
   could never be adopted and the site would report a signal as unextracted
   after extracting it every day for a week.

3. **Where there is evidence, the reason string says so.** If the previous read
   of the page was classified `changed-structure`, had a signal in a parser
   fault, yielded materially less than this one, or ran a different extractor
   version, the acquisition is recorded as extractor recovery with high
   confidence and names the evidence. None of it changes what is published — S10
   publishes nothing either way — but *"we could not tell"* and *"we could tell,
   and it was us"* are different findings and must not be written down the same
   way.

4. **The engine no longer emits `added` events at all.** There is no longer a
   code path that produces one. A consequence worth stating plainly: **this
   index will not report the moment a company first publishes a logo wall, a
   proof point or a seat minimum.** It cannot tell that moment apart from the
   moment our extractor first managed to read one. A false *"company X added Y"*
   costs more than a missed one, so the asymmetry resolves toward silence, the
   same way §4.3 and §4.10 resolve it.

5. **Tests.** `tests/diff.test.js` replays this exact case from the two lines
   still in `data/companies/airtable.ndjson` and asserts zero events for
   `customer_logos` while the three genuine changes on the same page still
   publish. Alongside it: a first observation of a target publishes nothing at
   all, an acquisition after a parser fault or a structure change is recognised
   as recovery, an acquired value is adopted only after corroboration, an
   unhealthy read never corroborates, a value that keeps moving never becomes a
   baseline, and a genuine value → value change still publishes normally.

### What is not retracted

The three other events from the same observation — `headline`, `subhead` and
`proof_points` — stand. Each is a `value → value` transition between two strings
this index actually read, and S10 has nothing to say about them.

They carry a limitation of their own, and it is now stated on the site rather
than only here. Airtable is documented in this repository as A/B-testing its
`<h1>`: two different hero strings, minutes apart, during development. The
oscillation detector reports `osc=0` for the headline change only because it has
not yet observed the value flap back — absence of a second reading is not
evidence of a stable one. A single observation cannot distinguish a
repositioning from an experiment that is still running, and the feed now marks
an event the page has not been read again since.

### What is still not solved

A signal that has never had a value is still not readable as a fact about the
company. `linear.app` publishes no logo wall this extractor can read, and the
index cannot tell that from a company that publishes none — the removal rules in
§4.3 already refuse to say the second, and S10 now refuses to say the first in
reverse. That gap is honest, but it is a gap: for signals that are null on day
one, this index measures its own reach as much as it measures the market.

The corroboration window is also the one place where S10 costs something real.
For three readings after a value appears, the site shows the signal as having no
established value while the raw observation lines plainly contain one. The
observation is right and the summary lags it. That is the correct direction to
be wrong in, and it is still a lag.

---

## 2026-08-07 — Notion's pricing did not change. Our crawler moved. {#2026-08-07-notion-currency}

**Retracted:** 2 change events, both `notion` / `pricing`, both detected at
`2026-08-07T11:18:26Z`.

| Signal | What was published |
|---|---|
| `pricing_entry_price` | *Entry price moved from EUR 9.5 to USD 10* |
| `pricing_tiers` | *Pricing tiers reordered* — `Free free \| Plus EUR 9.5 \| Business EUR 19.5 \| …` to `Free free \| Plus USD 10 \| Business USD 20 \| …` |

### What actually happened

Two observations of `notion.com/pricing`, seven minutes apart:

```
2026-08-07T11:11:09Z   crawled from a laptop in Germany
                       pricing_entry_price = "EUR 9.5"
                       Free free | Plus EUR 9.5 | Business EUR 19.5 | Enterprise custom | …

2026-08-07T11:18:26Z   crawled from a GitHub Actions runner in a US datacenter
                       pricing_entry_price = "USD 10"
                       Free free | Plus USD 10 | Business USD 20 | Enterprise custom | …
```

Notion changed nothing in those seven minutes. `notion.com/pricing` selects the
currency it quotes from the client's IP address. The first request egressed from
Germany and was quoted euros; the second egressed from a US cloud region and was
quoted dollars. Same page, same plans, same prices — two currencies.

### Why the existing gates did not catch it

The diff engine already had a gate for exactly this class of problem — a page
that comes back localised is re-baselined rather than reported as a rewrite — and
it has caught real cases (`klaviyo.com`, `stripe.com`, `zendesk.com` and
`snowflake.com` all redirect a German client to a translated page).

It missed this one because it was watching the wrong two things. It compares
`<html lang>` and the canonical URL, and Notion changed **neither**: both
responses declared `lang="en"` and both declared the canonical
`https://www.notion.com/pricing`. The only thing that differed was the currency
inside the page body, and nothing in the pipeline was looking at that.

The deeper failure is the one that made this unrecoverable rather than merely
wrong: **the crawl origin was not recorded anywhere.** `data/runs.ndjson` stored
a `trigger` field saying who asked for the run, but nothing said where the run
physically stood while it read the web. So even reading the archive back
afterwards, with full knowledge of what had happened, there was no field that
distinguished this from real drift. A false claim is bad. A false claim the
archive cannot be audited for is worse.

### What changed

1. **Crawl origin is recorded on every observation, every run, every target
   result and every change event.** `src/crawl/origin.js` resolves the
   environment exactly (`local` or `github-actions`, from the variables GitHub
   Actions sets) and the country best-effort, from one Cloudflare edge trace per
   run — no key, no account, and the same answer on a laptop as on a runner. A
   probe failure yields `unknown`, which downstream reads as *cannot rule out a
   shift*, never as *no shift*. The country is never inferred from a system
   timezone or locale, because that would replace a known gap with a confident
   lie.

2. **A change of origin suppresses locale-sensitive signals.** Rule S8 in
   `src/diff.js`. Every published price is locale-sensitive, and so is any signal
   whose value quotes a currency at all. The observation is still recorded in
   full; only the claim is withheld. The last known-good value is *not*
   overwritten, so the next reading from the origin we baselined against diffs
   against what we actually believed. The run is classified `origin-shift`,
   beside the existing `changed-structure`.

3. **A currency change with proportionate amounts is treated as routing, not
   repricing.** Rule S9. This needs no origin at all, which is what covers the
   two cases where origin is unknown — an observation recorded before this fix,
   and a probe that failed. It requires corroboration: the same currency, from
   the same origin, three consecutive times, and even then the new value is
   adopted **silently**. A consequence worth stating plainly: **this index will
   never report a currency-only price change.** It cannot tell one from locale
   routing. A currency change accompanied by a disproportionate price move is a
   real repricing and is still published.

4. **`Accept-Language` is pinned** to `en-US,en;q=0.9` on every request from
   every origin, so content negotiation stops being a second uncontrolled locale
   input beside the client IP. This reduces the variance. It does not remove
   IP-based routing, which ignores the header entirely — Notion's page did.

5. **GitHub Actions is now the canonical origin.** It is reproducible and
   documented; a laptop is neither. Local runs remain useful and remain
   supported, and they will produce `origin-shift` records against the canonical
   baseline, which is the correct and visible outcome rather than a silent one.

6. **Tests.** `tests/origin.test.js` replays this exact case — the real stored
   EUR 9.5 / USD 10 values, the real tier lists — and asserts zero change events.
   Alongside it: a genuine price change within one origin still publishes, an
   origin shift preserves last-known-good, a retracted event never reaches the
   public feed, and `unknown` origins are handled without either suppressing
   everything or suppressing nothing.

### What is still not solved

The index sees one geography at a time and always will, because it makes one
request per page. Pinning the canonical origin to GitHub Actions means the series
is internally consistent from here on; it does not mean the prices recorded are
the prices a European buyer sees. Where a company geo-routes, this index records
what a US-based client is shown, and says so. Anyone who needs the European
figure has to fetch it from Europe, and this crawler is not a multi-region fleet.

Observations recorded before the origin field existed would carry no origin, and
would be marked `unknown` rather than backfilled with a guess. The currency rule
(S9) is what protects them, since it does not depend on knowing where anything
was read from. In practice the archive contains no such stretch: the field
landed on 2026-08-07, the same day as the first observations, so every line in
`data/companies/` carries an origin. The rule is there for an archive extended
backwards, not for one that exists.
