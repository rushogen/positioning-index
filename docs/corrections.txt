# Corrections

Every claim this index has published and then withdrawn, what was wrong with it,
and what changed so it does not happen again.

The log exists because the alternative is worse. This index publishes statements
of the form *"company X changed Y on date Z"* to an audience that often knows the
answer independently, and a single false claim of that shape costs more
credibility than a hundred true ones earn. When one gets out, the useful response
is not to quietly delete it — it is to say what happened in enough detail that a
reader can judge whether the fix is any good.

**Nothing here is deleted.** A retracted event stays in `data/events.ndjson`
exactly as it was published, with a later line recording that it was withdrawn,
why, and when. The public feed excludes retracted events; `docs/api/retractions.json`
lists them. Both halves of the story stay in the git history, which is the whole
premise of the project.

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

The archive also contains a genuinely mixed-origin stretch: everything recorded
before 2026-08-07 carries no origin field, because the field did not exist. Those
observations are marked `unknown` rather than backfilled with a guess. The
currency rule (S9) is what protects them, since it does not depend on knowing
where anything was read from.
